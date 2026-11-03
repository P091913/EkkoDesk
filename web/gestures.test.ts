import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGestures, type Card } from './gestures.ts';

const setup = () => {
  const card: Card = { id: 'a', x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
  return { card, pointer: createGestures([card]) };
};
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('drag keeps the grab offset', () => {
  const { card, pointer } = setup();
  pointer('down', 'm1', 0.45, 0.5);
  assert.equal(pointer('move', 'm1', 0.55, 0.6), true);
  near(card.x, 0.5);
  near(card.y, 0.5);
});

test('down off the card grabs nothing', () => {
  const { card, pointer } = setup();
  pointer('down', 'm1', 0.1, 0.1);
  assert.equal(pointer('move', 'm1', 0.5, 0.5), false);
  assert.equal(card.x, 0.4);
});

test('up and cancel release the card', () => {
  for (const end of ['up', 'cancel'] as const) {
    const { card, pointer } = setup();
    pointer('down', 't1', 0.5, 0.5);
    pointer(end, 't1', 0.5, 0.5);
    assert.equal(pointer('move', 't1', 0.9, 0.9), false);
    assert.equal(card.x, 0.4);
  }
});

test('a second pointer on a held card is ignored', () => {
  const { card, pointer } = setup();
  pointer('down', 't1', 0.5, 0.5);
  pointer('down', 't2', 0.45, 0.45);
  assert.equal(pointer('move', 't2', 0.1, 0.1), false);
  assert.equal(card.x, 0.4);
});

test('the card stays on the page', () => {
  const { card, pointer } = setup();
  pointer('down', 'm1', 0.5, 0.5);
  pointer('move', 'm1', 2, -1);
  near(card.x, 0.8);
  near(card.y, 0);
});
