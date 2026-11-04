// Two stick figures that fight on their own (PLAN.md, "Toys"): they walk at each other, punch and kick, knock each other
// into cards and the page's edges, climb up cards after each other, go limp when hit (ragdoll.ts) and get back up.
// The first down three times loses the round. Their physics is physics.ts, the ball's. Pure, no DOM: main.tsx draws `pose`.
import { FIGHT_SPOT, HOLD_MS, type Card, type Phase } from './gestures.ts';
import { clamp, rectsOf, step, STEP, TAP_MS, thrown, type Body, type Rect, type Sample } from './physics.ts';
import { createRag, JOINTS, stepRag, type Joints, type Pt, type Rag } from './ragdoll.ts';

export const FR = 0.05; // the body's circle for collisions; the figure stands on its bottom edge
export const H = 0.14; // a figure's height, in page heights
const WALK = 0.38; // page heights per s
const CLIMB = 0.4; // up a card's side, page heights per s
const JUMP = -1.35; // straight up, page heights per s: about 0.4 high
const GAP = 0.045; // two figures standing closer than this are pushed apart
const SAME_LEVEL = 0.06;
const HEADROOM = 0.12; // a card whose top is nearer the page's top than this can't be stood on
const REACH_UP = 0.35; // a card whose bottom is this far above the feet can still be got onto, with a jump
const HIGH_GROUND = 0.3; // after taking a hit, the chance of heading for the nearest card to climb
const GOAL_S = 5; // giving up on a card that can't be reached
const CAMP_S = 1.5; // waiting on top for the other one to come up
const DOWNS = 3; // knockdowns that lose a round
const ROUND_S = 60; // the longest round, so the Pi's frames always end
const WIN_S = 1.5;
const HURT_S = 0.35;
const DOWN_S = 1;
const UP_S = 0.5; // getting up, from limp to standing
const STEADY_S = 0.25; // from limp to standing after a flinch
const FLINCH = 0.6; // a knock this hard (speed change) makes a figure flinch...
const FLOOR_IT = 2.2; // ...and this hard knocks it down
const STILL = 0.02;
// Reach is from the body's centre, in page heights. `push` is the knock given (forward, up); `down` the chance it floors them.
const MOVES = {
  punch: { reach: 0.075, windup: 0.16, active: 0.08, recover: 0.22, push: [1.0, -0.4], down: 0 },
  kick: { reach: 0.09, windup: 0.22, active: 0.1, recover: 0.3, push: [1.5, -0.7], down: 0.45 },
} as const;

type State = 'idle' | 'walk' | 'climb' | 'attack' | 'hurt' | 'down' | 'up' | 'win' | 'held';
const LIMP = new Set<State>(['hurt', 'down', 'held']); // drawn as a ragdoll
export type Fighter = {
  body: Body;
  dir: 1 | -1; // facing
  state: State;
  t: number; // seconds in this state
  move: keyof typeof MOVES;
  landed: boolean; // this attack already hit
  downs: number;
  grounded: boolean;
  wait: number; // seconds before the next attack or jump
  lay: number; // seconds lying still
  stride: number; // the walk and climb cycle
  rag?: Rag; // while limp
  steady?: { from: Joints; t: number; s: number }; // from limp back to a pose: the joints relative to the feet, and the time
  wall?: { id?: string; dir: 1 | -1 }; // the card being climbed, and which way it faces it
  goal?: { id?: string; t: number }; // a card picked to climb, for the high ground
  camp: number; // seconds left holding the card just climbed, waiting for the other one to come up
  mark: Pt; // where it was when it last got anywhere...
  stuck: number; // ...and how long it's been trying to move since
  detour: number; // seconds left going the other way round, after getting stuck
};

// A small seeded random number generator (mulberry32), so a test can replay the same fight.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const feetOf = (f: Fighter): Pt => [f.body.x, f.body.y + FR];
// The card a figure stands on, if any.
const standingOn = (f: Fighter, rects: Rect[]) =>
  f.grounded ? rects.find((r) => Math.abs(f.body.y + FR - r.y) < 0.01 && f.body.x >= r.x - FR / 2 && f.body.x <= r.x + r.w + FR / 2) : undefined;
// Where to stand to climb or jump onto a card: just outside its nearer side, facing in.
function approach(f: Fighter, c: Rect) {
  const left = f.body.x < c.x + c.w / 2;
  return { x: left ? c.x - FR - 0.01 : c.x + c.w + FR + 0.01, dir: (left ? 1 : -1) as 1 | -1 };
}
// Room to stand on a card's top at `x`: inside the page, and no other card in the way.
function roomOnTop(c: Rect, x: number, rects: Rect[]) {
  const box = { x: x - FR, y: c.y - H, w: 2 * FR, h: H - 0.005 };
  return box.y >= 0 && !rects.some((r) => r !== c && box.x < r.x + r.w && r.x < box.x + box.w && box.y < r.y + r.h && r.y < box.y + box.h);
}

export function createFighters(seed = Date.now()) {
  const random = rng(seed);
  const make = (): Fighter => ({
    body: { x: 0, y: 0, vx: 0, vy: 0, r: FR, bounce: 0.45, stick: 0.25, roll: 0.5 },
    dir: 1,
    state: 'idle',
    t: 0,
    move: 'punch',
    landed: false,
    downs: 0,
    grounded: false,
    wait: 0,
    lay: 0,
    stride: 0,
    camp: 0,
    mark: [0, 0],
    stuck: 0,
    detour: 0,
  });
  const fs = [make(), make()];
  let out = false;
  let round: 'fighting' | 'over' = 'over';
  let roundT = 0;
  let winner: number | null = null;
  let settled = true; // nothing to run: no frames needed
  let held: { id: string; i: number; dx: number; dy: number; samples: Sample[] } | undefined;
  let spotDown: { id: string; t: number } | undefined;
  let acc = 0;

  // Going limp starts the ragdoll from the pose it was in, its limbs lagging behind the body; coming out of it
  // eases back to standing.
  const set = (f: Fighter, s: State) => {
    if (LIMP.has(s) && !f.rag) {
      f.rag = createRag(posed(f), f.body.vx * 0.4, f.body.vy * 0.4, standing(f));
      f.steady = undefined;
    } else if (!LIMP.has(s) && f.rag) {
      const [fx, fy] = feetOf(f);
      const from = Object.fromEntries(JOINTS.map((k) => [k, [f.rag!.pos[k][0] - fx, f.rag!.pos[k][1] - fy]])) as Joints;
      f.steady = { from, t: 0, s: s === 'up' ? UP_S : STEADY_S };
      f.rag = undefined;
    }
    if (s !== 'climb') f.wall = undefined;
    f.state = s;
    f.t = 0;
  };
  const inSpot = (px: number, py: number) => px >= FIGHT_SPOT.x && px <= FIGHT_SPOT.x + FIGHT_SPOT.w && py >= FIGHT_SPOT.y;
  const speed = (f: Fighter) => Math.hypot(f.body.vx, f.body.vy);

  function end(w: number | null) {
    round = 'over';
    winner = w;
    for (const f of fs) {
      f.goal = undefined;
      if (f.state === 'walk' || f.state === 'attack') set(f, 'idle'); // out of time: both stop where they are
    }
    if (w !== null) set(fs[w], 'win');
  }
  // Back on its feet: the winner of a round that's over goes back to its winning pose (it may have been hit in the
  // same moment it won), anyone else just stands.
  const recovered = (i: number): State => (round === 'over' && winner === i ? 'win' : 'idle');
  function floor(i: number) {
    const f = fs[i];
    if (f.state === 'down') return;
    set(f, 'down');
    f.lay = 0;
    if (round === 'fighting' && ++f.downs >= DOWNS) end(1 - i);
  }
  // How a figure takes a knock of this speed: shrugs it off, flinches, or goes down.
  function react(i: number, hard: number, downChance = 0) {
    const f = fs[i];
    if (f.state === 'held') return;
    settled = false;
    if (hard >= FLOOR_IT || (downChance > 0 && random() < downChance)) floor(i);
    else if (hard >= FLINCH && f.state !== 'down') set(f, 'hurt');
  }
  function knock(i: number, dvx: number, dvy: number, downChance = 0) {
    fs[i].body.vx += dvx;
    fs[i].body.vy += dvy;
    react(i, Math.hypot(dvx, dvy), downChance);
  }

  function start() {
    round = 'fighting';
    roundT = 0;
    winner = null;
    settled = false;
    for (const f of fs) {
      f.downs = 0;
      f.goal = undefined;
      f.wait = 0.5 + random() * 0.5;
      set(f, f.state === 'down' ? 'up' : 'idle');
    }
  }

  // The nearest card worth climbing: higher than the feet, reachable, with room to stand on top.
  function highGround(f: Fighter, rects: Rect[]) {
    const fy = f.body.y + FR;
    const ok = rects.filter((r) => r.y >= HEADROOM && r.y < fy - SAME_LEVEL && r.y + r.h > fy - REACH_UP && roomOnTop(r, r.x + r.w / 2, rects));
    return ok.sort((a, b) => Math.abs(a.x + a.w / 2 - f.body.x) - Math.abs(b.x + b.w / 2 - f.body.x))[0];
  }

  // What a figure standing on something decides to do next.
  function think(f: Fighter, o: Fighter, rects: Rect[]) {
    if (f.state !== 'idle' && f.state !== 'walk') return;
    f.wait -= STEP;
    const b = f.body;
    const ob = o.body;
    // Turns only when it's clearly the other way: straight above or below, it keeps going (and walks off the edge)
    // rather than turning back and forth.
    const face = (x: number) => {
      if (Math.abs(x - b.x) > 0.02) f.dir = x > b.x ? 1 : -1;
    };
    const stand = () => {
      if (f.state !== 'idle') set(f, 'idle');
    };
    if (o.state === 'down' || o.state === 'held') {
      face(ob.x); // no hitting someone who's down
      return stand();
    }
    const level = Math.abs(ob.y - b.y) < SAME_LEVEL;
    if (level && Math.abs(ob.x - b.x) <= MOVES.kick.reach) {
      f.goal = undefined;
      f.stuck = 0; // fighting isn't being stuck
      face(ob.x);
      if (f.wait > 0) return stand();
      set(f, 'attack');
      f.move = random() < 0.6 ? 'punch' : 'kick';
      f.landed = false;
      return;
    }
    // On a card: hold it a while if the other one is below, and never walk off while they're climbing up it.
    const on = standingOn(f, rects);
    if (f.goal && on && on.id === f.goal.id) f.goal = undefined; // got there
    const comingUp = on && o.state === 'climb' && o.wall?.id === on.id;
    if (on && ob.y > b.y + SAME_LEVEL && (comingUp || (f.camp -= STEP) > 0)) {
      f.stuck = 0; // nor is waiting on purpose
      face(ob.x);
      return stand();
    }
    // Trying to get somewhere and not getting there (wedged in a gap, against a card it can't get past):
    // after 2 s it turns round and goes the other way for a bit, to find another way.
    if (Math.hypot(b.x - f.mark[0], b.y - f.mark[1]) > 0.03) {
      f.mark = [b.x, b.y];
      f.stuck = 0;
    } else if ((f.stuck += STEP) > 2) {
      f.stuck = 0;
      f.detour = 1.5 + random();
      f.dir = f.dir === 1 ? -1 : 1;
      f.goal = undefined;
    }
    // Where to: up onto the card the other one stands on, the card picked to climb, or straight at them.
    const up = ob.y < b.y - SAME_LEVEL ? standingOn(o, rects) : undefined;
    const card = f.detour > 0 ? undefined : (up ?? (f.goal ? rects.find((r) => r.id === f.goal!.id) : undefined));
    if (f.detour > 0) f.detour -= STEP; // keeps going the way it turned
    else if (card) {
      const a = approach(f, card);
      if (Math.abs(a.x - b.x) > 0.02) {
        face(a.x);
      } else {
        f.dir = a.dir; // at its side: in we go, a climb if it comes down to us, a jump if it's higher
        const reachable = card.y + card.h > b.y - FR;
        if (!reachable) {
          if (f.wait > 0) return stand();
          if (f.state !== 'walk') set(f, 'walk'); // a jump is a walk in the air: touching the side starts the climb
          b.vy = JUMP;
          b.vx = f.dir * WALK;
          f.wait = 1 + random();
          return;
        }
      }
    } else if (on && ob.y > b.y + SAME_LEVEL) {
      // Down to them: off the end of this card toward them, or the nearer end if they're right below.
      const left = ob.x < on.x || (ob.x <= on.x + on.w && b.x - on.x < on.x + on.w - b.x);
      f.dir = left ? -1 : 1;
    } else face(ob.x);
    // Up against a card it can't climb (no room on top): a jump to try to get over it now and then, else wait.
    if (blocked(f, rects)) {
      if (f.wait > 0) return stand();
      if (f.state !== 'walk') set(f, 'walk');
      b.vy = JUMP;
      f.wait = 1 + random();
      return;
    }
    if (f.state !== 'walk') set(f, 'walk');
  }

  // A card's side right ahead, at body height.
  function blocked(f: Fighter, rects: Rect[]) {
    const b = f.body;
    return rects.some((r) => Math.abs(b.x + f.dir * b.r - (f.dir === 1 ? r.x : r.x + r.w)) < 0.004 && b.y + b.r > r.y + 0.01 && b.y - b.r < r.y + r.h);
  }

  // The card it's walking or jumping into, if it can climb it: higher than its feet, with room to stand on top.
  function wallAhead(f: Fighter, rects: Rect[]) {
    const b = f.body;
    return rects.find((r) => {
      const side = f.dir === 1 ? r.x : r.x + r.w;
      const touching = Math.abs(b.x + f.dir * b.r - side) < 0.004;
      const beside = b.y + b.r > r.y + 0.01 && b.y - b.r < r.y + r.h;
      return touching && beside && r.y >= HEADROOM && r.y < b.y + b.r - 0.02 && roomOnTop(r, side + f.dir * b.r, rects);
    });
  }
  // Up the side, hand over hand, following the card if it's dragged; over the top onto it. If the card goes, or
  // something now blocks the top, it lets go.
  function climb(f: Fighter, rects: Rect[]) {
    const b = f.body;
    const w = f.wall!;
    const r = rects.find((r) => r.id === w.id);
    const side = r && (w.dir === 1 ? r.x : r.x + r.w);
    if (!r || side === undefined || b.y - b.r >= r.y + r.h || b.y + b.r < r.y - 0.02) {
      set(f, 'idle');
      f.grounded = false;
      return;
    }
    b.vx = b.vy = 0;
    b.x = side - w.dir * b.r;
    b.y -= CLIMB * STEP;
    f.stride += STEP * (CLIMB / 0.05);
    if (b.y + b.r <= r.y) {
      if (!roomOnTop(r, side + w.dir * b.r, rects)) {
        set(f, 'idle'); // no room up there any more
        f.grounded = false;
        return;
      }
      b.y = r.y - b.r;
      b.x = side + w.dir * b.r;
      f.grounded = true;
      f.camp = CAMP_S;
      set(f, 'idle');
    }
  }

  // A hit that lands is returned, not dealt here: both figures' hits in a step land together, so neither one is first.
  function attack(i: number): [number, number, number, number] | undefined {
    const f = fs[i];
    const o = fs[1 - i];
    const m = MOVES[f.move];
    let hit: [number, number, number, number] | undefined;
    if (!f.landed && f.t >= m.windup && f.t < m.windup + m.active) {
      const ahead = f.dir * (o.body.x - f.body.x);
      if (ahead >= 0 && ahead <= m.reach + 0.02 && Math.abs(o.body.y - f.body.y) < SAME_LEVEL && o.state !== 'down' && o.state !== 'held') {
        f.landed = true;
        hit = [1 - i, f.dir * m.push[0], m.push[1], m.down];
      }
    }
    if (f.t >= m.windup + m.active + m.recover) {
      set(f, 'idle');
      f.wait = 0.3 + random() * 0.5;
    }
    return hit;
  }

  function tick(rects: Rect[], aspect: number) {
    roundT += STEP;
    if (round === 'fighting' && roundT >= ROUND_S) end(null);
    const hits: [number, number, number, number][] = [];
    // Both decide, then both move: deciding in turn let the second one see where the first had just moved to,
    // and so strike first more often.
    for (let i = 0; i < 2; i++) {
      const f = fs[i];
      f.t += STEP;
      if (f.steady && (f.steady.t += STEP) >= f.steady.s) f.steady = undefined;
      if (f.goal && (f.goal.t += STEP) >= GOAL_S && !standingOn(f, rects)) f.goal = undefined; // can't get there: never mind
      if (f.grounded && round === 'fighting') think(f, fs[1 - i], rects);
    }
    for (let i = 0; i < 2; i++) {
      const f = fs[i];
      const b = f.body;
      if (f.state === 'held') {
        if (f.rag) stepRag(f.rag, anchor(f), rects, aspect); // dangling from the hand
        continue;
      }
      if (f.state === 'climb') {
        climb(f, rects);
        continue;
      }
      if (f.grounded) {
        if (f.state === 'walk') {
          b.vx = f.dir * WALK;
          f.stride += STEP * (WALK / 0.07);
        } else b.vx *= f.state === 'hurt' || f.state === 'down' ? 0.92 : 0.8; // a knocked one skids a little; a planted one stops
      }
      f.grounded = step(b, rects, aspect);
      if (f.state === 'walk' && round === 'fighting') {
        const card = wallAhead(f, rects); // walked or jumped into a card: up it goes
        if (card) {
          set(f, 'climb');
          f.wall = { id: card.id, dir: f.dir };
        }
      }
      if (f.rag) stepRag(f.rag, anchor(f), rects, aspect);
      if (f.state === 'attack') {
        const hit = attack(i);
        if (hit) hits.push(hit);
      } else if (f.state === 'hurt' && f.t >= HURT_S && f.grounded && speed(f) < 0.3) {
        set(f, recovered(i));
        if (round === 'fighting' && random() < HIGH_GROUND) {
          const card = highGround(f, rects);
          if (card) f.goal = { id: card.id, t: 0 };
        }
      } else if (f.state === 'down') {
        f.lay = f.grounded && speed(f) < 0.1 ? f.lay + STEP : 0;
        if (f.lay >= DOWN_S && !(round === 'over' && f.downs >= DOWNS)) set(f, 'up'); // knocked out stays down
      } else if (f.state === 'up' && f.t >= UP_S) set(f, recovered(i));
    }
    for (const [i, dvx, dvy, chance] of hits) knock(i, dvx, dvy, chance);
    // Two figures on the same level can't walk through each other.
    const [a, b] = fs.map((f) => f.body);
    const dx = b.x - a.x;
    if (Math.abs(dx) < GAP && Math.abs(b.y - a.y) < SAME_LEVEL && fs.every((f) => f.state !== 'held' && f.state !== 'climb')) {
      const push = (GAP - Math.abs(dx)) / 2;
      const s = dx >= 0 ? 1 : -1;
      a.x = clamp(a.x - s * push, FR, aspect - FR);
      b.x = clamp(b.x + s * push, FR, aspect - FR);
    }
    // Done when the round is over, nobody's held, and both are still on something and in a pose that stays put.
    settled =
      round === 'over' &&
      !held &&
      (winner === null || fs[winner].t >= WIN_S) &&
      fs.every((f) => f.grounded && speed(f) < STILL && !f.steady && (f.state === 'idle' || f.state === 'win' || (f.state === 'down' && f.downs >= DOWNS && f.lay >= DOWN_S)));
    if (settled) for (const f of fs) f.body.vx = f.body.vy = 0;
  }

  return {
    get out() {
      return out;
    },
    get round() {
      return round;
    },
    get winner() {
      return winner;
    },
    list: fs as readonly Fighter[],
    // A knock from outside, the ball (toys.ts): the speed is already given, this decides flinch or fall.
    react,
    knock,
    // Mouse and tracker pointers, in page coordinates. A figure can be grabbed and thrown like the ball; it hangs limp.
    // The "fight" spot: a tap brings them out or starts the next round; holding it HOLD_MS puts them away.
    pointer(phase: Phase, id: string, px: number, py: number, t: number, aspect: number): boolean {
      const x = px * aspect;
      const y = py;
      if (phase === 'down') {
        const i = out && !held ? fs.findIndex((f) => Math.hypot(x - f.body.x, y - (f.body.y + FR - H / 2)) <= H * 0.6) : -1;
        if (i >= 0) {
          const f = fs[i];
          held = { id, i, dx: f.body.x - x, dy: f.body.y - y, samples: [{ t, x, y }] };
          f.body.vx = f.body.vy = 0;
          f.goal = undefined;
          set(f, 'held');
          settled = false;
          return true;
        }
        if (inSpot(px, py)) {
          spotDown = { id, t };
          return true;
        }
        return false;
      }
      if (held?.id === id) {
        const f = fs[held.i];
        held.samples.push({ t, x, y });
        if (held.samples.length > 64) held.samples.shift();
        f.body.x = clamp(x + held.dx, FR, aspect - FR);
        f.body.y = clamp(y + held.dy, FR, 1 - FR);
        if (phase !== 'move') {
          [f.body.vx, f.body.vy] = phase === 'up' ? thrown(held.samples) : [0, 0];
          set(f, 'hurt'); // flies limp, lands, gets its balance back
          held = undefined;
        }
        return true;
      }
      if (spotDown?.id === id) {
        const ms = t - spotDown.t;
        if (phase === 'up' && inSpot(px, py)) {
          if (ms <= TAP_MS && !out) {
            out = true;
            fs.forEach((f, i) => {
              Object.assign(f.body, { x: (0.35 + 0.3 * i) * aspect, y: 0.9 - FR, vx: 0, vy: 0 });
              f.dir = i === 0 ? 1 : -1;
              f.grounded = true;
              f.rag = f.steady = undefined;
              set(f, 'idle');
            });
            acc = 0;
            start();
          } else if (ms <= TAP_MS && round === 'over') start();
          else if (ms >= HOLD_MS && out) {
            out = false;
            held = undefined;
            round = 'over';
            settled = true;
          }
        }
        if (phase !== 'move') spotDown = undefined;
        return true;
      }
      return false;
    },
    // Something changed under them (a card moved, came or went, or the window was resized).
    wake() {
      if (out) settled = false;
    },
    // True while there's anything to run: a round, a throw, someone flying, climbing or getting up.
    get active() {
      return out && !settled;
    },
    // Runs `dt` seconds in fixed steps. True while still active, so the caller asks for another frame.
    advance(dt: number, cards: Card[], aspect: number): boolean {
      if (!out || settled) return false;
      const rects = rectsOf(cards, aspect);
      acc += dt / STEP;
      while (acc >= 1 - 1e-9 && !settled) {
        tick(rects, aspect);
        acc -= 1;
      }
      if (settled) acc = 0;
      return !settled;
    },
  };
}

export type Fighters = ReturnType<typeof createFighters>;

// Where the ragdoll's hip is held: the body's centre, a little lower while down, so it lies flat. Not tied to touching
// the ground, which flickers in a skid and would jerk the hip up and down.
const anchor = (f: Fighter): Pt => [f.body.x, f.body.y + (f.state === 'down' ? 0.03 : -0.017)];

// The posed figure: joints as (forward, up) in figure heights from the feet, turned to face `dir`.
type Local = Record<string, Pt>;
const STAND: Local = {
  hip: [0, 0.48], neck: [0, 0.8], head: [0, 0.9],
  elbowF: [0.1, 0.62], handF: [0.17, 0.72], elbowB: [-0.04, 0.6], handB: [0.06, 0.68],
  kneeF: [0.08, 0.24], footF: [0.13, 0], kneeB: [-0.07, 0.24], footB: [-0.12, 0],
};
const lerp = (a: Pt, b: Pt, k: number): Pt => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];

function local(f: Fighter): Local {
  const j = { ...STAND };
  const s = f.state;
  if (s === 'walk') {
    const w = Math.sin(f.stride);
    Object.assign(j, { footF: [0.14 * w, 0], kneeF: [0.07 * w + 0.03, 0.24], footB: [-0.14 * w, 0], kneeB: [-0.07 * w + 0.03, 0.24] });
  } else if (s === 'climb') {
    // Facing the card's side: hands reaching up it in turn, knees up.
    const w = Math.sin(f.stride);
    Object.assign(j, {
      elbowF: [0.12, 0.92 + 0.06 * w], handF: [0.16, 1.08 + 0.1 * w], elbowB: [0.1, 0.86 - 0.06 * w], handB: [0.16, 1.0 - 0.1 * w],
      kneeF: [0.16, 0.36 + 0.1 * w], footF: [0.14, 0.14 + 0.1 * w], kneeB: [0.14, 0.3 - 0.1 * w], footB: [0.12, 0.06 - 0.06 * w],
    });
  } else if (s === 'attack') {
    const m = MOVES[f.move];
    const k = clamp((f.t - m.windup) / m.active, 0, 1); // 0 winding up, 1 fully out
    const back = clamp(1 - (f.t - m.windup - m.active) / m.recover, 0, 1); // pulled back in during recovery
    const reach = f.t < m.windup ? 0 : f.t < m.windup + m.active ? k : back;
    if (f.move === 'punch') {
      Object.assign(j, { elbowF: lerp([0.0, 0.66], [0.3, 0.74], reach), handF: lerp([-0.02, 0.72], [0.56, 0.74], reach) });
    } else {
      Object.assign(j, {
        kneeF: lerp([0.12, 0.34], [0.32, 0.46], reach), footF: lerp([0.06, 0.14], [0.64, 0.46], reach),
        neck: lerp([0, 0.8], [-0.08, 0.78], reach), head: lerp([0, 0.9], [-0.12, 0.87], reach),
      });
    }
  } else if (s === 'win') {
    Object.assign(j, { elbowF: [0.12, 0.98], handF: [0.16, 1.16], elbowB: [-0.12, 0.98], handB: [-0.16, 1.16] });
  }
  return j;
}
function toWorld(f: Fighter, j: Local): Joints {
  const [fx, fy] = feetOf(f);
  return Object.fromEntries(JOINTS.map((k) => [k, [fx + f.dir * j[k][0] * H, fy - j[k][1] * H]])) as Joints;
}
const posed = (f: Fighter) => toWorld(f, local(f));
const standing = (f: Fighter) => toWorld(f, STAND);

// The joints to draw: the ragdoll while limp, easing back to the pose after it, else the pose.
function joints(f: Fighter): Joints {
  if (f.rag) return f.rag.pos;
  const p = posed(f);
  if (!f.steady) return p;
  const k = clamp(f.steady.t / f.steady.s, 0, 1);
  const e = k * k * (3 - 2 * k); // smooth start and end
  const [fx, fy] = feetOf(f);
  return Object.fromEntries(JOINTS.map((n) => [n, lerp([fx + f.steady!.from[n][0], fy + f.steady!.from[n][1]], p[n], e)])) as Joints;
}

// A head and the lines of the body, arms and legs, as an SVG path, in physics units.
export function pose(f: Fighter): { d: string; head: Pt; r: number } {
  const j = joints(f);
  const at = (k: keyof Joints) => `${j[k][0].toFixed(4)} ${j[k][1].toFixed(4)}`;
  const d = `M${at('hip')}L${at('neck')}M${at('neck')}L${at('elbowF')}L${at('handF')}M${at('neck')}L${at('elbowB')}L${at('handB')}` +
    `M${at('hip')}L${at('kneeF')}L${at('footF')}M${at('hip')}L${at('kneeB')}L${at('footB')}`;
  return { d, head: [j.head[0], j.head[1]], r: 0.1 * H };
}
