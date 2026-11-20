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

// ── a visitor must not start a scan the guard would cut off half way, and the saved scan lives on the volume ──
const { extract } = require('./helpers/extract');
const { envNum } = require('../lib/health');
function scanWorld({ job, pageSpent, remaining = 400, env = {} }) {
  const calls = { scan: 0 };
  const log = { days: { '2026-11-20': { byJob: pageSpent ? { 'page: GET /api/prop-board': { credits: pageSpent } } : {} } } };
  const f = extract({ functions: ['collectSlateResults'], consts: [], globals: {
    getToday: () => '2026-11-20', slateScanCache: {}, SLATE_LOGIC_VERSION: 1, EMPTY_SCAN_RETRY_MS: 1, slateScanInflight: {}, slateScanPartial: {},
    currentCreditBudget: () => ({ known: true, canScan: true, scanCost: 60 }), oddsJob: { getStore: () => job }, oddsGuard: require('../lib/oddsguard'),
    oddsApiHealth: { remaining }, oddsUsageLog: log, toLocalDateStr: () => '2026-11-20', envNum, process: { env },
    scanSlate: async () => { calls.scan++; return { candidates: [1], results: [1] }; }, Date, Promise } });
  return { f, calls };
}
test('a page view starts a scan only when it fits in what pages may still spend; a scheduled job always may', async () => {
  const fits = scanWorld({ job: 'page: GET /api/prop-board', pageSpent: 100 });                 // 100 + a 60-credit scan = 160, under 200
  await fits.f.collectSlateResults('nba'); assert.equal(fits.calls.scan, 1);
  const cut = scanWorld({ job: 'page: GET /api/prop-board', pageSpent: 150 });                  // 150 + 60 = 210: it would be cut off half way
  const r = await cut.f.collectSlateResults('nba'); assert.equal(cut.calls.scan, 0, 'never started'); assert.equal(r.skipped, 'page spending limit'); assert.deepEqual(JSON.parse(JSON.stringify(r.results)), []);
  const job = scanWorld({ job: 'job: slate-scan-nba', pageSpent: 190 }); await job.f.collectSlateResults('nba'); assert.equal(job.calls.scan, 1, 'the scheduled scan is not limited by the page share');
  const low = scanWorld({ job: 'page: GET /api/prop-board', pageSpent: 0, remaining: 70 }); await low.f.collectSlateResults('nba'); assert.equal(low.calls.scan, 1, 'enough credits and an unused share: it runs');
  const override = scanWorld({ job: 'page: GET /api/prop-board', pageSpent: 190, env: { ODDS_ALLOW_LOW_CREDITS: '1' } }); await override.f.collectSlateResults('nba'); assert.equal(override.calls.scan, 1, 'the owner override still works');
});

test('on a host with a volume the saved scan sits next to the database, so a deploy does not wipe it; locally it stays in the app folder', () => {
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const line = src.match(/const SLATE_CACHE_FILE = [^\n]+/)[0];
  const at = env => new Function('process', 'path', line + '; return SLATE_CACHE_FILE;')({ env }, path);
  assert.equal(at({ WINAI_DB: '/data/winai.db' }), '/data/slate_scan_cache.json');
  assert.equal(at({}), 'slate_scan_cache.json');
});
