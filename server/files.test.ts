import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesk } from './desk.ts';
import { createFiles } from './files.ts';

const PDF = { id: '0123456789abcdef', name: 'invoice.pdf', type: 'application/pdf', from: 'telegram', at: '2026-11-03T18:00:00Z' };
const JPG = { id: 'fedcba9876543210', name: 'photo.jpg', type: 'image/jpeg', from: 'pc', at: '2026-11-03T19:00:00Z' };

// A stand-in for Ekko.Files: newest first, `q` matched against the name, bytes by id, the same key check.
async function mockStore() {
  const store = {
    list: [JPG, PDF] as object[],
    bytes: new Map<string, { type: string; body: string }>([
      [PDF.id, { type: PDF.type, body: '%PDF-1.7 fake' }],
      [JPG.id, { type: 'image/jpeg', body: 'jpeg bytes' }],
    ]),
    asked: [] as string[],
    hold: undefined as Promise<void> | undefined, // while set, file bytes wait for it
    down: false,
  };
  const server = createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://x');
    store.asked.push(req.url!);
    if (store.down) return void res.writeHead(500).end('boom');
    if (req.headers['x-api-key'] !== 'files-key') return void res.writeHead(401).end();
    if (u.pathname === '/files') {
      const q = u.searchParams.get('q');
      const found = (store.list as { name: string }[]).filter((f) => q === null || f.name.includes(q));
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(found.slice(0, Number(u.searchParams.get('limit')))));
    }
    await store.hold;
    const f = store.bytes.get(u.pathname.slice('/files/'.length));
    if (!f) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': f.type, 'x-content-type-options': 'nosniff' }).end(f.body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { store, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function setup(base: string) {
  const root = mkdtempSync(join(tmpdir(), 'desk-'));
  const dir = join(root, 'files');
  const pushed: any[] = [];
  const desk = createDesk(join(root, 'desk.json'), () => files.prune());
  const files = createFiles({ name: 'Ekko.Files', base, key: 'files-key' }, dir, desk, (m) => pushed.push(JSON.parse(m)));
  return { desk, files, dir, pushed };
}

test('show: opens the newest or a named file, and answers in Ekko’s words', async (t) => {
  const { store, server, base } = await mockStore();
  t.after(() => server.close());
  const { desk, files } = setup(base);

  let release!: () => void;
  store.hold = new Promise((ok) => (release = ok));
  const newest = await files.show(''); // answered while the bytes are still held back
  assert.deepEqual([newest.status, newest.body.message], [200, 'Opened “photo.jpg” on your desk.']);
  release();
  const named = await files.show('invoice');
  assert.deepEqual([named.status, named.body.message], [200, 'Opened “invoice.pdf” on your desk.']);
  assert.deepEqual(store.asked.filter((u) => u.startsWith('/files?')), ['/files?limit=1', '/files?q=invoice&limit=1']);
  assert.deepEqual(desk.widgets().filter((w) => w.kind === 'viewer').map((w) => w.file), [JPG.id, PDF.id]);

  const none = await files.show('tax return');
  assert.deepEqual([none.status, none.body.error], [404, "I couldn't find a file called “tax return”."]);
  store.list = [];
  assert.equal((await files.show('')).body.error, "You haven't sent me any photos or PDFs yet.");

  store.list = [{ ...PDF, id: '../../etc/passwd' }]; // never trusted into a path
  assert.equal((await files.show('')).status, 502);
  store.down = true;
  const down = await files.show('invoice');
  assert.deepEqual([down.status, down.body.error], [502, "Ekko's file store isn't answering, so I can't open that."]);
});

test('serve: copies once, serves with the stored type, and keeps showing it with the PC off', async (t) => {
  const { store, server, base } = await mockStore();
  t.after(() => server.close());
  const { desk, files, dir } = setup(base);
  await files.show('invoice');

  const r = await files.serve(PDF.id);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await r.text(), '%PDF-1.7 fake');
  store.down = true; // the PC is off: the Pi's copy still shows
  assert.equal(await (await files.serve(PDF.id)).text(), '%PDF-1.7 fake');
  assert.equal(store.asked.filter((u) => u.startsWith('/files/')).length, 1);

  assert.equal((await files.serve(JPG.id)).status, 404); // not open
  assert.equal((await files.serve('../desk.json')).status, 404);

  desk.remove(`file-${PDF.id}`); // the trash deletes the Pi's copy
  assert.deepEqual(readdirSync(dir), []);
});

test('serve: a file gone from Downloads, and bytes of the wrong type', async (t) => {
  const { store, server, base } = await mockStore();
  t.after(() => server.close());
  const { files, dir } = setup(base);
  store.bytes.delete(JPG.id); // deleted or changed on the PC before the copy: its old id is 404 now
  store.bytes.set(PDF.id, { type: 'text/html', body: '<script>' });
  await files.show('photo');
  await files.show('invoice');

  const gone = await files.serve(JPG.id);
  assert.deepEqual([gone.status, (await gone.json()).error], [404, "That file isn't there anymore."]);
  assert.equal((await files.serve(PDF.id)).status, 502);
  assert.equal(existsSync(join(dir, PDF.id)), false);
});

test('the Files card list: pushed only on change, bad entries dropped, the store down said plainly', async (t) => {
  const { store, server, base } = await mockStore();
  t.after(() => server.close());
  const { files, pushed } = setup(base);
  store.list = [JPG, { ...PDF, type: 'image/svg+xml' }, PDF];

  await files.tick();
  await files.tick();
  store.down = true;
  await files.tick();

  assert.equal(pushed.length, 2);
  assert.deepEqual(pushed[0].files.map((f: { name: string; from: string }) => [f.name, f.from]), [['photo.jpg', 'pc'], ['invoice.pdf', 'telegram']]);
  assert.deepEqual(pushed[1], { type: 'files', files: [], error: "Ekko's file store isn't answering." });
  assert.equal(files.openListed(PDF.id).status, 404); // the list is gone while the store is down
});
