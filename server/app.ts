import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Ask } from './ask.ts';
import type { Desk, Result } from './desk.ts';
import type { Files } from './files.ts';

const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const sha = (s: string) => createHash('sha256').update(s).digest();

// Hashing first gives timingSafeEqual equal-length inputs. No key configured means nobody gets in.
export function keyOk(given: string | undefined, expected = process.env.DESK_TRACKER_KEY): boolean {
  return !!expected && !!given && timingSafeEqual(sha(given), sha(expected));
}

// Browsers can't add X-Desk to a WebSocket upgrade, but they always send Origin:
// a foreign page fails the Origin check, and a rebound DNS name fails the Host check.
export function pageOk(host: string | undefined, origin: string | undefined): boolean {
  if (!host || !origin || !local.test(host)) return false;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && local.test(u.host);
  } catch {
    return false;
  }
}

const body = (c: Context) => c.req.json().catch(() => undefined);
const reply = (c: Context, r: Result) => c.json(r.body, r.status);

// Ekko's Brain. No Host check: it calls through host.docker.internal now and the Pi's tailnet name in phase 4.
const brain: MiddlewareHandler = async (c, next) => {
  if (!keyOk(c.req.header('x-api-key'), process.env.DESK_BRAIN_KEY)) {
    return c.json({ ok: false, error: 'Wrong or missing X-Api-Key.' }, 401);
  }
  await next();
};

export const createApp = (desk: Desk, files: Files, ask: Pick<Ask, 'start' | 'stop'>) =>
  new Hono()
    // The page's routes. Loopback alone doesn't stop another page open in a browser on the Pi from calling us
    // (CSRF, DNS rebinding): the custom header forces a CORS preflight we never approve, and the Host check rejects rebound names.
    .use('/api/desk/*', async (c, next) => {
      if (c.req.header('x-desk') !== '1' || !local.test(c.req.header('host') ?? '')) {
        return c.json({ ok: false, error: 'forbidden' }, 403);
      }
      await next();
    })
    .patch('/api/desk/widgets/:id', async (c) => reply(c, desk.patch(c.req.param('id'), await body(c))))
    .delete('/api/desk/widgets/:id', (c) => reply(c, desk.remove(c.req.param('id'))))
    .post('/api/desk/timer', async (c) => reply(c, desk.timer(await body(c))))
    .post('/api/desk/viewers', async (c) => {
      const b = await body(c);
      return reply(c, files.openListed(typeof b?.file === 'string' ? b.file : ''));
    })
    .get('/api/desk/files/:id', (c) => files.serve(c.req.param('id')))
    // How it went comes to every page as an `ask` message.
    .post('/api/desk/ask', async (c) => {
      const action: unknown = (await body(c))?.action;
      if (action !== 'start' && action !== 'stop') return c.json({ ok: false, error: 'action must be start or stop.' }, 400);
      ask[action]();
      return c.json({ ok: true });
    })
    .use('/api/notes', brain)
    .post('/api/notes', async (c) => {
      const b = await body(c);
      return reply(c, desk.addNote(typeof b === 'object' && b !== null ? b.text : undefined));
    })
    .use('/api/files/*', brain)
    .post('/api/files/show', async (c) => {
      const b = await body(c);
      const name = typeof b === 'object' && b !== null ? b.name : undefined;
      if (typeof name !== 'string' || name.length > 60) {
        return c.json({ ok: false, error: 'name must be text of at most 60 characters.' }, 400);
      }
      return reply(c, await files.show(name));
    })
    .use('/*', serveStatic({ root: './web/dist' }));
