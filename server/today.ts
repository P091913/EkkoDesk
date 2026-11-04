import type { Result } from './desk.ts';
import { call, isOk, poll, type Upstream } from './upstream.ts';

// The Today card (Ekko's DR-43): calories so far and your usual foods from Ekko.Food, the month's bills from Ekko.Budget.
// The keys stay here; the page only ever sees the `today` message and the answers to its taps.
const FOOD_MS = 120_000; // food also changes through Ekko and Telegram
const GLANCE_MS = 600_000; // each glance reads the Google Sheet
export const UNDO_MS = 15_000; // the page offers Undo for 10 s; a little longer here for a slow tap
const USUAL = 6;
export const SAY = {
  food: "Ekko's food diary isn't answering.",
  budget: "Ekko's budget isn't answering.",
  notUsual: "That isn't one of your usual foods any more.",
  late: 'Too late to undo that here. Ask Ekko to undo it.',
};

type Food = { name: string; caloriesEach: number };
type Next = { item: string; amount: number; date: string | null };
type Glance =
  | { status: 'ok'; message: string; billsLeft: number; leftToPay: number; next: Next | null }
  | { status: string; message: string };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max = 300): v is string => typeof v === 'string' && v.length <= max;
const food = (f: any): f is Food => str(f?.name, 100) && f.name.trim() !== '' && num(f.caloriesEach);

// Only the fields the card shows, each checked: the page trusts what comes from here.
function glanceOf(r: { status: number; body: any }): Glance {
  const b = r.body;
  if (isOk(r) && b?.status === 'ok' && str(b.message) && num(b.billsLeft) && num(b.leftToPay)) {
    const n = b.next;
    const next = n && str(n.item, 200) && num(n.amount) && (n.date === null || (str(n.date) && /^\d{4}-\d{2}-\d{2}$/.test(n.date)))
      ? { item: n.item, amount: n.amount, date: n.date }
      : null;
    return { status: 'ok', message: b.message, billsLeft: b.billsLeft, leftToPay: b.leftToPay, next };
  }
  // No tab for this month (200), or Google failed (502 {status:"error"}): Ekko's own sentence.
  if ((b?.status === 'not_found' || b?.status === 'error') && str(b.message)) return { status: b.status, message: b.message };
  return { status: 'error', message: SAY.budget };
}

export function createToday(foodUp: Upstream, budgetUp: Upstream, push: (msg: string) => void, now = Date.now, everyMs = FOOD_MS) {
  let day: { total: number } | { error: string } | null = null;
  let usual: { foods: Food[] } | { error: string } | null = null;
  let glance: Glance | null = null;
  let glancedAt = -Infinity;
  let glancing: Promise<void> | undefined;
  let logged: number | undefined; // when the desk last logged a food, for its one undo
  let last = '';

  function publish() {
    const msg = JSON.stringify({ type: 'today', day, usual, glance });
    if (msg !== last) push((last = msg));
  }

  async function readFood() {
    const [d, u] = await Promise.all([call(foodUp, '/food/day'), call(foodUp, `/food/usual?limit=${USUAL}`)]);
    day = isOk(d) && num(d.body?.total) ? { total: d.body.total } : { error: SAY.food };
    usual = isOk(u) && Array.isArray(u.body?.foods) ? { foods: u.body.foods.filter(food).slice(0, USUAL).map((f: Food) => ({ name: f.name, caloriesEach: f.caloriesEach })) } : { error: SAY.food };
  }

  // At most every 10 minutes unless `force`; one at a time.
  function readGlance(force: boolean) {
    if (glancing || (!force && now() - glancedAt < GLANCE_MS)) return glancing;
    glancing = call(budgetUp, '/budget/glance', 20_000)
      .then((r) => {
        glance = glanceOf(r);
        glancedAt = now();
      })
      .finally(() => (glancing = undefined));
    return glancing;
  }

  async function tick(force = false) {
    await Promise.all([readFood(), readGlance(force)]);
    publish();
  }

  return {
    tick: () => tick(),
    latest: () => last || JSON.stringify({ type: 'today', day, usual, glance }),
    // A tap on the card: everything now, the budget included.
    refresh: () => tick(true),
    async log(name: unknown): Promise<Result> {
      if (usual === null || !('foods' in usual) || !usual.foods.some((f) => f.name === name)) return { status: 400, body: { ok: false, error: SAY.notUsual } };
      const r = await call(foodUp, '/food/log', 10_000, { items: [{ food: name }] });
      if (!isOk(r) || !str(r.body?.message)) return { status: 502, body: { ok: false, error: SAY.food } };
      const ok = r.body.status === 'ok'; // "unknown": removed from the list meanwhile
      if (ok) logged = now();
      if (num(r.body.total)) day = { total: r.body.total };
      publish();
      void tick(); // the usual list may have changed order
      return { status: 200, body: { ok, message: r.body.message } };
    },
    // Ekko's undo takes off today's last log, whoever made it: so only once, and only just after the desk's own tap.
    async undo(): Promise<Result> {
      if (logged === undefined || now() - logged > UNDO_MS) return { status: 409, body: { ok: false, error: SAY.late } };
      logged = undefined;
      const r = await call(foodUp, '/food/undo', 10_000, {});
      if (!isOk(r) || !str(r.body?.message)) return { status: 502, body: { ok: false, error: SAY.food } };
      if (num(r.body.total)) day = { total: r.body.total };
      publish();
      return { status: 200, body: { ok: true, message: r.body.message } };
    },
    // Polls while the Today card is out and a page is open.
    set: poll(() => tick(), everyMs),
  };
}

export type Today = ReturnType<typeof createToday>;
