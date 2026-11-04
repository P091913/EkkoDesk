import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import pdfRenderer from 'pdfjs-dist/build/pdf.renderer.min.mjs?url';
import { R as BALL_R } from './ball';
import { pose } from './fighters';
import { BALL_SPOT, box, createGestures, FIGHT_SPOT, HOLD_MS, STRIP, TRASH, type Card, type Phase, type Result } from './gestures';
import { createToys } from './toys';

type Turn = { id: string; channel: string; at: string; said?: string; reply?: string; state: 'run' | 'ok' | 'err' };
type StoreFile = { id: string; name: string; type: string; from: string; at: string };
// A viewer's file while its card is open, by Ekko.Files id: a photo's blob URL, or the parsed PDF.
type Shown = { img?: string; pdf?: PDFDocumentProxy; error?: string };

let cards: Card[] = []; // replaced by every `state` from the server
const { pointer, wheel, held, trashing } = createGestures(() => cards);
const pinches = new Map<string, { x: number; y: number }>(); // live tracker pinches, drawn as rings
let chat: { turns: Turn[]; error?: string } = { turns: [] };
let fileList: { files: StoreFile[]; error?: string } = { files: [] };
// Ask Ekko, from the server's `ask` messages: what the chat card's button shows, and why the last question failed.
let asking: { state: string; note: string | null } = { state: 'idle', note: null };
// The Today card, from the server's `today` messages (PROTOCOL.md); null until the first read.
type Glance = { status: string; message: string; billsLeft?: number; leftToPay?: number; next?: { item: string; amount: number; date: string | null } | null };
let today: {
  day: { total?: number; error?: string } | null;
  usual: { foods?: { name: string; caloriesEach: number }[]; error?: string } | null;
  glance: Glance | null;
} = { day: null, usual: null, glance: null };
// What the last food tap said, with Undo while `undo`. Shown for UNDO_SHOWN ms.
let logged: { message: string; undo: boolean } | null = null;
let logging = false;
const UNDO_SHOWN = 10_000;
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
// The answer's body comes back for the few taps that show it (the food log).
function api(method: string, path: string, body?: object): Promise<any> {
  return fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Desk': '1' },
    body: body && JSON.stringify(body),
  })
    .then(async (r) => {
      const b = await r.json().catch(() => ({}));
      if (!r.ok) console.error(`${method} ${path}:`, b.error);
      return b;
    })
    .catch((e) => {
      console.error(`${method} ${path}:`, e);
      return { ok: false, error: "The desk server isn't answering." };
    });
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

// The quick food log. A second tap while one is on its way is dropped: tracker taps can misfire.
let loggedTimer: ReturnType<typeof setTimeout> | undefined;
function showLogged(message: string, undo: boolean) {
  logged = { message, undo };
  clearTimeout(loggedTimer);
  loggedTimer = setTimeout(() => {
    logged = null;
    redraw();
  }, UNDO_SHOWN);
  redraw();
}
function logFood(food: string) {
  if (logging) return;
  logging = true;
  api('POST', '/api/desk/food/log', { food }).then((b) => {
    logging = false;
    showLogged(b.message ?? b.error ?? '', b.ok === true);
  });
}
function undoFood() {
  if (!logged?.undo) return;
  logged.undo = false; // one undo per tap
  redraw();
  api('POST', '/api/desk/food/undo').then((b) => showLogged(b.message ?? b.error ?? '', false));
}

// Tracker taps aren't clicks, so what's under a tap is found from where it landed on the page.
function under(c: Card, at: { x: number; y: number }, selector: string) {
  const b = box(c);
  return document.elementFromPoint((b.x + at.x * b.w) * innerWidth, (b.y + at.y * b.h) * innerHeight)?.closest<HTMLElement>(selector);
}

// Timer: a preset starts it; the time pauses, resumes, or clears "done". Files: a row opens that file.
// Viewer: the left or right third turns the page (saved with the tap); a tap on a failed file tries again.
// Chat: the Ask Ekko button starts listening, and a second tap sends. A tap on the turns pages down, then back to the top.
// Today: a food logs one of it, Undo takes it back, and anywhere else reads everything again, the budget included.
function tapped(c: Card, at: { x: number; y: number }) {
  if (c.docked) return;
  if (c.kind === 'today') {
    const food = under(c, at, '[data-food]');
    if (food) return logFood(food.dataset.food!);
    if (under(c, at, '[data-undo]')) return undoFood();
    return void api('POST', '/api/desk/today/refresh');
  }
  if (c.kind === 'timer') {
    const timer = (body: object) => api('POST', '/api/desk/timer', body);
    if (at.y >= PRESET_ROW) return timer({ action: 'start', minutes: PRESETS[Math.min(PRESETS.length - 1, Math.floor(at.x * PRESETS.length))] });
    const { mode } = timerOf(c);
    if (mode === 'running') timer({ action: 'pause' });
    else if (mode === 'paused') timer({ action: 'start' });
    else if (mode === 'done') timer({ action: 'reset' });
  } else if (c.kind === 'chat') {
    if (under(c, at, '[data-ask]')) return api('POST', '/api/desk/ask', { action: asking.state === 'listening' ? 'stop' : 'start' });
    // Text is sized from the card, so a bigger card doesn't fit more of a long answer: pages do.
    const list = under(c, at, '.card')?.querySelector<HTMLElement>('.turns');
    if (!list) return;
    list.scrollTop = list.scrollTop + list.clientHeight >= list.scrollHeight - 1 ? 0 : list.scrollTop + list.clientHeight * 0.8;
    redraw(); // shows or hides "tap for more"
  } else if (c.kind === 'files') {
    const row = under(c, at, '[data-file]');
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

// The toys (toys.ts): the ball and the two fighters, moved straight in the DOM frame by frame, and only while something
// moves (a throw, a round). The rest of the page still redraws only on changes, as the Pi needs.
const toys = createToys();
const { ball, fighters } = toys;
let ballEl: HTMLDivElement | null = null;
let fighterEls: { path: SVGPathElement; head: SVGCircleElement }[] = [];
let frameId = 0;
let lastFrame = 0;
const aspect = () => innerWidth / innerHeight;
// What the spots say: Preact redraws them when it changes, the frames don't.
const toyLabels = () => `${ball.out} ${fighters.out} ${fighters.round}`;
function drawToys() {
  if (ballEl) ballEl.style.transform = `translate(${(ball.x - BALL_R) * innerHeight}px, ${(ball.y - BALL_R) * innerHeight}px)`;
  fighterEls.forEach((el, i) => {
    const p = pose(fighters.list[i]);
    el.path.setAttribute('d', p.d);
    el.head.setAttribute('cx', p.head[0].toFixed(4));
    el.head.setAttribute('cy', p.head[1].toFixed(4));
    el.head.setAttribute('r', p.r.toFixed(4));
  });
}
function frame(now: number) {
  const before = toyLabels();
  const moving = toys.advance(Math.max(0, Math.min(now - lastFrame, 100)) / 1000, cards, aspect());
  lastFrame = now;
  drawToys();
  frameId = moving ? requestAnimationFrame(frame) : 0;
  if (toyLabels() !== before) redraw(); // a round ended: "again"
}
// After anything that could move a toy or what it stands on: it runs until all settle again, usually one frame.
function roll() {
  toys.wake();
  if ((ball.out || fighters.out) && !frameId) {
    lastFrame = performance.now();
    frameId = requestAnimationFrame(frame);
  }
}
// The toys take a pointer that lands on one of them or on their spots; everything else goes to the cards.
function toy(phase: Phase, id: string, x: number, y: number, t: number) {
  const before = toyLabels();
  if (!toys.pointer(phase, id, x, y, t, aspect())) return false;
  drawToys();
  if (phase !== 'move') roll();
  if (toyLabels() !== before) redraw();
  return true;
}

// Tracker ids get a "t" prefix and mouse ids an "m", so the two can never collide.
function track(phase: Phase, id: string, x: number, y: number, t: number) {
  if (!toy(phase, id, x, y, t)) apply(pointer(phase, id, x, y, t));
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
    } else if (m?.type === 'today') {
      today = { day: m.day ?? null, usual: m.usual ?? null, glance: m.glance ?? null };
      redraw();
    } else if (m?.type === 'ask' && typeof m.state === 'string') {
      asking = { state: m.state, note: typeof m.note === 'string' ? m.note : null };
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

const mouse = (phase: Phase) => (e: PointerEvent) => {
  const [id, x, y] = [`m${e.pointerId}`, e.clientX / innerWidth, e.clientY / innerHeight];
  if (!toy(phase, id, x, y, e.timeStamp)) apply(pointer(phase, id, x, y, e.timeStamp));
};
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

// The chat card's turns, newest first, paged by taps (see tapped). Back to the top when a new turn comes in,
// and "tap for more" while some of it is below the card's edge.
function Turns({ font }: { font: { fontSize: string } }) {
  const ref = useRef<HTMLDivElement>(null);
  const newest = useRef<string | undefined>(undefined);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (chat.turns[0]?.id !== newest.current) {
      newest.current = chat.turns[0]?.id;
      el.scrollTop = 0;
    }
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    if (below !== more) setMore(below);
  });
  return (
    <>
      <div class="turns" ref={ref} style={font}>
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
      {more && (
        <div class="more" style={font}>
          tap for more
        </div>
      )}
    </>
  );
}

const ASK_LABEL: Record<string, string> = { listening: 'Listening… tap to send', working: 'Working on it…', thinking: 'Ekko is thinking…' };

// Ekko's budget is in dollars (en-US on Ekko's side). Dates come as yyyy-MM-dd, the Pi's own day.
const money = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const monthDay = (d: string) => new Date(`${d}T00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// The month's bills: how many are left and what they come to, then the next one, marked when it's past due.
function Bills({ g }: { g: Glance | null }) {
  if (!g) return null;
  if (g.status !== 'ok') return <p class="muted">{g.message}</p>;
  const n = g.next;
  const late = !!n?.date && n.date < new Date().toLocaleDateString('en-CA'); // en-CA writes yyyy-mm-dd
  return (
    <>
      <div>{g.billsLeft === 0 ? 'All bills paid this month.' : `${g.billsLeft} bill${g.billsLeft === 1 ? '' : 's'} left · ${money(g.leftToPay ?? 0)} to pay`}</div>
      {n && (
        <div class={late ? 'overdue' : 'muted'}>
          Next: {n.item} {money(n.amount)}
          {n.date && (late ? `, overdue since ${monthDay(n.date)}` : `, due ${monthDay(n.date)}`)}
        </div>
      )}
    </>
  );
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
    const font = { fontSize: `${b.w * 5}vw` };
    return (
      <>
        <Turns font={font} />
        <div class={`ask ${asking.state}`} data-ask style={font}>
          <b>{ASK_LABEL[asking.state] ?? 'Ask Ekko'}</b>
          {asking.note && <span>{asking.note}</span>}
        </div>
      </>
    );
  }
  if (c.kind === 'today') {
    const { day, usual, glance } = today;
    const font = { fontSize: `${b.w * 5}vw` };
    return (
      <>
        <div class="cal" style={{ fontSize: day?.error ? font.fontSize : `${b.w * 13}vw` }}>
          {!day ? '…' : day.error ? <p class="muted">{day.error}</p> : `${Math.round(day.total ?? 0).toLocaleString('en-US')} cal`}
        </div>
        <div class="foods" style={font}>
          {usual?.foods?.length === 0 && <p class="muted">Log food with Ekko and your usual foods show up here.</p>}
          {usual?.foods?.map((f) => (
            <div key={f.name} class="food" data-food={f.name}>
              <b>{f.name}</b>
              <span>{Math.round(f.caloriesEach)}</span>
            </div>
          ))}
        </div>
        {logged && (
          <div class="logged" style={font}>
            <span>{logged.message}</span>
            {logged.undo && <b data-undo>Undo</b>}
          </div>
        )}
        <div class="bills" style={font}>
          <Bills g={glance} />
        </div>
      </>
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
  useLayoutEffect(roll); // a card may have moved, come or gone under a toy
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
      <div class={`spot${ball.out ? ' out' : ''}`} style={{ width: `${BALL_SPOT.w * 100}vw`, height: `${BALL_SPOT.h * 100}vh`, transform: at(BALL_SPOT.x, BALL_SPOT.y) }}>
        {ball.out ? 'put away' : 'ball'}
      </div>
      <div class={`spot${fighters.out ? ' out' : ''}`} style={{ width: `${FIGHT_SPOT.w * 100}vw`, height: `${FIGHT_SPOT.h * 100}vh`, transform: at(FIGHT_SPOT.x, FIGHT_SPOT.y) }}>
        {!fighters.out ? 'fight' : fighters.round === 'over' ? 'again' : 'fighting'}
        {fighters.out && <small>hold: away</small>}
      </div>
      {fighters.out && (
        // The page's height is 1 unit, as in the toys' physics, so the fighters' poses go in as they are.
        <svg
          class="fighters"
          viewBox={`0 0 ${aspect()} 1`}
          ref={(el) => {
            fighterEls = el ? [...el.querySelectorAll('g')].map((g) => ({ path: g.querySelector('path')!, head: g.querySelector('circle')! })) : [];
            drawToys();
          }}
        >
          {[0, 1].map((i) => (
            <g key={i} class={`f${i}`}>
              <path />
              <circle />
            </g>
          ))}
        </svg>
      )}
      {ball.out && (
        <div
          class="ball"
          style={{ width: `${BALL_R * 200}vh`, height: `${BALL_R * 200}vh` }}
          ref={(el) => {
            ballEl = el;
            drawToys();
          }}
        />
      )}
      {[...pinches].map(([id, p]) => (
        <div key={id} class="pinch" style={{ transform: at(p.x, p.y) }} />
      ))}
      {!online && <div class="status">tracker offline</div>}
      {sheet && <img class="sheet" src={sheet} alt="" />}
    </>
  );
}

render(<App />, document.getElementById('app')!);
