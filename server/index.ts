import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApp, keyOk, pageOk } from './app.ts';
import { createDesk, type Widget } from './desk.ts';

const port = Number(process.env.PORT ?? 8081);
if (!process.env.DESK_TRACKER_KEY) console.warn('DESK_TRACKER_KEY is not set: every tracker will be refused');

const trackers = new Set<WebSocket>();
const pages = new Set<WebSocket>();

const status = () => JSON.stringify({ type: 'tracker', connected: trackers.size > 0 });
const state = (widgets: Widget[]) => JSON.stringify({ type: 'state', widgets });
const toPages = (msg: string) => pages.forEach((p) => p.send(msg));

const desk = createDesk('data/desk.json', (widgets) => toPages(state(widgets)));

// Loopback only: phase 4's `tailscale serve` is the one way in from the network.
const server = serve({ fetch: createApp(desk).fetch, hostname: '127.0.0.1', port }, () =>
  console.log(`ekko-desk on http://127.0.0.1:${port}`),
) as Server;

// 1 MB fits the calibration PNG with room to spare.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

server.on('upgrade', (req, socket, head) => {
  // Node drops its own error handler on upgrade sockets; an unhandled reset would crash the server.
  socket.on('error', () => {});
  const path = new URL(req.url ?? '/', 'http://x').pathname;

  if (path === '/ws/tracker' && keyOk(req.headers['x-api-key'] as string | undefined)) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      trackers.add(ws);
      if (trackers.size === 1) toPages(status());
      ws.on('error', (e) => console.error('tracker:', e.message));
      // Passed on unchanged: the tracker is authenticated, and the page ignores what it doesn't know.
      ws.on('message', (data, isBinary) => {
        if (!isBinary) toPages(data.toString());
      });
      ws.on('close', () => {
        trackers.delete(ws);
        if (trackers.size === 0) toPages(status());
      });
    });
  } else if (path === '/ws/page' && pageOk(req.headers.host, req.headers.origin)) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      pages.add(ws);
      ws.send(status());
      ws.send(state(desk.widgets()));
      ws.on('error', (e) => console.error('page:', e.message));
      ws.on('close', () => pages.delete(ws));
    });
  } else {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  }
});
