import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesk } from './desk.ts';

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'desk-')), 'data', 'desk.json');

test('a change is saved and survives a restart', () => {
  const file = tempFile();
  let pushed = 0;
  const desk = createDesk(file, () => pushed++);
  assert.deepEqual(desk.patch('timer', { x: 0.3, y: 0.4, w: 0.25, h: 0.15, z: 7, docked: true }), { status: 200, body: { ok: true } });
  assert.equal(pushed, 1);
  assert.equal(existsSync(`${file}.tmp`), false);

  const timer = createDesk(file, () => {}).widgets().find((w) => w.id === 'timer');
  assert.deepEqual(timer, { id: 'timer', kind: 'timer', x: 0.3, y: 0.4, w: 0.25, h: 0.15, z: 7, docked: true });
});

test('bad changes are refused and nothing is saved', () => {
  const file = tempFile();
  const desk = createDesk(file, () => assert.fail('pushed a refused change'));
  assert.equal(desk.patch('nope', { x: 0.5 }).status, 404);
  for (const body of [null, [], 'x', { x: 1.5 }, { x: '0.5' }, { w: 0 }, { z: 1.5 }, { z: -1 }, { docked: 'yes' }, { id: 'chat' }]) {
    assert.equal(desk.patch('timer', body).status, 400, JSON.stringify(body));
  }
  assert.equal(existsSync(file), false);
});

test('an unreadable file is kept aside, not overwritten', () => {
  const file = tempFile();
  createDesk(file, () => {}).patch('chat', { z: 5 }); // creates the folder
  writeFileSync(file, '{"widgets": [trunc');
  const desk = createDesk(file, () => {});
  assert.equal(readFileSync(`${file}.bad`, 'utf8'), '{"widgets": [trunc');
  assert.deepEqual(desk.widgets().map((w) => w.id), ['chat', 'timer']);
});
