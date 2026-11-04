import { isOk, poll, type Result } from './upstream.ts';

// The fields of the Brain's GET /trace events that the chat card uses.
export type TraceEvent = { seq: number; ts: string; requestId: string; channel: string; step: string; ok?: boolean | null; text?: string | null };
export type Turn = { id: string; channel: string; at: string; said?: string; reply?: string; state: 'run' | 'ok' | 'err' };

const SAID = 80; // cut short so one long turn can't fill the card
const REPLY = 160;
const FULL = 2000; // a desk question's whole answer, from /message: /trace keeps only one line of 160
const TURNS = 10;
const KEEP = 1000; // events held between polls

const cut = (s: string | null | undefined, n: number) => (s == null ? undefined : s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// One per message, newest first: what was said and the answer. From ekko-deck's turnsOf, without the model/tool path.
// `full` holds whole answers by request id, for questions asked from the desk.
export function turnsOf(events: TraceEvent[], now = Date.now(), full = new Map<string, string>()): Turn[] {
  const turns = new Map<string, Turn>();
  for (const e of events) {
    let t = turns.get(e.requestId);
    if (!t) turns.set(e.requestId, (t = { id: e.requestId, channel: e.channel, at: e.ts, state: 'run' }));
    if (e.step === 'request') t.said = cut(e.text, SAID);
    else if (e.step === 'error' || ((e.step === 'tool' || e.step === 'agent_tool') && e.ok === false)) t.state = 'err';
    else if (e.step === 'reply') {
      t.reply = cut(e.text, REPLY);
      if (t.state === 'run') t.state = 'ok';
    }
  }
  for (const t of turns.values()) {
    const whole = full.get(t.id);
    if (whole !== undefined) {
      t.reply = whole;
      if (t.state === 'run') t.state = 'ok'; // the answer can come before /trace's reply line
    }
    // A turn with no reply after five minutes never got one (Ekko restarted mid-turn).
    if (t.state === 'run' && now - Date.parse(t.at) > 300_000) t.state = 'err';
  }
  return [...turns.values()].reverse();
}

// Polls /trace while `set(true)`, and pushes {"type":"turns"} to the pages only when the turns change.
export function createChat(get: (path: string) => Promise<Result>, push: (msg: string) => void, everyMs = 2000) {
  let boot = '';
  let seq = 0;
  let events: TraceEvent[] = [];
  let last = JSON.stringify({ type: 'turns', turns: [] });
  let down: string | undefined;
  const full = new Map<string, string>();

  function publish(error?: string) {
    down = error;
    const msg = JSON.stringify({ type: 'turns', turns: turnsOf(events, Date.now(), full).slice(0, TURNS), ...(error && { error }) });
    if (msg !== last) push((last = msg));
  }

  async function tick() {
    const r = await get(`/trace?after=${seq}`);
    if (!isOk(r)) return publish(r.body?.error ?? 'Ekko unavailable');
    if (boot && r.body.boot !== boot) {
      // Ekko restarted and its numbers began again: the next poll loads everything afresh.
      [boot, seq, events] = ['', 0, []];
      return;
    }
    const list: TraceEvent[] = Array.isArray(r.body.events) ? r.body.events : [];
    boot = r.body.boot;
    events = [...events, ...list].slice(-KEEP);
    if (list.length) seq = list[list.length - 1].seq;
    publish();
  }

  // A desk question's whole answer, from the Brain's /message reply, shown in place of /trace's cut line.
  function answer(requestId: string, text: string) {
    full.set(requestId, text.length > FULL ? `${text.slice(0, FULL - 1)}…` : text);
    if (full.size > TURNS) full.delete(full.keys().next().value!);
    publish(down);
  }

  // `set` polls only while the chat card is out and a page is watching.
  return { tick, answer, latest: () => last, set: poll(tick, everyMs) };
}
