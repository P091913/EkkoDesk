import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as app2, keyOk, pageOk } from './app.ts';
import { createDesk, type Desk } from './desk.ts';
import { createFiles } from './files.ts';

// Ekko.Files isn't configured here: these tests stop at the checks in front of it (files.test.ts mocks the store).
const createApp = (desk: Desk) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'desk-')), 'files');
  return app2(desk, createFiles({ name: 'Ekko.Files' }, dir, desk, () => {}));
};

test('keyOk needs a configured key and an exact match', () => {
  assert.equal(keyOk('abc', 'abc'), true);
  assert.equal(keyOk('abd', 'abc'), false);
  assert.equal(keyOk('abcd', 'abc'), false);
  assert.equal(keyOk(undefined, 'abc'), false);
  assert.equal(keyOk('', ''), false);
  assert.equal(keyOk('abc', undefined), false);
});

test('pageOk accepts only local host and local origin', () => {
  assert.equal(pageOk('127.0.0.1:8081', 'http://127.0.0.1:8081'), true);
  assert.equal(pageOk('localhost:5173', 'http://localhost:5173'), true);
  assert.equal(pageOk('127.0.0.1:8081', 'https://evil.com'), false);
  assert.equal(pageOk('127.0.0.1:8081', 'http://localhost.evil.com'), false);
  assert.equal(pageOk('evil.com', 'http://127.0.0.1:8081'), false);
  assert.equal(pageOk('127.0.0.1:8081', undefined), false);
  assert.equal(pageOk('127.0.0.1:8081', 'null'), false);
  assert.equal(pageOk('127.0.0.1:8081', 'file://127.0.0.1'), false);
});

test('/api/desk needs X-Desk and a local Host', async () => {
  const app = createApp(createDesk(join(mkdtempSync(join(tmpdir(), 'desk-')), 'desk.json'), () => {}));
  const patch = (headers: Record<string, string>) =>
    app.request('/api/desk/widgets/chat', { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: '{"x":0.5}' });
  assert.equal((await patch({ host: '127.0.0.1:8081' })).status, 403);
  assert.equal((await patch({ host: 'evil.com', 'x-desk': '1' })).status, 403);
  assert.equal((await patch({ host: 'localhost:5173', 'x-desk': '0' })).status, 403);
  assert.equal((await patch({ host: '127.0.0.1:8081', 'x-desk': '1' })).status, 200);
});

test('/api/notes needs the Brain key, from any Host, and answers in sentences', async () => {
  process.env.DESK_BRAIN_KEY = 'brain-test-key';
  const app = createApp(createDesk(join(mkdtempSync(join(tmpdir(), 'desk-')), 'desk.json'), () => {}));
  const post = (headers: Record<string, string>, body = '{"text":"call mom"}') =>
    app.request('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json', host: 'host.docker.internal:8081', ...headers }, body });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ 'x-api-key': 'wrong' })).status, 401);
  assert.equal((await post({ 'x-desk': '1' })).status, 401); // the page's header doesn't open Ekko's route

  const ok = await post({ 'x-api-key': 'brain-test-key' });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).message, 'Put “call mom” on your desk.');
  const bad = await post({ 'x-api-key': 'brain-test-key' }, 'not json');
  assert.deepEqual([bad.status, (await bad.json()).error], [400, 'A note needs some text.']);
});

test('/api/files/show needs the Brain key and a name of at most 60 characters', async () => {
  process.env.DESK_BRAIN_KEY = 'brain-test-key';
  const app = createApp(createDesk(join(mkdtempSync(join(tmpdir(), 'desk-')), 'desk.json'), () => {}));
  const post = (headers: Record<string, string>, body: string) =>
    app.request('/api/files/show', { method: 'POST', headers: { 'content-type': 'application/json', host: 'host.docker.internal:8081', ...headers }, body });
  const key = { 'x-api-key': 'brain-test-key' };
  assert.equal((await post({}, '{"name":"invoice"}')).status, 401);
  assert.equal((await post({ 'x-desk': '1' }, '{"name":"invoice"}')).status, 401);
  for (const bad of ['{}', '{"name":5}', `{"name":"${'x'.repeat(61)}"}`, 'not json']) assert.equal((await post(key, bad)).status, 400, bad);
  const r = await post(key, `{"name":"${'x'.repeat(60)}"}`); // passes the checks, then finds no store
  assert.deepEqual([r.status, (await r.json()).error], [502, "Ekko's file store isn't answering, so I can't open that."]);
});

test('file bytes are for the page only, and only for open files', async () => {
  const app = createApp(createDesk(join(mkdtempSync(join(tmpdir(), 'desk-')), 'desk.json'), () => {}));
  const get = (headers: Record<string, string>) => app.request('/api/desk/files/0123456789abcdef', { headers: { host: '127.0.0.1:8081', ...headers } });
  assert.equal((await get({})).status, 403);
  assert.equal((await get({ 'x-api-key': 'brain-test-key' })).status, 403);
  assert.equal((await get({ 'x-desk': '1' })).status, 404);
});
