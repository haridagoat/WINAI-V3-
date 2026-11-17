// Property tests for the probability and market math: thousands of seeded random cases, each checking something that must always hold.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('./helpers/extract');
const M = require('../lib/market');
const params = require('../lib/params');
const { makeProjection } = require('./helpers/projection');
const P = makeProjection();

params.load();
const S0 = extract({
  functions: ['americanToDecimal', 'calcKellyStake', 'assessProp'],
  globals: { normalCdf: P.normalCdf, market: M, modelParams: params, calibrationModel: null, calibrate: p => p, calcOverUnderProbability: P.calcOverUnderProbability, usesCountModel: P.usesCountModel, countPmf: P.countPmf, countOverUnder: P.countOverUnder, blendWithMarket: P.blendWithMarket, calcEdgeScore: P.calcEdgeScore, missingProductionShare: P.missingProductionShare, baselineAbsenceWeight: () => 1 },
});
const S = { ...S0, calcOverUnderProbability: P.calcOverUnderProbability, usesCountModel: P.usesCountModel, countPmf: P.countPmf, countOverUnder: P.countOverUnder };
const rng = seed => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const TYPES = ['points', 'rebounds', 'assists', '3pm', 'steals', 'blocks', 'pra'];
const price = r => { const dec = 1.3 + r() * 1.5; return Math.round(dec >= 2 ? (dec - 1) * 100 : -100 / (dec - 1)); };
const randBooks = (r, line) => { const n = 1 + Math.floor(r() * 6), b = {}; for (let i = 0; i < n; i++) { const pt = line + Math.round((r() - 0.5) * 3) / 2; b['B' + i] = { Over: { point: pt, price: price(r) }, Under: { point: pt, price: price(r) } }; } return b; };

test('over + under = 1, every part is a probability, and a higher line is never easier to clear', () => {
  const r = rng(1); let n = 0;
  for (let i = 0; i < 6000; i++) {
    const type = TYPES[Math.floor(r() * TYPES.length)], big = type === 'points' || type === 'pra';
    const proj = 0.2 + r() * (big ? 38 : 9), sd = 0.4 + r() * (big ? 9 : 4), line = Math.round((0.5 + r() * (big ? 40 : 11)) * 2) / 2 + (r() < 0.4 ? 0.5 : 0);
    const p = S.calcOverUnderProbability(proj, sd, line, type); if (!p) continue; n++;
    assert.ok(p.overProbability >= 0 && p.overProbability <= 1 && p.underProbability >= 0 && p.underProbability <= 1, JSON.stringify([proj, sd, line, type, p]));
    assert.ok(Math.abs(p.overProbability + p.underProbability - 1) < 0.0025, JSON.stringify([proj, sd, line, type, p]));
    assert.ok(p.pushProbability >= 0 && p.pushProbability <= 0.9, 'push ' + p.pushProbability);
    if (!Number.isInteger(line)) assert.equal(p.pushProbability, 0, 'a half-number line cannot push');
    const hi = S.calcOverUnderProbability(proj, sd, line + 0.5, type);
    if (hi) assert.ok(hi.overProbability <= p.overProbability + 0.02, `raising the line raised P(over): ${JSON.stringify([proj, sd, line, type, p, hi])}`);
  }
  assert.ok(n > 5000);
});

test('the push chance is real: on a whole-number line it is close to the exact chance of landing on it', () => {
  const p = S.calcOverUnderProbability(2.4, 1.76, 2, '3pm'), pmf = S.countPmf(2.4, 1.76 ** 2, 40);
  assert.ok(Math.abs(p.pushProbability - pmf[2]) < 0.002, `${p.pushProbability} vs ${pmf[2]}`);
});

test('a blend always sits between the model and the market, and moves toward the model as its weight grows', () => {
  const r = rng(2);
  for (let i = 0; i < 4000; i++) {
    const a = 0.02 + r() * 0.96, b = 0.02 + r() * 0.96, w = r(), x = M.blendLogit(a, b, w), lo = Math.min(a, b) - 1e-9, hi = Math.max(a, b) + 1e-9;
    assert.ok(x >= lo && x <= hi, JSON.stringify([a, b, w, x]));
    const x2 = M.blendLogit(a, b, Math.min(1, w + 0.2)); assert.ok(a >= b ? x2 >= x - 1e-9 : x2 <= x + 1e-9);
  }
});

test('de-vigging keeps the order, sums to 1, and never produces a chance outside (0,1)', () => {
  const r = rng(3);
  for (let i = 0; i < 4000; i++) {
    const po = 0.05 + r() * 0.9, pu = 0.05 + r() * 0.9, d = M.devigPower(po, pu); if (!d) continue;
    assert.ok(Math.abs(d.over + d.under - 1) < 1e-9 && d.over > 0 && d.over < 1);
    if (Math.abs(po - pu) > 1e-6) assert.equal(d.over > d.under, po > pu, JSON.stringify([po, pu, d]));
  }
});

test('market fair chance at a line: a probability, and falling as the line rises', () => {
  const r = rng(4);
  for (let i = 0; i < 3000; i++) {
    const L = 10 + r() * 20, sd = 2 + r() * 8, books = randBooks(r, Math.round(L * 2) / 2);
    const a = M.marketFairAt(books, L, sd), b = M.marketFairAt(books, L + 0.5, sd);
    if (a) { assert.ok(a.over > 0 && a.over < 1 && Math.abs(a.over + a.under - 1) < 1e-9); }
    if (a && b && a.books === b.books) assert.ok(b.over <= a.over + 1e-6, JSON.stringify([L, sd, a, b]));
  }
});

test('the full assessment never produces a broken number, whatever the books look like', () => {
  const r = rng(5); let n = 0;
  for (let i = 0; i < 3000; i++) {
    const type = TYPES[Math.floor(r() * (TYPES.length - 1))], big = type === 'points', proj = 0.3 + r() * (big ? 35 : 8), sd = 0.5 + r() * (big ? 8 : 3);
    const a = S.assessProp({ propType: type, rawProjection: proj, sd, books: randBooks(r, Math.round(proj * 2) / 2) }); if (!a) continue; n++;
    for (const side of [a.over, a.under].filter(Boolean)) {
      assert.ok(side.prob > 0 && side.prob < 1 && Number.isFinite(side.ev) && side.ev >= -1 && side.ev <= 5, JSON.stringify(side));
      assert.ok(side.push >= 0 && side.push <= 0.9);
    }
    const evs = [a.over, a.under].filter(Boolean).map(x => x.ev); assert.equal(a.value.ev, Math.max(...evs), 'value is the better-price side');
    // the call is the side the projection leans (against the books' consensus), whatever the price says; with no lean it is the better price
    assert.ok(a.best === a.over || a.best === a.under, 'the call is one of the two sides');
  }
  assert.ok(n > 2500);
});

test('expected value is never below -1 for a real chance, and Kelly never stakes more than the cap', () => {
  const r = rng(6);
  for (let i = 0; i < 3000; i++) {
    const p = r(), pr = price(r), push = r() * 0.5, ev = M.expectedValue(p, pr, push);
    assert.ok(ev >= -1 - 1e-9 && ev <= 4, JSON.stringify([p, pr, push, ev]));
    const k = S.calcKellyStake(p, pr); assert.ok(k >= 0 && k <= 0.05 + 1e-9);
  }
});

test('hostile inputs never throw', () => {
  const junk = [NaN, Infinity, -Infinity, -1, 0, 1e12, '12', 'abc', null, undefined, {}, [], true];
  let threw = 0;
  for (const a of junk) for (const b of junk) for (const c of junk) {
    try {
      S.calcOverUnderProbability(a, b, c, 'points'); S.calcOverUnderProbability(a, b, c, '3pm');
      M.blendLogit(a, b, c); M.marketFairAt({ X: { Over: { point: a, price: b }, Under: { point: a, price: c } } }, a, b); M.expectedValue(a, b, c); M.devigPower(a, b); M.fairOverOfBook({ Over: { price: a }, Under: { price: b } });
      S.assessProp({ propType: 'points', rawProjection: a, sd: b, books: { X: { Over: { point: c, price: a }, Under: { point: c, price: b } } } });
    } catch (e) { threw++; assert.fail(`threw on ${[a, b, c].map(String)}: ${e.message}`); }
  }
  assert.equal(threw, 0);
});
