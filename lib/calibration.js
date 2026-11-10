// Turns the model's raw win chance into one that matches how often its picks
// actually win, using the graded history. Isotonic regression (a curve that can
// only go up) is fit to (predicted chance, won?) pairs, then blended with the raw
// number by how much data there is.
//
// It stays OFF (returns the raw chance unchanged) until two things are true:
//   1. there are at least MIN_GRADED graded picks that stored their model chance, and
//   2. in 5-fold cross-validation the calibrated chances beat the raw ones by at
//      least MIN_CV_GAIN in Brier score. If calibration doesn't help on picks it
//      has not seen, it is never turned on.
const MIN_GRADED = 60;
const SHRINK_K = 150;
const MIN_CV_GAIN = 0.002;
const FOLDS = 5;
const clamp = (x, lo = 0.02, hi = 0.98) => Math.min(hi, Math.max(lo, x));

// (predicted chance for the logged side, did that side win) from graded picks.
function samplesFrom(entries) {
  const out = [];
  for (const e of entries || []) {
    if (e.result !== 'WIN' && e.result !== 'LOSS') continue;
    const p = Number(e.modelProb) / 100;
    if (!isFinite(p) || p <= 0 || p >= 1) continue;
    out.push({ p, y: e.result === 'WIN' ? 1 : 0 });
  }
  return out;
}

// Pool-adjacent-violators: merge neighbours until the win rate never decreases.
function isotonic(samples) {
  const s = [...samples].sort((a, b) => a.p - b.p);
  const blocks = [];
  for (const { p, y } of s) {
    blocks.push({ n: 1, sy: y, sp: p });
    while (blocks.length > 1 && blocks[blocks.length - 2].sy / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sy / blocks[blocks.length - 1].n) {
      const b = blocks.pop(), a = blocks.pop();
      blocks.push({ n: a.n + b.n, sy: a.sy + b.sy, sp: a.sp + b.sp });
    }
  }
  return blocks.map(b => ({ x: b.sp / b.n, y: b.sy / b.n, n: b.n }));
}

// The ends of the curve can rest on a handful of picks (a few lucky wins at 95% would map every such chance to 100%). Knots at either end that
// rest on fewer than MIN_KNOT_N picks are dropped, so beyond the last well-supported point the curve stays flat at that point's rate.
const MIN_KNOT_N = 20;
function trimThin(knots, min = MIN_KNOT_N) {
  if (!knots.some(k => k.n >= min)) return knots;
  let a = 0, b = knots.length;
  while (a < b - 1 && knots[a].n < min) a++;
  while (b - 1 > a && knots[b - 1].n < min) b--;
  return knots.slice(a, b);
}

function evalKnots(knots, p) {
  if (!knots.length) return p;
  if (p <= knots[0].x) return knots[0].y;
  const last = knots[knots.length - 1];
  if (p >= last.x) return last.y;
  for (let i = 1; i < knots.length; i++) {
    if (p <= knots[i].x) {
      const a = knots[i - 1], b = knots[i];
      return b.x === a.x ? b.y : a.y + (b.y - a.y) * (p - a.x) / (b.x - a.x);
    }
  }
  return last.y;
}

// The blend weight grows with sample size: with 60 picks the curve counts for
// about 29%, with 600 about 80%.
const weightFor = n => n / (n + SHRINK_K);
const applyKnots = (knots, w, p) => clamp(w * evalKnots(knots, p) + (1 - w) * p);
const brier = (rows, f) => rows.length ? rows.reduce((t, r) => t + (f(r.p) - r.y) ** 2, 0) / rows.length : null;

function fit(entries, now = new Date()) {
  const samples = samplesFrom(entries), n = samples.length;
  const base = { version: 1, fittedAt: now.toISOString(), n, minGraded: MIN_GRADED };
  if (n < MIN_GRADED) {
    return { ...base, active: false, reason: `Needs ${MIN_GRADED} graded picks that stored their model chance (has ${n}).` };
  }
  const knots = trimThin(isotonic(samples)), w = weightFor(n);
  // out-of-sample check
  let cvRawSum = 0, cvCalSum = 0, held = 0;
  for (let f = 0; f < FOLDS; f++) {
    const train = samples.filter((_, i) => i % FOLDS !== f), test = samples.filter((_, i) => i % FOLDS === f);
    if (!train.length || !test.length) continue;
    const k = trimThin(isotonic(train)), wf = weightFor(train.length);
    cvRawSum += test.reduce((t, r) => t + (r.p - r.y) ** 2, 0);
    cvCalSum += test.reduce((t, r) => t + (applyKnots(k, wf, r.p) - r.y) ** 2, 0);
    held += test.length;
  }
  const cvRaw = cvRawSum / held, cvCal = cvCalSum / held, gain = cvRaw - cvCal;
  const active = gain >= MIN_CV_GAIN;
  return {
    ...base, active, w, knots,
    brierRaw: brier(samples, p => p), brierCal: brier(samples, p => applyKnots(knots, w, p)),
    cvBrierRaw: cvRaw, cvBrierCal: cvCal, cvGain: gain,
    reason: active
      ? `On: calibrated chances beat the raw ones on held-out picks by ${gain.toFixed(4)} Brier.`
      : `Off: on held-out picks it improved Brier by ${gain.toFixed(4)}, less than the ${MIN_CV_GAIN} needed.`,
  };
}

// raw chance (0-1) -> chance to use. Unchanged unless the model is active.
function apply(model, p) {
  if (!model || !model.active || p == null || !isFinite(p)) return p;
  return applyKnots(model.knots, model.w, p);
}


// Graded scan props as calibration samples. The scan logs hundreds of priced props a day (every prop, not only the logged picks), each with the model's raw
// chance for its chosen side and the stat that came in, so it grows several times faster than the pick history. A prop already counted as a logged pick
// (same day, league, player and prop) is skipped so nothing is counted twice, and a push (the stat landed exactly on the line) is not a win or a loss.
// Returns entries shaped like picks (modelProb in percent, result WIN/LOSS) so fit() can take them as they are.
function fromScanRows(rows, skip = new Set()) {
  const out = [];
  for (const r of rows || []) {
    const d = r && r.data, a = r && r.actual == null ? NaN : Number(r && r.actual);
    if (!d || !isFinite(a) || typeof d.evalLine !== 'number' || typeof d.modelOver !== 'number' || !isFinite(d.modelOver)) continue;
    const dir = String(d.direction || '').toUpperCase();
    if (dir !== 'OVER' && dir !== 'UNDER') continue;
    if (skip.has([r.date, r.league, r.player, r.propType].join('|'))) continue;
    if (a === d.evalLine) continue;
    const side = dir === 'OVER' ? d.modelOver : 1 - d.modelOver;
    out.push({ modelProb: side * 100, result: (a > d.evalLine) === (dir === 'OVER') ? 'WIN' : 'LOSS', source: 'scan' });
  }
  return out;
}

module.exports = { fromScanRows, fit, apply, samplesFrom, isotonic, evalKnots, trimThin, MIN_KNOT_N, MIN_GRADED, SHRINK_K, MIN_CV_GAIN };
