const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../lib/db');
const E = require('../lib/errors');
const { createAlerts } = require('../lib/alerts');

test('scrub removes emails, keys, tokens and long ids', () => {
  const s = E.scrub('failed for maya@example.com with Bearer abc123 and sk-ant-api03-ABCDEFGH and sk_live_abcdefghij12 token ' + 'a'.repeat(43));
  assert.doesNotMatch(s, /maya@|abc123|ABCDEFGH|abcdefghij12|aaaaaaaa/); assert.match(s, /\[email\]/); assert.match(s, /\[token\]/);
  assert.equal(E.scrub('ab '.repeat(300), 50).length, 50); assert.equal(E.scrub(null), ''); assert.equal(E.scrub({ a: 1 }), '[object Object]');
});
test('routes lose their query string and their ids', () => {
  assert.equal(E.routeOf('get', '/api/prop-context?player=Nikola%20Jokic&email=a@b.com'), 'GET /api/prop-context');
  assert.equal(E.routeOf('POST', '/api/clv/12345/result'), 'POST /api/clv/:id/result');
  assert.equal(E.routeOf('GET', '/auth/reset/' + 'Ab1_'.repeat(11)), 'GET /auth/reset/:id');
  assert.equal(E.routeOf(null, undefined), '');
});
function rig(over = {}) {
  const store = createStore({ dbPath: ':memory:' }); let t = Date.parse('2026-10-12T12:00:00Z'); const posts = [];
  const alerts = createAlerts({ store, webhookUrl: 'https://hooks.example/x', post: async (u, b) => { posts.push(b.text); }, now: () => t });
  const log = E.createErrorLog({ store, alerts, now: () => t, ...over });
  return { store, log, posts, advance: ms => { t += ms; } };
}
test('an error is stored scrubbed, grouped with repeats, and announced once', async () => {
  const r = rig();
  assert.equal(r.log.record({ source: 'server', route: 'GET /api/x', message: 'boom for maya@example.com' }), true);
  assert.equal(r.log.record({ source: 'server', route: 'GET /api/x', message: 'boom for maya@example.com' }), false);   // same bug again: no second alert
  r.log.record({ source: 'server', route: 'GET /api/x', message: 'boom for maya@example.com' });
  await new Promise(x => setTimeout(x, 20));
  assert.equal(r.posts.length, 1); assert.match(r.posts[0], /Server error on GET \/api\/x: boom for \[email\]/);
  const g = r.log.groups(); assert.equal(g.length, 1); assert.equal(g[0].count, 3); assert.equal(g[0].message, 'boom for [email]');
  assert.ok(!JSON.stringify(r.store.recentEvents(50)).includes('maya@'));
});
test('the same bug alerts again after the cooldown, and a different bug alerts at once', async () => {
  const r = rig({ cooldownMs: 3600e3 });
  r.log.record({ route: 'GET /a', message: 'one' }); r.advance(30 * 60e3);
  assert.equal(r.log.record({ route: 'GET /a', message: 'one' }), false);
  assert.equal(r.log.record({ route: 'GET /b', message: 'two' }), true);
  r.advance(40 * 60e3);
  assert.equal(r.log.record({ route: 'GET /a', message: 'one' }), true);
});
test('a burst of different errors cannot flood the alert channel', () => {
  const r = rig({ maxAlertsPerHour: 3 });
  let sent = 0; for (let i = 0; i < 20; i++) if (r.log.record({ route: 'GET /r' + i, message: 'm' + i })) sent++;
  assert.equal(sent, 3); assert.equal(r.log.groups().length, 20);                     // all are still written down
  r.advance(61 * 60e3); assert.equal(r.log.record({ route: 'GET /new', message: 'later' }), true);
});
test('groups only cover the window asked for, and sources are named', () => {
  const r = rig(); r.log.record({ source: 'client', route: '/', message: 'x is not a function' });
  r.log.record({ source: 'nonsense', route: 'GET /y', message: 'z' });
  assert.deepEqual(r.log.groups().map(g => g.source).sort(), ['client', 'server']);
  assert.equal(r.log.groups({ sinceMs: -1 }).length, 0);
});
