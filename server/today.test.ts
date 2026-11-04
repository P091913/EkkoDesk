import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createToday, SAY, UNDO_MS } from './today.ts';

// Stand-ins for Ekko.Food and Ekko.Budget on one port: each path answers from `answers`, and every call is recorded.
async function mockEkko() {
  const calls: { method: string; path: string; key?: string; body?: any }[] = [];
  const answers: Record<string, [number, object]> = {
    '/food/day': [200, { status: 'ok', message: '1,240 calories today.', total: 1240, unknown: null }],
    '/food/usual': [200, { status: 'ok', message: '2 usual foods.', foods: [{ name: 'coffee', caloriesEach: 5 }, { name: 'toast', caloriesEach: 120.5 }, { name: '', caloriesEach: 1 }] }],
    '/food/log': [200, { status: 'ok', message: 'Logged coffee: 5 calories. 1,245 calories today.', total: 1245 }],
    '/food/undo': [200, { status: 'ok', message: 'Took off coffee. 1,240 calories today.', total: 1240 }],
    '/budget/glance': [200, { status: 'ok', message: '3 bills left.', billsLeft: 3, leftToPay: 1850, endingBalance: 400, next: { item: 'Rent', amount: 1200, date: '2026-11-05' } }],
  };
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c)).on('end', () => {
      const path = new URL(req.url!, 'http://x').pathname;
      calls.push({ method: req.method!, path: req.url!, key: req.headers['x-api-key'] as string, body: data ? JSON.parse(data) : undefined });
      const [status, body] = answers[path] ?? [404, {}];
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { calls, answers, base, close: () => server.close() };
}

function setup(base: string) {
  let t = 1_000_000;
  const pushed: any[] = [];
  const today = createToday({ name: 'Ekko.Food', base, key: 'food-key' }, { name: 'Ekko.Budget', base, key: 'budget-key' }, (m) => pushed.push(JSON.parse(m)), () => t);
  return { today, pushed, last: () => pushed.at(-1), later: (ms: number) => (t += ms) };
}

test('the card shows calories, usual foods and bills, and reads the budget at most every 10 minutes', async () => {
  const e = await mockEkko();
  const { today, pushed, last, later } = setup(e.base);
  await today.tick();
  assert.deepEqual(last(), {
    type: 'today',
    day: { total: 1240 },
    usual: { foods: [{ name: 'coffee', caloriesEach: 5 }, { name: 'toast', caloriesEach: 120.5 }] }, // the nameless one is dropped
    glance: { status: 'ok', message: '3 bills left.', billsLeft: 3, leftToPay: 1850, next: { item: 'Rent', amount: 1200, date: '2026-11-05' } },
  });
  assert.ok(e.calls.every((c) => c.key === (c.path.startsWith('/budget') ? 'budget-key' : 'food-key')));
  const glances = () => e.calls.filter((c) => c.path === '/budget/glance').length;

  later(9 * 60_000);
  await today.tick();
  assert.equal(glances(), 1); // cached
  assert.equal(pushed.length, 1); // nothing changed: nothing pushed
  await today.refresh(); // a tap on the card
  assert.equal(glances(), 2);
  later(11 * 60_000);
  await today.tick();
  assert.equal(glances(), 3);
  e.close();
});

test('a tap logs one usual food, and only the desk can undo it, once, just after', async () => {
  const e = await mockEkko();
  const { today, last, later } = setup(e.base);
  await today.tick();

  assert.deepEqual(await today.log('cake'), { status: 400, body: { ok: false, error: SAY.notUsual } });
  assert.deepEqual(await today.undo(), { status: 409, body: { ok: false, error: SAY.late } }); // nothing logged from the desk yet
  assert.deepEqual(await today.log('coffee'), { status: 200, body: { ok: true, message: 'Logged coffee: 5 calories. 1,245 calories today.' } });
  assert.deepEqual(e.calls.find((c) => c.path === '/food/log')!.body, { items: [{ food: 'coffee' }] });
  assert.deepEqual(last().day, { total: 1245 });

  later(UNDO_MS - 1000);
  assert.deepEqual(await today.undo(), { status: 200, body: { ok: true, message: 'Took off coffee. 1,240 calories today.' } });
  assert.equal(e.calls.find((c) => c.path === '/food/undo')!.method, 'POST');
  assert.deepEqual(last().day, { total: 1240 });
  assert.equal((await today.undo()).status, 409); // once only

  await today.log('coffee');
  later(UNDO_MS + 1);
  assert.equal((await today.undo()).status, 409); // too late: say "undo that" to Ekko
  assert.equal(e.calls.filter((c) => c.path === '/food/undo').length, 1);

  e.answers['/food/log'] = [200, { status: 'unknown', message: "Coffee isn't on your food list any more." }];
  assert.deepEqual(await today.log('coffee'), { status: 200, body: { ok: false, message: "Coffee isn't on your food list any more." } });
  assert.equal((await today.undo()).status, 409); // nothing was logged, so nothing to undo
  e.close();
});

test("each failure shows Ekko's sentence, or says which service isn't answering", async () => {
  const e = await mockEkko();
  const { today, last } = setup(e.base);
  e.answers['/budget/glance'] = [200, { status: 'not_found', message: "There's no November tab on the expenses sheet yet." }];
  await today.refresh();
  assert.deepEqual(last().glance, { status: 'not_found', message: "There's no November tab on the expenses sheet yet." });
  e.answers['/budget/glance'] = [502, { status: 'error', message: "Google Sheets didn't answer." }];
  await today.refresh();
  assert.deepEqual(last().glance, { status: 'error', message: "Google Sheets didn't answer." });
  e.answers['/budget/glance'] = [403, { error: 'forbidden' }];
  await today.refresh();
  assert.deepEqual(last().glance, { status: 'error', message: SAY.budget });
  e.close();

  await today.refresh(); // both services gone
  assert.deepEqual(last(), { type: 'today', day: { error: SAY.food }, usual: { error: SAY.food }, glance: { status: 'error', message: SAY.budget } });
  assert.deepEqual(await today.log('coffee'), { status: 400, body: { ok: false, error: SAY.notUsual } }); // the list is gone too
});
