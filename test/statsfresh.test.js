// The stat files are refreshed whenever they are over 20 hours old and the league is in season, so a laptop that slept through 7 AM catches up.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('./helpers/extract');

const NOW = Date.parse('2026-11-11T20:00:00Z');
function setup({ mtime, inSeason = true, fail = false, writes = true } = {}) {
  const calls = []; let mt = mtime;
  const f = extract({ functions: ['ensureStatsFresh'], consts: ['STATS_MAX_AGE_HOURS', 'statsRefreshing'],
    globals: { datachecks: { inSeason: () => inSeason }, mtimeOf: () => mt, STAT_FILE: { nba: 'a.json', wnba: 'b.json' }, runStatsScript: async lg => { calls.push(lg); if (fail) throw new Error('nba.com refused'); if (writes) mt = (mt || 0) + 1000; },
      Date: Object.assign(function (...a) { return a.length ? new Date(...a) : new Date(NOW); }, { now: () => NOW }) } });
  return { f, calls };
}

test('a file over 20 hours old is refreshed; a fresh one, an in-season-only rule and a running refresh are not', async () => {
  const stale = setup({ mtime: NOW - 38 * 3600e3 });
  assert.equal(await stale.f.ensureStatsFresh('nba'), 'refreshed'); assert.deepEqual(stale.calls, ['nba']);
  const fresh = setup({ mtime: NOW - 3 * 3600e3 }); assert.equal(await fresh.f.ensureStatsFresh('nba'), 'fresh'); assert.deepEqual(fresh.calls, []);
  const off = setup({ mtime: NOW - 99 * 3600e3, inSeason: false }); assert.equal(await off.f.ensureStatsFresh('wnba'), 'out of season'); assert.deepEqual(off.calls, []);
  const missing = setup({ mtime: null }); assert.equal(await missing.f.ensureStatsFresh('nba'), 'refreshed');
});

test('forced runs ignore age and season, only one refresh runs per league at a time, and a failure lets the next try go', async () => {
  const t = setup({ mtime: NOW - 1000, inSeason: false });
  assert.equal(await t.f.ensureStatsFresh('nba', { force: true }), 'refreshed');
  let release; const hold = new Promise(r => { release = r; });
  let slowMt = 0; const slow = extract({ functions: ['ensureStatsFresh'], consts: ['STATS_MAX_AGE_HOURS', 'statsRefreshing'], globals: { datachecks: { inSeason: () => true }, mtimeOf: () => slowMt, STAT_FILE: { nba: 'a' }, runStatsScript: () => hold.then(() => { slowMt = 5; }), Date } });
  const first = slow.ensureStatsFresh('nba'); assert.equal(await slow.ensureStatsFresh('nba'), 'already running'); release(); assert.equal(await first, 'refreshed');
  const bad = setup({ mtime: 0, fail: true }); await assert.rejects(() => bad.f.ensureStatsFresh('nba'), /refused/); await assert.rejects(() => bad.f.ensureStatsFresh('nba'), /refused/, 'the lock was released');
});

test('a script that exits cleanly but wrote no new file is a failure, not "refreshed" (nba.com refusing a cloud host looks exactly like this)', async () => {
  const blocked = setup({ mtime: NOW - 38 * 3600e3, writes: false });
  await assert.rejects(() => blocked.f.ensureStatsFresh('nba'), /wrote no new file/);
  const none = setup({ mtime: null, writes: false });
  await assert.rejects(() => none.f.ensureStatsFresh('nba'), /wrote no new file/, 'no file before and none after');
});
