import { call, type Upstream } from './upstream.ts';

// Ask Ekko by voice (PLAN.md): the tracker records the PC's microphone between two taps and sends back what it heard,
// which goes to the Brain as the "desk" channel. The turn shows in the chat card through /trace, with the whole answer
// from /message in place of /trace's one cut line, so an approval question can be read in full before it's answered.
export const MAX_TEXT = 500; // the Brain's MessageRequest.MaxTextLength
const BRAIN_MS = 150_000; // a server-ops run can take up to 120 s
export const SAY = {
  noTracker: "The tracker isn't running, so I can't hear you.",
  nothing: "I didn't catch that.",
  noText: "I couldn't transcribe that right now.",
  tooLong: "That's longer than Ekko takes in one message.",
  refused: "Ekko refused the desk's key, so I couldn't pass that on.",
  down: "Ekko isn't answering.",
};

// listening: recording. working: the tracker is transcribing. thinking: the Brain has the question.
type State = 'idle' | 'listening' | 'working' | 'thinking';

export function createAsk(
  brain: Upstream,
  toTracker: (msg: string) => boolean,
  push: (msg: string) => void,
  answer: (requestId: string, text: string) => void,
  waitMs = 90_000,
) {
  let state: State = 'idle';
  let note: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const latest = () => JSON.stringify({ type: 'ask', state, note });
  const listen = (on: boolean) => toTracker(JSON.stringify({ v: 1, type: 'listen', on }));

  function set(next: State, n: string | null = null) {
    state = next;
    note = n;
    clearTimeout(timer);
    // A tracker that never answers (an old one ignores `listen`) can't leave the button stuck. The Brain has its own timeout.
    if (next === 'listening' || next === 'working') timer = setTimeout(() => set('idle', SAY.noText), waitMs);
    push(latest());
  }

  return {
    latest,
    start() {
      if (state !== 'idle') return;
      if (listen(true)) set('listening');
      else set('idle', SAY.noTracker);
    },
    stop() {
      if (state !== 'listening') return;
      listen(false);
      set('working');
    },
    // From the tracker: {text} or {error}. One that arrives after a give-up, or a second one, is dropped.
    async heard(m: { text?: unknown; error?: unknown }) {
      if (state !== 'listening' && state !== 'working') return;
      if (typeof m.error === 'string') return set('idle', m.error.slice(0, 200));
      const text = typeof m.text === 'string' ? m.text.trim() : '';
      if (!text) return set('idle', SAY.nothing); // the Brain would 400 it, and that never reaches /trace
      if (text.length > MAX_TEXT) return set('idle', SAY.tooLong);
      set('thinking');
      const r = await call(brain, '/message', BRAIN_MS, { text, channel: 'desk', conversationId: 'desk' });
      if (r.status === 200 && typeof r.body?.requestId === 'string' && typeof r.body.text === 'string') {
        answer(r.body.requestId, r.body.text);
        return set('idle');
      }
      console.error('ask:', r.status, r.body?.error);
      // The Brain's own reason for a 400 (as Ekko's glasses say it); a refused key; anything else is Ekko being down.
      if (r.status === 400 && typeof r.body?.error === 'string') set('idle', `Ekko couldn't take that: ${r.body.error.slice(0, 200)}.`);
      else set('idle', r.status === 401 ? SAY.refused : SAY.down);
    },
    // The tracker went away mid-question. A question already with the Brain carries on.
    lost() {
      if (state === 'listening' || state === 'working') set('idle', SAY.noTracker);
    },
  };
}

export type Ask = ReturnType<typeof createAsk>;
