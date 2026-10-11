const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../lib/security');

test('control characters and oversized values are caught in queries', () => {
  assert.match(s.queryProblem({ player: 'a\u0000b' }), /control characters/);
  assert.match(s.queryProblem({ q: 'x'.repeat(201) }), /longer than 200/);
  assert.equal(s.queryProblem({ player: "A'ja Wilson", opp: 'New York Liberty', line: '19.5' }), null);
  assert.equal(s.queryProblem({ player: 'José Álvarez-Smith Jr.' }), null);   // real names with accents and punctuation pass
});

test('array and nested query values are checked too', () => {
  assert.match(s.queryProblem({ p: ['ok', 'bad\u0001'] }), /control/);
  assert.match(s.queryProblem({ p: { a: 1 } }), /plain text/);
});

test('tabs and newlines are fine in bodies (AI prompts contain them), null bytes are not', () => {
  assert.equal(s.bodyProblem({ prompt: 'line one\n\tline two\r\n' }), null);
  assert.match(s.bodyProblem({ a: { b: ['x', 'y\u0000'] } }), /control/);
  assert.match(s.bodyProblem(JSON.parse('{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":1}}}}}}}}')), /deeply nested/);
});

test('a saved prop keeps only known fields with enforced types', () => {
  const ok = s.cleanEntryInput({ player: " A'ja Wilson ", opp: 'Golden State Valkyries', propType: 'Points', line: '27.5', verdict: 'LEAN_OVER', league: 'wnba', projection: '29.9', edge: '2.4', confidence: '88', gameDate: '2026-10-10', extra: 'ignored' });
  assert.equal(ok.error, undefined);
  assert.deepEqual([ok.value.player, ok.value.propType, ok.value.line, ok.value.league, ok.value.confidence], ["A'ja Wilson", 'points', 27.5, 'wnba', 88]);
  assert.equal('extra' in ok.value, false);
});

test('markup, bad enums and junk are refused when saving a prop', () => {
  const bad = b => s.cleanEntryInput({ player: 'P', line: 10, ...b }).error;
  assert.ok(bad({ propType: '<img src=x onerror=1>' }));
  assert.ok(bad({ verdict: 'OVER<img src=x onerror=window.x=1>' }));
  assert.ok(bad({ player: '<script>' }));
  assert.ok(bad({ opp: 'x'.repeat(81) }));
  assert.ok(bad({ gameDate: '10/10/2026' }));
  assert.ok(s.cleanEntryInput({ player: 'P', line: 'abc' }).error);
  assert.ok(s.cleanEntryInput({ player: '', line: 10 }).error);
  assert.ok(s.cleanEntryInput({ player: 'P', line: 9999 }).error);
  assert.ok(s.cleanEntryInput(null).error);
});

test('out-of-range numbers are dropped, not stored', () => {
  const v = s.cleanEntryInput({ player: 'P', line: 10, confidence: 400, edge: 99999, projection: 5000 }).value;
  assert.deepEqual([v.confidence, v.edge, v.projection], [null, null, null]);
});

test('updates accept only a real result, numbers in range, and plain notes', () => {
  assert.deepEqual(s.cleanUpdateInput({ result: 'WIN', actualStat: '27', notes: 'ok' }).value, { result: 'WIN', actualStat: 27, notes: 'ok' });
  assert.deepEqual(s.cleanUpdateInput({ result: null }).value, { result: null });
  assert.ok(s.cleanUpdateInput({ result: 'WON' }).error);
  assert.ok(s.cleanUpdateInput({ actualStat: -1 }).error);
  assert.ok(s.cleanUpdateInput({ closingLine: 'NaN' }).error);
  assert.ok(s.cleanUpdateInput({ notes: '<b>x</b>' }).error);
  assert.deepEqual(s.cleanUpdateInput({ actualStat: 0 }).value, { actualStat: 0 });   // a real 0 is kept
});

function fakeRes() { return { code: 200, headers: {}, body: null, set(h, v) { if (typeof h === 'object') Object.assign(this.headers, h); else this.headers[h] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }

test('rate limiter lets the first requests through, blocks past the limit, and recovers', () => {
  let t = 1000;
  const lim = s.createRateLimiter({ windowMs: 1000, max: 3, now: () => t });
  const hit = ip => { const r = fakeRes(); let passed = false; lim({ ip }, r, () => { passed = true; }); return { passed, r }; };
  assert.ok(hit('a').passed && hit('a').passed && hit('a').passed);
  const blocked = hit('a');
  assert.equal(blocked.passed, false);
  assert.equal(blocked.r.code, 429);
  assert.ok(blocked.r.headers['Retry-After']);
  assert.ok(hit('b').passed, 'another address is unaffected');
  t += 1500;
  assert.ok(hit('a').passed, 'a new window starts fresh');
});

test('admin brute force: ten wrong tokens block that address, a right one clears it', () => {
  let t = 0;
  const f = s.createFailLimiter({ max: 10, windowMs: 1000, now: () => t });
  for (let i = 0; i < 9; i++) f.fail('ip');
  assert.equal(f.blocked('ip'), false);
  f.fail('ip');
  assert.equal(f.blocked('ip'), true);
  assert.equal(f.blocked('other'), false);
  t += 1500;
  assert.equal(f.blocked('ip'), false, 'the block expires');
  f.fail('ip'); f.ok('ip');
  assert.equal(f.blocked('ip'), false);
});

test('security headers are set on every response', () => {
  const r = fakeRes(); let next = false;
  s.securityHeaders({}, r, () => { next = true; });
  assert.ok(next);
  assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(r.headers['X-Frame-Options'], 'DENY');
  assert.equal(r.headers['Referrer-Policy'], 'no-referrer');
});

test('a state-changing request from another site is refused', () => {
  const run = headers => { let out = 'next'; s.sameOrigin({ get: h => headers[h.toLowerCase()] }, { status: c => ({ json: () => { out = c; } }) }, () => { out = 'next'; }); return out; };
  assert.equal(run({ origin: 'https://evil.test', host: 'winai.test' }), 403);
  assert.equal(run({ origin: 'null', host: 'winai.test' }), 403);
  assert.equal(run({ origin: 'https://winai.test', host: 'winai.test' }), 'next');
  assert.equal(run({ 'sec-fetch-site': 'cross-site', host: 'winai.test' }), 403);
  assert.equal(run({ host: 'winai.test' }), 'next');            // curl and server-to-server calls carry no Origin
});

test('the rate limiter reports each block', () => {
  let blocks = 0;
  const lim = s.createRateLimiter({ windowMs: 1000, max: 2, onBlock: () => blocks++, now: () => 5 });
  const res = { set() {}, status: () => ({ json() {} }) };
  for (let i = 0; i < 5; i++) lim({ ip: '1.1.1.1' }, res, () => {});
  assert.equal(blocks, 3);
});
