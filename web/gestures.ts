// Pointers → card changes, one handler for the mouse and the tracker: drag, tap, two-pointer resize, dock, trash, stacking.
// Positions are 0–1 across the page, measured from the top-left, as in PROTOCOL.md. Times are ms on the pointer's own clock.

// The layout fields, plus each kind's own (PROTOCOL.md): notes `text` and `added`, the timer `endsAt` or `leftMs`,
// viewers `file`, `name`, `type`, `page` and `added`.
export type Card = {
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
export type Phase = 'down' | 'move' | 'up' | 'cancel';
// `at` is where a tap landed inside the card, 0–1: tracker taps aren't DOM clicks, so the page hit-tests with it.
export type Result = { redraw: boolean; tap?: Card; at?: { x: number; y: number }; save?: Card; remove?: Card };

const TAP_MS = 350;
const TAP_MOVE = 0.01;
const MIN = 0.05; // smallest card side
export const STRIP = 0.9; // releasing a drag below this docks the card
export const CHIP = { w: 0.1, h: 0.05, y: 0.925 };
// Notes and viewers only: let go here after holding it there HOLD_MS to remove it. A quicker release just docks it.
export const TRASH = { x: 0.9, y: STRIP, w: 0.1, h: 1 - STRIP };
// The toys' spots, at the other end of the strip: the ball's (ball.ts), then the fighters' (fighters.ts).
export const BALL_SPOT = { x: 0, y: STRIP, w: 0.08, h: 1 - STRIP };
export const FIGHT_SPOT = { x: 0.08, y: STRIP, w: 0.08, h: 1 - STRIP };
const TOYS_END = FIGHT_SPOT.x + FIGHT_SPOT.w;
export const HOLD_MS = 600;
const TRASHABLE = new Set(['note', 'viewer']);
const inTrash = (x: number, y: number) => x >= TRASH.x && y >= TRASH.y;

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

// `bin`: when this pointer took a note over the trash.
type Grab = { id: string; dx: number; dy: number; x: number; y: number; x0: number; y0: number; t0: number; moved: boolean; bin?: number };
type Resize = { d0: number; w0: number; h0: number; cx: number; cy: number };

// Cards are looked up by id on every event, so a new `state` from the server mid-drag doesn't strand a grab.
export function createGestures(cards: () => Card[]) {
  const grabs = new Map<string, Grab>();
  const resizes = new Map<string, Resize>();

  const byId = (id: string) => cards().find((c) => c.id === id);
  const on = (cardId: string) => [...grabs.values()].filter((g) => g.id === cardId);
  // On a z tie the later card wins, as it's the one drawn on top (a tap and a server change can raise two cards to the same z).
  const top = (x: number, y: number) =>
    cards()
      .filter((c) => {
        const b = box(c);
        return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
      })
      .reduce<Card | undefined>((t, c) => (!t || c.z >= t.z ? c : t), undefined);
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
      // A held hand sends no moves, so the time is kept here and checked on release.
      if (TRASHABLE.has(card.kind)) g.bin = inTrash(x, y) ? (g.bin ?? t) : undefined;
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
    if (phase === 'up' && !resized && g.bin !== undefined && inTrash(x, y) && t - g.bin >= HOLD_MS) return { redraw: true, remove: card };
    if (phase === 'up' && !resized && !g.moved && t - g.t0 <= TAP_MS) {
      const b = box(card);
      return { redraw: true, tap: card, at: { x: (x - b.x) / b.w, y: (y - b.y) / b.h }, save: card };
    }
    if (phase === 'up' && !resized && g.moved) card.docked = y > STRIP;
    if (card.docked) {
      card.x = clamp(card.x, TOYS_END, TRASH.x - CHIP.w); // between the toys' spots and the trash, never under them
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

  return {
    pointer,
    wheel,
    held: (cardId: string) => on(cardId).length > 0,
    trashing: () => [...grabs.values()].some((g) => g.bin !== undefined), // a note or viewer is over the trash
  };
}
