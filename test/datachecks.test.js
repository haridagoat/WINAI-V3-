const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../lib/db');
const D = require('../lib/datachecks');

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-10T12:00:00Z');
function ctx(over = {}) {
  const store = createStore({ dbPath: ':memory:' });
  const calls = [];
  const base = {
    store, now: () => NOW, adminEmail: null,
    today: () => '2026-10-10', daysAgo: n => `2026-10-${10 - n}`,
    fileMtime: () => NOW - 2 * HOUR, refreshStats: async lg => calls.push('refresh:' + lg),
    statRows: () => [{ PLAYER_NAME: 'A', MIN: 30, GP: 20, PTS: 15 }],
    slateCacheDates: () => ({}), clearSlateCache: lg => calls.push('clear:' + lg),
    newestBackupMtime: () => NOW - 2 * HOUR, runBackup: () => calls.push('backup'),
    picks: () => [], runGrade: async () => calls.push('grade'),
    creditBudget: () => ({ known: true, canScan: true, remaining: 300, scanCost: 60 }),
    authStatus: () => ({ enabled: true }),
    billingStatus: () => ({ requested: false, configured: false, missing: ['STRIPE_SECRET_KEY'], on: false, mode: null, lastWebhookAt: null }),
  };
  const c = { ...base, ...over };
  return { c, calls, run: async key => D.buildChecks(c).find(x => x.key === key).run() };
}

test('season windows: WNBA May to October, NBA mid-October to June', () => {
  const d = s => new Date(s + 'T12:00:00Z');
  assert.equal(D.inSeason('wnba', d('2026-07-01')), true);
  assert.equal(D.inSeason('wnba', d('2026-12-01')), false);
  assert.equal(D.inSeason('nba', d('2026-12-01')), true);
  assert.equal(D.inSeason('nba', d('2027-01-15')), true);
  assert.equal(D.inSeason('nba', d('2026-08-01')), false);
});

test('stat files: fresh is healthy', async () => {
  const { run } = ctx(); assert.equal((await run('stats-nba')).status, 'ok');
});
test('stat files: stale in the off season is expected, not a fault', async () => {
  const { run, calls } = ctx({ now: () => Date.parse('2026-08-10T12:00:00Z'), fileMtime: () => Date.parse('2026-07-01T00:00:00Z') });
  const r = await run('stats-nba');   // NBA is out of season in August
  assert.equal(r.status, 'ok'); assert.match(r.detail, /Off season/); assert.deepEqual(calls, []);
});
test('stat files: stale in season is re-fetched and reported as fixed when the file updates', async () => {
  let m = NOW - 10 * DAY;
  const { run, calls } = ctx({ fileMtime: () => m, refreshStats: async lg => { m = NOW - 1000; } });
  const r = await run('stats-wnba');   // WNBA is in season in October
  assert.equal(r.status, 'fixed'); assert.match(r.detail, /Re-fetched/);
});
test('stat files: if the refresh does not work it asks for you, and does not retry within 6 hours', async () => {
  let attempts = 0;
  const k = ctx({ fileMtime: () => NOW - 10 * DAY, refreshStats: async () => { attempts++; throw new Error('no python'); } });
  const r1 = await k.run('stats-wnba');
  assert.equal(r1.status, 'bad'); assert.match(r1.detail, /no python/);
  const r2 = await k.run('stats-wnba');
  assert.equal(r2.status, 'bad'); assert.match(r2.detail, /already tried/);
  assert.equal(attempts, 1);
});

test('slate cache: an old day is cleared; today\'s is left alone', async () => {
  const a = ctx({ slateCacheDates: () => ({ nba: '2026-10-10', wnba: '2026-10-09' }) });
  const r = await a.run('slate-cache');
  assert.equal(r.status, 'fixed'); assert.deepEqual(a.calls, ['clear:wnba']);
  assert.equal((await ctx({ slateCacheDates: () => ({ nba: '2026-10-10' }) }).run('slate-cache')).status, 'ok');
});

test('backup: recent is healthy, missing is written, a failed write asks for you', async () => {
  assert.equal((await ctx().run('backup')).status, 'ok');
  let m = null;
  const w = ctx({ newestBackupMtime: () => m, runBackup: () => { m = NOW; } });
  assert.equal((await w.run('backup')).status, 'fixed');
  assert.equal((await ctx({ newestBackupMtime: () => null, runBackup: () => { throw new Error('disk full'); } }).run('backup')).status, 'bad');
});

test('pick values: impossible numbers are reported, never edited', async () => {
  const picks = [{ id: 1, line: 24.5, confidence: 80 }, { id: 2, line: -3 }, { id: 3, confidence: 140 }, { id: 3, result: 'MAYBE' }, { id: 5, actualStat: -1 }];
  const before = JSON.stringify(picks);
  const r = await ctx({ picks: () => picks }).run('picks-values');
  assert.equal(r.status, 'bad'); assert.match(r.detail, /4 picks/); assert.match(r.detail, /Nothing was changed/);
  assert.equal(JSON.stringify(picks), before);
  assert.equal((await ctx({ picks: () => [{ id: 1, line: 20 }] }).run('picks-values')).status, 'ok');
});
test('stat values: judged per game, so season totals do not trip it; real impossibilities do', async () => {
  const fine = [{ PLAYER_NAME: 'Star', MIN: 2269.9, GP: 78, PTS: 809, FGM: 262, FGA: 618 }, { PLAYER_NAME: 'Bench', MIN: 20.7, GP: 14, FGM: 2, FGA: 6 }, { PLAYER_NAME: 'DNP', MIN: 0, GP: 0 }];
  assert.equal((await ctx({ statRows: lg => (lg === 'nba' ? fine : null) }).run('stat-values')).status, 'ok');
  const rows = [...fine, { PLAYER_NAME: 'Neg', MIN: -2, GP: 10 }, { PLAYER_NAME: 'Long', MIN: 600, GP: 10 }, { PLAYER_NAME: 'Many', MIN: 20, GP: 120 }, { PLAYER_NAME: 'Shots', MIN: 300, GP: 10, FGM: 9, FGA: 4 }];
  const r = await ctx({ statRows: lg => (lg === 'nba' ? rows : null) }).run('stat-values');
  assert.equal(r.status, 'bad'); assert.match(r.detail, /4 player rows/);
});

test('grading: overdue picks trigger a grading run; fixed only if they clear', async () => {
  let overdue = true;
  const pick = () => ({ id: 1, source: 'auto', date: '2026-10-01', result: overdue ? null : 'WIN' });
  const k = ctx({ picks: () => [pick()], runGrade: async () => { overdue = false; } });
  assert.equal((await k.run('grading')).status, 'fixed');
  const stuck = ctx({ picks: () => [{ id: 1, source: 'auto', date: '2026-10-01', result: null }] });
  assert.equal((await stuck.run('grading')).status, 'bad');
  const withReason = ctx({ picks: () => [{ id: 1, source: 'auto', date: '2026-10-01', result: null, gradeNote: 'no game found' }] });
  assert.equal((await withReason.run('grading')).status, 'ok');
});

test('credits, sign-in and old props', async () => {
  assert.equal((await ctx({ creditBudget: () => ({ known: true, canScan: false, remaining: 38, scanCost: 60 }) }).run('odds-credits')).status, 'bad');
  assert.equal((await ctx({ authStatus: () => ({ enabled: false, detail: 'not set up' }) }).run('accounts')).status, 'bad');
  const k = ctx(); k.c.store.writePick({ id: 1, player: 'old' });
  assert.equal((await k.run('unclaimed')).status, 'bad');                     // no ADMIN_EMAIL: nobody can see them
  k.c.adminEmail = 'me@example.com';
  assert.equal((await k.run('unclaimed')).status, 'ok');
});

test('database health reports damage and never throws on a healthy file', async () => {
  assert.equal((await ctx().run('db-integrity')).status, 'ok');
  const bad = ctx(); bad.c.store = { ...bad.c.store, integrityCheck: () => ['row 5 missing from index'] };
  assert.equal((await D.buildChecks(bad.c).find(x => x.key === 'db-integrity').run()).status, 'bad');
});

test('runAll isolates a crashing check, records the result, and alerts once per new problem', async () => {
  const k = ctx({ creditBudget: () => ({ known: true, canScan: false, remaining: 10, scanCost: 60 }) });
  const sent = [], resolved = [];
  const alerts = { notify: async a => sent.push(a), resolve: key => resolved.push(key) };
  const checks = [...D.buildChecks(k.c), { key: 'boom', name: 'Boom', description: '', run: async () => { throw new Error('exploded'); } }];
  const r1 = await D.runAll({ checks, store: k.c.store, alerts, now: () => NOW });
  assert.ok(r1.checks.find(c => c.key === 'boom').detail.includes('exploded'));
  assert.equal(r1.checks.find(c => c.key === 'odds-credits').status, 'bad');
  const firstAlerts = sent.length; assert.ok(firstAlerts >= 2);
  const r2 = await D.runAll({ checks, store: k.c.store, alerts, now: () => NOW + HOUR });
  assert.equal(sent.length, firstAlerts);                                    // same problems: no repeat alert
  assert.deepEqual(JSON.parse(k.c.store.getMeta('datachecks:last')).counts, r2.counts);
  k.c.creditBudget = () => ({ known: true, canScan: true, remaining: 400, scanCost: 60 });
  await D.runAll({ checks, store: k.c.store, alerts, now: () => NOW + 2 * HOUR });
  assert.ok(resolved.includes('datacheck:odds-credits'));                    // recovery re-arms the alert
});

// ── offsite backup ──
test('offsite: not set up is a fault only once people have accounts', async () => {
  assert.equal((await ctx().run('offsite')).status, 'ok');
  const w = ctx(); w.c.store.createUser('a@example.com', new Date().toISOString(), new Date().toISOString(), { name: 'A', passwordHash: 'x' });
  const r = await w.run('offsite'); assert.equal(r.status, 'bad'); assert.match(r.detail, /1 person has an account/);
});
test('offsite: uploads when the last copy is old, restore-tests weekly, and says what happened', async () => {
  const calls = [];
  const off = { configured: true };
  const w = ctx({ offsite: off, offsiteUpload: async () => { calls.push('up'); return { bytes: 20480 }; }, offsiteVerify: async () => { calls.push('verify'); return { users: 3, picks: 98 }; } });
  const first = await w.run('offsite');
  assert.equal(first.status, 'fixed'); assert.deepEqual(calls, ['up', 'verify']); assert.match(first.detail, /Restore test passed: 3 accounts and 98 picks/);
  const again = await w.run('offsite');                                                      // everything is recent now: nothing to do
  assert.equal(again.status, 'ok'); assert.deepEqual(calls, ['up', 'verify']);
});
test('offsite: a failed upload or a failed restore test asks for you', async () => {
  const mk = over => ctx({ offsite: { configured: true }, offsiteUpload: async () => ({ bytes: 1 }), offsiteVerify: async () => ({ users: 1, picks: 1 }), ...over });
  const up = await mk({ offsiteUpload: async () => { throw new Error('403 bucket says no'); } }).run('offsite');
  assert.equal(up.status, 'bad'); assert.match(up.detail, /uploading now failed: 403 bucket says no/);
  const ver = await mk({ offsiteVerify: async () => { throw new Error('passphrase is wrong'); } }).run('offsite');
  assert.equal(ver.status, 'bad'); assert.match(ver.detail, /restore test FAILED.*passphrase is wrong/);
});
