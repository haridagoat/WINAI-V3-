const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/market');

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
const book = (point, over, under) => ({ Over: { point, price: over }, Under: { point, price: under } });

test('normal curve and its inverse agree and match known values', () => {
  near(M.normalCdf(0), 0.5, 1e-6); near(M.normalCdf(1.96), 0.975, 1e-4); near(M.normalCdf(-1), 0.158655, 1e-5);
  for (const p of [0.001, 0.02, 0.2, 0.5, 0.8, 0.975, 0.999]) near(M.normalCdf(M.normalInv(p)), p, 1e-5);
});

test('American odds convert and bad prices are refused', () => {
  near(M.impliedFromAmerican(-110), 0.5238, 1e-3); near(M.impliedFromAmerican(150), 0.4, 1e-6);
  near(M.decimalFromAmerican(-110), 1.9091, 1e-3); near(M.decimalFromAmerican(200), 3, 1e-9);
  for (const bad of [0, 50, -50, 99, 'abc', null, undefined, NaN]) { assert.equal(M.impliedFromAmerican(bad), null); assert.equal(M.decimalFromAmerican(bad), null); }
});

test('power de-vig: sides add to 1, an even market stays even, and the longshot loses more than under simple division', () => {
  const even = M.devigPower(M.impliedFromAmerican(-110), M.impliedFromAmerican(-110)); near(even.over, 0.5); near(even.under, 0.5);
  const po = M.impliedFromAmerican(-250), pu = M.impliedFromAmerican(200);
  const d = M.devigPower(po, pu); near(d.over + d.under, 1, 1e-9);
  const proportionalUnder = pu / (po + pu);
  assert.ok(d.under < proportionalUnder, 'the power method should take more margin off the longshot side');
  assert.equal(M.devigPower(0, 0.5), null);
  const noMargin = M.devigPower(0.4, 0.5); near(noMargin.over + noMargin.under, 1, 1e-9);   // under-round prices are normalised, not rejected
});

test('one book showing a single side is treated with a typical margin', () => {
  const f = M.fairOverOfBook({ Over: { point: 20.5, price: -110 } }); near(f, 0.5, 0.01);
  near(M.fairOverOfBook({ Under: { point: 20.5, price: -110 } }), 0.5, 0.01);
  assert.equal(M.fairOverOfBook({}), null);
});

test('market fair chance at the line: same-number books average; a book on another number is moved along a bell curve', () => {
  const books = { A: book(22.5, -110, -110), B: book(22.5, -120, 100) };
  const f = M.marketFairAt(books, 22.5, 6); assert.equal(f.books, 2); near(f.over + f.under, 1, 1e-9); assert.ok(f.over > 0.45 && f.over < 0.55);
  const atHigher = M.marketFairAt({ A: book(22.5, -110, -110) }, 23.5, 6), atLower = M.marketFairAt({ A: book(22.5, -110, -110) }, 21.5, 6);
  assert.ok(atHigher.over < 0.5 && atLower.over > 0.5, 'a higher line is harder to clear');
  near(atHigher.over + atLower.over, 1, 0.01);
  assert.equal(M.marketFairAt({ A: book(22.5, -110, -110) }, 30.5, 6), null, 'a book far from the line is left out');
  assert.equal(M.marketFairAt({}, 22.5, 6), null); assert.equal(M.marketFairAt(books, 22.5, 0), null); assert.equal(M.marketFairAt(null, 22.5, 6), null);
});

test('book weights: a sharper book counts for more', () => {
  const books = { Sharp: book(22.5, -130, 110), Soft: book(22.5, 110, -130) };
  const even = M.marketFairAt(books, 22.5, 6).over, weighted = M.marketFairAt(books, 22.5, 6, { bookWeights: { Sharp: 3 } }).over;
  assert.ok(weighted > even, 'leaning on the book that favours the Over raises the Over chance');
});

test('best offers: lowest Over number and highest Under number, better price breaks a tie', () => {
  const o = M.bestOffers({ A: book(22.5, -110, -110), B: book(21.5, -125, 105), C: book(23.5, 100, -140), D: book(22.5, -105, -115) });
  assert.equal(o.over.book, 'B'); assert.equal(o.over.point, 21.5);
  assert.equal(o.under.book, 'C'); assert.equal(o.under.point, 23.5);
  const tie = M.bestOffers({ A: book(22.5, -115, -105), B: book(22.5, -105, -115) });
  assert.equal(tie.over.book, 'B'); assert.equal(tie.under.book, 'A');
  assert.deepEqual(M.bestOffers({}), { over: null, under: null });
});

test('consensus line is the median Over number', () => {
  assert.equal(M.consensusLineOf({ A: book(22.5, -110, -110), B: book(23.5, -110, -110), C: book(22.5, -110, -110) }), 22.5);
  assert.equal(M.consensusLineOf({ A: book(22.5, -110, -110), B: book(23.5, -110, -110) }), 23);
  assert.equal(M.consensusLineOf({}), null);
});

test('log-odds blend: weight 0 is the market, weight 1 is the model, and the middle sits between', () => {
  near(M.blendLogit(0.7, 0.5, 0), 0.5); near(M.blendLogit(0.7, 0.5, 1), 0.7);
  const mid = M.blendLogit(0.7, 0.5, 0.5); assert.ok(mid > 0.5 && mid < 0.7);
  assert.equal(M.blendLogit(0.7, null, 0.2), 0.7); assert.equal(M.blendLogit(null, 0.55, 0.2), 0.55); assert.equal(M.blendLogit(null, null, 0.2), null);
  near(M.blendLogit(0.9, 0.5, 5), 0.9); near(M.blendLogit(0.9, 0.5, -3), 0.5);   // the weight is kept inside 0..1
});

test('with no market the model is pulled toward 50%', () => {
  const p = M.shrinkToHalf(0.8); assert.ok(p > 0.5 && p < 0.7, String(p)); near(M.shrinkToHalf(0.5), 0.5); assert.equal(M.shrinkToHalf(null), null);
});

test('expected value: break-even at the implied chance, and a push refund scales it down', () => {
  near(M.expectedValue(0.55, -110), 0.05, 1e-3); near(M.expectedValue(M.impliedFromAmerican(-110), -110), 0, 2e-3);
  const noPush = M.expectedValue(0.6, -110), withPush = M.expectedValue(0.6, -110, 0.28);
  near(withPush, noPush * 0.72, 1e-3);
  assert.equal(M.expectedValue(null, -110), null); assert.equal(M.expectedValue(0.6, 50), null);
  assert.ok(Math.abs(M.expectedValue(0.6, -110, 5) - M.expectedValue(0.6, -110, 0.9)) < 1e-9, 'a push chance is capped');
});
