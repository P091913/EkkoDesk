import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, keyOk, pageOk } from './app.ts';
import { createDesk } from './desk.ts';

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

test('/api needs X-Desk and a local Host', async () => {
  const app = createApp(createDesk(join(mkdtempSync(join(tmpdir(), 'desk-')), 'desk.json'), () => {}));
  const patch = (headers: Record<string, string>) =>
    app.request('/api/desk/widgets/chat', { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: '{"x":0.5}' });
  assert.equal((await patch({ host: '127.0.0.1:8081' })).status, 403);
  assert.equal((await patch({ host: 'evil.com', 'x-desk': '1' })).status, 403);
  assert.equal((await patch({ host: 'localhost:5173', 'x-desk': '0' })).status, 403);
  assert.equal((await patch({ host: '127.0.0.1:8081', 'x-desk': '1' })).status, 200);
});
