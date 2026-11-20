// ESPN game logs, shaped like nba.com's (lib/espngames.js), and the server's switch to them when nba.com does not answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/espngames');
const { extract } = require('./helpers/extract');

const NAMES = ['minutes', 'fieldGoalsMade-fieldGoalsAttempted', 'fieldGoalPct', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'threePointPct', 'freeThrowsMade-freeThrowsAttempted', 'freeThrowPct', 'totalRebounds', 'assists', 'blocks', 'steals', 'fouls', 'turnovers', 'points'];
const row = (min, fg, tp, ft, reb, ast, blk, stl, to, pts) => [String(min), fg, '0', tp, '0', ft, '0', String(reb), String(ast), String(blk), String(stl), '2', String(to), String(pts)];
const ev = (id, iso, atVs, oppName, oppAbbr, res = 'W') => ({ id, atVs, gameDate: iso, gameResult: res, opponent: { displayName: oppName, abbreviation: oppAbbr } });
function log(kinds) {   // kinds: [{ type, games: [[eventId, stats]] }]
  const events = {}, seasonTypes = [];
  for (const k of kinds) {
    const evs = [];
    for (const [id, iso, atVs, opp, abbr, stats] of k.games) { events[id] = ev(id, iso, atVs, opp, abbr); evs.push({ eventId: id, stats }); }
    seasonTypes.push({ displayName: k.type, categories: [{ displayName: 'month', events: evs }] });
  }
  return { names: NAMES, events, seasonTypes };
}
const G = (id, iso, atVs, opp, abbr, pts, min = 34) => [id, iso, atVs, opp, abbr, row(min, '8-20', '4-5', '1-1', 2, 7, 0, 2, 1, pts)];

test('a game becomes the same shape nba.com gives: date, matchup, minutes, shooting splits', () => {
  const j = log([{ type: '2026-27 Regular Season', games: [G('1', '2026-11-20T01:00:00.000+00:00', '@', 'Minnesota Timberwolves', 'MIN', 21)] }]);
  const g = E.parseGameLog(j, { teamAbbr: 'ny' }).regular[0];
  assert.equal(g.date, 'Nov 19, 2026', 'tip-off at 8pm Eastern is the 19th, not the 20th UTC');
  assert.equal(g.matchup, 'NY @ MIN'.replace('NY', 'NY')); assert.equal(g.home, false); assert.equal(g.wl, 'W');
  assert.deepEqual([g.min, g.pts, g.reb, g.ast, g.stl, g.blk, g.tov], ['34', 21, 2, 7, 2, 0, 1]);
  assert.deepEqual([g.fgm, g.fga, g.fg_pct, g.fg3m, g.fg3a, g.fg3_pct, g.ftm, g.fta], [8, 20, 40, 4, 5, 80, 1, 1]);
  assert.ok(!('oreb' in g) && !('plus_minus' in g), 'what ESPN does not have is left out, not invented');
});

test('the day is zero-padded like nba.com writes it, and ESPN team codes become nba.com codes', () => {
  const j = log([{ type: '2026-27 Regular Season', games: [G('1', '2026-11-08T00:30:00.000+00:00', 'vs', 'San Antonio Spurs', 'SA', 10)] }]);
  const g = E.parseGameLog(j, { teamAbbr: 'ny' }).regular[0];
  assert.equal(g.date, 'Nov 07, 2026'); assert.equal(g.matchup, 'NY vs. SAS'); assert.equal(E.nbaAbbr('GS'), 'GSW'); assert.equal(E.nbaAbbr('bos'), 'BOS');
});

test('preseason, play-in and all-star rows are left out; playoffs are kept apart; games with no minutes are skipped', () => {
  const j = log([
    { type: '2026-27 Preseason', games: [G('p', '2026-10-05T23:00:00.000+00:00', 'vs', 'X', 'XXX', 50)] },
    { type: '2025-26 Play In Regular Season', games: [G('pi', '2026-04-15T23:00:00.000+00:00', 'vs', 'Orlando Magic', 'ORL', 31)] },
    { type: '2026-27 Regular Season', games: [G('r1', '2026-11-01T23:00:00.000+00:00', 'vs', 'Boston Celtics', 'BOS', 20), G('dnp', '2026-11-03T23:00:00.000+00:00', 'vs', 'Boston Celtics', 'BOS', 0, 0), G('r2', '2026-11-05T23:00:00.000+00:00', '@', 'Miami Heat', 'MIA', 25)] },
    { type: '2025-26 Postseason', games: [G('po', '2026-05-01T23:00:00.000+00:00', 'vs', 'Detroit Pistons', 'DET', 30)] },
  ]);
  const r = E.parseGameLog(j, { teamAbbr: 'NYK' });
  assert.deepEqual(r.regular.map(g => g.pts), [25, 20], 'newest first; the 0-minute game is gone; preseason and play-in are not here');
  assert.deepEqual(r.post.map(g => g.pts), [30]);
});

test('nothing, or something that is not an ESPN log, gives an empty log and no crash', () => {
  for (const bad of [null, undefined, {}, { names: [], events: null }, 'x']) assert.deepEqual(E.parseGameLog(bad), { regular: [], post: [] });
});

test('averages use the same arithmetic and rounding as the nba.com script, including Python\'s round-half-to-even', () => {
  const a = E.calcAvgs([{ pts: 2, min: '30' }, { pts: 2, min: '30' }, { pts: 2, min: '30' }, { pts: 3, min: '30' }]);   // 9/4 = 2.25 -> Python gives 2.2
  assert.equal(a.pts, 2.2);
  assert.equal(E.calcAvgs([{ pts: 3 }, { pts: 3 }, { pts: 3 }, { pts: 4 }]).pts, 3.2, '13/4 = 3.25 -> 3.2');
  assert.equal(E.calcAvgs([{ pts: 2 }, { pts: 3 }]).pts, 2.5);
  assert.deepEqual(E.calcAvgs([]), {});
  const w = E.calcAvgs([{ fgm: 4, fga: 10, fg3m: 1, fg3a: 4, ftm: 2, fta: 2, min: '20' }, { fgm: 6, fga: 10, fg3m: 3, fg3a: 4, ftm: 0, fta: 2, min: '40' }]);
  assert.deepEqual([w.fg_pct, w.fg3_pct, w.ft_pct, w.min], [50, 50, 50, 30]);
});

test('last season counts for more early on and fades: the same weights as season_blend.py', () => {
  assert.equal(E.priorWeight(0), 1); assert.equal(E.priorWeight(null), 1);
  assert.equal(E.priorWeight(5), 0.25); assert.equal(E.priorWeight(15), 0.15); assert.equal(E.priorWeight(40), 0.1); assert.equal(E.priorWeight(60), 0.05); assert.equal(E.priorWeight(82), 0.05);
  assert.equal(E.priorWeight(1), 0.45); assert.equal(E.priorWeight(2), 0.4); assert.equal(E.priorWeight(21), 0.1475); assert.equal(E.priorWeight(30), 0.125);   // values checked against season_blend.prior_weight itself
  assert.deepEqual(E.blendAvgs({ pts: 20 }, { pts: 30 }, 0.1), { pts: 21 }); assert.deepEqual(E.blendAvgs({ pts: 20 }, {}, 0.1), { pts: 20 }); assert.deepEqual(E.blendAvgs({}, { pts: 30 }, 0.1), { pts: 30 });
});

test('the player log: this season first, topped up with last season, with the nba.com script\'s counts and averages', () => {
  const cur = E.parseGameLog(log([{ type: '2026-27 Regular Season', games: Array.from({ length: 15 }, (_, i) => G('c' + i, `2026-11-${String(15 - i).padStart(2, '0')}T23:00:00.000+00:00`, 'vs', 'Boston Celtics', 'BOS', 20 + i)) }]), { teamAbbr: 'NYK' });
  const pri = E.parseGameLog(log([{ type: '2025-26 Regular Season', games: Array.from({ length: 40 }, (_, i) => G('o' + i, `2026-04-${String(30 - i % 28).padStart(2, '0')}T23:00:00.000+00:00`, 'vs', 'Miami Heat', 'MIA', 10)) }]), { teamAbbr: 'NYK' });
  // the older games sort by date; make last season clearly older
  const L = E.buildLog({ name: 'A B', id: '1', season: '2026-27', current: cur, prior: pri });
  assert.equal(L.currentSeasonGames, 15); assert.equal(L.games.length, 20); assert.equal(L.priorSeasonGamesInWindow, 5);
  assert.equal(L.gamesFound, 15 + 4, 'round(30 * 0.15 = 4.5) is 4 in Python, not 5');
  assert.equal(L.games[0].priorSeason, undefined); assert.equal(L.games[15].priorSeason, true);
  assert.equal(L.l5.pts, E.calcAvgs(L.games.slice(0, 5)).pts); assert.equal(L.source, 'ESPN game log');
  assert.ok(L.season_avg.pts > 0);
  assert.deepEqual(E.buildLog({ name: 'N', id: '2', season: '2026-27', current: { regular: [], post: [] }, prior: { regular: [], post: [] } }), { error: 'No game log for N' });
  const veteran = E.buildLog({ name: 'V', id: '3', season: '2026-27', current: { regular: cur.regular.concat(cur.regular, cur.regular), post: [] }, prior: pri });
  assert.equal(veteran.priorSeasonGamesInWindow, 0, 'with 40+ games this season, last season is not added to the window'); assert.equal(veteran.gamesFound, 45);
});

test('opponents match by full name, nickname or code, and a different team in the same city does not match', () => {
  const g = { _opp: { name: 'Los Angeles Lakers', abbr: 'LAL' } };
  for (const q of ['Los Angeles Lakers', 'Lakers', 'LAL', 'lakers']) assert.ok(E.matchesOpponent(g, q), q);
  for (const q of ['Los Angeles Clippers', 'LAC', 'Celtics', '', null]) assert.ok(!E.matchesOpponent(g, q), String(q));
  assert.ok(E.matchesOpponent({ _opp: { name: 'Portland Trail Blazers', abbr: 'POR' } }, 'Trail Blazers'));
});

test('head to head: games against that team over the last seasons, newest first, stopping at six, with the trend', () => {
  const mk = (type, base, n, opp, pts) => ({ type, games: Array.from({ length: n }, (_, i) => G(base + i, `${base.slice(0, 4)}-${String(12 - i).padStart(2, '0')}-10T23:00:00.000+00:00`, 'vs', opp, 'BOS', pts[i])) });
  const s1 = E.parseGameLog(log([mk('2026-27 Regular Season', '2026a', 3, 'Boston Celtics', [30, 28, 26])]), { teamAbbr: 'NYK' });
  const s2 = E.parseGameLog(log([mk('2025-26 Regular Season', '2025a', 4, 'Boston Celtics', [20, 20, 20, 20])]), { teamAbbr: 'NYK' });
  const s3 = E.parseGameLog(log([mk('2024-25 Regular Season', '2024a', 4, 'Boston Celtics', [10, 10, 10, 10])]), { teamAbbr: 'NYK' });
  const r = E.buildH2H({ name: 'A', id: '1', opponent: 'Boston Celtics', seasons: [s1, s2, s3] });
  assert.equal(r.h2h.gamesVsOpp, 7, 'stops after the season that reached six: the third season is not used'); assert.equal(r.h2h.recentGames[0].pts, 30);
  assert.equal(r.h2h.trend, 'IMPROVING');
  assert.equal(E.buildH2H({ name: 'A', id: '1', opponent: 'Miami Heat', seasons: [s1] }).h2h, null);
});

// ── the server: nba.com first, ESPN when nba.com does not answer ──
function bridgeWorld({ source = 'auto', python }) {
  const calls = { python: 0, espn: 0 }; const events = [];
  const espnResult = { player: 'P', id: '9', source: 'ESPN game log', games: [], l10: {} };
  const g = {
    process: { env: { GAMELOG_SOURCE: source } }, security: { badString: () => false }, nbaApiBridgeCache: {}, NBA_BRIDGE_TTL: 1800e3, currentNbaSeason: () => '2026-27',
    enqueueBridge: fn => fn(), path: { join: (...a) => a.join('/') }, __dirname: '/app', console: { log() {}, warn() {} }, store: { addEvent: (...a) => events.push(a) },
    spawn: () => { calls.python++; return python(); },
    fetchViaEspn: async () => { calls.espn++; return espnResult; }, fetchH2HViaEspn: async () => { calls.espn++; return { gamesVsOpp: 6, source: 'espn' }; },
    setTimeout, clearTimeout, Date, Buffer, JSON,
  };
  const f = extract({ functions: ['fetchViaBridge', 'fetchH2HViaBridge', 'noteBridge'], consts: ['GAMELOG_SOURCE', 'bridgeHealth', 'bridgeIsDown', 'isBridgeOutage'], globals: g });
  return { f, calls, events, espnResult };
}
const fakePy = ({ out = '', err = '' } = {}) => {
  const hs = {};
  const py = { stdout: { on: (e, fn) => { if (e === 'data') hs.out = fn; } }, stderr: { on: (e, fn) => { if (e === 'data') hs.err = fn; } }, on: (e, fn) => { if (e === 'close') hs.close = fn; }, kill() {} };
  setImmediate(() => { if (out && hs.out) hs.out(Buffer.from(out)); if (err && hs.err) hs.err(Buffer.from(err)); if (hs.close) hs.close(0); });
  return py;
};

test('when the nba.com script gives nothing usable, the player\'s games come from ESPN instead of an error', async () => {
  const w = bridgeWorld({ python: () => fakePy({ out: '', err: '' }) });
  const r = await w.f.fetchViaBridge('Jalen Brunson');
  assert.equal(r.source, 'ESPN game log'); assert.equal(w.calls.python, 1); assert.equal(w.calls.espn, 1);
});

test('a real answer from nba.com is used as it is, and ESPN is not asked', async () => {
  const ok = JSON.stringify({ player: 'P', id: 1, source: 'nba_api (live)', games: [], l10: {} });
  const w = bridgeWorld({ python: () => fakePy({ out: ok }) });
  const r = await w.f.fetchViaBridge('Jalen Brunson'); assert.equal(r.source, 'nba_api (live)'); assert.equal(w.calls.espn, 0);
});

test('"player not found" from nba.com is an answer, not an outage: ESPN is not asked and the pause does not start', async () => {
  const w = bridgeWorld({ python: () => fakePy({ out: JSON.stringify({ error: 'Player not found: Nobody' }) }) });
  for (let i = 0; i < 4; i++) { const r = await w.f.fetchViaBridge('Nobody' + i); assert.match(r.error, /not found/); }
  assert.equal(w.calls.espn, 0); assert.equal(w.f.bridgeIsDown(), false);
});

test('three outages in a row pause nba.com for 15 minutes (no more 20-second waits), and the pause is announced once', async () => {
  const w = bridgeWorld({ python: () => fakePy({ out: '' }) });
  for (let i = 0; i < 3; i++) await w.f.fetchViaBridge('P' + i);
  assert.equal(w.calls.python, 3); assert.equal(w.f.bridgeIsDown(), true);
  await w.f.fetchViaBridge('P9'); await w.f.fetchViaBridge('P10');
  assert.equal(w.calls.python, 3, 'while paused the script is not started at all'); assert.equal(w.calls.espn, 5);
  assert.equal(w.events.length, 1, 'one note in the admin log, not one per lookup');
});

test('GAMELOG_SOURCE=espn never starts the script; =nba never uses ESPN', async () => {
  const a = bridgeWorld({ source: 'espn', python: () => fakePy({ out: '' }) });
  assert.equal((await a.f.fetchViaBridge('X')).source, 'ESPN game log'); assert.equal(a.calls.python, 0);
  const b = bridgeWorld({ source: 'nba', python: () => fakePy({ out: '' }) });
  const r = await b.f.fetchViaBridge('X'); assert.match(r.error, /parse error/i); assert.equal(b.calls.espn, 0);
});

test('a forced refresh (grading a game that just ended) forgets the player\'s cached game logs from both sources', async () => {
  const cache = { 'Jalen Brunson:2026-27': 1, 'h2h:Jalen Brunson:Boston Celtics': 1, 'Someone Else:2026-27': 1 };
  const eCache = { '3934672:2027': 1, '3934672:2026': 1, '999:2027': 1 };
  const f = extract({ functions: ['dropGameLogCaches'], globals: { nbaApiBridgeCache: cache, espnLogCache: eCache, resolveNBAPlayer: async n => (n === 'Jalen Brunson' ? { id: '3934672' } : null), Object } });
  await f.dropGameLogCaches('Jalen Brunson');
  assert.deepEqual(Object.keys(cache), ['Someone Else:2026-27']); assert.deepEqual(Object.keys(eCache), ['999:2027']);
  await f.dropGameLogCaches('Unknown Person'); assert.equal(Object.keys(cache).length, 1, 'an unknown player does not break it');
});

test('head to head: an error answer from the nba.com script ("Expecting value") is an outage and ESPN is used; "no games vs that team" is not', async () => {
  const blocked = bridgeWorld({ python: () => fakePy({ out: JSON.stringify({ error: 'Expecting value: line 1 column 1 (char 0)' }) }) });
  const h = await blocked.f.fetchH2HViaBridge('Jalen Brunson', 'Boston Celtics');
  assert.equal(h.gamesVsOpp, 6); assert.equal(blocked.calls.espn, 1);
  const none = bridgeWorld({ python: () => fakePy({ out: JSON.stringify({ player: 'P', h2h: null, error: 'No H2H games found vs Nowhere' }) }) });
  assert.equal(await none.f.fetchH2HViaBridge('Jalen Brunson', 'Nowhere'), null); assert.equal(none.calls.espn, 0, 'a real "none found" is an answer');
  const timedOut = bridgeWorld({ python: () => fakePy({ out: 'not json at all' }) });
  assert.equal((await timedOut.f.fetchH2HViaBridge('Jalen Brunson', 'Boston Celtics')).gamesVsOpp, 6);
  const espnOnly = bridgeWorld({ source: 'espn', python: () => fakePy({ out: '' }) });
  assert.equal((await espnOnly.f.fetchH2HViaBridge('Jalen Brunson', 'Boston Celtics')).gamesVsOpp, 6); assert.equal(espnOnly.calls.python, 0);
});
