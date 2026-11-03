// Pointers → card changes, one handler for the mouse and the tracker. Phase 1: drag only.
// Positions are 0–1 across the page, measured from the top-left, as in PROTOCOL.md.

export type Card = { id: string; x: number; y: number; w: number; h: number };
export type Phase = 'down' | 'move' | 'up' | 'cancel';

const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);

export function createGestures(cards: Card[]) {
  // Each live pointer holds one card, grabbed at an offset from its top-left corner.
  const grabs = new Map<string, { card: Card; dx: number; dy: number }>();

  // Returns true when a card moved, so the caller redraws only then.
  return function pointer(phase: Phase, id: string, x: number, y: number): boolean {
    if (phase === 'down') {
      const card = cards.findLast((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
      const held = [...grabs.values()].some((g) => g.card === card);
      if (card && !held) grabs.set(id, { card, dx: x - card.x, dy: y - card.y }); // a second pointer on a card is phase 2's resize
      return false;
    }
    const g = grabs.get(id);
    if (!g) return false;
    if (phase !== 'move') {
      grabs.delete(id);
      return false;
    }
    g.card.x = clamp(x - g.dx, 1 - g.card.w);
    g.card.y = clamp(y - g.dy, 1 - g.card.h);
    return true;
  };
}
