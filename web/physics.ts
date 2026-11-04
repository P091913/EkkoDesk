// The toys' shared physics (PLAN.md, "Toys"): circles that fall toward the bottom of the page, bounce off its edges and off
// cards, roll to a stop and rest. Units: the page is 1 high and `aspect` wide, so circles stay round. Pure, no DOM.
import { STRIP, type Card } from './gestures.ts';

export const FLOOR = STRIP; // things land on the top of the dock strip, never on the chips or the trash
export const G = 2.2; // gravity, page heights per s²
export const STEP = 1 / 120; // fixed step, so a slow frame rate gives the same path
const THROW_MS = 100; // a throw's speed comes from the hand's last 100 ms
const MAX_V = 8; // the fastest throw, page heights per s

export type Rect = { x: number; y: number; w: number; h: number; id?: string }; // id: the card's, so a climber can follow it
export type Body = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  bounce: number; // share of the speed into a surface that comes back out
  stick: number; // a bounce slower than this just stops, so nothing hops forever
  roll: number; // friction, page heights per s²
};
export type Sample = { t: number; x: number; y: number };

export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// Cards that are out, in physics units. Chips sit in the strip, below the floor.
export const rectsOf = (cards: Card[], aspect: number): Rect[] =>
  cards.filter((c) => !c.docked).map((c) => ({ x: c.x * aspect, y: c.y, w: c.w * aspect, h: c.h, id: c.id }));

// One fixed step: gravity, friction, move, then out of any card and back inside the page.
// Returns true if something underneath held it up, so the caller can tell standing or resting from flying.
export function step(b: Body, rects: Rect[], aspect: number): boolean {
  let below = false;
  const hit = (nx: number, ny: number) => {
    const vn = b.vx * nx + b.vy * ny;
    if (ny < -0.7) below = true;
    if (vn >= 0) return; // already moving away
    const back = -vn * b.bounce;
    const out = back < b.stick ? 0 : back;
    b.vx += (out - vn) * nx;
    b.vy += (out - vn) * ny;
  };

  b.vy += G * STEP;
  const s = Math.hypot(b.vx, b.vy);
  if (s > 0) {
    const k = Math.max(0, s - b.roll * STEP) / s;
    b.vx *= k;
    b.vy *= k;
  }
  b.x += b.vx * STEP;
  b.y += b.vy * STEP;

  for (const r of rects) {
    // The nearest point of the card to the centre; inside the card, out by the shortest way.
    const cx = clamp(b.x, r.x, r.x + r.w);
    const cy = clamp(b.y, r.y, r.y + r.h);
    const dx = b.x - cx;
    const dy = b.y - cy;
    const d = Math.hypot(dx, dy);
    if (d >= b.r) continue;
    if (d > 1e-9) {
      b.x = cx + (dx / d) * b.r;
      b.y = cy + (dy / d) * b.r;
      hit(dx / d, dy / d);
    } else {
      const ways: [number, number, number][] = [
        [b.x - r.x, -1, 0],
        [r.x + r.w - b.x, 1, 0],
        [b.y - r.y, 0, -1],
        [r.y + r.h - b.y, 0, 1],
      ];
      const [, nx, ny] = ways.reduce((m, w) => (w[0] < m[0] ? w : m));
      if (nx) b.x = nx < 0 ? r.x - b.r : r.x + r.w + b.r;
      else b.y = ny < 0 ? r.y - b.r : r.y + r.h + b.r;
      hit(nx, ny);
    }
  }
  // The page's edges last, so a card can never push it off the desk.
  if (b.x < b.r) {
    b.x = b.r;
    hit(1, 0);
  }
  if (b.x > aspect - b.r) {
    b.x = aspect - b.r;
    hit(-1, 0);
  }
  if (b.y < b.r) {
    b.y = b.r;
    hit(0, 1);
  }
  if (b.y > FLOOR - b.r) {
    b.y = FLOOR - b.r;
    hit(0, -1);
  }
  return below;
}

// Two circles that overlap are pushed apart, the lighter one further, and bounce off each other by their masses.
// Returns null if they don't touch, else how much speed `b` gained, so a fighter knows how hard it was hit.
export function collide(a: Body, ma: number, b: Body, mb: number, bounce = 0.5): number | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d >= a.r + b.r || d < 1e-9) return null;
  const nx = dx / d;
  const ny = dy / d;
  const over = a.r + b.r - d;
  const ia = 1 / ma;
  const ib = 1 / mb;
  a.x -= nx * over * (ia / (ia + ib));
  a.y -= ny * over * (ia / (ia + ib));
  b.x += nx * over * (ib / (ia + ib));
  b.y += ny * over * (ib / (ia + ib));
  const closing = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (closing >= 0) return 0;
  const j = (-(1 + bounce) * closing) / (ia + ib);
  a.vx -= j * ia * nx;
  a.vy -= j * ia * ny;
  b.vx += j * ib * nx;
  b.vy += j * ib * ny;
  return j * ib;
}

// A throw: from the oldest sample in the last THROW_MS to the release. A hand held still first just drops it.
export function thrown(s: Sample[]): [number, number] {
  const end = s[s.length - 1];
  const start = s.find((p) => end.t - p.t <= THROW_MS) ?? end;
  const dt = (end.t - start.t) / 1000;
  if (dt < 0.01) return [0, 0];
  const vx = (end.x - start.x) / dt;
  const vy = (end.y - start.y) / dt;
  const k = Math.min(1, MAX_V / (Math.hypot(vx, vy) || 1));
  return [vx * k, vy * k];
}

// A quick release on a toy's spot in the strip is a tap, as on a card (gestures.ts).
export const TAP_MS = 350;
