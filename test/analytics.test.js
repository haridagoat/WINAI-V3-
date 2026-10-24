const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnalytics, cleanHost, cleanKey, distinctIdFor, DEFAULT_HOST } = require('../lib/analytics');
const B = require('../lib/billing');

const KEY = 'phc_testprojectkey123';
const recorder = () => {
  const sent = [];
  return { sent, post: async (url, body) => { sent.push({ url, body }); } };
};

test('without a key nothing is sent and the browser gets no config', async () => {
  const r = recorder();
  const a = createAnalytics({ key: '', post: r.post });
  assert.equal(a.enabled, false);
  assert.equal(await a.capture(1, 'signed_up'), false);
  assert.equal(a.clientConfig(), null);
  assert.equal(r.sent.length, 0);
});

test('an event goes to /capture/ with the account id, never anything else identifying', async () => {
  const r = recorder();
  const a = createAnalytics({ key: KEY, post: r.post, now: () => new Date('2026-10-22T12:00:00Z') });
  assert.equal(await a.capture(42, 'subscribe_clicked', { feature: 'analyzer' }), true);
  assert.equal(r.sent.length, 1);
  const { url, body } = r.sent[0];
  assert.equal(url, `${DEFAULT_HOST}/capture/`);
  assert.equal(body.api_key, KEY);
  assert.equal(body.event, 'subscribe_clicked');
  assert.equal(body.distinct_id, 'u_42');
  assert.equal(body.distinct_id, distinctIdFor(42));
  assert.equal(body.properties.feature, 'analyzer');
  assert.equal(body.timestamp, '2026-10-22T12:00:00.000Z');
});

test('a failed send is swallowed, logged, and never throws', async () => {
  const logs = [];
  const a = createAnalytics({ key: KEY, post: async () => { throw new Error('ECONNRESET'); }, log: m => logs.push(m) });
  assert.equal(await a.capture(1, 'logged_in'), false);
  assert.match(logs[0], /logged_in not sent: ECONNRESET/);
  const b = createAnalytics({ key: KEY, post: () => { throw new Error('sync boom'); } });   // even a synchronous throw
  assert.equal(await b.capture(1, 'x'), false);
});

test('no event without an account', async () => {
  const r = recorder();
  const a = createAnalytics({ key: KEY, post: r.post });
  assert.equal(await a.capture(null, 'paywall_hit'), false);
  assert.equal(await a.capture(undefined, 'paywall_hit'), false);
  assert.equal(r.sent.length, 0);
});

test('app_opened fires once per person per day', async () => {
  const r = recorder();
  const a = createAnalytics({ key: KEY, post: r.post });
  await a.appOpened(1, '2026-10-22');
  await a.appOpened(1, '2026-10-22');
  await a.appOpened(2, '2026-10-22');
  await a.appOpened(1, '2026-10-23');
  assert.deepEqual(r.sent.map(s => [s.body.distinct_id, s.body.properties.day]), [['u_1', '2026-10-22'], ['u_2', '2026-10-22'], ['u_1', '2026-10-23']]);
});

test('only https hosts (or a local stand-in) are accepted', () => {
  assert.equal(cleanHost(''), DEFAULT_HOST);
  assert.equal(cleanHost('https://eu.i.posthog.com/'), 'https://eu.i.posthog.com');
  assert.equal(cleanHost('http://localhost:8010'), 'http://localhost:8010');
  assert.equal(cleanHost('http://evil.example.com'), null);
  assert.equal(cleanHost('https://x.com/path'), null);
  const r = recorder();
  assert.equal(createAnalytics({ key: KEY, host: 'http://evil.example.com', post: r.post }).enabled, false);
});

test('a malformed key turns analytics off', () => {
  assert.equal(cleanKey('phc_abc def'), '');
  assert.equal(cleanKey('<script>'), '');
  assert.equal(cleanKey(KEY), KEY);
});

test('the browser config carries only the public key and host', () => {
  const a = createAnalytics({ key: KEY, host: 'https://eu.i.posthog.com', post: async () => {} });
  assert.deepEqual(a.clientConfig(), { key: KEY, host: 'https://eu.i.posthog.com' });
});

// ── paywall mode ──
test('PAYWALL picks the mode; anything unexpected means no paywall', () => {
  assert.equal(B.paywallMode('on'), 'stripe');
  assert.equal(B.paywallMode('fake'), 'fake');
  assert.equal(B.paywallMode(' FAKE '), 'fake');
  for (const v of [undefined, '', 'off', 'true', '1', 'yes']) assert.equal(B.paywallMode(v), 'off');
});

test('feature names from the browser are allowlisted', () => {
  assert.equal(B.cleanFeature('analyzer'), 'analyzer');
  assert.equal(B.cleanFeature('team_breakdown'), 'team_breakdown');
  assert.equal(B.cleanFeature('<img src=x>'), 'general');
  assert.equal(B.cleanFeature(undefined), 'general');
  assert.equal(B.cleanFeature({}), 'general');
});

test('a fake-door unlock is the same comp flag, so it makes the account Pro', () => {
  assert.equal(B.isPro({ comped: 1 }, null), true);
  assert.equal(B.planInfo({ comped: 1 }, null).plan, 'pro');
  assert.equal(B.isPro({ comped: 0 }, null), false);
});
