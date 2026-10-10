// Scores the graded history: win rate (with a confidence interval) by prop type,
// league, side, confidence tier and EV size; how well the model's chances matched
// results (Brier, calibration bins); how far projections were from the real stat;
// and closing-line value. A slice only gets an opinion once it has enough picks.
const MIN_FOR_STATS = 30;   // total graded before any win-rate talk
const MIN_FOR_SLICE = 20;   // graded picks in a slice before it can be flagged
const BREAK_EVEN = 52.4;    // win rate needed at -110

const americanToDecimal = a => { a = Number(a); if (!isFinite(a) || a === 0) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; };
const sideOf = v => /OVER/.test(v || '') ? 'OVER' : /UNDER/.test(v || '') ? 'UNDER' : null;
const tierOf = c => c >= 75 ? 'strong' : c >= 55 ? 'lean' : 'thin';
const round = (x, d = 1) => x == null || !isFinite(x) ? null : parseFloat(x.toFixed(d));

// Wilson interval: honest about small samples (unlike winRate +/- nothing).
function wilson(wins, n, z = 1.96) {
  if (!n) return null;
  const p = wins / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [round(((c - m) / d) * 100), round(((c + m) / d) * 100)];
}

function summarize(list) {
  const wins = list.filter(e => e.result === 'WIN').length, losses = list.filter(e => e.result === 'LOSS').length, pushes = list.filter(e => e.result === 'PUSH').length;
  const decided = wins + losses;
  let profit = 0, priced = 0;
  for (const e of list) {
    const dec = americanToDecimal(e.price);
    if (!dec || (e.result !== 'WIN' && e.result !== 'LOSS')) continue;
    priced++; profit += e.result === 'WIN' ? dec - 1 : -1;
  }
  return { n: list.length, wins, losses, pushes, winRate: decided ? round(wins / decided * 100) : null, ci: wilson(wins, decided), roi: priced ? round(profit / priced * 100) : null, pricedPicks: priced };
}

function groupBy(list, keyFn) {
  const m = {};
  for (const e of list) { const k = keyFn(e); if (k == null) continue; (m[k] = m[k] || []).push(e); }
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, summarize(v)]));
}

function buildReport(entries, { now = new Date(), confVersion = null } = {}) {
  const graded = entries.filter(e => ['WIN', 'LOSS', 'PUSH'].includes(e.result));
  const decided = graded.filter(e => e.result !== 'PUSH');
  const overall = summarize(graded);

  const slices = {
    propType: groupBy(graded, e => e.propType),
    league: groupBy(graded, e => e.league),
    side: groupBy(graded, e => sideOf(e.verdict)),
    confidenceTier: groupBy(graded.filter(e => e.confidence != null && (confVersion == null || e.confVersion === confVersion)), e => tierOf(e.confidence)),
    evSize: groupBy(graded.filter(e => e.ev != null), e => e.ev >= 0.15 ? '15% or more' : e.ev >= 0.05 ? '5% to 15%' : 'under 5%'),
  };

  // how well the stated chances matched reality
  const cal = decided.filter(e => e.modelProb != null).map(e => ({ p: e.modelProb / 100, y: e.result === 'WIN' ? 1 : 0 })).filter(r => r.p > 0 && r.p < 1);
  const bins = [];
  for (let lo = 50; lo < 100; lo += 5) {
    const inBin = cal.filter(r => r.p * 100 >= lo && r.p * 100 < lo + 5);
    if (inBin.length) bins.push({ from: lo, to: lo + 5, n: inBin.length, predicted: round(inBin.reduce((t, r) => t + r.p, 0) / inBin.length * 100), actual: round(inBin.reduce((t, r) => t + r.y, 0) / inBin.length * 100) });
  }
  const probability = {
    n: cal.length,
    brier: cal.length ? round(cal.reduce((t, r) => t + (r.p - r.y) ** 2, 0) / cal.length, 4) : null,
    logLoss: cal.length ? round(-cal.reduce((t, r) => t + (r.y ? Math.log(r.p) : Math.log(1 - r.p)), 0) / cal.length, 4) : null,
    bins,
  };

  // projection vs the real stat (needs the stat, not just win/loss)
  const withStat = entries.filter(e => e.actualStat != null && e.projection != null);
  const projErr = list => list.length ? { n: list.length, mae: round(list.reduce((t, e) => t + Math.abs(e.actualStat - e.projection), 0) / list.length, 2), bias: round(list.reduce((t, e) => t + (e.actualStat - e.projection), 0) / list.length, 2) } : null;
  const byType = {};
  for (const e of withStat) (byType[e.propType] = byType[e.propType] || []).push(e);
  const projection = { overall: projErr(withStat), byPropType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, projErr(v)])) };

  // closing-line value
  const clvRows = entries.filter(e => e.clv != null);
  const clv = {
    n: clvRows.length, beat: clvRows.filter(e => e.clv > 0).length, flat: clvRows.filter(e => e.clv === 0).length, worse: clvRows.filter(e => e.clv < 0).length,
    avg: clvRows.length ? round(clvRows.reduce((t, e) => t + e.clv, 0) / clvRows.length, 2) : null,
  };

  // slices that have earned an opinion
  const flags = [];
  for (const [dim, groups] of Object.entries(slices)) {
    for (const [name, s] of Object.entries(groups)) {
      const d = s.wins + s.losses;
      if (d < MIN_FOR_SLICE || !s.ci) continue;
      if (s.ci[1] < 50) flags.push({ level: 'skip', dimension: dim, slice: name, message: `${name} (${dim}) wins ${s.winRate}% over ${d} picks and even the top of its range (${s.ci[1]}%) is under 50%. Consider skipping it.` });
      else if (s.ci[0] > BREAK_EVEN) flags.push({ level: 'keep', dimension: dim, slice: name, message: `${name} (${dim}) wins ${s.winRate}% over ${d} picks and the low end of its range (${s.ci[0]}%) clears break-even.` });
    }
  }

  return {
    generatedAt: now.toISOString(),
    totals: { tracked: entries.length, graded: graded.length, decided: decided.length, waitingToGrade: entries.filter(e => e.source === 'auto' && !e.result && !e.gradeNote).length, unmatched: entries.filter(e => e.source === 'auto' && !e.result && e.gradeNote).length },
    enoughForWinRate: decided.length >= MIN_FOR_STATS, minForStats: MIN_FOR_STATS, minForSlice: MIN_FOR_SLICE,
    overall, slices, probability, projection, clv, flags,
  };
}

module.exports = { buildReport, summarize, wilson, MIN_FOR_STATS, MIN_FOR_SLICE, BREAK_EVEN };
