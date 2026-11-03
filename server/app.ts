import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

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

export const app = new Hono().use('/*', serveStatic({ root: './web/dist' }));
