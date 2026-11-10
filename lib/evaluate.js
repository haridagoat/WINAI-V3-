// Scores the model against the market on every logged prop that has a result. Pure functions, no I/O.
//
// A logged row (see buildCandidateResult in server.js) carries, at the consensus line `evalLine`: the model's own projection, the market-blended
// estimate, the model's chance of the Over, the market's fair chance, and the blended chance. `actual` is the stat.
// Because every scanned prop is in the log, not only the ones that looked good, these scores are not skewed by what was picked.
const { clampP } = require('./market');

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const round = (v, d = 3) => (v == null || !isFinite(v) ? null : parseFloat(v.toFixed(d)));

function scoreRows(rows) {
  const err = { model: [], blended: [], market: [] }, sq = { model: [], blended: [], market: [] };
  const prob = { model: [], market: [], final: [] };       // [chance, outcome] pairs
  const signed = { model: [], market: [] };
  for (const r of rows) {
    if (r.actual == null) continue;                          // no result yet (Number(null) would read as a zero stat)
    const d = r.data || {}, a = Number(r.actual), L = d.evalLine;
    if (!isFinite(a) || L == null || d.modelProjection == null) continue;
    err.model.push(Math.abs(a - d.modelProjection)); sq.model.push((a - d.modelProjection) ** 2); signed.model.push(a - d.modelProjection);
    const bl = d.blended ?? d.projection ?? d.modelProjection;          // older rows called the market-blended estimate `projection`
    err.blended.push(Math.abs(a - bl)); sq.blended.push((a - bl) ** 2);
    err.market.push(Math.abs(a - L)); sq.market.push((a - L) ** 2); signed.market.push(a - L);
    if (a === L) continue;                                   // a push decides nothing
    const y = a > L ? 1 : 0;
    if (d.modelOver != null) prob.model.push([d.modelOver, y]);
    if (d.marketOver != null) prob.market.push([d.marketOver, y]);
    if (d.finalOver != null) prob.final.push([d.finalOver, y]);
  }
  const brier = ps => mean(ps.map(([p, y]) => (p - y) ** 2));
  const logloss = ps => mean(ps.map(([p, y]) => -(y ? Math.log(clampP(p, 0.01, 0.99)) : Math.log(1 - clampP(p, 0.01, 0.99)))));
  return {
    n: err.model.length, decided: prob.model.length,
    mae: { model: round(mean(err.model)), blended: round(mean(err.blended)), market: round(mean(err.market)) },
    rmse: { model: round(Math.sqrt(mean(sq.model))), blended: round(Math.sqrt(mean(sq.blended))), market: round(Math.sqrt(mean(sq.market))) },
    bias: { model: round(mean(signed.model)), market: round(mean(signed.market)) },
    brier: { model: round(brier(prob.model), 4), market: round(brier(prob.market), 4), final: round(brier(prob.final), 4) },
    logloss: { model: round(logloss(prob.model), 4), market: round(logloss(prob.market), 4), final: round(logloss(prob.final), 4) },
    overRate: prob.model.length ? round(mean(prob.model.map(([, y]) => y))) : null,
  };
}

// How the "value picks" (props whose best price had at least `minEv` expected value) really did, against the best line and side recorded for each:
// the model's own record, kept on the same footing as everything else in the scan log.
function valuePickRecord(rows, minEv = 0.03) {
  let wins = 0, losses = 0, pushes = 0, evSum = 0, probSum = 0, n = 0;
  for (const r of rows) {
    const b = r.data && r.data.best;
    if (r.actual == null || !b || b.ev == null || b.ev < minEv || b.line == null) continue;
    const a = Number(r.actual); if (!isFinite(a)) continue;
    n++; evSum += b.ev; probSum += b.prob ?? 0;
    if (a === b.line) pushes++; else if ((b.side === 'over') === (a > b.line)) wins++; else losses++;
  }
  const decided = wins + losses;
  return { picks: n, wins, losses, pushes, winRate: decided ? round(wins / decided) : null, expectedWinRate: n ? round(probSum / n) : null, avgEv: n ? round(evSum / n, 4) : null };
}

function scanMetrics(rows) {
  const out = { overall: scoreRows(rows), byProp: {}, valuePicks: valuePickRecord(rows) };
  for (const t of [...new Set(rows.map(r => r.propType))]) { const sub = rows.filter(r => r.propType === t); if (sub.length >= 20) out.byProp[t] = scoreRows(sub); }
  return out;
}

// The model's chance against how often the Over really hit, in bands, for the model alone and for the blend.
function calibrationBands(rows, field = 'modelOver', edges = [0, 0.35, 0.45, 0.55, 0.65, 1.0001]) {
  const bands = edges.slice(0, -1).map((lo, i) => ({ from: lo, to: edges[i + 1], n: 0, claimed: 0, hit: 0 }));
  for (const r of rows) {
    if (r.actual == null) continue;
    const d = r.data || {}, a = Number(r.actual), p = d[field];
    if (p == null || !isFinite(a) || a === d.evalLine) continue;
    const b = bands.find(x => p >= x.from && p < x.to); if (!b) continue;
    b.n++; b.claimed += p; b.hit += a > d.evalLine ? 1 : 0;
  }
  return bands.filter(b => b.n).map(b => ({ range: `${Math.round(b.from * 100)}-${Math.min(100, Math.round(b.to * 100))}%`, n: b.n, claimed: round(b.claimed / b.n), hitRate: round(b.hit / b.n) }));
}


// How much of the model's disagreement with the posted line was real, per prop type: the slope of (what happened - line) on (model - line).
// 1 means whenever the model said "2 above the line" it was 2 above; 0 means its disagreements were noise. Needs minN graded props per type.
function disagreement(rows, minN = 30) {
  const by = {};
  for (const r of rows || []) {
    if (r.actual == null) continue;
    const d = r.data || {}, a = Number(r.actual), L = d.evalLine, m = d.modelProjection;
    if (!isFinite(a) || typeof L !== 'number' || typeof m !== 'number') continue;
    (by[r.propType] = by[r.propType] || []).push([m - L, a - L]);
  }
  const out = {};
  for (const [t, pts] of Object.entries(by)) {
    if (pts.length < minN) continue;
    const mx = mean(pts.map(p => p[0])), my = mean(pts.map(p => p[1]));
    let sxx = 0, sxy = 0; for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
    if (sxx > 0) out[t] = { n: pts.length, slope: round(sxy / sxx), avgGap: round(mx) };
  }
  return out;
}


// Forward checks on two adjustments, from scan rows logged with them (rows before they were logged carry no field and are skipped).
// Both look at the relative miss of the model's own projection: (actual - projection) / projection, positive = the model was too low.
//  - teammate-out lift: props that carried a lift of `minBoost` or more, against props that carried none. If the boosted ones were still
//    projected too low, the lift is too small; too high, too big. Judged by a t-statistic on the difference, and only once there are `minN` boosted props.
//  - position allowed: slope of the relative miss on (multiplier - 1). 1 = the adjustment is the right size, 0 = it does nothing, below 0 = it hurts.
function forwardChecks(rows, { minBoost = 0.02, minN = 30 } = {}) {
  const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const cell = a => ({ n: a.length, miss: a.length ? round(mean(a), 4) : null, se: a.length > 2 ? round(sd(a) / Math.sqrt(a.length), 4) : null });
  const tm = {}, pos = {};
  for (const r of rows || []) {
    if (r.actual == null) continue;
    const d = r.data || {}, a = Number(r.actual), m = d.modelProjection;
    if (!isFinite(a) || typeof m !== 'number' || !(m > 0)) continue;
    const rel = (a - m) / m;
    for (const key of [r.propType, 'all']) {
      if (typeof d.tmBoost === 'number') { const g = (tm[key] = tm[key] || { boosted: [], none: [] }); if (d.tmBoost >= minBoost) g.boosted.push(rel); else if (d.tmBoost < 0.005) g.none.push(rel); }
      if (typeof d.posMult === 'number') { (pos[key] = pos[key] || []).push([d.posMult - 1, rel]); }
    }
  }
  const out = { teammateOut: {}, position: {} };
  for (const [k, g] of Object.entries(tm)) {
    if (!g.boosted.length) continue;
    const b = cell(g.boosted), n0 = cell(g.none);
    let verdict = 'too early', t = null;
    if (b.n >= minN && n0.n >= minN && b.se != null && n0.se != null) {
      t = (b.miss - n0.miss) / Math.sqrt(b.se ** 2 + n0.se ** 2);
      verdict = t >= 2 ? 'lift looks too small' : t <= -2 ? 'lift looks too big' : 'about right';
    }
    out.teammateOut[k] = { boosted: b, none: n0, t: round(t, 2), verdict };
  }
  for (const [k, pts] of Object.entries(pos)) {
    const moved = pts.filter(p => Math.abs(p[0]) > 1e-9);
    if (moved.length < minN) { if (moved.length) out.position[k] = { n: moved.length, slope: null, verdict: 'too early' }; continue; }
    let sxx = 0, sxy = 0; for (const [x, y] of pts) { sxx += x * x; sxy += x * y; }
    const slope = sxx > 0 ? sxy / sxx : null;
    out.position[k] = { n: moved.length, slope: round(slope, 2), verdict: slope == null ? 'too early' : slope >= 0.5 ? 'adds value' : slope > 0 ? 'weak' : 'not helping' };
  }
  return out;
}

module.exports = { forwardChecks, disagreement, scanMetrics, scoreRows, calibrationBands, valuePickRecord };
