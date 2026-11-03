import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Widget = { id: string; kind: string; x: number; y: number; w: number; h: number; z: number; docked: boolean };
export type Result = { status: 200 | 400 | 404; body: { ok: boolean; error?: string } };

// Phase 3 fills these in; seeding them now means desk.json never needs migrating.
const DEFAULTS: Widget[] = [
  { id: 'chat', kind: 'chat', x: 0.05, y: 0.08, w: 0.25, h: 0.45, z: 1, docked: false },
  { id: 'timer', kind: 'timer', x: 0.7, y: 0.08, w: 0.2, h: 0.12, z: 2, docked: false },
];
const MIN = 0.02; // the page's smallest card is 0.05; this only rejects nonsense
const RANGES: Record<string, [number, number]> = { x: [0, 1], y: [0, 1], w: [MIN, 1], h: [MIN, 1] };

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
    } else {
      return `unknown field ${k}`;
    }
  }
  return out;
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

export function createDesk(file: string, changed: (widgets: Widget[]) => void) {
  const widgets = load(file);

  // Temp file + rename, so a crash or power cut mid-write leaves the old file whole.
  function save() {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ widgets }, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  return {
    widgets: () => widgets,
    patch(id: string, body: unknown): Result {
      const w = widgets.find((w) => w.id === id);
      if (!w) return { status: 404, body: { ok: false, error: `no widget ${id}` } };
      const fields = check(body);
      if (typeof fields === 'string') return { status: 400, body: { ok: false, error: fields } };
      Object.assign(w, fields);
      save();
      changed(widgets);
      return { status: 200, body: { ok: true } };
    },
  };
}

export type Desk = ReturnType<typeof createDesk>;
