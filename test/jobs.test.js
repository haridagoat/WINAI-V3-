// The server's background jobs (scan log, grading, top-up for games without props, late-news re-pricing), run exactly as written in server.js
// against controlled fakes for the network and the clock. These only fire on game days, so this is where a wiring slip would otherwise hide.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('./helpers/extract');
const { createStore } = require('../lib/db');
const { eventsDueForFill, eventInfoFrom } = require('../lib/slatefill');

const TODAY = '2026-11-04';
const HOUR = 3600e3;
const NOW = Date.parse('2026-11-04T15:00:00Z');

function world({ inSeason = true, credits = { known: true, remaining: 300, critAt: 40 } } = {}) {
  const store = createStore({ dbPath: ':memory:', log: () => {} });
  const w = {
    store, TODAY, saved: 0, picksLogged: [], rosters: {}, candidatesFor: {}, evaluated: [], cleared: [], fetchedEvents: [],
    slateScanCache: {}, slateScanInflight: {}, slateFillInflight: {}, topPlaysCache: { nba: 'x' }, teamPicksCache: { nba: 'x' },
  };
  const g = {
    process: { env: {} }, Date: Object.assign(function (...a) { return a.length ? new Date(...a) : new Date(NOW); }, { now: () => NOW, UTC: Date.UTC, parse: Date.parse }),
    store, getToday: () => TODAY, toLocalDateStr: d => new Date(d).toISOString().slice(0, 10), envNum: (v, d) => (v == null || v === '' ? d : Number(v)),
    datachecks: { inSeason: () => inSeason }, SLATE_LOGIC_VERSION: 3, slateScanCache: w.slateScanCache, slateScanInflight: w.slateScanInflight, slateFillInflight: w.slateFillInflight,
    topPlaysCache: w.topPlaysCache, teamPicksCache: w.teamPicksCache, saveSlateScanCacheToDisk: () => { w.saved++; },
    currentCreditBudget: () => credits, getOddsEvents: async () => w.oddsEvents || [], eventsDueForFill, eventInfoFrom,
    fetchESPNRoster: async team => w.rosters[team] || { injured: [] }, fetchWNBARoster: async team => w.rosters[team] || { injured: [] },
    fetchSlateCandidates: async (sportKey, { onlyIds, report }) => { w.fetchedEvents.push([...onlyIds]); const out = []; for (const id of onlyIds) { const cs = w.candidatesFor[id] || []; report.push({ id, home: w.info?.[id]?.home, away: w.info?.[id]?.away, commence: w.info?.[id]?.commence, count: cs.length, ok: true }); out.push(...cs); } return out; },
    evaluateCandidatesInto: async (league, cands, out) => { w.evaluated.push(cands.length); for (const c of cands) out.push({ player: c.player, propType: c.propType, homeTeam: c.homeTeam, awayTeam: c.awayTeam, team: c.homeTeam, opponent: c.awayTeam, confidence: 60, direction: 'OVER', projection: 20, scan: { evalLine: c.line, modelProjection: 21, projection: 20.2, sd: 6, modelOver: 0.6, marketOver: 0.5, finalOver: 0.51, books: [], best: { side: 'over', line: c.line, price: -110, prob: 0.51, ev: 0.01 } } }); },
    autoLogSlatePicks: (lg, rs) => { w.picksLogged.push(rs.length); },
    fetchPlayerStats: async name => w.stats?.[name] || { error: 'no data' }, fetchWNBAPlayerStats: async () => ({ error: 'no data' }),
    findGameForPick: (stats, e) => (stats.games || []).find(x => x.date === e.date) || null, gradeStatValue: (g, t) => g[t === 'points' ? 'pts' : t === 'rebounds' ? 'reb' : 'ast'],
    FILL_GAP_MS: 40 * 60e3, FILL_WINDOW_MS: 8 * HOUR, FILL_TRIES: 8, FILL_COST_PER_GAME: 3,
  };
  const fns = extract({ functions: ['logScanProps', 'gradeScanProps', 'injurySig', 'describeInjuryChange', 'reprojectChangedGames', 'reprojectChangedGamesOnce', 'fillMissingProps'], consts: ['REPROJECT_GAP_MS', 'reprojectInflight'], globals: g });
  return { w, f: fns, store };
}
const cand = (player, propType, line, home, away) => ({ player, propType, line, homeTeam: home, awayTeam: away, books: {} });
const game = (id, home, away, hoursAway, count = 5) => ({ id, home, away, commence: new Date(NOW + hoursAway * HOUR).toISOString(), count, attempts: 1, lastTry: NOW - 5 * HOUR, ok: true });
const setupSlate = (w, games, results = []) => {
  w.info = Object.fromEntries(games.map(g => [g.id, g]));
  w.slateScanCache.nba = { dateKey: TODAY, v: 3, ts: NOW, data: { candidates: [], results, eventInfo: w.info, injurySig: {} } };
};

test('scan log: every scanned prop is stored once with its numbers, only in season', () => {
  const { w, f, store } = world();
  const rows = [{ player: 'A', propType: 'points', team: 'T', opponent: 'O', confidence: 55, direction: 'OVER', scan: { evalLine: 20.5, modelProjection: 22 } }, { player: 'B', propType: 'assists', scan: null }];
  assert.equal(f.logScanProps('nba', rows), 1, 'a row with no scan summary is skipped');
  assert.equal(f.logScanProps('nba', rows), 0, 'the same prop logged twice in a day is stored once');
  const pending = store.scanPropsPending('2026-11-05'); assert.equal(pending.length, 1); assert.equal(pending[0].data.evalLine, 20.5); assert.equal(pending[0].data.team, 'T');
  assert.equal(world({ inSeason: false }).f.logScanProps('nba', rows), 0, 'nothing is logged out of season');
});

test('grading fills in the real stat, sets aside players with no game after three days, and never grades twice', async () => {
  const { w, f, store } = world();
  const mk = (date, player, propType) => store.addScanProps([{ date, league: 'nba', player, propType, data: { evalLine: 20.5 } }]);
  mk('2026-11-03', 'Played', 'points'); mk('2026-11-03', 'Played', 'rebounds'); mk('2026-11-03', 'NoGame', 'points'); mk('2026-10-30', 'NoGame', 'assists'); mk('2026-11-03', 'Broken', 'points');
  w.stats = { Played: { games: [{ date: '2026-11-03', pts: 27, reb: 8, ast: 5 }] }, NoGame: { games: [] } };
  const out = await f.gradeScanProps();
  assert.match(out, /graded 2 of 5/); assert.match(out, /set aside 1/);
  const c = store.scanCounts('nba'); assert.equal(c.graded, 2); assert.equal(c.setAside, 1); assert.equal(c.waiting, 2, 'recent misses and failures are retried tomorrow, not given up on');
  const graded = Object.fromEntries(store.gradedScanProps('nba').map(r => [r.propType, r.actual])); assert.deepEqual(graded, { points: 27, rebounds: 8 });
  const waiting = store.scanPropsPending('2026-11-05').map(r => `${r.date} ${r.player}`).sort();
  assert.deepEqual(waiting, ['2026-11-03 Broken', '2026-11-03 NoGame'], 'the old miss was set aside; yesterday\'s miss and the failed lookup are still waiting');
  assert.match(await f.gradeScanProps(), /graded 0/);
  assert.equal(store.gradedScanProps('nba').length, 2, 'running again changes nothing');
});

test('late news: the first look only records a baseline; a later change re-prices that game, logs it and clears the day-locked caches', async () => {
  const { w, f, store } = world();
  setupSlate(w, [game('e1', 'Boston Celtics', 'Miami Heat', 5), game('e2', 'Denver Nuggets', 'Utah Jazz', 5)], [
    { player: 'Old', propType: 'points', homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat' }, { player: 'Keep', propType: 'points', homeTeam: 'Denver Nuggets', awayTeam: 'Utah Jazz' }]);
  w.candidatesFor.e1 = [cand('Jaylen Brown', 'points', 24.5, 'Boston Celtics', 'Miami Heat'), cand('Jayson Tatum', 'points', 27.5, 'Boston Celtics', 'Miami Heat')];
  store.addScanProps([{ date: TODAY, league: 'nba', player: 'Jaylen Brown', propType: 'points', data: { projection: 25, modelProjection: 26, evalLine: 24.5 } }]);
  assert.match(await f.reprojectChangedGames('nba'), /no injury changes/, 'first look: nothing is compared yet');
  assert.deepEqual(w.slateScanCache.nba.data.injurySig['Boston Celtics'], [], 'a baseline was recorded');
  // news lands: Tatum is out
  w.rosters['Boston Celtics'] = { injured: [{ name: 'Jayson Tatum', status: 'Out' }] };
  const out = await f.reprojectChangedGames('nba');
  assert.match(out, /1 game re-priced/); assert.match(out, /Jayson Tatum out/);
  assert.deepEqual(w.fetchedEvents, [['e1']], 'only the changed game was re-fetched');
  const res = w.slateScanCache.nba.data.results;
  assert.ok(res.some(r => r.player === 'Keep'), 'the other game is untouched'); assert.ok(!res.some(r => r.player === 'Old'), 'the old numbers for the changed game are gone');
  assert.equal(res.filter(r => r.homeTeam === 'Boston Celtics').length, 2, 'the new numbers replace them');
  assert.equal(w.topPlaysCache.nba, undefined); assert.equal(w.teamPicksCache.nba, undefined);
  assert.equal(w.picksLogged.length, 1); assert.ok(w.saved >= 1);
  assert.ok(store.recentEvents(5).some(e => e.kind === 'reproject' && /Jayson Tatum out/.test(e.message)), 'the change is in the event log');
  const up = store.scanPropsPending('2026-11-05').find(r => r.player === 'Jaylen Brown'); assert.equal(up.data.first.projection, 25, 'the scan log keeps the first look');
  assert.equal(w.slateScanCache.nba.data.eventInfo.e1.reprojectedAt, NOW);
  assert.match(await f.reprojectChangedGames('nba'), /no game due|no injury changes/, 'not re-priced again within 20 minutes');
});

test('late news: skipped when credits are low (and retried later), when a game has started, and when nothing is scanned', async () => {
  const low = world({ credits: { known: true, remaining: 30, critAt: 40 } });
  setupSlate(low.w, [game('e1', 'Boston Celtics', 'Miami Heat', 5)]);
  await low.f.reprojectChangedGames('nba'); low.w.rosters['Boston Celtics'] = { injured: [{ name: 'X', status: 'Out' }] };
  assert.match(await low.f.reprojectChangedGames('nba'), /0 games? re-priced, 1 skipped/); assert.deepEqual(low.w.fetchedEvents, []);
  assert.equal(low.w.slateScanCache.nba.data.eventInfo.e1.reprojectedAt, undefined, 'a skipped game is still due next time');

  const started = world(); setupSlate(started.w, [game('e1', 'Boston Celtics', 'Miami Heat', -1)]);
  assert.match(await started.f.reprojectChangedGames('nba'), /no game due/);
  const none = world(); assert.match(await none.f.reprojectChangedGames('nba'), /no finished scan/);
  const mid = world(); setupSlate(mid.w, [game('e1', 'A', 'B', 4)]); mid.w.slateScanInflight.nba = Promise.resolve(); assert.match(await mid.f.reprojectChangedGames('nba'), /no finished scan/, 'never runs while a scan is writing');
  assert.match(await world({ inSeason: false }).f.reprojectChangedGames('nba'), /no finished scan|out of season/);
});

test('late news: two overlapping runs do the work once', async () => {
  const { w, f } = world();
  setupSlate(w, [game('e1', 'Boston Celtics', 'Miami Heat', 5)]);
  await f.reprojectChangedGames('nba'); w.rosters['Boston Celtics'] = { injured: [{ name: 'Z', status: 'Out' }] }; w.candidatesFor.e1 = [cand('P', 'points', 20.5, 'Boston Celtics', 'Miami Heat')];
  const [a, b] = await Promise.all([f.reprojectChangedGames('nba'), f.reprojectChangedGames('nba')]);
  assert.deepEqual([a, b].filter(x => /re-priced/.test(x)).length, 1, 'exactly one of them did the work');
  assert.ok([a, b].some(x => x === 'previous check still running'), 'the other stood aside');
  assert.equal(w.fetchedEvents.length, 1, 'the game was fetched (and paid for) once');
});

test('top-up: only games with no props are asked, new props are merged in, caches cleared, games with props untouched', async () => {
  const { w, f } = world();
  setupSlate(w, [game('has', 'Boston Celtics', 'Miami Heat', 4, 12), { ...game('empty', 'Denver Nuggets', 'Utah Jazz', 4, 0), lastTry: NOW - 2 * HOUR }], [{ player: 'Existing', propType: 'points', homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat' }]);
  w.slateScanCache.nba.data.candidates = [cand('Existing', 'points', 20.5, 'Boston Celtics', 'Miami Heat')];
  w.oddsEvents = [{ id: 'has', home_team: 'Boston Celtics', away_team: 'Miami Heat', commence_time: w.info.has.commence }, { id: 'empty', home_team: 'Denver Nuggets', away_team: 'Utah Jazz', commence_time: w.info.empty.commence }];
  w.candidatesFor.empty = [cand('New Guy', 'points', 14.5, 'Denver Nuggets', 'Utah Jazz'), cand('New Guy', 'assists', 3.5, 'Denver Nuggets', 'Utah Jazz')];
  const out = await f.fillMissingProps('nba');
  assert.match(out, /asked 1 game, 1 had props \(2 added\)/); assert.deepEqual(w.fetchedEvents, [['empty']]);
  const d = w.slateScanCache.nba.data;
  assert.equal(d.candidates.length, 3); assert.equal(d.results.length, 3, 'old result kept, two new ones added');
  assert.equal(d.eventInfo.empty.count, 2); assert.equal(d.eventInfo.empty.attempts, 2); assert.equal(d.eventInfo.has.count, 12, 'the game that had props is not re-counted');
  assert.equal(w.topPlaysCache.nba, undefined); assert.equal(w.teamPicksCache.nba, undefined); assert.ok(w.saved >= 1);
  assert.equal(w.store.scanCounts('nba').total, 2, 'the new props were logged');
  assert.match(await f.fillMissingProps('nba'), /every game has props|not due yet/, 'asking again right away does nothing');
});

test('top-up: skipped on low credits, with no scan to top up, and while a scan is running', async () => {
  const low = world({ credits: { known: true, remaining: 20, critAt: 40 } });
  setupSlate(low.w, [{ ...game('empty', 'Denver Nuggets', 'Utah Jazz', 4, 0), lastTry: NOW - 2 * HOUR }]);
  low.w.oddsEvents = [{ id: 'empty', home_team: 'Denver Nuggets', away_team: 'Utah Jazz', commence_time: low.w.info.empty.commence }];
  assert.match(await low.f.fillMissingProps('nba'), /skipped: 20 credits left/); assert.deepEqual(low.w.fetchedEvents, []);
  assert.match(await world().f.fillMissingProps('nba'), /no finished scan/);
  const busy = world(); setupSlate(busy.w, []); busy.w.slateScanInflight.nba = Promise.resolve(); assert.match(await busy.f.fillMissingProps('nba'), /no finished scan/);
});
