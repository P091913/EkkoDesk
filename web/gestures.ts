// Pointers → card changes, one handler for the mouse and the tracker: drag, tap, two-pointer resize, dock, stacking.
// Positions are 0–1 across the page, measured from the top-left, as in PROTOCOL.md. Times are ms on the pointer's own clock.

export type Card = { id: string; kind: string; x: number; y: number; w: number; h: number; z: number; docked: boolean };
export type Phase = 'down' | 'move' | 'up' | 'cancel';
export type Result = { redraw: boolean; tap?: Card; save?: Card };

const TAP_MS = 350;
const TAP_MOVE = 0.01;
const MIN = 0.05; // smallest card side
export const STRIP = 0.9; // releasing a drag below this docks the card
export const CHIP = { w: 0.1, h: 0.05, y: 0.925 };

const NONE: Result = { redraw: false };
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

// A docked card is drawn and hit as a chip; its w and h are kept for when it comes back out.
export const box = (c: Card) => (c.docked ? { x: c.x, y: c.y, w: CHIP.w, h: CHIP.h } : c);

// Scales about the card's centre, keeping its shape, its size within limits, and the card on the page.
function scale(c: Card, w0: number, h0: number, s: number, cx: number, cy: number) {
  s = clamp(s, MIN / Math.min(w0, h0), 1 / Math.max(w0, h0));
  c.w = w0 * s;
  c.h = h0 * s;
  c.x = clamp(cx - c.w / 2, 0, 1 - c.w);
  c.y = clamp(cy - c.h / 2, 0, 1 - c.h);
}

type Grab = { id: string; dx: number; dy: number; x: number; y: number; x0: number; y0: number; t0: number; moved: boolean };
type Resize = { d0: number; w0: number; h0: number; cx: number; cy: number };

// Cards are looked up by id on every event, so a new `state` from the server mid-drag doesn't strand a grab.
export function createGestures(cards: () => Card[]) {
  const grabs = new Map<string, Grab>();
  const resizes = new Map<string, Resize>();

  const byId = (id: string) => cards().find((c) => c.id === id);
  const on = (cardId: string) => [...grabs.values()].filter((g) => g.id === cardId);
  const top = (x: number, y: number) =>
    cards()
      .filter((c) => {
        const b = box(c);
        return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
      })
      .sort((a, b) => b.z - a.z)[0];
  const raise = (c: Card) => {
    if (cards().some((o) => o !== c && o.z >= c.z)) c.z = Math.max(...cards().map((o) => o.z)) + 1;
  };

  function pointer(phase: Phase, id: string, x: number, y: number, t: number): Result {
    if (phase === 'down') {
      const card = top(x, y);
      if (!card) return NONE;
      const held = on(card.id);
      if (held.length >= 2 || (held.length === 1 && card.docked)) return NONE; // chips don't resize
      if (held.length === 1) {
        resizes.set(card.id, { d0: dist(held[0], { x, y }), w0: card.w, h0: card.h, cx: card.x + card.w / 2, cy: card.y + card.h / 2 });
      }
      grabs.set(id, { id: card.id, dx: x - card.x, dy: y - card.y, x, y, x0: x, y0: y, t0: t, moved: false });
      raise(card);
      return { redraw: true };
    }

    const g = grabs.get(id);
    if (!g) return NONE;
    const card = byId(g.id);
    if (!card) {
      grabs.delete(id); // the card is gone from the server's state
      return NONE;
    }

    if (phase === 'move') {
      g.x = x;
      g.y = y;
      if (dist(g, { x: g.x0, y: g.y0 }) >= TAP_MOVE) g.moved = true;
      const r = resizes.get(card.id);
      if (r) {
        const [a, b] = on(card.id);
        scale(card, r.w0, r.h0, dist(a, b) / Math.max(r.d0, 1e-6), r.cx, r.cy);
      } else {
        const b = box(card);
        card.x = clamp(x - g.dx, 0, 1 - b.w);
        card.y = clamp(y - g.dy, 0, 1 - b.h);
      }
      return { redraw: true };
    }

    // up or cancel
    grabs.delete(id);
    const resized = resizes.delete(card.id);
    const [rest] = on(card.id);
    if (rest) {
      // One pointer left after a resize: it carries on dragging from where it is, and can't become a tap.
      Object.assign(rest, { dx: rest.x - card.x, dy: rest.y - card.y, moved: true });
      return { redraw: true };
    }
    if (phase === 'up' && !resized && !g.moved && t - g.t0 <= TAP_MS) return { redraw: true, tap: card, save: card };
    if (phase === 'up' && !resized && g.moved) card.docked = y > STRIP;
    if (card.docked) {
      card.x = clamp(card.x, 0, 1 - CHIP.w);
      card.y = CHIP.y; // chips sit in a line in the strip
    } else {
      card.x = clamp(card.x, 0, 1 - card.w);
      card.y = clamp(card.y, 0, 1 - card.h);
    }
    return { redraw: true, save: card };
  }

  // The mouse wheel stands in for a two-pointer resize. Returns the card it changed.
  function wheel(x: number, y: number, factor: number): Card | undefined {
    const card = top(x, y);
    if (!card || card.docked || on(card.id).length) return undefined;
    scale(card, card.w, card.h, factor, card.x + card.w / 2, card.y + card.h / 2);
    return card;
  }

  return { pointer, wheel, held: (cardId: string) => on(cardId).length > 0 };
}
