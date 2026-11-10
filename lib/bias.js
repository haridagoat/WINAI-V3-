// The model has run a little high on some stats (points and assists, in the first graded week). This learns how much from what actually happened
// and scales the projection back by that ratio. Pure functions; the server fits it every night from the graded scan log and applies it.
//
// For each league and prop type: ratio = (sum of what happened) / (sum of what the model said before any correction). It only counts once there
// are MIN_N graded props, is pulled toward 1 while the sample is small, and is kept inside LO..HI so a bad week cannot swing projections far.
// Every scan row stores the correction that was in force, so the next fit always starts from the uncorrected projection (no compounding).
const MIN_N = 100, SHRINK_K = 100, LO = 0.85, HI = 1.10;

const fin = v => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// rows: [{ league, propType, actual, modelProjection, biasMult? }] -> { 'nba:points': { mult, ratio, n } }
function fitBias(rows, { minN = MIN_N, shrinkK = SHRINK_K, lo = LO, hi = HI } = {}) {
  const groups = new Map();
  for (const r of rows || []) {
    if (!r || !fin(r.actual) || !fin(r.modelProjection) || r.actual < 0) continue;
    const raw = r.modelProjection / (fin(r.biasMult) && r.biasMult > 0 ? r.biasMult : 1);
    if (!(raw > 0.05)) continue;
    const k = `${r.league || 'nba'}:${r.propType}`;
    if (!groups.has(k)) groups.set(k, { a: 0, m: 0, n: 0 });
    const g = groups.get(k); g.a += r.actual; g.m += raw; g.n += 1;
  }
  const out = {};
  for (const [k, g] of groups) {
    if (g.n < minN || !(g.m > 0)) continue;
    const ratio = g.a / g.m, w = g.n / (g.n + shrinkK);
    out[k] = { mult: parseFloat(clamp(1 + (ratio - 1) * w, lo, hi).toFixed(4)), ratio: parseFloat(ratio.toFixed(4)), n: g.n };
  }
  return out;
}

// The correction to apply to a projection (1 = none).
function multFor(table, league, propType, { lo = LO, hi = HI } = {}) {
  const e = table && table[`${league || 'nba'}:${propType}`];
  return e && fin(e.mult) && e.mult >= lo && e.mult <= hi ? e.mult : 1;
}

module.exports = { fitBias, multFor, MIN_N, SHRINK_K, LO, HI };
