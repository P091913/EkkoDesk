import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChat, turnsOf, type TraceEvent } from './ekko.ts';
import type { Result } from './upstream.ts';

const ev = (seq: number, requestId: string, step: string, more: Partial<TraceEvent> = {}): TraceEvent =>
  ({ seq, ts: '2026-11-03T12:00:00Z', requestId, channel: 'telegram', step, ...more });
const NOW = Date.parse('2026-11-03T12:01:00Z');

test('turnsOf: one turn per message, newest first, long text cut short', () => {
  const turns = turnsOf(
    [
      ev(1, 'a', 'request', { text: 'put a note on my desk: call mom' }),
      ev(2, 'a', 'tool', { ok: true }),
      ev(3, 'a', 'reply', { text: 'Put “call mom” on your desk.' }),
      ev(4, 'b', 'request', { text: 'x'.repeat(300), channel: 'glasses' }),
      ev(5, 'b', 'tool', { ok: false }),
      ev(6, 'b', 'reply', { text: 'y'.repeat(300) }),
      ev(7, 'c', 'request', { text: 'still thinking' }),
    ],
    NOW,
  );
  assert.deepEqual(turns.map((t) => [t.id, t.state]), [['c', 'run'], ['b', 'err'], ['a', 'ok']]);
  assert.equal(turns[2].reply, 'Put “call mom” on your desk.');
  assert.equal(turns[1].said!.length, 80);
  assert.equal(turns[1].reply!.length, 160);
  assert.ok(turns[1].reply!.endsWith('…'));
  assert.equal(turnsOf([ev(1, 'c', 'request')], NOW + 600_000)[0].state, 'err'); // no reply after 5 minutes
});

test('the chat pushes only changes, reports Ekko down, and starts over when Ekko restarts', async () => {
  const replies: Result[] = [];
  const asked: string[] = [];
  const pushed: any[] = [];
  const chat = createChat(async (path) => (asked.push(path), replies.shift()!), (m) => pushed.push(JSON.parse(m)));
  const ok = (boot: string, events: TraceEvent[]) => replies.push({ status: 200, body: { boot, events } });

  ok('b1', [ev(1, 'a', 'request', { text: 'hi' }), ev(2, 'a', 'reply', { text: 'hello' })]);
  await chat.tick();
  ok('b1', []);
  await chat.tick(); // nothing new: nothing pushed
  replies.push({ status: 502, body: { ok: false, error: 'Ekko unavailable' } });
  await chat.tick();
  ok('b2', [ev(1, 'z', 'request')]); // restarted: this batch is ignored...
  await chat.tick();
  ok('b2', [ev(1, 'z', 'request', { text: 'new' })]); // ...and the next poll starts from 0
  await chat.tick();

  assert.deepEqual(asked, ['/trace?after=0', '/trace?after=2', '/trace?after=2', '/trace?after=2', '/trace?after=0']);
  assert.deepEqual(pushed.map((m) => [m.turns.map((t: any) => t.said), m.error]), [
    [['hi'], undefined],
    [['hi'], 'Ekko unavailable'],
    [['new'], undefined],
  ]);
  assert.deepEqual(JSON.parse(chat.latest()).turns[0].said, 'new');
});
