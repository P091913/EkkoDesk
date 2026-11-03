import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Desk } from './desk.ts';

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

export const createApp = (desk: Desk) =>
  new Hono()
    // Loopback alone doesn't stop another page open in a browser on the Pi from calling us (CSRF, DNS rebinding):
    // the custom header forces a CORS preflight we never approve, and the Host check rejects rebound names.
    .use('/api/*', async (c, next) => {
      if (c.req.header('x-desk') !== '1' || !local.test(c.req.header('host') ?? '')) {
        return c.json({ ok: false, error: 'forbidden' }, 403);
      }
      await next();
    })
    .patch('/api/desk/widgets/:id', async (c) => {
      const r = desk.patch(c.req.param('id'), await c.req.json().catch(() => undefined));
      return c.json(r.body, r.status);
    })
    .use('/*', serveStatic({ root: './web/dist' }));
