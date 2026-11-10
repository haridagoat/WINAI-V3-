// The daily grading report for the admin: how yesterday's picks and logged props came out. Pure functions, no I/O.
//
// Input (all plain data, assembled by the server):
//   date        the day being reported, YYYY-MM-DD (yesterday)
//   picks       every graded pick: { league, day, result: WIN|LOSS|PUSH, player, propType, verdict, line, actualStat, confidence?, ev? }
//   allPicks    every logged pick, graded or not, for choosing each day's best bets: { id, day, confidence, ev }
//   pickCounts  { waiting, setAside }   picks still ungraded / given up on
//   scan        { nba: { counts, graded: [rows] }, wnba: ... }   the scan log: counts and every graded row (rows carry .date and .data)
//   top3        the locked daily Top 3 picks: { date, league, player, propType, line, direction, confidence?, ev?, actual? } (actual null until graded)
//   calibration { active, reason }      credits: remaining Odds credits (or null)
const { scoreRows, valuePickRecord, disagreement, forwardChecks } = require('./evaluate');
const bestBets = require('./bestbets');

const pct = v => (v == null || !isFinite(v) ? '-' : `${(v * 100).toFixed(1)}%`);
const rec = a => {
  const wins = a.filter(p => p.result === 'WIN').length, losses = a.filter(p => p.result === 'LOSS').length, pushes = a.filter(p => p.result === 'PUSH').length;
  return { n: a.length, wins, losses, pushes, winRate: wins + losses ? wins / (wins + losses) : null };
};
const recText = r => `${r.wins}-${r.losses}${r.pushes ? `-${r.pushes}` : ''} (${pct(r.winRate)})`;
const num = (v, d = 2) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));
const dayLabel = d => { const t = new Date(`${d}T12:00:00Z`); return isNaN(t) ? d : t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); };
// How strong a pick was when it was made: the confidence score the app shows, and the expected value per $1 at the price taken.
const STRENGTH = [{ key: 'strong', label: 'Strong', range: '70+', min: 70 }, { key: 'solid', label: 'Solid', range: '60-69', min: 60 }, { key: 'fair', label: 'Fair', range: '50-59', min: 50 }, { key: 'light', label: 'Light', range: 'under 50', min: -Infinity }];
const EV_TIERS = [{ key: 'value', label: 'Value', range: '3%+', min: 0.03 }, { key: 'small', label: 'Small edge', range: '0-3%', min: 0 }, { key: 'negative', label: 'Below break-even', range: 'under 0', min: -Infinity }];
const isNum = v => typeof v === 'number' && isFinite(v);
const strengthOf = c => (isNum(c) ? STRENGTH.find(b => c >= b.min) : null);
const evTierOf = v => (isNum(v) ? EV_TIERS.find(b => v >= b.min) : null);
const LABEL = { points: 'pts', rebounds: 'reb', assists: 'ast', '3pm': '3pm', steals: 'stl', blocks: 'blk', pra: 'pra', pr: 'p+r', pa: 'p+a', ra: 'r+a' };

// A locked Top 3 pick is graded from the stat the game ended with, against the line it was locked at: null while the stat is not in yet.
function top3Result(p) {
  if (!p || !isNum(p.actual) || !isNum(p.line)) return null;
  if (p.actual === p.line) return 'PUSH';
  const over = String(p.direction || '').toUpperCase() === 'OVER';
  return (p.actual > p.line) === over ? 'WIN' : 'LOSS';
}

// The same bet can be logged twice when its line moves between scans; it counts once, as first logged (lowest id).
function onePerBet(list) {
  if (!Array.isArray(list)) return list;
  const first = new Map();
  for (const p of list) {
    if (!p || p.id == null || !p.player) continue;
    const k = [p.day, p.league || 'nba', p.player, p.propType].join('|'), cur = first.get(k);
    if (!cur || p.id < cur.id) first.set(k, p);
  }
  return list.filter(p => !p || p.id == null || !p.player || first.get([p.day, p.league || 'nba', p.player, p.propType].join('|')) === p);
}

function buildGradingReport({ date, picks = [], allPicks = null, pickCounts = {}, scan = {}, top3 = [], bias = null, calibration = null, credits = null, maxListed = 12 } = {}) {
  picks = onePerBet(picks); allPicks = onePerBet(allPicks);
  const graded = picks.filter(p => ['WIN', 'LOSS', 'PUSH'].includes(p.result));
  const dayPicks = graded.filter(p => p.day === date), toDate = graded.filter(p => p.day && p.day <= date);
  const leagues = [...new Set(dayPicks.map(p => p.league || 'nba'))];
  // Best bets: chosen from every pick logged that day (not only the graded ones), then scored from the graded ones.
  const bbIds = bestBets.bestBetIds(allPicks || graded.map(p => ({ ...p, day: p.day })));
  const isBB = p => p.id != null && bbIds.has(p.id), R = bestBets.RULES;
  const data = { date, picks: { day: rec(dayPicks), toDate: rec(toDate), byLeague: {}, waiting: pickCounts.waiting || 0, setAside: pickCounts.setAside || 0,
    list: dayPicks.slice(0, 40).map(p => ({ league: p.league || 'nba', player: p.player, propType: p.propType, verdict: String(p.verdict || '').replace('LEAN_', ''), line: p.line, actual: p.actualStat ?? null, result: p.result,
      confidence: isNum(p.confidence) ? p.confidence : null, strength: strengthOf(p.confidence)?.label || null, ev: isNum(p.ev) ? p.ev : null, bestBet: p.id != null && bbIds.has(p.id) })) }, scan: {}, calibration, credits, bias: Object.entries(bias || {}).map(([k, e]) => ({ league: k.split(':')[0], propType: k.split(':')[1], mult: e.mult, ratio: e.ratio, n: e.n })) };
  const tiers = (list, of, field) => ({
    tiers: list.map(t => ({ key: t.key, label: t.label, range: t.range, day: rec(dayPicks.filter(p => of(p[field])?.key === t.key)), toDate: rec(toDate.filter(p => of(p[field])?.key === t.key)) })),
    unrated: toDate.filter(p => !of(p[field])).length,
  });
  data.strength = { confidence: tiers(STRENGTH, strengthOf, 'confidence'), ev: tiers(EV_TIERS, evTierOf, 'ev') };
  const bbGraded = graded.filter(isBB), bbWaiting = (allPicks || []).filter(p => bbIds.has(p.id) && !['WIN', 'LOSS', 'PUSH'].includes(p.result) && !p.setAside && p.day <= date).length;
  data.bestBets = { rules: { ...R, text: bestBets.describe() }, day: rec(bbGraded.filter(p => p.day === date)), sinceLock: rec(bbGraded.filter(p => p.day >= R.lockedOn && p.day <= date)), earlier: rec(bbGraded.filter(p => p.day < R.lockedOn)), waiting: bbWaiting, restOfPicks: rec(toDate.filter(p => !isBB(p) && p.day >= R.lockedOn)) };
  for (const lg of ['nba', 'wnba']) {
    const all = graded.filter(p => (p.league || 'nba') === lg && p.day <= date);
    if (all.length || dayPicks.some(p => (p.league || 'nba') === lg)) data.picks.byLeague[lg] = { day: rec(dayPicks.filter(p => (p.league || 'nba') === lg)), toDate: rec(all) };
  }
  // The locked daily Top 3: the three most confident picks across the slate, as they were shown. Tracked from the first day one was saved.
  const t3 = (top3 || []).filter(p => p && p.date && p.date <= date).map(p => ({ ...p, result: top3Result(p) }));
  const t3Graded = t3.filter(p => p.result), t3Day = t3.filter(p => p.date === date);
  const t3Start = t3.length ? t3.map(p => p.date).sort()[0] : null;
  data.top3 = { startedOn: t3Start, days: new Set(t3.map(p => `${p.date}|${p.league}`)).size, day: rec(t3Day.filter(p => p.result)), toDate: rec(t3Graded), waiting: t3.filter(p => !p.result).length,
    byLeague: Object.fromEntries(['nba', 'wnba'].filter(lg => t3Graded.some(p => p.league === lg)).map(lg => [lg, rec(t3Graded.filter(p => p.league === lg))])),
    restOfPicks: t3Start ? rec(toDate.filter(p => p.day >= t3Start)) : rec([]),
    list: t3Day.map(p => ({ league: p.league || 'nba', player: p.player, propType: p.propType, direction: String(p.direction || ''), line: p.line, actual: isNum(p.actual) ? p.actual : null, result: p.result,
      confidence: isNum(p.confidence) ? p.confidence : null, ev: isNum(p.ev) ? p.ev : null })) };
  for (const lg of ['nba', 'wnba']) {
    const s = scan[lg]; if (!s || !s.counts || !s.counts.total) continue;
    const rows = s.graded || [], dayRows = rows.filter(r => r.date === date);
    data.scan[lg] = { counts: s.counts, real: disagreement(rows), forward: forwardChecks(rows), day: dayRows.length ? { graded: dayRows.length, scores: scoreRows(dayRows), valuePicks: valuePickRecord(dayRows) } : null, toDate: rows.length ? { graded: rows.length, scores: scoreRows(rows), valuePicks: valuePickRecord(rows) } : null };
  }

  const L = [];
  const headline = dayPicks.length
    ? `${dayLabel(date)}: ${dayPicks.length} picks graded, ${recText(data.picks.day)}`
    : `${dayLabel(date)}: no picks were graded`;
  L.push(`WIN AI grading report for ${dayLabel(date)}`);
  L.push('');
  if (dayPicks.length) {
    L.push(`PICKS GRADED: ${dayPicks.length}  ->  ${recText(data.picks.day)}`);
    for (const lg of leagues) { const r = data.picks.byLeague[lg]; if (r && leagues.length > 1) L.push(`  ${lg.toUpperCase()}: ${recText(r.day)}`); }
    const byType = {}; for (const p of dayPicks) (byType[p.propType] = byType[p.propType] || []).push(p);
    const types = Object.entries(byType).map(([t, a]) => `${LABEL[t] || t} ${recText(rec(a))}`);
    if (types.length > 1) L.push(`  by type: ${types.join(' | ')}`);
    const shown = dayPicks.slice(0, maxListed);
    for (const p of shown) L.push(`  ${p.result === 'WIN' ? '✓' : p.result === 'LOSS' ? '✗' : '–'} ${p.player} ${String(p.verdict || '').replace('LEAN_', '')} ${p.line} ${LABEL[p.propType] || p.propType}  (actual ${p.actualStat ?? '?'})${p.id != null && bbIds.has(p.id) ? '  ★ best bet' : ''}${strengthOf(p.confidence) ? `  [${strengthOf(p.confidence).label} ${Math.round(p.confidence)}${isNum(p.ev) ? `, EV ${(p.ev * 100).toFixed(1)}%` : ''}]` : ''}`);
    if (dayPicks.length > shown.length) L.push(`  ... and ${dayPicks.length - shown.length} more`);
  } else {
    L.push('PICKS GRADED: none. Either no games were played, no picks were logged that day, or the results are not in the stats feed yet.');
  }
  const strengthLine = (name, g, range) => { const r = x => (x.n ? `${recText(x)}` : 'none'); return `  ${name}${range ? ' ' + range : ''}: ${dayPicks.length ? r(g.day) : '-'} that day | ${r(g.toDate)} all picks`; };
  const bb = data.bestBets, bbCell = x => (x.n ? recText(x) : 'none');
  L.push(`BEST BETS (${bb.rules.text}; rules fixed on ${bb.rules.lockedOn}, so only picks from that day on are a real test)`);
  L.push(`  ${dayLabel(date)}: ${bbCell(bb.day)} | since ${bb.rules.lockedOn}: ${bbCell(bb.sinceLock)}${bb.restOfPicks.n ? ` (all other picks in that time: ${recText(bb.restOfPicks)})` : ''}${bb.waiting ? ` | ${bb.waiting} waiting` : ''}`);
  if (bb.earlier.n) L.push(`  before ${bb.rules.lockedOn} (reference only, the rules were chosen with these results in view): ${recText(bb.earlier)}`);
  const t3d = data.top3;
  L.push(`TOP 3 (the most confident picks of the day, locked when shown${t3d.startedOn ? `; tracked since ${t3d.startedOn}` : ''})`);
  if (!t3d.days) L.push('  none locked yet');
  else {
    const c = x => (x.n ? recText(x) : 'none');
    L.push(`  ${dayLabel(date)}: ${c(t3d.day)} | all days: ${c(t3d.toDate)}${t3d.restOfPicks.n ? ` (every pick in that time: ${recText(t3d.restOfPicks)})` : ''}${t3d.waiting ? ` | ${t3d.waiting} waiting` : ''}`);
    for (const p of t3d.list) L.push(`  ${p.result === 'WIN' ? '✓' : p.result === 'LOSS' ? '✗' : p.result === 'PUSH' ? '–' : '·'} ${p.player} ${p.direction.replace('LEAN_', '')} ${p.line} ${LABEL[p.propType] || p.propType}  (actual ${p.actual ?? '?'})${p.confidence != null ? `  [${Math.round(p.confidence)}${p.ev != null ? `, EV ${(p.ev * 100).toFixed(1)}%` : ''}]` : ''}`);
  }
  const rated = data.strength.confidence.tiers.some(t => t.toDate.n);
  if (rated) {
    L.push('BY STRENGTH (the confidence score when the pick was made)');
    for (const t of data.strength.confidence.tiers) L.push(strengthLine(t.label, t, t.range));
    if (data.strength.ev.tiers.some(t => t.toDate.n)) {
      L.push('BY EXPECTED VALUE (at the price taken)');
      for (const t of data.strength.ev.tiers) L.push(strengthLine(t.label, t, t.range));
    }
  }
  const lgText = Object.entries(data.picks.byLeague).filter(([, v]) => v.toDate.n).map(([lg, v]) => `${lg.toUpperCase()} ${recText(v.toDate)}`);
  L.push(`SINCE TRACKING BEGAN: ${recText(data.picks.toDate)}${lgText.length > 1 ? ` (${lgText.join(' | ')})` : ''} over ${data.picks.toDate.n} graded picks (break-even at -110 is 52.4%; ${data.picks.toDate.n < 400 ? 'a record this size cannot separate skill from luck yet' : 'treat small gaps from 50-52% as noise'})`);
  L.push(`WAITING: ${data.picks.waiting} picks ungraded${data.picks.setAside ? `, ${data.picks.setAside} set aside (no matching game in the stats log)` : ''}`);

  for (const [lg, s] of Object.entries(data.scan)) {
    L.push('');
    L.push(`EVERY PROP THE ${lg.toUpperCase()} SCAN LOGGED (not just picks): ${s.counts.total} logged, ${s.counts.graded} graded, ${s.counts.waiting} waiting${s.counts.setAside ? `, ${s.counts.setAside} set aside` : ''}`);
    const part = (name, x) => {
      if (!x) return;
      const c = x.scores;
      L.push(`  ${name} (${x.graded} props): average miss  model ${num(c.mae.model)}  market-blend ${num(c.mae.blended)}  posted line ${num(c.mae.market)}`);
      L.push(`      win-chance score (lower is better)  model ${num(c.brier.model, 3)}  market ${num(c.brier.market, 3)}  our blend ${num(c.brier.final, 3)}`);
      const v = x.valuePicks;
      L.push(`      picks that also cleared the 3% value bar: ${v.picks ? `${v.wins}-${v.losses}${v.pushes ? `-${v.pushes}` : ''}, won ${pct(v.winRate)} against ${pct(v.expectedWinRate)} expected` : 'none'}`);
    };
    part(`${dayLabel(date)}`, s.day); part('Since logging began', s.toDate);
    if (!s.day) L.push(`  Nothing from ${dayLabel(date)} has been graded yet.`);
    const fw = s.forward || { teammateOut: {}, position: {} };
    const tmAll = fw.teammateOut.all, posAll = fw.position.all;
    if (tmAll) L.push(`  Teammate-out lift check (props carrying a lift of 2%+ vs none; relative miss, + = model too low): ${tmAll.boosted.n} boosted ${pct(tmAll.boosted.miss)} vs ${tmAll.none.n} not ${pct(tmAll.none.miss)} -> ${tmAll.verdict}`);
    if (posAll) L.push(`  Position-allowed check: ${posAll.n} props moved by it, slope ${posAll.slope == null ? '-' : posAll.slope} (1 = right size, 0 = nothing) -> ${posAll.verdict}`);
    const real = Object.entries(s.real || {}).map(([t, x]) => `${LABEL[t] || t} ${num(x.slope)} (${x.n} props)`);
    if (real.length) L.push(`  How much of its disagreement with the line was real (1 = all of it, 0 = none): ${real.join(' | ')}`);
    if (s.day && s.day.scores.mae.model != null && s.day.scores.mae.market != null) L.push(`  ${s.day.scores.mae.model < s.day.scores.mae.market ? 'The model beat the posted line that day.' : 'The posted line was closer than the model that day.'}`);
  }

  L.push('');
  if (data.bias.length) L.push(`BIAS CORRECTION IN USE: ${data.bias.map(b => `${b.league.toUpperCase()} ${LABEL[b.propType] || b.propType} x${b.mult} (raw ratio ${b.ratio}, ${b.n} props)`).join(' | ')}`);
  L.push(`CALIBRATION: ${calibration ? `${calibration.active ? 'on' : 'off'}. ${calibration.reason || ''}`.trim() : 'not fitted yet'}`);
  if (credits != null) L.push(`ODDS CREDITS LEFT: ${credits}`);
  return { date, headline, text: L.join('\n'), data };
}

module.exports = { top3Result, buildGradingReport, strengthOf, evTierOf, STRENGTH, EV_TIERS };
