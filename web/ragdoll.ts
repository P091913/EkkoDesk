// A fighter gone limp (PLAN.md, "Toys"): its joints are loose points joined by bones of fixed length, swinging and
// flopping under gravity, with the hip pulled along by the fighter's body circle. Verlet steps, the toys' fixed STEP.
import { FLOOR, G, STEP, type Rect } from './physics.ts';

export type Pt = [number, number];
export const JOINTS = ['head', 'neck', 'hip', 'elbowF', 'handF', 'elbowB', 'handB', 'kneeF', 'footF', 'kneeB', 'footB'] as const;
export type Joint = (typeof JOINTS)[number];
export type Joints = Record<Joint, Pt>;
// head–hip keeps the torso and neck in one piece; everything else bends.
const BONES: [Joint, Joint][] = [
  ['head', 'neck'], ['neck', 'hip'], ['head', 'hip'],
  ['neck', 'elbowF'], ['elbowF', 'handF'], ['neck', 'elbowB'], ['elbowB', 'handB'],
  ['hip', 'kneeF'], ['kneeF', 'footF'], ['hip', 'kneeB'], ['kneeB', 'footB'],
];
const ITERATIONS = 8;
const DAMP = 0.995; // a little air, so it settles
const GRIP = 0.5; // a joint on the floor or a card keeps half its sideways speed

export type Rag = { pos: Joints; prev: Joints; len: number[] };

const copy = (j: Joints) => Object.fromEntries(JOINTS.map((k) => [k, [j[k][0], j[k][1]]])) as Joints;

// From where the joints are now, moving at (vx, vy). Bone lengths come from `rest`, the standing pose, so a limp
// figure keeps its proportions even when it went limp mid-kick.
export function createRag(at: Joints, vx: number, vy: number, rest: Joints): Rag {
  const pos = copy(at);
  const prev = copy(at);
  for (const k of JOINTS) {
    prev[k][0] -= vx * STEP;
    prev[k][1] -= vy * STEP;
  }
  const len = BONES.map(([a, b]) => Math.hypot(rest[a][0] - rest[b][0], rest[a][1] - rest[b][1]));
  return { pos, prev, len };
}

// One step: each joint carries on, falls, then bones pull back to length, the hip goes toward `anchor`, and nothing
// stays inside a card or below the floor.
export function stepRag(r: Rag, anchor: Pt, rects: Rect[], aspect: number) {
  for (const k of JOINTS) {
    const p = r.pos[k];
    const q = r.prev[k];
    const vx = (p[0] - q[0]) * DAMP;
    const vy = (p[1] - q[1]) * DAMP;
    q[0] = p[0];
    q[1] = p[1];
    p[0] += vx;
    p[1] += vy + G * STEP * STEP;
  }
  const touching = new Set<Joint>();
  for (let n = 0; n < ITERATIONS; n++) {
    BONES.forEach(([a, b], i) => {
      const pa = r.pos[a];
      const pb = r.pos[b];
      const dx = pb[0] - pa[0];
      const dy = pb[1] - pa[1];
      const d = Math.hypot(dx, dy) || 1e-9;
      const k = (d - r.len[i]) / d / 2;
      pa[0] += dx * k;
      pa[1] += dy * k;
      pb[0] -= dx * k;
      pb[1] -= dy * k;
    });
    const hip = r.pos.hip;
    hip[0] += (anchor[0] - hip[0]) * 0.5;
    hip[1] += (anchor[1] - hip[1]) * 0.5;
    for (const k of JOINTS) if (touch(r.pos[k], rects, aspect)) touching.add(k);
  }
  // Friction once per step, after the bones are sorted out: applied every pass, it held limbs so hard they stretched.
  for (const k of touching) {
    const p = r.pos[k];
    const q = r.prev[k];
    q[0] = p[0] - (p[0] - q[0]) * GRIP;
    q[1] = p[1] - (p[1] - q[1]) * GRIP;
  }
}

// A joint against the page or a card is pushed out the shortest way. True if it touched.
function touch(p: Pt, rects: Rect[], aspect: number): boolean {
  const x0 = p[0];
  const y0 = p[1];
  p[0] = Math.min(Math.max(p[0], 0), aspect);
  p[1] = Math.min(Math.max(p[1], 0), FLOOR);
  let hit = p[0] !== x0 || p[1] !== y0;
  for (const c of rects) {
    if (p[0] <= c.x || p[0] >= c.x + c.w || p[1] <= c.y || p[1] >= c.y + c.h) continue;
    const ways: [number, number, number][] = [
      [p[0] - c.x, c.x, NaN],
      [c.x + c.w - p[0], c.x + c.w, NaN],
      [p[1] - c.y, NaN, c.y],
      [c.y + c.h - p[1], NaN, c.y + c.h],
    ];
    const [, x, y] = ways.reduce((m, w) => (w[0] < m[0] ? w : m));
    if (Number.isNaN(y)) p[0] = x;
    else p[1] = y;
    hit = true;
  }
  return hit;
}

// How far each bone is from its length, as a share of it: for the tests.
export function stretch(r: Rag): number {
  return Math.max(...BONES.map(([a, b], i) => Math.abs(Math.hypot(r.pos[a][0] - r.pos[b][0], r.pos[a][1] - r.pos[b][1]) - r.len[i]) / r.len[i]));
}
