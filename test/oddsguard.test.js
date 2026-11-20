// The Odds API spending guard for visitor-started calls (lib/oddsguard.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { decide, pageSpentToday } = require('../lib/oddsguard');

test('a page view is refused when the credits are at the reserve, and allowed just above it', () => {
  assert.equal(decide({ job: 'page: GET /api/team-picks', remaining: 500, pageSpent: 0 }).allow, true);
  assert.equal(decide({ job: 'page: GET /api/team-picks', remaining: 31, pageSpent: 0 }).allow, true);
  const d = decide({ job: 'page: GET /api/team-picks', remaining: 30, pageSpent: 0 });
  assert.equal(d.allow, false); assert.match(d.reason, /kept for the scheduled scan/);
  assert.equal(decide({ job: 'page: x', remaining: 0, pageSpent: 0 }).allow, false);
});

test('pages stop at their daily share, which is above one full scan so the first visitor can still start it', () => {
  assert.equal(decide({ job: 'page: x', remaining: 500, pageSpent: 199 }).allow, true);
  const d = decide({ job: 'page: x', remaining: 500, pageSpent: 200 }); assert.equal(d.allow, false); assert.match(d.reason, /daily limit 200/);
  assert.equal(decide({ job: 'page: x', remaining: 500, pageSpent: 120, pageCap: 100 }).allow, false, 'the limits can be changed');
  assert.ok(200 > 60 * 2, 'default cap covers an NBA and a WNBA scan');
});

test('scheduled jobs, untagged calls and unknown credit counts are never blocked here', () => {
  assert.equal(decide({ job: 'job: slate-scan-nba', remaining: 2, pageSpent: 9999 }).allow, true);
  assert.equal(decide({ job: undefined, remaining: 2, pageSpent: 9999 }).allow, true);
  assert.equal(decide({ job: 'page: x', remaining: null, pageSpent: 0 }).allow, true, 'unknown is not a reason to block');
});

test('page spend is the sum of only the "page:" entries for that day', () => {
  const log = { days: { '2026-11-20': { byJob: { 'page: GET /api/a': { credits: 10 }, 'job: slate-scan-nba': { credits: 60 }, 'page: GET /api/b': { credits: 5 } } }, '2026-11-19': { byJob: { 'page: z': { credits: 99 } } } } };
  assert.equal(pageSpentToday(log, '2026-11-20'), 15); assert.equal(pageSpentToday(log, '2026-11-21'), 0); assert.equal(pageSpentToday(null, 'x'), 0);
});

test('the server registers the guard before every Odds call, and leaves the free calls (events list, /sports) alone', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /axios\.interceptors\.request\.use\(/);
  assert.match(src, /oddsGuard\.decide\(\{ job: oddsJob\.getStore\(\)/);
  assert.match(src, /\/sports\\\/\?\(\\\?\|\$\)\|\\\/events\$\//, 'the free calls are exempt');
  assert.ok(src.indexOf('axios.interceptors.request.use(') < src.indexOf('axios.interceptors.response.use('));
});
