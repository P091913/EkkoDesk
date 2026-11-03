import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { createGestures, type Card, type Phase } from './gestures';

// shortcut: one card held only in page memory; phase 2 saves positions on the server.
const cards: Card[] = [{ id: 'card', x: 0.4, y: 0.4, w: 0.2, h: 0.2 }];
const pointer = createGestures(cards);
const pinches = new Map<string, { x: number; y: number }>(); // live tracker pinches, drawn as rings
let online = false;
let redraw = () => {};

const phases = new Set(['down', 'move', 'up', 'cancel']);

// Tracker ids get a "t" prefix and mouse ids an "m", so the two can never collide.
function track(phase: Phase, id: string, x: number, y: number) {
  pointer(phase, id, x, y);
  if (phase === 'down' || phase === 'move') pinches.set(id, { x, y });
  else pinches.delete(id);
  redraw();
}

function setOnline(on: boolean) {
  online = on;
  if (!on) for (const id of [...pinches.keys()]) track('cancel', id, 0, 0); // a lost tracker can't send `up`
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
      track(m.phase, `t${m.id}`, m.x, m.y);
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
  if (pointer(phase, `m${e.pointerId}`, e.clientX / innerWidth, e.clientY / innerHeight)) redraw();
};
addEventListener('pointerdown', mouse('down'));
addEventListener('pointermove', mouse('move'));
addEventListener('pointerup', mouse('up'));
addEventListener('pointercancel', mouse('cancel'));

const at = (x: number, y: number) => `translate(${x * 100}vw, ${y * 100}vh)`;

function App() {
  const [, set] = useState(0);
  useEffect(() => {
    redraw = () => set((n) => n + 1);
    connect();
  }, []);
  return (
    <>
      {cards.map((c) => (
        <div key={c.id} class="card" style={{ width: `${c.w * 100}vw`, height: `${c.h * 100}vh`, transform: at(c.x, c.y) }}>
          drag me
        </div>
      ))}
      {[...pinches].map(([id, p]) => (
        <div key={id} class="pinch" style={{ transform: at(p.x, p.y) }} />
      ))}
      {!online && <div class="status">tracker offline</div>}
    </>
  );
}

render(<App />, document.getElementById('app')!);
