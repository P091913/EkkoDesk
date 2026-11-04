import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFighters, FR, pose } from './fighters.ts';
import { FIGHT_SPOT, STRIP, type Card } from './gestures.ts';
import { stretch } from './ragdoll.ts';
import { createToys } from './toys.ts';

const A = 16 / 9;
const SX = FIGHT_SPOT.x + FIGHT_SPOT.w / 2;
const card = (x: number, y: number, w: number, h: number): Card => ({ id: 'c', kind: 'note', x, y, w, h, z: 1, docked: false });

function outFighters(seed = 7) {
  const f = createFighters(seed);
  f.pointer('down', 'm1', SX, 0.95, 0, A);
  f.pointer('up', 'm1', SX, 0.95, 100, A);
  return f;
}
// Runs up to `s` seconds at 60 frames a second, calling `each` after every frame; stops early when nothing's active.
function run(f: ReturnType<typeof createFighters>, s: number, cards: Card[] = [], each = () => {}) {
  let frames = 0;
  while (frames < s * 60 && f.advance(1 / 60, cards, A)) {
    frames++;
    each();
  }
  return frames / 60;
}

test('a tap on the fight spot brings them out facing each other on the floor, and a round starts', () => {
  const f = outFighters();
  assert.equal(f.out, true);
  assert.equal(f.round, 'fighting');
  const [a, b] = f.list;
  assert.deepEqual([a.dir, b.dir], [1, -1]);
  assert.ok(a.body.x < b.body.x);
  for (const x of f.list) assert.equal(x.body.y, STRIP - FR);
  f.pointer('down', 'm1', SX, 0.95, 200, A);
  f.pointer('up', 'm1', SX, 0.95, 300, A); // a tap mid-round changes nothing
  assert.equal(f.round, 'fighting');
});

test('they close in and hit each other, and the first down three times loses; then the frames stop', () => {
  const f = outFighters();
  let hits = 0;
  let wasHurt = false;
  const seconds = run(f, 120, [], () => {
    const hurt = f.list.some((x) => x.state === 'hurt' || x.state === 'down');
    if (hurt && !wasHurt) hits++;
    wasHurt = hurt;
  });
  assert.ok(hits >= 3, `${hits} hits`);
  assert.equal(f.round, 'over');
  assert.ok(seconds <= 62, `took ${seconds} s`); // a round lasts at most 60 s, then they settle
  assert.equal(f.active, false);
  assert.equal(f.advance(1 / 60, [], A), false);
  if (f.winner !== null) {
    assert.equal(f.list[f.winner].state, 'win');
    assert.equal(f.list[1 - f.winner].downs, 3);
    assert.equal(f.list[1 - f.winner].state, 'down'); // knocked out stays down
  }
  f.pointer('down', 'm1', SX, 0.95, 1000, A);
  f.pointer('up', 'm1', SX, 0.95, 1100, A); // a tap starts the next round
  assert.equal(f.round, 'fighting');
  assert.ok(f.list.every((x) => x.downs === 0));
});

test('a knock sends a figure into a card, and it bounces off', () => {
  const f = outFighters();
  const b = f.list[1];
  const wall = card(b.body.x / A + 0.06, 0.5, 0.1, 0.38); // a card standing on the floor just to its right
  f.knock(1, 2.5, -0.3);
  let maxX = 0;
  let back = false;
  run(f, 1, [wall], () => {
    maxX = Math.max(maxX, b.body.x);
    if (b.body.vx < 0) back = true;
  });
  assert.ok(maxX <= wall.x * A - FR + 1e-9, 'never inside the card');
  assert.ok(back, 'bounced back off it');
});

test('a figure can be grabbed and thrown; holding the spot puts them away', () => {
  const f = outFighters();
  const a = f.list[0];
  const [px, py] = [a.body.x / A, a.body.y];
  assert.equal(f.pointer('down', 't1', px, py, 0, A), true);
  assert.equal(a.state, 'held');
  for (let i = 1; i <= 5; i++) f.pointer('move', 't1', px + 0.04 * i, py - 0.05 * i, 20 * i, A);
  f.pointer('up', 't1', px + 0.2, py - 0.25, 100, A);
  assert.equal(a.state, 'hurt');
  assert.ok(a.body.vx > 1 && a.body.vy < -1, 'thrown up and right');

  f.pointer('down', 'm1', SX, 0.95, 1000, A);
  f.pointer('up', 'm1', SX, 0.95, 1400, A); // between a tap and a hold: nothing
  assert.equal(f.out, true);
  f.pointer('down', 'm1', SX, 0.95, 2000, A);
  f.pointer('up', 'm1', SX, 0.95, 2700, A);
  assert.equal(f.out, false);
  assert.equal(f.advance(1 / 60, [], A), false);
});

test('the same seed fights the same fight at 30 and at 120 frames a second', () => {
  const at = (fps: number) => {
    const f = outFighters(42);
    const seen: number[] = [];
    for (let i = 0; i < fps * 8; i++) {
      f.advance(1 / fps, [], A);
      if ((i + 1) % (fps / 30) === 0) seen.push(...f.list.flatMap((x) => [x.body.x, x.body.y]));
    }
    return seen;
  };
  const slow = at(30);
  const fast = at(120);
  assert.equal(slow.length, fast.length);
  slow.forEach((v, i) => assert.ok(Math.abs(v - fast[i]) < 1e-9, `${v} != ${fast[i]} at ${i}`));
});

test('a knocked figure goes limp in one piece, never into a card or the floor, and gets back up to its pose', () => {
  const f = outFighters();
  const b = f.list[1];
  const shelf = card(b.body.x / A + 0.04, 0.6, 0.12, 0.28);
  f.knock(1, 2.6, -0.9); // hard enough to floor it, into the card
  assert.equal(b.state, 'down');
  let worst = 0;
  let wasLimp = false;
  let up = false;
  run(f, 4, [shelf], () => {
    if (b.rag) {
      wasLimp = true;
      worst = Math.max(worst, stretch(b.rag));
      for (const [x, y] of Object.values(b.rag.pos)) {
        assert.ok(y <= STRIP + 1e-9, 'not through the floor');
        const r = { x: shelf.x * A, y: shelf.y, w: shelf.w * A, h: shelf.h };
        assert.ok(!(x > r.x + 1e-9 && x < r.x + r.w - 1e-9 && y > r.y + 1e-9 && y < r.y + r.h - 1e-9), 'not inside the card');
      }
    }
    up ||= b.state === 'up';
  });
  assert.ok(wasLimp && up, 'went limp, then got up');
  assert.ok(worst < 0.4, `bones stretched ${Math.round(worst * 100)}%`);
});

test('they climb a card after each other, and only one with room to stand on top', () => {
  const f = outFighters(5);
  const [a, b] = f.list;
  const box = card(0.6, 0.62, 0.15, 0.28); // a card standing on the floor, its top 0.62
  Object.assign(b.body, { x: (box.x + box.w / 2) * A, y: box.y - FR }); // the other one stands on it...
  b.camp = 10; // ...holding it, as if it had just climbed up
  let climbed = false;
  run(f, 6, [box], () => {
    climbed ||= a.state === 'climb';
  });
  assert.ok(climbed, 'climbed up after it');
  assert.ok(a.body.y < box.y || a.state === 'hurt' || a.state === 'down', 'got up there, and the fight goes on on top');

  const g = outFighters(5);
  const roof = card(0.6, 0.45, 0.15, 0.1); // right over the top of the first one: no room to stand
  Object.assign(g.list[1].body, { x: (box.x + box.w / 2) * A - 0.02, y: 0.3 });
  let tried = false;
  run(g, 4, [box, roof], () => {
    tried ||= g.list[0].state === 'climb';
  });
  assert.equal(tried, false, 'no room on top: no climb');
});

test('the ball hits a figure: it flinches and is pushed back, and the ball bounces off', () => {
  const toys = createToys(3);
  toys.pointer('down', 'm1', SX, 0.95, 0, A);
  toys.pointer('up', 'm1', SX, 0.95, 100, A);
  const target = toys.fighters.list[0];
  toys.pointer('down', 'm2', 0.04, 0.95, 0, A); // the ball's spot
  toys.pointer('up', 'm2', 0.04, 0.95, 100, A);
  Object.assign(toys.ball.body, { x: target.body.x - 0.25, y: target.body.y, vx: 5, vy: -0.3 });
  toys.ball.wake();
  let flinched = false;
  let pushed = 0;
  for (let i = 0; i < 30; i++) {
    toys.advance(1 / 120, [], A);
    flinched ||= target.state === 'hurt' || target.state === 'down';
    pushed = Math.max(pushed, target.body.vx);
  }
  assert.ok(flinched, 'flinched');
  assert.ok(pushed > 0.6, `pushed at ${pushed}`);
  assert.ok(toys.ball.body.vx < 2, 'the ball lost its speed into the figure');
});

test('a pose is a head and a path of joints, standing on the floor', () => {
  const f = outFighters();
  const p = pose(f.list[0]);
  assert.match(p.d, /^M[\d. ]+L[\d. ]+(M[\d. ]+(L[\d. ]+)+)+$/);
  const ys = [...p.d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => Number(m[2]));
  assert.ok(Math.abs(Math.max(...ys) - STRIP) < 1e-3, 'feet on the floor');
  assert.ok(p.head[1] < STRIP - 0.1, 'head up');
});
