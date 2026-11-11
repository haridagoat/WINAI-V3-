// The first two steps of the projection, run through the real module (lib/projection.js): the minutes projection and the usage multiplier.
// Numbers are worked out by hand in the comments, so a changed constant or a dropped step shows up as a failing test, not a drifting projection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const params = require('../lib/params');
const { makeProjection } = require('./helpers/projection');

params.load();
const near = (a, b, eps = 0.06) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
// Settings for one test only, restored after (each test file runs in its own process, so nothing leaks to other files).
function withParams(obj, fn) {
  const f = path.join(os.tmpdir(), 'mu_' + Math.random().toString(36).slice(2) + '.json'); fs.writeFileSync(f, JSON.stringify(obj));
  params.load(f);
  try { return fn(); } finally { params.load(); }
}

// ── building blocks ────────────────────────────────────────────────────────────────────────────────
const day = i => `2026-11-${String(10 - i).padStart(2, '0')}`;                       // game 0 is the newest, 10 Nov
const games = (mins, pts = null) => mins.map((m, i) => ({ date: day(i), min: m, pts: pts ? pts[i] : 20, reb: 5, ast: 4, fg3m: 2, stl: 1, blk: 1 }));
const stats = (mins, { season = 30, seasonGames = 10, pts = null, name = 'Target Guy' } = {}) => ({
  player: { name }, last10Games: games(mins, pts), seasonGames, seasonAvg: season == null ? undefined : { min: season, pts: 20 }, averages: { min: String(mins[0]), pts: '20' },
});
const same = (n, v) => Array(n).fill(v);

// A team: the target plus seven regulars (15 points a game each, 30 minutes), and whoever is injured, with season rows the way the stat file holds them (totals).
const row = (name, ppg, mpg = 30, gp = 10) => ({ PLAYER_NAME: name, GP: gp, MIN: mpg * gp, PTS: ppg * gp, REB: 50, AST: 30, FG3M: 15, STL: 8, BLK: 4 });
const healthy = ['Target Guy', 'Pa One', 'Pb Two', 'Pc Three', 'Pd Four', 'Pe Five', 'Pf Six', 'Pg Seven'];
function team({ injured = [], ppg = {}, mpg = {} } = {}) {
  const rows = healthy.map(n => row(n, 15)), inj = injured.map(i => ({ name: i.name, status: i.status || 'Out', position: 'F' }));
  for (const i of injured) rows.push(row(i.name, i.ppg ?? 25, i.mpg ?? 30));
  return { rows, roster: { players: healthy.map(name => ({ name })), injured: inj } };
}
// An absence cache entry: how the injured player's missed games line up with the target's recent games.
const NEW_ABSENCE = { lastPlayed: '2026-11-11', gamesThisSeason: 10 };       // missed every recent game? No: played until after them, so the absence is new to the baseline
const OLD_ABSENCE = { lastPlayed: '2026-10-01', gamesThisSeason: 0 };        // has missed all of the target's recent games and the season: already in the baseline
const proj = (rows, cache) => makeProjection({ injuryAbsenceCache: cache || {}, loadNBAStats: () => ({ playerStats: rows }) });

// ── minutes ──────────────────────────────────────────────────────────────────────────────────────────
test('minutes: recent minutes are pulled toward the season by 6 games of weight, then the last three games add half the gap', () => {
  // ten games of 30 minutes, season average 24: weight on recent 10/(10+6) = 0.625 -> 30*.625 + 24*.375 = 27.75
  // last three (30) against 27.75: gap 8.1% of the baseline, half of it = +4.05% -> 28.875
  const m = proj([]).projectMinutes(stats(same(10, 30), { season: 24 }), {}, 'points');
  near(m.baselineMinutes, 27.75); near(m.projectedMinutes, 28.875); near(m.recentMinutes, 30); near(m.seasonMinutes, 24);
  assert.deepEqual(m.details.map(d => d.label), ['season-shrunk baseline', 'recent rotation trend']);
  near(m.details[1].minutes, 1.1);
});

test('minutes: a player with no games this season gets weight from the season only as far as there are games, and none when there is no season at all', () => {
  const m = proj([]).projectMinutes(stats(same(10, 30), { season: null }), {}, 'points');
  near(m.baselineMinutes, 30); assert.equal(m.seasonMinutes, null); assert.ok(!m.details.some(d => d.label === 'season-shrunk baseline'));
  const few = proj([]).projectMinutes(stats(same(2, 30), { season: 20, seasonGames: 2 }), {}, 'points');
  near(few.baselineMinutes, 22.5);                                   // 2 games: weight 2/(2+6) = .25 -> 30*.25 + 20*.75
});

test('minutes: the recent-trend step moves minutes by at most 12 percent either way', () => {
  // season 20; ten games 38,38,38 then seven of 20. Winsorized to 10..30 around the median of 20: 38 becomes 30, so recent = 23, baseline 21.875.
  // last three average 30: the gap is +37%, half of it +18.6%, held to +12% -> 21.875 * 1.12 = 24.5
  const up = proj([]).projectMinutes(stats([38, 38, 38, ...same(7, 20)], { season: 20 }), {}, 'points');
  near(up.baselineMinutes, 21.875); near(up.projectedMinutes, 24.5);
  // the same shape reversed: season 40, last three of 10 against a baseline near 36.4 -> -12% -> ~32
  const down = proj([]).projectMinutes(stats([10, 10, 10, ...same(7, 40)], { season: 40 }), {}, 'points');
  near(down.projectedMinutes / down.baselineMinutes, 0.88, 0.006);   // the figures are rounded to a tenth, so the ratio is too
});

test('minutes: one wild game cannot move the baseline much (outliers are clipped to the player\'s own median)', () => {
  const calm = proj([]).projectMinutes(stats(same(10, 30), { season: 30 }), {}, 'points').baselineMinutes;
  const wild = proj([]).projectMinutes(stats([60, ...same(9, 30)], { season: 30 }), {}, 'points').baselineMinutes;   // a 60-minute game is clipped to 45
  assert.ok(wild - calm < 1.0, `${wild} vs ${calm}`); assert.ok(wild > calm);
});

test('minutes: a teammate who is out adds minutes, but only the share of the lift that minutes carry, and never more than 20 percent', () => {
  // seven regulars at 15 ppg + the target = 8 healthy at 15, the star at 25: his share is 25 / (8*15 + 25) = 17.24%, times the points sensitivity .29 = +5.0% usage.
  // The minutes share for points is .18 / .29 = 0.62, so minutes grow 5.0% * .62 = 3.1%: 30 -> 30.93.
  const t = team({ injured: [{ name: 'Star Man' }] }), s = stats(same(10, 30), { season: 30 });
  const m = proj(t.rows, { 'star man': NEW_ABSENCE }).projectMinutes(s, { playerRoster: t.roster, nbaPlayerStats: t.rows }, 'points');
  near(m.projectedMinutes, 30.93, 0.05);
  assert.ok(m.details.some(d => d.label === 'teammate-out role bump'));
  const none = proj(t.rows, { 'star man': OLD_ABSENCE }).projectMinutes(s, { playerRoster: t.roster, nbaPlayerStats: t.rows }, 'points');
  near(none.projectedMinutes, 30, 0.01); assert.ok(!none.details.some(d => d.label === 'teammate-out role bump'), 'an absence already in his recent games adds nothing');
  // the cap: a sensitivity of .5 with minutes carrying .9 of it (slope 1.5) on a +30% usage would be +27%: held to +20%
  withParams({ usage: { sens: { points: 0.5 }, minutesSlope: 1.5 } }, () => {
    const big = team({ injured: [{ name: 'Huge Man', ppg: 200 }] });
    const capped = proj(big.rows, { 'huge man': NEW_ABSENCE }).projectMinutes(s, { playerRoster: big.roster, nbaPlayerStats: big.rows }, 'points');
    near(capped.projectedMinutes, 36, 0.01);
  });
});

test('minutes: the back-to-back cut applies only on a back-to-back and only when the setting is below 1', () => {
  const s = stats(same(10, 30), { season: 30 });
  near(proj([]).projectMinutes(s, { gameContext: { isBackToBack: true } }, 'points').projectedMinutes, 30, 0.01);            // shipped setting: 1.0, no cut
  withParams({ rest: { minutes: 0.96 } }, () => {
    const b2b = proj([]).projectMinutes(s, { gameContext: { isBackToBack: true } }, 'points');
    near(b2b.projectedMinutes, 28.8, 0.01); assert.ok(b2b.details.some(d => d.label === 'back-to-back rest management'));
    near(proj([]).projectMinutes(s, { gameContext: { isBackToBack: false } }, 'points').projectedMinutes, 30, 0.01);
  });
});

// ── usage ────────────────────────────────────────────────────────────────────────────────────────────
const usage = (P, t, s, prop = 'points') => P.calcUsageInflation(t.roster, s, prop, t.rows, 'nba');

test('usage: a star who is out gives the sensitivity times his share of the team\'s production', () => {
  const t = team({ injured: [{ name: 'Star Man' }] }), s = stats(same(10, 30));
  near(usage(proj(t.rows, { 'star man': NEW_ABSENCE }), t, s), 1.05, 1e-3);                 // .29 * 25/145
  const rebs = proj(t.rows, { 'star man': NEW_ABSENCE }), tr = team({ injured: [{ name: 'Star Man' }] });
  assert.ok(usage(rebs, tr, stats(same(10, 30)), 'rebounds') > 1);
});

test('usage: how much of the absence is already in his recent games decides how much counts', () => {
  const t = team({ injured: [{ name: 'Star Man' }] }), s = stats(same(10, 30));
  near(usage(proj(t.rows, { 'star man': OLD_ABSENCE }), t, s), 1.0, 1e-3);                  // out for all of his recent games: nothing new
  near(usage(proj(t.rows, {}), t, s), 1.025, 1e-3);                                         // no record of it either way: half
  const half = { 'star man': { lastPlayed: day(5), gamesThisSeason: 5 } };                   // missed some of his games
  const w = usage(proj(t.rows, half), t, s); assert.ok(w > 1.0 && w < 1.05, `${w}`);
});

test('usage: questionable counts half, doubtful and out count in full, and a bench player who is out counts for nothing', () => {
  const s = stats(same(10, 30));
  const q = team({ injured: [{ name: 'Star Man', status: 'Questionable' }] }), d = team({ injured: [{ name: 'Star Man', status: 'Doubtful' }] });
  near(usage(proj(q.rows, { 'star man': NEW_ABSENCE }), q, s), 1.025, 1e-3);
  near(usage(proj(d.rows, { 'star man': NEW_ABSENCE }), d, s), 1.05, 1e-3);
  const bench = team({ injured: [{ name: 'Bench Guy', ppg: 6, mpg: 9 }] });
  const P = proj(bench.rows, { 'bench guy': NEW_ABSENCE });
  near(usage(P, bench, s), 1.0, 1e-3); assert.equal(P.calcUsageInflation._lastTeammate, 0);
});

test('usage: more than one player out adds up, the missing share is capped at 60 percent, and the whole lift at +30 percent', () => {
  const s = stats(same(10, 30)), cache = { 'star man': NEW_ABSENCE, 'second man': NEW_ABSENCE };
  const two = team({ injured: [{ name: 'Star Man' }, { name: 'Second Man', ppg: 20 }] });
  near(usage(proj(two.rows, cache), two, s), 1 + 0.29 * 45 / 165, 1e-3);                    // (25 + 20) of 8*15 + 25 + 20 = 165
  withParams({ usage: { sens: { points: 1.5 } } }, () => {
    const huge = team({ injured: [{ name: 'Huge Man', ppg: 200 }] });                       // 200 of 320 would be 62%: held to 60%, and 1.5 * .6 = +90% is held to +30%
    assert.equal(usage(proj(huge.rows, { 'huge man': NEW_ABSENCE }), huge, s), 1.3);
    const cooling = stats(same(10, 30), { pts: [16, 16, 16, ...same(7, 20)] });
    assert.equal(usage(proj(huge.rows, { 'huge man': NEW_ABSENCE }), huge, cooling), 1.25, 'the teammate part is held to +30% first, then the cooling trend takes 5% off (not 1.9 - .05 clamped to 1.30)');
    const share = proj(huge.rows, { 'huge man': NEW_ABSENCE }).missingProductionShare(huge.roster, huge.roster.injured, huge.rows, s);
    assert.equal(share.share.PTS, 0.6, '200 of 320 is 62.5%, held to 60%');
  });
});

test('usage: with fewer than five regulars on the squad the production share is not trusted and no teammate lift is applied', () => {
  const t = { rows: [row('Target Guy', 15), row('Pa One', 15), row('Star Man', 25)], roster: { players: [{ name: 'Target Guy' }, { name: 'Pa One' }], injured: [{ name: 'Star Man', status: 'Out' }] } };
  assert.equal(proj(t.rows).missingProductionShare(t.roster, t.roster.injured, t.rows, stats(same(10, 30))), null);
});

test('usage: the hot-streak term is half the gap between the last three and last ten games, held to 5 percent, and needs five games and a single stat', () => {
  const none = { roster: { players: [], injured: [] }, rows: [] }, P = proj([]);
  const at = (pts, prop = 'points') => P.calcUsageInflation(none.roster, stats(same(10, 30), { pts }), prop, none.rows, 'nba');
  near(at([21, 21, 21, ...same(7, 20)]), 1.0172, 1e-3);          // l10 = 20.3, l3 = 21: +3.4% gap, half = +1.72%
  assert.equal(at([24, 24, 24, ...same(7, 20)]), 1.05);          // +13% gap would be +6.6%: held to +5%
  assert.equal(at([16, 16, 16, ...same(7, 20)]), 0.95);          // and -5% the other way
  assert.equal(at(same(10, 20)), 1);
  assert.equal(at([24, 24, 24, ...same(7, 20)], 'pra'), 1, 'a combo has no single stat to trend');
  const short = P.calcUsageInflation(none.roster, { ...stats(same(4, 30), { pts: [24, 24, 24, 20] }), last10Games: games(same(4, 30), [24, 24, 24, 20]) }, 'points', none.rows, 'nba');
  assert.equal(short, 1, 'under five games: no trend');
});

test('usage: the teammate part and the hot-streak part add, and the result stays between 0.85 and 1.30', () => {
  const t = team({ injured: [{ name: 'Star Man' }] }), s = stats(same(10, 30), { pts: [24, 24, 24, ...same(7, 20)] });
  near(usage(proj(t.rows, { 'star man': NEW_ABSENCE }), t, s), 1.10, 1e-3);                  // +5.0% teammates, +5% hot
  assert.equal(proj([]).calcUsageInflation({ players: [], injured: [] }, stats(same(10, 30), { pts: [16, 16, 16, ...same(7, 20)] }), 'points', [], 'nba'), 0.95);
});

test('usage: the numbers shown for the page (the teammate part and its breakdown) match the multiplier', () => {
  const t = team({ injured: [{ name: 'Star Man' }] }), s = stats(same(10, 30), { pts: [24, 24, 24, ...same(7, 20)] }), P = proj(t.rows, { 'star man': NEW_ABSENCE });
  const b = P.calcInjuryBreakdown(t.roster, s, 'points', t.rows, 'nba');
  near(b.mult, 1.10, 1e-3); near(b.teammateBoost, 0.05, 1e-3); near(b.totalBoost, 0.10, 1e-3); assert.equal(b.usgBased, true);
  assert.equal(b.details[0].method, 'production share'); assert.equal(b.details[0].injuredPlayers[0].newToBaseline, '100%');
  assert.deepEqual(b.injuredPlayers.map(p => p.name), ['Star Man']);
});
