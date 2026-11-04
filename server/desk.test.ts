import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesk, MAX_NOTES, MAX_VIEWERS } from './desk.ts';

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
  assert.deepEqual(desk.widgets().map((w) => w.id), ['chat', 'timer', 'files']);
});

test('notes land in the first free spot along the top, above the strip', () => {
  const desk = createDesk(tempFile(), () => {});
  desk.patch('chat', { docked: true });
  desk.patch('timer', { docked: true });
  desk.patch('files', { docked: true });
  const spots = Array.from({ length: 21 }, (_, i) => {
    desk.addNote(`note ${i}`);
    const n = desk.widgets().at(-1)!;
    return [Number(n.x.toFixed(2)), Number(n.y.toFixed(2)), n.y + n.h <= 0.9];
  });
  assert.deepEqual(spots.slice(0, 6), [[0.02, 0.02, true], [0.2, 0.02, true], [0.38, 0.02, true], [0.56, 0.02, true], [0.74, 0.02, true], [0.02, 0.24, true]]);
  assert.ok(spots.every((s) => s[2]));
  assert.deepEqual(spots[20].slice(0, 2), [0.02, 0.02]); // 20 spots taken: the next goes on top of the first
});

test('the first note skips the default cards', () => {
  const desk = createDesk(tempFile(), () => {});
  desk.addNote('call mom');
  const n = desk.widgets().at(-1)!;
  assert.deepEqual([n.x, n.y, n.kind, n.text], [0.38, 0.02, 'note', 'call mom']);
  assert.ok(n.z > Math.max(...desk.widgets().slice(0, -1).map((w) => w.z)));
});

test('note limits, wording, ids and removal', () => {
  const file = tempFile();
  const desk = createDesk(file, () => {});
  assert.deepEqual(desk.addNote('  call mom  ').body.message, 'Put “call mom” on your desk.');
  assert.equal(desk.addNote('   ').body.error, 'A note needs some text.');
  assert.equal(desk.addNote(42).status, 400);
  assert.equal(desk.addNote('x'.repeat(201)).body.error, 'A note can be at most 200 characters.');
  assert.equal(desk.addNote('x'.repeat(200)).status, 201);
  for (let i = 2; i < MAX_NOTES; i++) desk.addNote(`n${i}`);
  const full = desk.addNote('one too many');
  assert.deepEqual([full.status, full.body.error], [409, 'Your desk already has 30 notes. Take some off first.']);

  const ids = desk.widgets().filter((w) => w.kind === 'note').map((w) => w.id);
  assert.equal(new Set(ids).size, MAX_NOTES); // same millisecond, still unique
  assert.equal(desk.remove(ids[0]).status, 200);
  assert.equal(desk.remove(ids[0]).status, 404);
  assert.equal(desk.remove('timer').status, 404); // only notes and viewers can be removed
  assert.equal(createDesk(file, () => {}).widgets().filter((w) => w.kind === 'note').length, MAX_NOTES - 1);
});

test('timer: start, pause, resume, reset, and it survives a restart', () => {
  const file = tempFile();
  let t = 1_000_000;
  const now = () => t;
  const desk = createDesk(file, () => {}, now);
  const timer = () => desk.widgets().find((w) => w.id === 'timer')!;

  assert.equal(desk.timer({ action: 'start' }).status, 400); // nothing to resume
  for (const minutes of [0, 181, 1.5, '5']) assert.equal(desk.timer({ action: 'start', minutes }).status, 400);
  assert.equal(desk.timer({ action: 'nap' }).status, 400);

  desk.timer({ action: 'start', minutes: 15 });
  assert.equal(timer().endsAt, t + 15 * 60_000);
  t += 60_000;
  desk.timer({ action: 'pause' });
  assert.deepEqual([timer().endsAt, timer().leftMs], [null, 14 * 60_000]);
  t += 3_600_000; // paused time doesn't count
  assert.equal(createDesk(file, () => {}, now).widgets().find((w) => w.id === 'timer')!.leftMs, 14 * 60_000);
  desk.timer({ action: 'start' });
  assert.deepEqual([timer().endsAt, timer().leftMs], [t + 14 * 60_000, null]);
  desk.timer({ action: 'reset' });
  assert.deepEqual([timer().endsAt, timer().leftMs], [null, null]);
});

test('a desk saved before the Files card gets it in a free spot, on top', () => {
  const file = tempFile();
  createDesk(file, () => {}).patch('chat', { z: 7 }); // writes chat, timer and files
  const old = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ widgets: old.widgets.filter((w: { id: string }) => w.id !== 'files') }));
  const files = createDesk(file, () => {}).widgets().find((w) => w.id === 'files')!;
  assert.deepEqual([files.kind, +files.x.toFixed(2), files.y, files.z], ['files', 0.46, 0.02, 8]);
});

test('viewers: open, bring back to the front, at most five, page saved, removed', () => {
  const file = tempFile();
  let t = 1000;
  const desk = createDesk(file, () => {}, () => t);
  const f = (n: number) => ({ id: `${n}`.padStart(16, 'a'), name: `f${n}.pdf`, type: 'application/pdf' });

  const r = desk.showFile(f(1));
  assert.deepEqual([r.status, r.body.message], [200, 'Opened “f1.pdf” on your desk.']);
  const v = desk.widgets().at(-1)!;
  assert.deepEqual([v.id, v.kind, v.file, v.page, v.added, v.x, v.y], ['file-aaaaaaaaaaaaaaa1', 'viewer', f(1).id, 1, 1000, 0.35, 0.04]);

  for (let n = 2; n <= MAX_VIEWERS; n++) desk.showFile(f(n));
  const full = desk.showFile(f(9));
  assert.deepEqual([full.status, full.body.error], [409, 'Your desk already has 5 files open. Close one first.']);

  // Already open: no sixth card, but it comes to the front, out of the strip, highlighted again.
  desk.patch(v.id, { docked: true, x: 0.1, y: 0.925, page: 3 });
  t = 2000;
  assert.equal(desk.showFile(f(1)).status, 200);
  const again = desk.widgets().find((w) => w.id === v.id)!;
  assert.deepEqual([again.docked, again.x, again.y, again.added, again.page], [false, 0.35, 0.04, 2000, 3]);
  assert.equal(again.z, Math.max(...desk.widgets().map((w) => w.z)));
  assert.equal(desk.patch(v.id, { page: 0 }).status, 400);

  assert.equal(desk.remove(v.id).status, 200);
  assert.equal(createDesk(file, () => {}).widgets().filter((w) => w.kind === 'viewer').length, MAX_VIEWERS - 1);
});
