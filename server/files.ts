// Ekko.Files on the desk (Ekko's DR-40): the Files card's list, opening a viewer card, and the Pi's copy of each open file.
// The page never sees FILES_KEY: this server fetches the bytes and serves them under /api/desk/.
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Desk, Result } from './desk.ts';
import { call, isOk, poll, type Upstream } from './upstream.ts';

export type StoreFile = { id: string; name: string; type: string; from: string; at: string };

const ID = /^[0-9a-f]{16}$/;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
const MAX_BYTES = 20 * 1024 * 1024;
const LIST = 20;
const FIND_MS = 8000; // the Brain waits 10 s for our answer
const COPY_MS = 60_000; // 20 MB over the tailnet
const DOWN = "Ekko's file store isn't answering.";
const fail = (status: 404 | 502, error: string): Result => ({ status, body: { ok: false, error } });
const OK: Result = { status: 200, body: { ok: true } };

// Ekko.Files is ours, but its ids end up in paths and URLs and its types in Content-Type, so each entry is checked.
const pick = (f: any): StoreFile | undefined =>
  typeof f?.id === 'string' && ID.test(f.id) && TYPES.has(f.type) && typeof f.name === 'string'
    ? { id: f.id, name: f.name, type: f.type, from: String(f.from ?? ''), at: String(f.at ?? '') }
    : undefined;

export function createFiles(store: Upstream, dir: string, desk: Desk, push: (msg: string) => void, everyMs = 5000) {
  mkdirSync(dir, { recursive: true });
  const copying = new Map<string, Promise<Result>>(); // one download per file at a time
  let listed = new Map<string, StoreFile>();
  let last = JSON.stringify({ type: 'files', files: [] });

  const viewer = (id: string) => desk.widgets().find((w) => w.kind === 'viewer' && w.file === id);

  async function download(id: string, type: string): Promise<Result> {
    const path = join(dir, id);
    try {
      const res = await fetch(`${store.base}/files/${id}`, {
        headers: store.key ? { 'X-Api-Key': store.key } : {},
        signal: AbortSignal.timeout(COPY_MS),
      });
      // A Downloads file that was deleted or changed (DR-41) has lost its id.
      if (res.status === 404) return fail(404, "That file isn't there anymore.");
      const got = res.headers.get('content-type')?.split(';')[0].trim();
      if (!res.ok || got !== type || Number(res.headers.get('content-length')) > MAX_BYTES) {
        console.error(`Ekko.Files ${id}: HTTP ${res.status}, ${got}, ${res.headers.get('content-length')} bytes`);
        return fail(502, DOWN);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_BYTES) return fail(502, DOWN);
      if (!viewer(id)) return fail(404, 'closed'); // closed while downloading: don't leave a copy behind
      // Async, so writing 20 MB to the SD card doesn't hold up the tracker's pointers. Temp file + rename: never a half copy.
      await writeFile(`${path}.tmp`, bytes);
      await rename(`${path}.tmp`, path);
      return OK;
    } catch (e) {
      console.error(`Ekko.Files ${id}:`, (e as Error).message);
      return fail(502, DOWN);
    }
  }

  // The Pi's copy, so an open file still shows when the PC is off.
  async function copy(id: string, type: string): Promise<Result> {
    if (await stat(join(dir, id)).then(() => true, () => false)) return OK;
    let p = copying.get(id);
    if (!p) copying.set(id, (p = download(id, type).finally(() => copying.delete(id))));
    return p;
  }

  function open(f: StoreFile): Result {
    const r = desk.showFile(f);
    if (r.body.ok) void copy(f.id, f.type); // the answer doesn't wait for the bytes
    return r;
  }

  async function tick() {
    const r = await call(store, `/files?limit=${LIST}`);
    const ok = isOk(r) && Array.isArray(r.body);
    const files = ok ? r.body.flatMap((f: unknown) => pick(f) ?? []) : [];
    listed = new Map(files.map((f: StoreFile) => [f.id, f]));
    const msg = JSON.stringify({ type: 'files', files, ...(!ok && { error: DOWN }) });
    if (msg !== last) push((last = msg));
  }

  return {
    tick,
    latest: () => last,
    // The Files card's list: polled only while the card is out and a page is watching.
    set: poll(tick, everyMs),

    // From Ekko: "" is the newest file. Ekko reads `message` and `error` out word for word.
    async show(name: string): Promise<Result> {
      const r = await call(store, `/files?${name ? `q=${encodeURIComponent(name)}&` : ''}limit=1`, FIND_MS);
      const found = isOk(r) && Array.isArray(r.body) ? r.body : undefined;
      const f = found?.length ? pick(found[0]) : undefined;
      if (!found || (found.length && !f)) {
        console.error('Ekko.Files:', r.status, r.body?.error ?? 'unexpected answer');
        return fail(502, "Ekko's file store isn't answering, so I can't open that.");
      }
      if (!f) return fail(404, name ? `I couldn't find a file called “${name}”.` : "You haven't sent me any photos or PDFs yet.");
      return open(f);
    },

    // From a tap on a row of the Files card.
    openListed: (id: string) => {
      const f = listed.get(id);
      return f ? open(f) : fail(404, `no file ${id} in the list`);
    },

    // Only open files, with their stored type, so nothing else on the PC can be read through here.
    async serve(id: string): Promise<Response> {
      const w = ID.test(id) ? viewer(id) : undefined;
      if (!w?.type || !TYPES.has(w.type)) return Response.json({ ok: false, error: `no open file ${id}` }, { status: 404 });
      const r = await copy(id, w.type);
      if (!r.body.ok) return Response.json(r.body, { status: r.status });
      const bytes = await readFile(join(dir, id));
      return new Response(bytes, { headers: { 'Content-Type': w.type, 'X-Content-Type-Options': 'nosniff' } });
    },

    // Deletes the copies of files no longer open: at start-up and after every desk change. Never touches Ekko.Files.
    prune() {
      const open = new Set(desk.widgets().flatMap((w) => (w.kind === 'viewer' && w.file ? [w.file] : [])));
      for (const name of readdirSync(dir)) {
        if (!open.has(name) && !copying.has(name.replace(/\.tmp$/, ''))) rmSync(join(dir, name), { force: true });
      }
    },
  };
}

export type Files = ReturnType<typeof createFiles>;
