// The sportsbook market as a source of probability. Pure functions, no I/O.
//
// Why this exists: on the app's graded picks the posted line predicted the stat better than the model did, and once the market's own
// price was known the model's probability added almost nothing (best weight on the model: about 3%). So the market is the starting
// point here and the model is a small nudge on top of it. The one real edge left in a pick is price shopping: the best price on a side
// against what all the books together say the fair chance is.
//
// Books arrive in the shape both odds fetchers already produce:  { "DraftKings": { Over: { point, price }, Under: { point, price } }, ... }

const clampP = (p, lo = 0.01, hi = 0.99) => Math.min(hi, Math.max(lo, p));
const logit = p => Math.log(p / (1 - p));
const sigmoid = z => 1 / (1 + Math.exp(-z));
const isNum = v => typeof v === 'number' && isFinite(v);

function normalCdf(z) {
  // Abramowitz-Stegun 7.1.26 on erf: accurate to about 1e-7, enough for probabilities that are rounded to 3 places
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
// Inverse of the normal curve (Acklam's rational approximation, relative error about 1e-9).
function normalInv(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239],
    b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1],
    c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
    d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function impliedFromAmerican(price) {
  const p = parseFloat(price);
  if (!isFinite(p) || p === 0 || Math.abs(p) < 100) return null;
  return p > 0 ? 100 / (p + 100) : -p / (-p + 100);
}
function decimalFromAmerican(price) {
  const p = parseFloat(price);
  if (!isFinite(p) || p === 0 || Math.abs(p) < 100) return null;
  return p > 0 ? 1 + p / 100 : 1 + 100 / -p;
}

// Removes a book's margin from a two-way price with the power method: find k so that po^k + pu^k = 1. It takes more off the longshot than
// simply dividing by the total does, which is how the favourite-longshot bias shows up in real prices.
function devigPower(po, pu) {
  if (!(po > 0 && po < 1 && pu > 0 && pu < 1)) return null;
  if (po + pu <= 1) return { over: po / (po + pu), under: pu / (po + pu) };   // no margin to remove
  let lo = 1, hi = 6;
  for (let i = 0; i < 60; i++) { const k = (lo + hi) / 2; if (Math.pow(po, k) + Math.pow(pu, k) > 1) lo = k; else hi = k; }
  const k = (lo + hi) / 2, o = Math.pow(po, k), u = Math.pow(pu, k);
  return { over: o / (o + u), under: u / (o + u) };
}

const TYPICAL_MARGIN = 1.0476;   // a -110 / -110 market: used only when a book shows one side
// One book's fair chance of the Over at the book's own number.
function fairOverOfBook(entry) {
  const po = impliedFromAmerican(entry?.Over?.price), pu = impliedFromAmerican(entry?.Under?.price);
  if (po != null && pu != null) { const d = devigPower(po, pu); return d ? d.over : null; }
  if (po != null) return clampP(po / TYPICAL_MARGIN);
  if (pu != null) return clampP(1 - pu / TYPICAL_MARGIN);
  return null;
}

// What every book together says about the Over at line L. A book that posts a different number is moved to L by treating its fair price
// as a point on a bell curve with spread `sd`. Books more than `maxShift` away from L are left out (the shift stops being trustworthy).
function marketFairAt(books, L, sd, { bookWeights = {}, maxShift = null } = {}) {
  const line = parseFloat(L);
  if (!books || !isNum(line) || !(sd > 0)) return null;
  const shiftLimit = maxShift != null ? maxShift : Math.max(1, 0.25 * sd);
  let num = 0, den = 0, n = 0;
  for (const [name, entry] of Object.entries(books)) {
    const point = entry?.Over?.point ?? entry?.Under?.point;
    if (!isNum(point)) continue;
    const f = fairOverOfBook(entry);
    if (f == null) continue;
    const gap = line - point;
    if (Math.abs(gap) > shiftLimit) continue;
    let fAtL = f;
    if (gap !== 0) { const mu = point - sd * normalInv(1 - clampP(f)); fAtL = 1 - normalCdf((line - mu) / sd); }
    const w = isNum(bookWeights[name]) ? bookWeights[name] : 1;
    num += w * fAtL; den += w; n++;
  }
  if (!n) return null;
  const over = clampP(num / den);
  return { over, under: 1 - over, books: n };
}

// The best price on each side: the lowest Over number (easiest to clear) and the highest Under number, with the better price breaking ties.
function bestOffers(books) {
  let over = null, under = null;
  for (const [book, e] of Object.entries(books || {})) {
    const o = e?.Over, u = e?.Under;
    if (o && isNum(o.point)) {
      const dec = decimalFromAmerican(o.price);
      if (!over || o.point < over.point || (o.point === over.point && dec > (decimalFromAmerican(over.price) || 0))) over = { book, point: o.point, price: o.price };
    }
    if (u && isNum(u.point)) {
      const dec = decimalFromAmerican(u.price);
      if (!under || u.point > under.point || (u.point === under.point && dec > (decimalFromAmerican(under.price) || 0))) under = { book, point: u.point, price: u.price };
    }
  }
  return { over, under };
}

// Median Over line across books, to one decimal.
function consensusLineOf(books) {
  const pts = Object.values(books || {}).map(e => e?.Over?.point).filter(isNum).sort((a, b) => a - b);
  if (!pts.length) return null;
  const mid = Math.floor(pts.length / 2);
  return parseFloat((pts.length % 2 ? pts[mid] : (pts[mid - 1] + pts[mid]) / 2).toFixed(1));
}

// Model and market combined on the log-odds scale. wModel is the share of the answer that comes from the model.
function blendLogit(pModel, pMarket, wModel) {
  const w = Math.min(1, Math.max(0, wModel));
  if (!isNum(pModel) && !isNum(pMarket)) return null;
  if (!isNum(pMarket)) return pModel;
  if (!isNum(pModel)) return pMarket;
  return sigmoid(w * logit(clampP(pModel, 0.005, 0.995)) + (1 - w) * logit(clampP(pMarket, 0.005, 0.995)));
}

// With no market to lean on the model stands alone, pulled hard toward 50% because on the app's own record its raw chances ran far too high.
function shrinkToHalf(p, keep = 0.5) { return isNum(p) ? sigmoid(keep * logit(clampP(p, 0.005, 0.995))) : p; }

// Expected profit per $1. pOver and pUnder are the chances given that the bet is not refunded; pPush is the chance of landing exactly on a
// whole-number line, where the stake comes back. So only the share (1 - pPush) of bets are decided.
function expectedValue(pSide, price, pPush = 0) {
  const dec = decimalFromAmerican(price);
  if (!isNum(pSide) || dec == null) return null;
  const live = 1 - Math.min(0.9, Math.max(0, pPush || 0));
  return parseFloat((live * (pSide * (dec - 1) - (1 - pSide))).toFixed(4));
}

module.exports = { clampP, logit, sigmoid, normalCdf, normalInv, impliedFromAmerican, decimalFromAmerican, devigPower, fairOverOfBook, marketFairAt, bestOffers, consensusLineOf, blendLogit, shrinkToHalf, expectedValue };
