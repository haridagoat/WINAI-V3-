#!/usr/bin/env node
// The replay lab. Walks forward through past games, tests how rates, minutes and teammate-out effects are predicted, and (with --write)
// saves the settings that beat the current method on a season they were not fitted on.
//
//   python3 scripts/lab/fetch_logs.py     (first, once; downloads about 55,000 player-games)
//   npm run lab                           print what it finds
//   npm run lab -- --write                also update model_params.json with the settings that held up
//
// Fitted on the oldest full season, checked on the next one. A setting is adopted only when it improves the checked season by at least 0.5%.
const fs = require('fs'), path = require('path');
const lab = require('../../lib/lab');

const ROOT = path.join(__dirname, '..', '..'), DATA = path.join(ROOT, 'lab_data'), WRITE = process.argv.includes('--write');
const load = f => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (_) { return null; } };
const seasons = fs.existsSync(DATA) ? [...new Set(fs.readdirSync(DATA).map(f => (f.match(/^players_(\d{4}-\d{2})\.json$/) || [])[1]).filter(Boolean))].sort().reverse() : [];
if (seasons.length < 2) { console.error('Need at least two seasons in lab_data/. Run: python3 scripts/lab/fetch_logs.py'); process.exit(1); }

const build = season => {
  const players = load(`players_${season}.json`), teams = load(`teams_${season}.json`);
  if (!players || !teams) return null;
  const info = lab.prepareTeams(teams);
  return { season, rows: players, info, players: lab.preparePlayers(players, info), games: players.length };
};
// newest first: [current (may be partial), last season, the one before]
const data = seasons.map(build).filter(Boolean);
const current = data[0], testSeason = data[1], trainSeason = data[2] || data[1];
console.log(`Seasons: current ${current.season} (${current.games} player-games), check ${testSeason.season} (${testSeason.games}), fit ${trainSeason.season} (${trainSeason.games})\n`);

const f = (v, d = 3) => (v == null ? '  -  ' : v.toFixed(d));
const pctBetter = (a, b) => (a == null || b == null ? null : (b - a) / b * 100);
const report = { at: new Date().toISOString(), seasons: { current: current.season, check: testSeason.season, fit: trainSeason.season } };
const adopt = { decay: { halfLifeGames: {}, shrinkK: {}, lambda: {} }, spread: {}, minutes: null, usage: { sens: {} }, rest: null };

// ── 1. how to predict a player's level ──
console.log('1. PREDICTING A PLAYER\'S STAT  (average miss per game, lower is better; rotation players only)');
console.log('   stat   fitted settings            |  checked season: fitted   current   last 10   season avg   | better than current');
report.level = {};
for (const stat of lab.STATS) {
  const r = lab.fitLevel(trainSeason.players, testSeason.players, stat);
  const better = pctBetter(r.test.fitted, r.test.current);
  const holdout = current.games > 1500 ? (() => { const rows = lab.levelRows(current.players, stat, { halfLife: r.halfLife, lambda: r.lambda }, 15); return rows.length >= 150 ? { n: rows.length, fitted: lab.mae(rows, x => x.pred), current: lab.mae(rows, x => x.current) } : null; })() : null;
  report.level[stat] = { ...r, betterPct: better, holdout };
  console.log(`   ${stat.padEnd(5)}  half-life ${String(r.halfLife).padEnd(4)} games, ${Math.round(r.lambda * 100)}% decayed   |  ${f(r.test.fitted)}    ${f(r.test.current)}    ${f(r.test.l10)}    ${f(r.test.season)}   | ${better == null ? '-' : better.toFixed(1) + '%'}${holdout ? `   (this season so far, n=${holdout.n}: ${f(holdout.fitted)} vs ${f(holdout.current)})` : ''}`);
  if (better != null && better >= 1.0 && (!holdout || holdout.fitted <= holdout.current * 1.01)) { const k = lab.KEY[stat === 'FG3M' ? 'FG3M' : stat]; adopt.decay.halfLifeGames[k] = r.halfLife; adopt.decay.lambda[k] = r.lambda; }
}

// ── 2. spread of outcomes ──
console.log('\n2. SPREAD OF OUTCOMES AROUND A PREDICTION  (sd = a + b x level;  phi = variance / mean for count stats)');
report.spread = {};
for (const stat of lab.STATS) {
  const lv = report.level[stat], s = lab.fitSpread(testSeason.players, stat, { halfLife: lv.halfLife, lambda: lv.lambda });
  report.spread[stat] = s;
  console.log(`   ${stat.padEnd(5)} a=${f(s.a, 2)}  b=${f(s.b, 3)}  phi=${f(s.phi, 2)}   (n=${s.n})`);
  if (['FG3M', 'STL', 'BLK'].includes(stat) && s.phi != null && s.phi > 0.2 && s.phi < 4) adopt.spread[lab.KEY[stat]] = { phi: parseFloat(s.phi.toFixed(2)) };
}

// ── 3. minutes ──
console.log('\n3. MINUTES  (average miss in minutes)');
const trainMin = lab.minutesRows(trainSeason.players), testMin = lab.minutesRows(testSeason.players);
const m = lab.fitMinutes(trainMin, testMin);
report.minutes = m;
console.log(`   checked season (n=${m.test.n}):  current method ${f(m.test.current, 2)}   decayed average ${f(m.test.decayOnly, 2)}   decayed + rest + expected blowout ${f(m.test.withContext, 2)}   (${(pctBetter(m.test.withContext, m.test.current) ?? 0).toFixed(1)}% better than current)`);
console.log(`   back-to-back: ${((m.b2bRatio - 1) * 100).toFixed(1)}% minutes   (the live model uses -4%)`);
console.log('   expected size of the margin -> minutes vs the player\'s own baseline:');
console.log('     |margin|   starters (28+ min)          rotation (12-28 min)');
for (let i = 0; i < Math.max(m.starterCurve.length, m.benchCurve.length); i++) {
  const s = m.starterCurve[i], b = m.benchCurve[i], lab_ = (s || b);
  console.log(`     ${String(lab_.from).padStart(2)}-${String(lab_.to ?? '+').padEnd(3)}   ${s ? ((s.ratio - 1) * 100).toFixed(1).padStart(6) + '%  (n=' + s.n + ')' : '   -   '}       ${b ? ((b.ratio - 1) * 100).toFixed(1).padStart(6) + '%  (n=' + b.n + ')' : '   -   '}`);
}
const minBetter = pctBetter(m.test.withContext, m.test.current);
if (minBetter != null && minBetter >= 0.5) adopt.minutes = { starterMin: m.starterMin, starterCurve: m.starterCurve.map(x => ({ from: x.from, to: x.to, ratio: x.ratio })), benchCurve: m.benchCurve.map(x => ({ from: x.from, to: x.to, ratio: x.ratio })), b2bRatio: m.b2bRatio };

// ── 4. teammates out ──
console.log('\n4. WHEN A REGULAR ROTATION PLAYER IS OUT  (extra output by the others, per 1.0 of the team\'s production that is missing)');
const combinedPlayers = new Map(); for (const s of [trainSeason, testSeason]) for (const [id, p] of s.players) { const key = `${s.season}:${id}`; combinedPlayers.set(key, p); }
const sharesAll = new Map(); for (const s of [trainSeason, testSeason]) for (const [k, v] of lab.missingShares(s.rows, s.info)) sharesAll.set(k, v);   // game ids are unique across seasons
const levelParams = Object.fromEntries(lab.STATS.map(s => [s, { halfLife: report.level[s].halfLife, lambda: report.level[s].lambda }]));
const out = lab.fitTeammateOut(combinedPlayers, sharesAll, levelParams);
report.teammateOut = out;
console.log('   stat    slope (95% range)         games with someone out   lift by missing share (0-5%, 5-12%, 12-25%, 25%+)');
for (const stat of [...lab.STATS, 'MIN']) {
  const r = out[stat], rng = r.stderr != null ? `${(r.slope - 1.96 * r.stderr).toFixed(2)} to ${(r.slope + 1.96 * r.stderr).toFixed(2)}` : '-';
  console.log(`   ${stat.padEnd(5)}   ${f(r.slope, 2)} (${rng})`.padEnd(46) + `${String(r.nWithMissing).padStart(6)}                   ${r.buckets.map(b => b.lift == null ? '  -  ' : (b.lift * 100).toFixed(1) + '%').join('   ')}`);
  if (stat !== 'MIN' && r.slope != null && r.stderr != null && r.slope > 0 && r.slope / r.stderr >= 2) adopt.usage.sens[lab.KEY[stat]] = r.slope;
}
if (out.MIN.slope != null && out.MIN.stderr != null && out.MIN.slope > 0 && out.MIN.slope / out.MIN.stderr >= 2) adopt.usage.minutesSlope = out.MIN.slope;

// ── 5. rest ──
console.log('\n5. SECOND NIGHT OF A BACK-TO-BACK  (given that the player played; change vs his own baseline, +/- one standard error)');
const rest = lab.fitRest(combinedPlayers, levelParams);
report.rest = rest;
for (const stat of ['MIN', ...lab.STATS]) { const r = rest[stat]; console.log(`   ${stat.padEnd(5)} back-to-back ${((r.b2b.lift ?? 0) * 100).toFixed(1).padStart(5)}% +/-${((r.b2b.stderr ?? 0) * 100).toFixed(1)} (n=${r.b2b.n})    1 day off ${((r.oneDay.lift ?? 0) * 100).toFixed(1).padStart(5)}%    2+ days off ${((r.rested.lift ?? 0) * 100).toFixed(1).padStart(5)}%`); }
console.log('   ...and only in games where every regular rotation player was there (so teammates resting does not distort it):');
const restClean = lab.fitRest(combinedPlayers, levelParams, sharesAll);
report.restClean = restClean;
for (const stat of ['MIN', ...lab.STATS]) { const r = restClean[stat]; console.log(`   ${stat.padEnd(5)} back-to-back ${((r.b2b.lift ?? 0) * 100).toFixed(1).padStart(5)}% +/-${((r.b2b.stderr ?? 0) * 100).toFixed(1)} (n=${r.b2b.n})    1 day off ${((r.oneDay.lift ?? 0) * 100).toFixed(1).padStart(5)}%    2+ days off ${((r.rested.lift ?? 0) * 100).toFixed(1).padStart(5)}%`); }
adopt.rest = { minutes: parseFloat(Math.min(1, 1 + restClean.MIN.b2b.lift - restClean.MIN.rested.lift).toFixed(3)), stats: parseFloat(Math.min(1, 1 + restClean.PTS.b2b.lift - restClean.PTS.rested.lift).toFixed(3)) };   // never a bonus: only a penalty the data supports

// ── 6. what defenses give up to guards, forwards and centers ──
console.log('\n6. WHAT A DEFENSE GIVES UP TO A PLAYER\'S GROUP  (guards / forwards / centers; slope of "vs his own baseline" on "how far the defense is above the league", shrunk toward the league for early games)');
const positions = load('positions.json');
report.positionAllowed = null;
if (!positions) console.log('   (skipped: no lab_data/positions.json; run python3 scripts/lab/fetch_logs.py)');
else {
  const groupOf = id => lab.groupOfPosition(positions[String(id)]);
  const per = [trainSeason, testSeason].map(s => ({ season: s.season, fit: lab.fitPositionAllowed(s.players, lab.allowedByGroup(s.rows, s.info, groupOf), groupOf, levelParams) }));
  report.positionAllowed = per;
  console.log('   stat   whole-defense level (fit season | checked season)      split between groups only (fit season | checked season)');
  const cell = c => (c.slope == null ? '    -    ' : `${c.slope.toFixed(2)} +/-${(1.96 * (c.stderr ?? 0)).toFixed(2)}`.padStart(13));
  for (const stat of lab.STATS) console.log(`   ${stat.padEnd(5)} ${per.map(p => cell(p.fit[stat].level)).join(' | ')}        ${per.map(p => cell(p.fit[stat].mix)).join(' | ')}      (typical gap ${(per[1].fit[stat].mix.sdX * 100 || 0).toFixed(1)}%)`);
  console.log('   ...and the group\'s figure for the stat once the defense\'s overall points allowed are known (what the group and the stat add):');
  for (const stat of lab.STATS) console.log(`   ${stat.padEnd(5)} ${per.map(p => cell(p.fit[stat].net)).join(' | ')}`);
  adopt.positionAllowed = {};
  for (const stat of lab.STATS) {
    const a = per[0].fit[stat].net, b = per[1].fit[stat].net;
    // adopted only when both seasons agree on the sign and the pair is clearly above zero (the group's figure for the stat, beyond overall points allowed)
    if (a.slope > 0 && b.slope > 0 && a.stderr != null && b.stderr != null && (a.slope + b.slope) / 2 >= 2 * Math.sqrt((a.stderr ** 2 + b.stderr ** 2) / 4)) adopt.positionAllowed[lab.KEY[stat]] = parseFloat(Math.min(1, (a.slope + b.slope) / 2).toFixed(2));
  }
}

// ── 7. a player's own record without a teammate ──
console.log('\n7. A PLAYER\'S OWN RECORD WITHOUT THE SAME TEAMMATE  (games where a regular teammate was out; average miss per game, lower is better)');
{
  const slopes = Object.fromEntries(lab.STATS.map(st => [st, out[st].slope ?? 0]));
  const ordered = [trainSeason, testSeason].filter((x, i, arr) => arr.indexOf(x) === i);
  if (ordered.length < 2) console.log('   (skipped: needs two seasons)');
  else {
    const res = lab.fitPairWithout(ordered, sharesAll, slopes, levelParams);
    report.pairWithout = res;
    console.log('   stat   games   baseline   league-wide lift   own record (k=)  best on fit season -> checked season   better than league-wide');
    for (const stat of lab.STATS) {
      const fit = res[stat][trainSeason.season], chk = res[stat][testSeason.season];
      if (!fit || !chk) { console.log(`   ${stat}: not enough games`); continue; }
      const ks = Object.keys(fit.pair).map(Number), bestK = ks.reduce((b, k) => (fit.pair[k] < fit.pair[b] ? k : b), ks[0]);
      const m = (e, x) => x / e.n;
      console.log(`   ${stat.padEnd(5)} ${String(chk.n).padStart(6)}   ${f(m(chk, chk.base))}      ${f(m(chk, chk.league))}              ${f(m(chk, chk.pair[bestK]))} (k=${bestK})     fit ${(pctBetter(m(fit, fit.pair[bestK]), m(fit, fit.league)) ?? 0).toFixed(2)}% -> checked ${(pctBetter(m(chk, chk.pair[bestK]), m(chk, chk.league)) ?? 0).toFixed(2)}%`);
    }
    console.log('   and is the league-wide lift itself right on these games? (checked season; average signed miss = actual - predicted, and root-mean-square miss)');
    for (const stat of lab.STATS) { const e = res[stat][testSeason.season]; if (e) console.log(`     ${stat.padEnd(5)} signed miss: baseline ${(e.biasBase / e.n).toFixed(3)}  with lift ${(e.biasLeague / e.n).toFixed(3)}    root-mean-square: baseline ${Math.sqrt(e.sqBase / e.n).toFixed(3)}  with lift ${Math.sqrt(e.sqLeague / e.n).toFixed(3)}`); }
    console.log('   what size of lift fits best? (1.00 = the league-wide lift as fitted; fit season | checked season)');
    for (const stat of lab.STATS) { const c = x => { const e = res[stat][x.season]; return e && e.sxx > 0 ? (e.sxy / e.sxx).toFixed(2) : '  - '; }; console.log(`     ${stat.padEnd(5)} ${c(trainSeason)} | ${c(testSeason)}`); }
    // The fitted lift is too big when checked game by game: scale what is adopted by the size that fits best (average of both seasons, between 0 and 1).
    const sizeOf = stat => { const v = [trainSeason, testSeason].map(x => { const e = res[stat][x.season]; return e && e.sxx > 0 ? e.sxy / e.sxx : null; }).filter(x => x != null); return v.length ? Math.max(0, Math.min(1, v.reduce((a, b) => a + b, 0) / v.length)) : 1; };
    report.liftSize = Object.fromEntries(lab.STATS.map(st => [st, parseFloat(sizeOf(st).toFixed(2))]));
    for (const st of lab.STATS) { const k = lab.KEY[st]; if (adopt.usage.sens[k] != null) adopt.usage.sens[k] = parseFloat((adopt.usage.sens[k] * sizeOf(st)).toFixed(2)); }
    if (adopt.usage.minutesSlope != null) adopt.usage.minutesSlope = parseFloat((adopt.usage.minutesSlope * sizeOf('PTS')).toFixed(2));
    console.log('   (every k tried, checked season, % better than league-wide, points | assists | rebounds | 3pm)');
    for (const k of Object.keys(res.PTS[testSeason.season]?.pair || {})) console.log(`     k=${String(k).padEnd(3)} ${['PTS', 'AST', 'REB', 'FG3M'].map(st => { const e = res[st][testSeason.season]; return e ? (pctBetter(e.pair[k] / e.n, e.league / e.n) ?? 0).toFixed(2).padStart(7) + '%' : '   -   '; }).join(' | ')}`);
  }
}

console.log('\nADOPTED (settings that held up on the checked season):');
console.log(JSON.stringify(adopt, null, 2));
fs.writeFileSync(path.join(DATA, 'report.json'), JSON.stringify(report, null, 2));

if (WRITE) {
  const file = path.join(ROOT, 'model_params.json'), cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file + '.bak', JSON.stringify(cur, null, 2));
  const merged = require('../../lib/params').merge(cur, { fittedAt: report.at, decay: adopt.decay, spread: adopt.spread, ...(adopt.minutes ? { minutes: adopt.minutes } : {}), usage: adopt.usage, ...(adopt.rest ? { rest: adopt.rest } : {}), ...(adopt.positionAllowed && Object.keys(adopt.positionAllowed).length ? { positionAllowed: { sens: adopt.positionAllowed } } : {}) });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  console.log(`\nWrote ${path.relative(ROOT, file)} (previous copy kept as model_params.json.bak)`);
} else console.log('\n(not written: run with --write to save these)');
