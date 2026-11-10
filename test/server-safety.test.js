// Static guards for the server's safety net. The live attack suite (npm run redteam) found that 30 anonymous requests with a repeated
// query parameter could switch the whole site off; these keep the three fixes in place.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('every route handler is wrapped so an async throw becomes an answer, not a hang', () => {
  assert.match(src, /for \(const m of \['get', 'post', 'put', 'delete', 'patch', 'all', 'use'\]\)/);
  assert.match(src, /r\.catch\(next\)/);
  assert.ok(src.indexOf("function safeHandler") < src.indexOf("app.use(compression("), 'the wrapper must be installed before any route or middleware');
});

test('query values must be plain single text, with no control characters', () => {
  assert.match(src, /typeof v !== 'string'/);
  assert.match(src, /CONTROL_CHARS = \/\[\\u0000-\\u001f\\u007f\]\//);
  assert.ok(src.indexOf("app.use('/api', apiLimiter)") < src.indexOf('const CONTROL_CHARS'), 'checked right after the rate limiter');
});

test("a bad request cannot count toward the process's exit limit", () => {
  const fn = src.slice(src.indexOf('function noteFault'), src.indexOf("process.on('uncaughtException'"));
  assert.match(fn, /if \(kind !== 'route'\) \{ recentFaults = /, 'only process-level faults are counted');
  assert.match(fn, /recentFaults\.length > 20/);
});

test('the server gives up on slow and half-open clients', () => {
  assert.match(src, /server\.headersTimeout = 20000; server\.requestTimeout = 120000/);
});

test('the caches keyed by visitor-typed names are capped', () => {
  const line = src.split('\n').find(l => l.includes('capCache(c)') && l.includes('for (const c of ['));
  for (const c of ['projectionCache', 'playerStatsCache', 'nbaApiBridgeCache', 'shotChartCache', 'propLinesCache', 'playerIdCache']) assert.ok(line.includes(c), `${c} must be capped`);
});
