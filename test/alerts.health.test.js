const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../lib/db');
const { createAlerts } = require('../lib/alerts');
const { creditBudget, evaluateHealth } = require('../lib/health');

const HOUR = 3600 * 1000;

function setup(extra = {}) {
  const store = createStore({ dbPath: ':memory:' });
  const sent = []; let t = Date.now();   // a real clock: the cooldown compares against epoch time
  const alerts = createAlerts({ store, webhookUrl: 'https://hooks.example/x', post: async (u, b) => { sent.push({ u, b }); }, cooldownMs: 12 * HOUR, now: () => t, ...extra });
  return { store, sent, alerts, advance: ms => { t += ms; } };
}

test('an alert is logged and pushed to the webhook in both Discord and Slack shapes', async () => {
  const { alerts, sent, store } = setup();
  const r = await alerts.notify({ key: 'a', level: 'critical', message: 'Odds credits: 39 left' });
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].b.content.includes('Odds credits') && sent[0].b.text.includes('Odds credits'));
  assert.equal(store.recentEvents(5)[0].message, 'Odds credits: 39 left');
});

test('the same alert is not pushed again within the cooldown, but is again after it', async () => {
  const { alerts, sent, advance } = setup();
  await alerts.notify({ key: 'a', message: 'one' });
  const again = await alerts.notify({ key: 'a', message: 'one' });
  assert.equal(again.sent, false); assert.equal(again.reason, 'cooldown');
  advance(13 * HOUR);
  assert.equal((await alerts.notify({ key: 'a', message: 'one' })).sent, true);
  assert.equal(sent.length, 2);
});

test('different problems alert independently, and resolving re-arms an alert', async () => {
  const { alerts, sent } = setup();
  await alerts.notify({ key: 'a', message: 'one' });
  await alerts.notify({ key: 'b', message: 'two' });
  assert.equal(sent.length, 2);
  alerts.resolve('a');
  assert.equal((await alerts.notify({ key: 'a', message: 'one again' })).sent, true);
});

test('with no webhook it still records the event and says so', async () => {
  const store = createStore({ dbPath: ':memory:' });
  const alerts = createAlerts({ store, webhookUrl: undefined });
  const r = await alerts.notify({ key: 'a', message: 'x' });
  assert.equal(r.sent, false);
  assert.equal(store.recentEvents(1).length, 1);
  assert.equal(alerts.configured, false);
});

test('a failing webhook never throws into the caller', async () => {
  const store = createStore({ dbPath: ':memory:' });
  const alerts = createAlerts({ store, webhookUrl: 'https://x', post: async () => { throw new Error('boom'); } });
  const r = await alerts.notify({ key: 'a', message: 'x' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'boom');
});

test('credit budget: levels follow the thresholds', () => {
  assert.equal(creditBudget({ remaining: 250 }).level, 'ok');
  assert.equal(creditBudget({ remaining: 99 }).level, 'warn');
  assert.equal(creditBudget({ remaining: 39 }).level, 'critical');
  assert.equal(creditBudget({ remaining: null }).known, false);
  assert.equal(creditBudget({ remaining: 70, scanCost: 60 }).canScan, true);
  assert.equal(creditBudget({ remaining: 39, scanCost: 60 }).canScan, false);
});

test('credit budget: pace and runway only after the meter has run long enough to trust', () => {
  const now = Date.now();
  const fresh = creditBudget({ remaining: 100, usage: { since: new Date(now - 2 * HOUR).toISOString(), credits: 20 }, now });
  assert.equal(fresh.perDay, null);
  const aged = creditBudget({ remaining: 100, usage: { since: new Date(now - 24 * HOUR).toISOString(), credits: 20 }, now });
  assert.equal(aged.perDay, 20);
  assert.equal(aged.runwayDays, 5);
});

test('health: low credits make the overall status critical and the message names the cost of a scan', () => {
  const h = evaluateHealth({ odds: { configured: true, remaining: 39, usage: { credits: 0 } }, anthropicConfigured: true, balldontlieConfigured: true });
  assert.equal(h.status, 'critical');
  assert.match(h.checks.find(c => c.id === 'credits').detail, /scan costs about 60/);
});

test('health: a missing key is critical, stale stat files only warn, no test run warns', () => {
  const now = Date.now();
  const h = evaluateHealth({ odds: { configured: false }, anthropicConfigured: false, balldontlieConfigured: true,
    statFiles: { WNBA: { mtime: now - 65 * 24 * HOUR }, NBA: { mtime: now - 2 * HOUR } }, tests: null }, { now });
  const by = id => h.checks.find(c => c.id === id).level;
  assert.equal(by('odds'), 'critical');
  assert.equal(by('ai'), 'critical');
  assert.equal(by('file_WNBA'), 'warn');
  assert.equal(by('file_NBA'), 'ok');
  assert.equal(by('tests'), 'warn');
});

test('health: failing tests are critical; a job that failed warns; a healthy system is ok', () => {
  const base = { odds: { configured: true, remaining: 400, usage: {} }, anthropicConfigured: true, balldontlieConfigured: true, storage: { backend: 'sqlite', picks: 5 }, tests: { ts: new Date().toISOString(), passed: 40, failed: 0 } };
  assert.equal(evaluateHealth(base).status, 'ok');
  assert.equal(evaluateHealth({ ...base, tests: { ...base.tests, failed: 2 } }).status, 'critical');
  assert.equal(evaluateHealth({ ...base, jobs: { grade: { ok: false, error: 'x' } } }).status, 'warn');
  assert.equal(evaluateHealth({ ...base, storage: { backend: 'json', note: 'fallback' } }).status, 'warn');
});

test('the pace comes from the saved daily record when there is one, even right after a restart', () => {
  const now = Date.now();
  const b = creditBudget({ remaining: 90, dailyAverage: 30, usage: { since: new Date(now - 60000).toISOString(), credits: 0 }, now });
  assert.equal(b.perDay, 30); assert.equal(b.runwayDays, 3);
  assert.equal(creditBudget({ remaining: 90, dailyAverage: 0, now }).perDay, null);
});
