import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Every widget has the layout fields; notes add `text` and `added` (ms), the timer `endsAt` (ms) or `leftMs` while paused,
// a viewer the Ekko.Files `file` id, its `name` and `type`, the `page` shown, and `added` (when it was last shown).
export type Widget = {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  docked: boolean;
  text?: string;
  added?: number;
  endsAt?: number | null;
  leftMs?: number | null;
  file?: string;
  name?: string;
  type?: string;
  page?: number;
};
export type Result = {
  status: 200 | 201 | 400 | 404 | 409 | 502;
  body: { ok: boolean; error?: string; message?: string; id?: string };
};

const DEFAULTS: Widget[] = [
  { id: 'chat', kind: 'chat', x: 0.05, y: 0.08, w: 0.25, h: 0.45, z: 1, docked: false },
  { id: 'timer', kind: 'timer', x: 0.7, y: 0.08, w: 0.2, h: 0.2, z: 2, docked: false },
  { id: 'files', kind: 'files', x: 0.7, y: 0.32, w: 0.2, h: 0.5, z: 3, docked: false },
  { id: 'today', kind: 'today', x: 0.05, y: 0.56, w: 0.25, h: 0.32, z: 4, docked: false },
];
const MIN = 0.02; // the page's smallest card is 0.05; this only rejects nonsense
const RANGES: Record<string, [number, number]> = { x: [0, 1], y: [0, 1], w: [MIN, 1], h: [MIN, 1] };

export const MAX_NOTES = 30;
export const MAX_TEXT = 200;
const NOTE = { w: 0.16, h: 0.2 };
export const MAX_VIEWERS = 5; // each one holds a decoded photo or PDF in the Pi's browser
const VIEWER = { x: 0.35, y: 0.04, w: 0.3, h: 0.8 }; // top centre; each further one a little to the right
const GAP = 0.02;
const STRIP = 0.9; // the top of the dock strip, as in web/gestures.ts: notes are placed above it

// The page is the only caller, but a bad value would end up saved, so every field is checked.
export function check(body: unknown): Partial<Widget> | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'body must be a JSON object';
  const out: Partial<Widget> = {};
  for (const [k, v] of Object.entries(body)) {
    const range = RANGES[k];
    if (range) {
      if (typeof v !== 'number' || !(v >= range[0] && v <= range[1])) return `${k} must be a number from ${range[0]} to ${range[1]}`;
      (out as Record<string, number>)[k] = v;
    } else if (k === 'z') {
      if (!Number.isSafeInteger(v) || v < 0) return 'z must be a whole number, 0 or more';
      out.z = v;
    } else if (k === 'docked') {
      if (typeof v !== 'boolean') return 'docked must be true or false';
      out.docked = v;
    } else if (k === 'page') {
      if (!Number.isSafeInteger(v) || v < 1) return 'page must be a whole number, 1 or more';
      out.page = v;
    } else {
      return `unknown field ${k}`;
    }
  }
  return out;
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: Widget) =>
  !b.docked && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// The first spot, row by row from the top-left, that no card covers; the first spot if the desk is full.
export function place(widgets: Widget[], size = NOTE): { x: number; y: number } {
  for (let y = GAP; y + size.h <= STRIP; y += size.h + GAP) {
    for (let x = GAP; x + size.w <= 1; x += size.w + GAP) {
      if (!widgets.some((w) => overlaps({ x, y, w: size.w, h: size.h }, w))) return { x, y };
    }
  }
  return { x: GAP, y: GAP };
}

function load(file: string): Widget[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULTS);
    throw e;
  }
  try {
    const widgets = JSON.parse(text).widgets;
    if (!Array.isArray(widgets)) throw new Error('no widgets array');
    return widgets;
  } catch (e) {
    // Never overwrite a file we can't read: set it aside for a human and start fresh.
    console.error(`${file} is unreadable (${(e as Error).message}); kept as ${file}.bad, starting fresh`);
    renameSync(file, `${file}.bad`);
    return structuredClone(DEFAULTS);
  }
}

const fail = (status: 400 | 404 | 409, error: string): Result => ({ status, body: { ok: false, error } });

export function createDesk(file: string, changed: (widgets: Widget[]) => void, now = Date.now) {
  let widgets = load(file);
  // A default card added since the file was written (Files, Today) goes in its own spot if that's free, else the first free
  // spot, on top. Saved with the next change.
  for (const d of DEFAULTS) {
    if (widgets.some((w) => w.id === d.id)) continue;
    const spot = widgets.some((w) => overlaps(d, w)) ? place(widgets, d) : { x: d.x, y: d.y };
    widgets.push({ ...d, ...spot, z: Math.max(0, ...widgets.map((w) => w.z)) + 1 });
  }

  // Temp file + rename, so a crash or power cut mid-write leaves the old file whole. Every change is saved, then pushed.
  function commit(result: Result): Result {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ widgets }, null, 2));
    renameSync(`${file}.tmp`, file);
    changed(widgets);
    return result;
  }
  const top = () => Math.max(0, ...widgets.map((w) => w.z)) + 1;

  return {
    widgets: () => widgets,

    patch(id: string, body: unknown): Result {
      const w = widgets.find((w) => w.id === id);
      if (!w) return fail(404, `no widget ${id}`);
      const fields = check(body);
      if (typeof fields === 'string') return fail(400, fields);
      Object.assign(w, fields);
      return commit({ status: 200, body: { ok: true } });
    },

    // From Ekko, which reads `message` and `error` to the user word for word.
    addNote(raw: unknown): Result {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (!text) return fail(400, 'A note needs some text.');
      if (text.length > MAX_TEXT) return fail(400, `A note can be at most ${MAX_TEXT} characters.`);
      if (widgets.filter((w) => w.kind === 'note').length >= MAX_NOTES) {
        return fail(409, `Your desk already has ${MAX_NOTES} notes. Take some off first.`);
      }
      // The time keeps ids in order; the random part means two notes in one millisecond can't collide.
      const id = `note-${now().toString(36)}-${randomUUID().slice(0, 8)}`;
      widgets.push({ id, kind: 'note', ...place(widgets), ...NOTE, z: top(), docked: false, text, added: now() });
      return commit({ status: 201, body: { ok: true, id, message: `Put “${text}” on your desk.` } });
    },

    // Notes and viewers go in the trash; the chat, timer and Files cards stay.
    remove(id: string): Result {
      if (!widgets.some((w) => w.id === id && (w.kind === 'note' || w.kind === 'viewer'))) return fail(404, `no note or viewer ${id}`);
      widgets = widgets.filter((w) => w.id !== id);
      return commit({ status: 200, body: { ok: true } });
    },

    // From Ekko or a tap in the Files card. A file already open comes to the front instead of opening twice.
    showFile(f: { id: string; name: string; type: string }): Result {
      const viewers = widgets.filter((w) => w.kind === 'viewer');
      const open = viewers.find((w) => w.file === f.id);
      if (open) {
        // A chip comes back out at the viewer spot: its chip position would put most of it below the page.
        Object.assign(open, open.docked ? { x: VIEWER.x, y: VIEWER.y } : {}, { z: top(), docked: false, added: now() });
      } else if (viewers.length >= MAX_VIEWERS) {
        return fail(409, `Your desk already has ${MAX_VIEWERS} files open. Close one first.`);
      } else {
        const { id, name, type } = f;
        const x = VIEWER.x + 0.03 * viewers.length;
        widgets.push({ id: `file-${id}`, kind: 'viewer', ...VIEWER, x, z: top(), docked: false, file: id, name, type, page: 1, added: now() });
      }
      return commit({ status: 200, body: { ok: true, message: `Opened “${f.name}” on your desk.` } });
    },

    // {"action":"start","minutes":15} starts afresh, {"action":"start"} resumes, "pause", "reset".
    timer(body: unknown): Result {
      const t = widgets.find((w) => w.kind === 'timer');
      if (!t) return fail(404, 'no timer');
      const { action, minutes } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      const running = t.endsAt != null && t.endsAt > now();
      if (action === 'start' && minutes !== undefined) {
        if (!Number.isInteger(minutes) || (minutes as number) < 1 || (minutes as number) > 180) {
          return fail(400, 'minutes must be a whole number from 1 to 180');
        }
        Object.assign(t, { endsAt: now() + (minutes as number) * 60_000, leftMs: null });
      } else if (action === 'start') {
        if (running) return { status: 200, body: { ok: true } };
        if (t.leftMs == null) return fail(400, 'the timer is not paused');
        Object.assign(t, { endsAt: now() + t.leftMs, leftMs: null });
      } else if (action === 'pause') {
        if (!running) return { status: 200, body: { ok: true } };
        Object.assign(t, { endsAt: null, leftMs: t.endsAt! - now() });
      } else if (action === 'reset') {
        Object.assign(t, { endsAt: null, leftMs: null });
      } else {
        return fail(400, 'action must be start, pause or reset');
      }
      return commit({ status: 200, body: { ok: true } });
    },
  };
}

export type Desk = ReturnType<typeof createDesk>;
