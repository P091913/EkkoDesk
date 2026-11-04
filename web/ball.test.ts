import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBall, R } from './ball.ts';
import { BALL_SPOT, STRIP, type Card } from './gestures.ts';

const A = 16 / 9; // the page's aspect: positions in the ball's units are page heights
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const card = (x: number, y: number, w: number, h: number, docked = false): Card => ({ id: 'c', kind: 'note', x, y, w, h, z: 1, docked });

// Out of its spot by a tap, as the page does it.
function outBall() {
  const ball = createBall();
  const sx = BALL_SPOT.w / 2;
  assert.equal(ball.pointer('down', 'm1', sx, 0.95, 0, A), true);
  ball.pointer('up', 'm1', sx, 0.95, 100, A);
  return ball;
}
// Grab it where it is, move it to (px, py) over `ms`, let go after `holdMs` more.
function throwIt(ball: ReturnType<typeof createBall>, px: number, py: number, ms = 100, holdMs = 0) {
  const [x0, y0] = [ball.x / A, ball.y];
  ball.pointer('down', 't1', x0, y0, 1000, A);
  for (let i = 1; i <= 5; i++) ball.pointer('move', 't1', x0 + ((px - x0) * i) / 5, y0 + ((py - y0) * i) / 5, 1000 + (ms * i) / 5, A);
  ball.pointer('up', 't1', px, py, 1000 + ms + holdMs, A);
}
// Frames until it rests (or 30 s), and the highest point after each floor bounce.
function settle(ball: ReturnType<typeof createBall>, cards: Card[] = [], fps = 60) {
  let frames = 0;
  while (ball.advance(1 / fps, cards, A) && frames < fps * 30) frames++;
  return frames / fps;
}

test('a tap on its spot brings it out with a hop, and another puts it away', () => {
  const ball = outBall();
  assert.equal(ball.out, true);
  assert.equal(ball.advance(1 / 60, [], A), true); // moving
  assert.ok(ball.y < STRIP - R); // up off the floor
  assert.equal(ball.pointer('down', 'm2', 0.5, 0.95, 0, A), false); // the rest of the strip is the cards'
  ball.pointer('down', 'm1', 0.01, 0.95, 200, A);
  ball.pointer('up', 'm1', 0.01, 0.95, 700, A); // too slow for a tap
  assert.equal(ball.out, true);
  ball.pointer('down', 'm1', 0.01, 0.95, 800, A);
  ball.pointer('up', 'm1', 0.01, 0.95, 900, A);
  assert.equal(ball.out, false);
  assert.equal(ball.advance(1 / 60, [], A), false);
});

test('the throw takes its speed from the last 100 ms; a hand held still just drops it', () => {
  const ball = outBall();
  settle(ball);
  throwIt(ball, 0.5, 0.6, 100, 300); // put in the middle first
  settle(ball);
  throwIt(ball, 0.2, 0.3); // 0.3 page widths left and up, in 100 ms: fast
  const x0 = ball.x;
  ball.advance(1 / 120, [], A);
  assert.ok(x0 - ball.x > 0.02, 'flies on left');

  settle(ball);
  throwIt(ball, 0.6, 0.5, 100, 300); // a move, then held still for 300 ms before letting go
  const y1 = ball.y;
  ball.advance(1 / 120, [], A);
  near(ball.x, 0.6 * A, 1e-9); // stays where the hand left it, not flying sideways
  assert.ok(ball.y > y1, 'falls');
});

test('each bounce loses energy, and it comes to rest on the floor, then stops asking for frames', () => {
  const ball = outBall();
  settle(ball);
  throwIt(ball, 0.5, 0.05, 100, 300); // carried to the top and dropped
  const tops: number[] = []; // the highest point of each bounce (smallest y: y runs down the page)
  let rising = false;
  let prev = ball.y;
  for (let i = 0; i < 60 * 30 && ball.advance(1 / 60, [], A); i++) {
    if (!rising && ball.y < prev) rising = true; // just bounced
    else if (rising && ball.y > prev) {
      tops.push(prev);
      rising = false;
    }
    prev = ball.y;
  }
  assert.ok(tops.length >= 2, `bounced ${tops.length} times`);
  for (let i = 1; i < tops.length; i++) assert.ok(tops[i] > tops[i - 1], 'each bounce lower than the last');
  near(ball.y, STRIP - R);
  assert.equal(ball.advance(1 / 60, [], A), false);
});

test('cards are solid: it lands on one and rests there, and falls when the card goes', () => {
  const shelf = card(0.4, 0.5, 0.2, 0.2);
  const ball = outBall();
  settle(ball);
  throwIt(ball, 0.5, 0.2, 100, 300); // dropped above the card
  settle(ball, [shelf]);
  near(ball.y, 0.5 - R, 1e-3);
  assert.ok(settle(ball, [shelf]) === 0, 'still at rest');
  ball.wake(); // the card was dragged away
  assert.ok(settle(ball, []) > 0);
  near(ball.y, STRIP - R);
  assert.equal(ball.advance(1 / 60, [card(0, 0.89, 1, 0.11, true)], A), false); // chips in the strip aren't in the way
});

test('a wall bounces it back with less speed', () => {
  const ball = outBall();
  settle(ball);
  throwIt(ball, 0.95, ball.y, 50); // hard to the right along the floor
  let maxX = 0;
  for (let i = 0; i < 600 && ball.advance(1 / 120, [], A); i++) maxX = Math.max(maxX, ball.x);
  near(maxX, A - R, 1e-9);
  assert.ok(ball.x < A - R - 0.05, 'came back off the wall');
});

test('the path is the same at 30 and at 120 frames a second', () => {
  const run = (fps: number) => {
    const ball = outBall();
    const xs: number[] = [];
    for (let i = 0; i < fps * 2; i++) {
      ball.advance(1 / fps, [card(0.3, 0.6, 0.2, 0.1)], A);
      if ((i + 1) % (fps / 30) === 0) xs.push(ball.x, ball.y);
    }
    return xs;
  };
  const slow = run(30);
  const fast = run(120);
  assert.equal(slow.length, fast.length);
  slow.forEach((v, i) => near(v, fast[i], 1e-9));
});
