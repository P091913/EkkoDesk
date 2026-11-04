// The toys on the desk (PLAN.md, "Toys"): the ball and the two fighters, run together in the same fixed steps so the
// ball can hit them. Pure, no DOM: main.tsx draws them and asks for frames only while `advance` says something moves.
import { createBall } from './ball.ts';
import { createFighters } from './fighters.ts';
import type { Card, Phase } from './gestures.ts';
import { collide, STEP } from './physics.ts';

const BALL_MASS = 1;
const FIGHTER_MASS = 3; // a ball knocks a figure back, but less than it bounces off
const BALL_BOUNCE = 0.6;

export function createToys(seed?: number) {
  const ball = createBall();
  const fighters = createFighters(seed);
  let acc = 0;
  let ballMoving = false;

  // The ball against each figure it touches: they bounce apart by their masses, and the figure takes the knock.
  function hits() {
    if (!ball.out || ball.held || !fighters.out) return;
    fighters.list.forEach((f, i) => {
      if (f.state === 'held') return;
      const gained = collide(ball.body, BALL_MASS, f.body, FIGHTER_MASS, BALL_BOUNCE);
      if (gained === null) return;
      ball.wake();
      fighters.wake();
      fighters.react(i, gained);
    });
  }

  return {
    ball,
    fighters,
    // The ball first (it's the smaller target), then the figures, then their spots.
    pointer(phase: Phase, id: string, px: number, py: number, t: number, aspect: number): boolean {
      return ball.pointer(phase, id, px, py, t, aspect) || fighters.pointer(phase, id, px, py, t, aspect);
    },
    // Something changed under them: a card moved, came or went, or the window was resized.
    wake() {
      ball.wake();
      fighters.wake();
      ballMoving = ball.out;
    },
    // Runs `dt` seconds in fixed steps, everything together. True while anything still moves.
    advance(dt: number, cards: Card[], aspect: number): boolean {
      acc += dt / STEP;
      while (acc >= 1 - 1e-9) {
        acc -= 1;
        ballMoving = ball.advance(STEP, cards, aspect); // exactly one step each
        fighters.advance(STEP, cards, aspect);
        hits();
        if (!ballMoving && !fighters.active) {
          acc = 0;
          break;
        }
      }
      return ballMoving || fighters.active;
    },
  };
}

export type Toys = ReturnType<typeof createToys>;
