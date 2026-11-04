// A toy ball to throw around the desk while thinking (PLAN.md, "Toys"). Its physics is physics.ts, shared with the fighters.
// Pure, no DOM: main.tsx draws it and runs the frames, only while something moves.
// Units: the page is 1 high and `aspect` wide. Gravity pulls toward the bottom, your side of the desk.
import { BALL_SPOT, type Card, type Phase } from './gestures.ts';
import { clamp, FLOOR, rectsOf, step, STEP, TAP_MS, thrown, type Body, type Sample } from './physics.ts';

export const R = 0.035; // radius, in page heights
const REST = 0.02; // slower than this, on something, and it's at rest
const GRAB = 1.5; // how far out from the ball a pinch still grabs it, in radii: hands aren't precise

export function createBall() {
  const b: Body = { x: 0, y: 0, vx: 0, vy: 0, r: R, bounce: 0.6, stick: 0.12, roll: 0.35 };
  let out = false;
  let resting = true;
  let held: { id: string; dx: number; dy: number; samples: Sample[] } | undefined;
  let spotTap: { id: string; t: number } | undefined;
  let acc = 0; // steps owed, carried between frames

  const inSpot = (px: number, py: number) => px >= BALL_SPOT.x && px <= BALL_SPOT.x + BALL_SPOT.w && py >= BALL_SPOT.y;

  return {
    get out() {
      return out;
    },
    get x() {
      return b.x;
    },
    get y() {
      return b.y;
    },
    // For the toys sharing the desk with it (toys.ts): its body, and whether a hand has it.
    body: b,
    get held() {
      return !!held;
    },
    // Mouse and tracker pointers, in page coordinates (0–1 across and down). True if the ball took it, so no card does.
    pointer(phase: Phase, id: string, px: number, py: number, t: number, aspect: number): boolean {
      const x = px * aspect;
      const y = py;
      if (phase === 'down') {
        if (out && !held && Math.hypot(x - b.x, y - b.y) <= R * GRAB) {
          held = { id, dx: b.x - x, dy: b.y - y, samples: [{ t, x, y }] };
          b.vx = b.vy = 0;
          resting = false;
          return true;
        }
        if (inSpot(px, py)) {
          spotTap = { id, t };
          return true;
        }
        return false;
      }
      if (held?.id === id) {
        held.samples.push({ t, x, y });
        if (held.samples.length > 64) held.samples.shift();
        b.x = clamp(x + held.dx, R, aspect - R);
        b.y = clamp(y + held.dy, R, FLOOR - R);
        if (phase !== 'move') {
          [b.vx, b.vy] = phase === 'up' ? thrown(held.samples) : [0, 0]; // a lost hand just drops it
          held = undefined;
          acc = 0;
        }
        return true;
      }
      if (spotTap?.id === id) {
        if (phase === 'up' && t - spotTap.t <= TAP_MS && inSpot(px, py)) {
          if (out) {
            out = false;
            held = undefined;
          } else {
            // Out of its spot with a little hop up and to the right: about a sixth of the page high.
            Object.assign(b, { x: (BALL_SPOT.x + BALL_SPOT.w / 2) * aspect, y: FLOOR - R, vx: 0.4, vy: -0.85 });
            out = true;
            resting = false;
            acc = 0;
          }
        }
        if (phase !== 'move') spotTap = undefined;
        return true;
      }
      return false;
    },
    // Something changed under it (a card moved, came, went, it was hit, or the window was resized): check it's still held up.
    wake() {
      if (out && !held) resting = false;
    },
    // Runs the physics for `dt` seconds in fixed steps. Cards are solid; chips in the strip are below the floor.
    // True while it's still moving, so the caller knows to ask for another frame.
    advance(dt: number, cards: Card[], aspect: number): boolean {
      if (!out || held || resting) return false;
      const rects = rectsOf(cards, aspect);
      acc += dt / STEP;
      while (acc >= 1 - 1e-9 && !resting) {
        if (step(b, rects, aspect) && Math.hypot(b.vx, b.vy) < REST) {
          b.vx = b.vy = 0;
          resting = true;
        }
        acc -= 1;
      }
      if (resting) acc = 0;
      return !resting;
    },
  };
}

export type Ball = ReturnType<typeof createBall>;
