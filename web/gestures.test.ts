import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHIP, createGestures, type Card } from './gestures.ts';

const card = (id: string, x: number, y: number, z = 1): Card => ({ id, kind: id, x, y, w: 0.2, h: 0.2, z, docked: false });
const setup = (...extra: Card[]) => {
  const a = card('a', 0.4, 0.4);
  const cards = [a, ...extra];
  return { a, ...createGestures(() => cards) };
};
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('drag keeps the grab offset and saves on release', () => {
  const { a, pointer } = setup();
  pointer('down', 'm1', 0.45, 0.5, 0);
  assert.equal(pointer('move', 'm1', 0.55, 0.6, 100).redraw, true);
  near(a.x, 0.5);
  near(a.y, 0.5);
  const r = pointer('up', 'm1', 0.55, 0.6, 500);
  assert.equal(r.save, a);
  assert.equal(r.tap, undefined);
});

test('down off a card grabs nothing', () => {
  const { a, pointer } = setup();
  assert.equal(pointer('down', 'm1', 0.1, 0.1, 0).redraw, false);
  assert.equal(pointer('move', 'm1', 0.5, 0.5, 10).redraw, false);
  assert.equal(a.x, 0.4);
});

test('a quick still release is a tap; slow, moved or cancelled is not', () => {
  const { a, pointer } = setup();
  pointer('down', 't1', 0.5, 0.5, 0);
  pointer('move', 't1', 0.505, 0.5, 100);
  assert.equal(pointer('up', 't1', 0.505, 0.5, 300).tap, a);

  pointer('down', 't2', 0.5, 0.5, 1000);
  assert.equal(pointer('up', 't2', 0.5, 0.5, 1400).tap, undefined);

  pointer('down', 't3', 0.5, 0.5, 2000);
  pointer('move', 't3', 0.52, 0.5, 2100);
  pointer('move', 't3', 0.5, 0.5, 2150); // back to the start still counts as moved
  assert.equal(pointer('up', 't3', 0.5, 0.5, 2200).tap, undefined);

  pointer('down', 't4', 0.5, 0.5, 3000);
  assert.equal(pointer('cancel', 't4', 0.5, 0.5, 3100).tap, undefined);
});

test('the touched card goes on top', () => {
  const { a, pointer } = setup(card('b', 0.5, 0.5, 2));
  pointer('down', 'm1', 0.45, 0.45, 0); // only on a
  assert.equal(a.z, 3);
  pointer('up', 'm1', 0.45, 0.45, 50);
  pointer('down', 'm1', 0.55, 0.55, 100); // on both: a is on top now, so a is grabbed
  pointer('move', 'm1', 0.65, 0.55, 150);
  near(a.x, 0.5);
});

test('two pointers resize about the centre, then the last one drags', () => {
  const { a, pointer } = setup();
  pointer('down', 't1', 0.45, 0.5, 0);
  pointer('down', 't2', 0.55, 0.5, 10);
  pointer('move', 't2', 0.65, 0.5, 20); // distance 0.1 → 0.2
  near(a.w, 0.4);
  near(a.h, 0.4);
  near(a.x, 0.3); // centre stays at 0.5
  near(a.y, 0.3);
  assert.equal(pointer('up', 't2', 0.65, 0.5, 30).save, undefined); // saved when the last pointer lets go
  pointer('move', 't1', 0.5, 0.5, 40);
  near(a.x, 0.35);
  const r = pointer('up', 't1', 0.5, 0.5, 50);
  assert.equal(r.tap, undefined);
  assert.equal(r.save, a);
});

test('resize stays within limits', () => {
  const { a, pointer } = setup();
  pointer('down', 't1', 0.45, 0.5, 0);
  pointer('down', 't2', 0.55, 0.5, 10);
  pointer('move', 't2', 0.451, 0.5, 20);
  near(a.w, 0.05);
  pointer('move', 't2', 5, 0.5, 30);
  near(a.w, 1);
});

test('releasing a drag in the strip docks; dragging the chip out restores it', () => {
  const { a, pointer } = setup();
  pointer('down', 'm1', 0.5, 0.5, 0);
  pointer('move', 'm1', 0.5, 0.95, 100);
  pointer('up', 'm1', 0.5, 0.95, 200);
  assert.equal(a.docked, true);
  near(a.y, CHIP.y);
  near(a.w, 0.2); // kept for later

  pointer('down', 'm1', a.x + 0.01, CHIP.y + 0.01, 300);
  pointer('move', 'm1', 0.3, 0.3, 400);
  pointer('up', 'm1', 0.3, 0.3, 500);
  assert.equal(a.docked, false);
  near(a.w, 0.2);
});

test('a chip dropped back in the strip snaps into line; a tap there does not dock', () => {
  const { a, pointer } = setup();
  a.y = 0.75; // card bottom reaches into the strip
  pointer('down', 'm1', 0.5, 0.93, 0);
  assert.equal(pointer('up', 'm1', 0.5, 0.93, 100).tap, a);
  assert.equal(a.docked, false);

  a.docked = true;
  a.y = CHIP.y;
  pointer('down', 'm1', a.x + 0.01, CHIP.y + 0.01, 200);
  pointer('move', 'm1', a.x + 0.05, 0.96, 300);
  pointer('up', 'm1', a.x + 0.05, 0.96, 400);
  assert.equal(a.docked, true);
  near(a.y, CHIP.y);
});

test('the wheel scales the card under it', () => {
  const { a, wheel } = setup();
  assert.equal(wheel(0.5, 0.5, 1.5), a);
  near(a.w, 0.3);
  near(a.x, 0.35);
  assert.equal(wheel(0.1, 0.1, 1.5), undefined);
});

test('a card dropped from the state mid-drag releases the grab', () => {
  let cards = [card('a', 0.4, 0.4)];
  const { pointer } = createGestures(() => cards);
  pointer('down', 't1', 0.5, 0.5, 0);
  cards = [];
  assert.equal(pointer('move', 't1', 0.6, 0.6, 10).redraw, false);
});

test('held is true only while a pointer is on the card', () => {
  const { held, pointer } = setup();
  assert.equal(held('a'), false);
  pointer('down', 't1', 0.5, 0.5, 0);
  assert.equal(held('a'), true);
  pointer('up', 't1', 0.5, 0.5, 500);
  assert.equal(held('a'), false);
});
