// Copied from ekko-deck's server/upstream.ts, without its Activity feed: one way to call another service.
export type Upstream = { name: string; base?: string; key?: string };
export type Result = { status: number; body: any };

// Every failure comes back as JSON {ok:false, error}, so a dead service only breaks its own card.
export async function call(up: Upstream, path: string, timeoutMs = 10_000): Promise<Result> {
  if (!up.base) return { status: 503, body: { ok: false, error: `${up.name} not configured` } };
  try {
    const res = await fetch(up.base + path, {
      headers: up.key ? { 'X-Api-Key': up.key } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: { ok: false, error: text.slice(0, 200) || `HTTP ${res.status}` } };
    }
  } catch (e) {
    const timedOut = (e as Error).name === 'TimeoutError';
    return { status: 502, body: { ok: false, error: `${up.name} ${timedOut ? 'timed out' : 'unavailable'}` } };
  }
}

export const isOk = (r: Result) => r.status >= 200 && r.status < 300;

// Runs `tick` every `everyMs` while switched on. `run` is bumped on every start and stop,
// so a tick still in flight from before a stop can't start a second loop.
export function poll(tick: () => Promise<unknown>, everyMs: number) {
  let on = false;
  let run = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function loop(mine: number) {
    await tick().catch((e) => console.error('poll:', e)); // a throw would end the loop, and crash Node as an unhandled rejection
    if (mine === run) timer = setTimeout(() => loop(mine), everyMs);
  }
  return (next: boolean) => {
    if (next === on) return;
    on = next;
    run++;
    clearTimeout(timer);
    if (on) loop(run);
  };
}
