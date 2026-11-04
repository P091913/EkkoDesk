import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAsk, SAY } from './ask.ts';

// A stand-in Brain that records each /message and answers with `status` and `body`.
async function mockBrain() {
  const got: { key?: string; body: any }[] = [];
  const brain = { status: 200, body: { text: 'Put “buy milk” on your desk.', requestId: 'r1' } as object };
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c)).on('end', () => {
      got.push({ key: req.headers['x-api-key'] as string, body: JSON.parse(data) });
      res.writeHead(brain.status, { 'content-type': 'application/json' }).end(JSON.stringify(brain.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { got, brain, base, close: () => server.close() };
}

function setup(base: string, tracker = true, waitMs = 1000) {
  const sent: any[] = [];
  const pushed: any[] = [];
  const answers: [string, string][] = [];
  const toTracker = (m: string) => {
    if (tracker) sent.push(JSON.parse(m));
    return tracker;
  };
  const ask = createAsk({ name: 'Ekko', base, key: 'desk-key' }, toTracker, (m) => pushed.push(JSON.parse(m)), (id, text) => answers.push([id, text]), waitMs);
  return { ask, sent, pushed, answers, last: () => pushed.at(-1) };
}

test('a question goes from the tracker to the Brain as the desk channel, and the whole answer to the chat card', async () => {
  const b = await mockBrain();
  const { ask, sent, pushed, answers, last } = setup(b.base);
  ask.start();
  assert.deepEqual(sent, [{ v: 1, type: 'listen', on: true }]);
  assert.deepEqual(last(), { type: 'ask', state: 'listening', note: null });
  ask.start(); // a stray start while listening changes nothing
  ask.stop();
  assert.deepEqual(sent[1], { v: 1, type: 'listen', on: false });
  assert.equal(last().state, 'working');

  const asking = ask.heard({ text: '  put a note on my desk: buy milk ' });
  assert.equal(last().state, 'thinking');
  await ask.heard({ text: 'a second heard' }); // already with the Brain: dropped
  await asking;
  assert.deepEqual(b.got, [{ key: 'desk-key', body: { text: 'put a note on my desk: buy milk', channel: 'desk', conversationId: 'desk' } }]);
  assert.deepEqual(answers, [['r1', 'Put “buy milk” on your desk.']]);
  assert.deepEqual(last(), { type: 'ask', state: 'idle', note: null });
  assert.deepEqual(pushed.map((m) => m.state), ['listening', 'working', 'thinking', 'idle']);
  await ask.heard({ text: 'late' }); // nothing was asked: dropped
  assert.equal(b.got.length, 1);
  b.close();
});

test('every failure says why, in a sentence', async () => {
  const b = await mockBrain();
  const { ask, answers, last } = setup(b.base);
  const say = async (m: object) => {
    ask.start();
    await ask.heard(m);
    return last().note;
  };
  assert.equal(await say({ text: ' ' }), SAY.nothing); // silence isn't sent: the Brain would 400 it
  assert.equal(await say({ text: 'x'.repeat(501) }), SAY.tooLong);
  assert.equal(await say({ error: "I can't open the PC's microphone." }), "I can't open the PC's microphone.");
  assert.equal(b.got.length, 0);

  b.brain.status = 400;
  b.brain.body = { error: 'text is required' };
  assert.equal(await say({ text: 'hello' }), "Ekko couldn't take that: text is required.");
  b.brain.status = 401;
  assert.equal(await say({ text: 'hello' }), SAY.refused);
  b.brain.status = 500;
  assert.equal(await say({ text: 'hello' }), SAY.down);
  b.brain.status = 200;
  b.brain.body = { text: 'no request id' };
  assert.equal(await say({ text: 'hello' }), SAY.down); // an answer it can't place
  assert.deepEqual(answers, []);
  b.close();
  assert.equal(await say({ text: 'hello' }), SAY.down); // no Brain at all

  ask.start();
  ask.lost(); // the tracker went away mid-question
  assert.deepEqual(last(), { type: 'ask', state: 'idle', note: SAY.noTracker });

  const none = setup(b.base, false);
  none.ask.start();
  assert.deepEqual(none.last(), { type: 'ask', state: 'idle', note: SAY.noTracker });
  assert.deepEqual(none.sent, []);
});

test('a tracker that never answers can not leave the button stuck', async () => {
  const { ask, last } = setup('http://127.0.0.1:9', true, 20);
  ask.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(last(), { type: 'ask', state: 'idle', note: SAY.noText });
});
