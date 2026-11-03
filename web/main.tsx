import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { box, createGestures, STRIP, type Card, type Phase, type Result } from './gestures';

let cards: Card[] = []; // replaced by every `state` from the server
const { pointer, wheel, held } = createGestures(() => cards);
const pinches = new Map<string, { x: number; y: number }>(); // live tracker pinches, drawn as rings
const taps = new Map<string, number>(); // shortcut: placeholder cards count taps until phase 3 gives them real actions
let online = false;
let sheet: string | null = null; // the calibration image, while the tracker is calibrating
let redraw = () => {};

const phases = new Set(['down', 'move', 'up', 'cancel']);

// Saved on release, never during a drag. The server pushes the new `state` back to every page.
function save(c: Card) {
  const { x, y, w, h, z, docked } = c;
  fetch(`/api/desk/widgets/${encodeURIComponent(c.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Desk': '1' },
    body: JSON.stringify({ x, y, w, h, z, docked }),
  })
    .then(async (r) => {
      if (!r.ok) console.error('save failed:', (await r.json()).error);
    })
    .catch((e) => console.error('save failed:', e));
}

function apply(r: Result) {
  if (r.tap) taps.set(r.tap.id, (taps.get(r.tap.id) ?? 0) + 1);
  if (r.save) save(r.save);
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
      // A card still held keeps the page's copy; the server's is from before the drag and would make it jump.
      cards = m.widgets.map((w: Card) => (held(w.id) && cards.find((c) => c.id === w.id)) || w);
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

function App() {
  const [, set] = useState(0);
  useEffect(() => {
    redraw = () => set((n) => n + 1);
    connect();
  }, []);
  return (
    <>
      <div class="strip" style={{ top: `${STRIP * 100}vh` }} />
      {cards.map((c) => {
        const b = box(c);
        return (
          <div
            key={c.id}
            class={c.docked ? 'card chip' : 'card'}
            style={{ width: `${b.w * 100}vw`, height: `${b.h * 100}vh`, transform: at(b.x, b.y), zIndex: c.z }}
          >
            {c.kind}
            {!c.docked && taps.get(c.id) ? ` · ${taps.get(c.id)} taps` : ''}
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
