import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import pdfRenderer from 'pdfjs-dist/build/pdf.renderer.min.mjs?url';
import { box, createGestures, HOLD_MS, STRIP, TRASH, type Card, type Phase, type Result } from './gestures';

type Turn = { id: string; channel: string; at: string; said?: string; reply?: string; state: 'run' | 'ok' | 'err' };
type StoreFile = { id: string; name: string; type: string; from: string; at: string };
// A viewer's file while its card is open, by Ekko.Files id: a photo's blob URL, or the parsed PDF.
type Shown = { img?: string; pdf?: PDFDocumentProxy; error?: string };

let cards: Card[] = []; // replaced by every `state` from the server
const { pointer, wheel, held, trashing } = createGestures(() => cards);
const pinches = new Map<string, { x: number; y: number }>(); // live tracker pinches, drawn as rings
let chat: { turns: Turn[]; error?: string } = { turns: [] };
let fileList: { files: StoreFile[]; error?: string } = { files: [] };
const shown = new Map<string, Shown>();
// Each card's size as last saved. A PDF page is redrawn when it changes: once a resize ends, not all through it.
let settled = new Map<string, string>();
let online = false;
let sheet: string | null = null; // the calibration image, while the tracker is calibrating
let redraw = () => {};

const phases = new Set(['down', 'move', 'up', 'cancel']);
const PRESETS = [5, 15, 25]; // minutes, along the bottom of the timer card
const PRESET_ROW = 0.6; // where that row starts, 0–1 down the card
const NEW_MS = 10_000; // how long a new note, or a file just shown, stays highlighted

// The page's calls to its own server. The server pushes the new `state` back to every page.
function api(method: string, path: string, body?: object) {
  fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Desk': '1' },
    body: body && JSON.stringify(body),
  })
    .then(async (r) => {
      if (!r.ok) console.error(`${method} ${path}:`, (await r.json()).error);
    })
    .catch((e) => console.error(`${method} ${path}:`, e));
}

// Saved on release, never during a drag. A viewer's page turned by a tap goes with it.
function save(c: Card) {
  const { x, y, w, h, z, docked, page } = c;
  api('PATCH', `/api/desk/widgets/${encodeURIComponent(c.id)}`, { x, y, w, h, z, docked, page });
}

// pdf.js loads when the first PDF opens. Its two workers parse and draw off the main thread, so drawing a page never
// stalls a drag. pdf.js 6 has no eval left to switch off: its isEvalSupported option is gone.
const pdfjs = () =>
  import('pdfjs-dist').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = pdfWorker;
    lib.GlobalWorkerOptions.rendererSrc = pdfRenderer;
    return lib;
  });

// An <img src> can't send X-Desk, so the page fetches the bytes itself, once per open viewer.
function load(c: Card) {
  const id = c.file!;
  if (shown.has(id)) return;
  const mine: Shown = {};
  shown.set(id, mine);
  fetch(`/api/desk/files/${encodeURIComponent(id)}`, { headers: { 'X-Desk': '1' } })
    .then(async (r): Promise<Shown> => {
      if (!r.ok) return { error: (await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}` };
      if (c.type !== 'application/pdf') return { img: URL.createObjectURL(await r.blob()) };
      return { pdf: await (await pdfjs()).getDocument({ data: await r.arrayBuffer() }).promise };
    })
    .catch((): Shown => ({ error: "Couldn't open this file." }))
    .then((s) => {
      if (shown.get(id) === mine) shown.set(id, s);
      else release(s); // closed while loading
      redraw();
    });
}
function release(s: Shown) {
  if (s.img) URL.revokeObjectURL(s.img);
  void s.pdf?.loadingTask.destroy(); // pdf.js 6: the document is closed through its loading task
}
const pageOf = (c: Card, pdf: PDFDocumentProxy) => Math.min(Math.max(c.page ?? 1, 1), pdf.numPages);

function timerOf(c: Card, now = Date.now()): { mode: 'idle' | 'running' | 'paused' | 'done'; ms: number } {
  if (c.leftMs != null) return { mode: 'paused', ms: c.leftMs };
  if (c.endsAt == null) return { mode: 'idle', ms: 0 };
  const ms = c.endsAt - now;
  return ms > 0 ? { mode: 'running', ms } : { mode: 'done', ms: 0 };
}
const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Timer: a preset starts it; the time pauses, resumes, or clears "done". Files: a row opens that file.
// Viewer: the left or right third turns the page (saved with the tap); a tap on a failed file tries again.
function tapped(c: Card, at: { x: number; y: number }) {
  if (c.docked) return;
  if (c.kind === 'timer') {
    const timer = (body: object) => api('POST', '/api/desk/timer', body);
    if (at.y >= PRESET_ROW) return timer({ action: 'start', minutes: PRESETS[Math.min(PRESETS.length - 1, Math.floor(at.x * PRESETS.length))] });
    const { mode } = timerOf(c);
    if (mode === 'running') timer({ action: 'pause' });
    else if (mode === 'paused') timer({ action: 'start' });
    else if (mode === 'done') timer({ action: 'reset' });
  } else if (c.kind === 'files') {
    const b = box(c); // the row under the tap, found from where it landed on the page
    const row = document.elementFromPoint((b.x + at.x * b.w) * innerWidth, (b.y + at.y * b.h) * innerHeight)?.closest<HTMLElement>('[data-file]');
    if (row) api('POST', '/api/desk/viewers', { file: row.dataset.file });
  } else if (c.kind === 'viewer') {
    const s = shown.get(c.file!);
    if (s?.error) {
      shown.delete(c.file!);
      load(c);
    } else if (s?.pdf) {
      c.page = Math.min(Math.max(pageOf(c, s.pdf) + (at.x < 1 / 3 ? -1 : at.x > 2 / 3 ? 1 : 0), 1), s.pdf.numPages);
    }
  }
}

// Redraws once when something changes on its own: the timer's next second, or a highlight ending (a new note, a file just shown).
// No interval, so nothing runs while the desk is still.
let wakeTimer: ReturnType<typeof setTimeout> | undefined;
function wake() {
  clearTimeout(wakeTimer);
  const now = Date.now();
  const due = cards.flatMap((c) => {
    if (c.added && c.added + NEW_MS > now) return [c.added + NEW_MS - now];
    const t = c.kind === 'timer' ? timerOf(c, now) : undefined;
    return t?.mode === 'running' ? [t.ms % 1000 || 1000] : [];
  });
  if (due.length) {
    wakeTimer = setTimeout(() => {
      redraw();
      wake();
    }, Math.min(...due) + 5); // +5: land just past the change, never just before it
  }
}

// When a note went over the trash, on the page's clock: for drawing only, gestures.ts decides with the pointer's own clock.
let binAt: number | undefined;
function watchTrash() {
  if (!trashing()) binAt = undefined;
  else if (binAt === undefined) {
    binAt = performance.now();
    setTimeout(redraw, HOLD_MS); // one redraw to show it armed
  }
}

function apply(r: Result) {
  if (r.remove) {
    const gone = r.remove;
    cards = cards.filter((c) => c !== gone); // gone at once; the server's `state` follows
    api('DELETE', `/api/desk/widgets/${encodeURIComponent(gone.id)}`);
  }
  if (r.tap && r.at) tapped(r.tap, r.at);
  if (r.save) save(r.save);
  watchTrash();
  if (r.redraw) redraw();
}

// Tracker ids get a "t" prefix and mouse ids an "m", so the two can never collide.
function track(phase: Phase, id: string, x: number, y: number, t: number) {
  apply(pointer(phase, id, x, y, t));
  if (phase === 'down' || phase === 'move') pinches.set(id, { x, y });
  else pinches.delete(id);
  redraw();
}

function setOnline(on: boolean) {
  online = on;
  if (!on) {
    for (const id of [...pinches.keys()]) track('cancel', id, 0, 0, 0); // a lost tracker can't send `up`
    sheet = null; // nor hide its calibration image
  }
  redraw();
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/page`);
  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    // Unknown versions and types are ignored, so the tracker and the desk can be updated separately.
    if (m?.v === 1 && m.type === 'pointer' && phases.has(m.phase) && Number.isFinite(m.x) && Number.isFinite(m.y)) {
      track(m.phase, `t${m.id}`, m.x, m.y, Number.isFinite(m.t) ? m.t : performance.now());
    } else if (m?.v === 1 && m.type === 'calibrate') {
      sheet = typeof m.png === 'string' ? `data:image/png;base64,${m.png}` : null;
      redraw();
    } else if (m?.type === 'state' && Array.isArray(m.widgets)) {
      settled = new Map(m.widgets.map((w: Card) => [w.id, `${w.w}x${w.h}`])); // copied: gestures change the cards in place
      // A card still held keeps the page's copy; the server's is from before the drag and would make it jump.
      cards = m.widgets.map((w: Card) => (held(w.id) && cards.find((c) => c.id === w.id)) || w);
      for (const c of cards) if (c.kind === 'viewer' && !c.docked) load(c);
      for (const [id, s] of shown) {
        if (!cards.some((c) => c.kind === 'viewer' && c.file === id)) {
          shown.delete(id); // closed: free the photo or PDF
          release(s);
        }
      }
      wake();
      redraw();
    } else if (m?.type === 'turns' && Array.isArray(m.turns)) {
      chat = { turns: m.turns, error: typeof m.error === 'string' ? m.error : undefined };
      redraw();
    } else if (m?.type === 'files' && Array.isArray(m.files)) {
      fileList = { files: m.files, error: typeof m.error === 'string' ? m.error : undefined };
      redraw();
    } else if (m?.type === 'tracker') {
      setOnline(m.connected === true);
    }
  };
  ws.onclose = () => {
    setOnline(false);
    setTimeout(connect, 2000);
  };
}

const mouse = (phase: Phase) => (e: PointerEvent) => apply(pointer(phase, `m${e.pointerId}`, e.clientX / innerWidth, e.clientY / innerHeight, e.timeStamp));
addEventListener('pointerdown', mouse('down'));
addEventListener('pointermove', mouse('move'));
addEventListener('pointerup', mouse('up'));
addEventListener('pointercancel', mouse('cancel'));
addEventListener('resize', () => redraw()); // note text and PDF pages are sized in px from the window; everything else is in vw/vh

// The wheel has no release, so save once it has been still for half a second.
let wheelSave: ReturnType<typeof setTimeout> | undefined;
let wheelCard: Card | undefined;
addEventListener('wheel', (e) => {
  const c = wheel(e.clientX / innerWidth, e.clientY / innerHeight, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  if (!c) return;
  redraw();
  clearTimeout(wheelSave);
  if (wheelCard && wheelCard.id !== c.id) save(wheelCard); // moved on to another card: don't drop this one
  wheelCard = c;
  wheelSave = setTimeout(() => {
    save(c);
    wheelCard = undefined;
  }, 500);
});

const at = (x: number, y: number) => `translate(${x * 100}vw, ${y * 100}vh)`;
// A note sits a little crooked, like one stuck on by hand: -2° to 2° from its id, so it never changes.
const tilt = (id: string) => ([...id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 9) * 0.5 - 2;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// Today's files show the time, older ones the date.
function when(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString() ? hhmm(iso) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// One PDF page, fitted to the card. Drawn again only when the page or the card's saved size changes.
function PdfPage({ pdf, page, size }: { pdf: PDFDocumentProxy; page: number; size: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let task: RenderTask | undefined;
    let stop = false;
    pdf.getPage(page).then((p) => {
      const canvas = ref.current;
      if (stop || !canvas) return;
      const area = canvas.parentElement!; // the card above the page number
      const one = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({ scale: Math.min(area.clientWidth / one.width, area.clientHeight / one.height) * devicePixelRatio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = p.render({ canvas, viewport });
      task.promise.catch(() => {}); // cancelled by the next draw
    });
    return () => {
      stop = true;
      task?.cancel();
    };
  }, [pdf, page, size]);
  return <canvas ref={ref} />;
}

// Written as big as fits, like on paper: a short note gets big writing, a long one shrinks to 12 px and is then cut off.
// The area each character needs is about 0.5 em wide by 1.3 em tall, plus room for word wrapping.
function noteFont(text: string, b: { w: number; h: number }) {
  const w = b.w * innerWidth - 24; // minus the note's padding in style.css
  const h = b.h * innerHeight - 30;
  const fit = Math.sqrt((w * h) / (Math.max(text.length, 1) * 0.78)) * 0.7;
  return `${Math.round(Math.max(12, Math.min(fit, h / 1.4, 64)))}px`;
}

// Text is sized from the card, so resizing a card scales what's in it.
function Body({ c, b }: { c: Card; b: { w: number; h: number } }) {
  if (c.docked) return <span class="label">{c.text ?? c.name ?? c.kind}</span>;
  if (c.kind === 'note') return <p style={{ fontSize: noteFont(c.text ?? '', b) }}>{c.text}</p>;
  if (c.kind === 'timer') {
    const { mode, ms } = timerOf(c);
    return (
      <>
        <div class={`time ${mode}`} style={{ fontSize: `${b.h * 28}vh` }}>
          {mode === 'done' ? 'done' : mmss(ms)}
        </div>
        <div class="presets" style={{ fontSize: `${b.h * 12}vh` }}>
          {PRESETS.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      </>
    );
  }
  if (c.kind === 'chat') {
    return (
      <div class="turns" style={{ fontSize: `${b.w * 5}vw` }}>
        {chat.error && <p class="muted">{chat.error}</p>}
        {!chat.error && chat.turns.length === 0 && <p class="muted">No messages yet.</p>}
        {chat.turns.map((t) => (
          <div key={t.id} class={`turn ${t.state}`}>
            <div class="said">
              <b>{t.said ?? '…'}</b>
              <time>{hhmm(t.at)}</time>
            </div>
            <div class="ans">{t.state === 'run' ? 'working…' : (t.reply ?? '')}</div>
            <div class="via">{t.channel}</div>
          </div>
        ))}
      </div>
    );
  }
  if (c.kind === 'files') {
    return (
      <div class="list" style={{ fontSize: `${b.w * 5}vw` }}>
        {fileList.error && <p class="muted">{fileList.error}</p>}
        {!fileList.error && fileList.files.length === 0 && <p class="muted">No files yet.</p>}
        {fileList.files.map((f) => (
          <div key={f.id} class="file" data-file={f.id}>
            <b>{f.name}</b>
            <span>
              {when(f.at)} · {f.from === 'pc' ? 'PC' : f.from}
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (c.kind === 'viewer') {
    const s = shown.get(c.file!) ?? {};
    return (
      <>
        <div class="view">
          {s.img && <img src={s.img} alt="" />}
          {s.pdf && <PdfPage pdf={s.pdf} page={pageOf(c, s.pdf)} size={`${settled.get(c.id)} ${innerWidth}x${innerHeight}`} />}
          {!s.img && !s.pdf && <p class="muted">{s.error ?? 'loading…'}</p>}
        </div>
        {s.pdf && (
          <div class="pages">
            {pageOf(c, s.pdf)} / {s.pdf.numPages}
          </div>
        )}
      </>
    );
  }
  return <>{c.kind}</>;
}

function App() {
  const [, set] = useState(0);
  useEffect(() => {
    redraw = () => set((n) => n + 1);
    connect();
  }, []);
  const now = Date.now();
  const bin = binAt === undefined ? '' : performance.now() - binAt >= HOLD_MS ? ' armed' : ' over';
  return (
    <>
      <div class="strip" style={{ top: `${STRIP * 100}vh` }} />
      <div class={`trash${bin}`} style={{ width: `${TRASH.w * 100}vw`, height: `${TRASH.h * 100}vh`, transform: at(TRASH.x, TRASH.y) }}>
        trash
      </div>
      {cards.map((c) => {
        const b = box(c);
        const fresh = c.added && now - c.added < NEW_MS ? ' new' : '';
        return (
          <div
            key={c.id}
            class={`card ${c.kind}${c.docked ? ' chip' : ''}${fresh}`}
            style={{
              width: `${b.w * 100}vw`,
              height: `${b.h * 100}vh`,
              transform: at(b.x, b.y) + (c.kind === 'note' && !c.docked ? ` rotate(${tilt(c.id)}deg)` : ''),
              zIndex: c.z,
            }}
          >
            <Body c={c} b={b} />
          </div>
        );
      })}
      {[...pinches].map(([id, p]) => (
        <div key={id} class="pinch" style={{ transform: at(p.x, p.y) }} />
      ))}
      {!online && <div class="status">tracker offline</div>}
      {sheet && <img class="sheet" src={sheet} alt="" />}
    </>
  );
}

render(<App />, document.getElementById('app')!);
