const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const P = require('../lib/params');

test('a missing or broken file falls back to the defaults', () => {
  P.load(path.join(os.tmpdir(), 'no-such-params.json')); assert.equal(P.info().loadedFrom, null); assert.equal(P.get().market.minEv, 0.03);
  const bad = path.join(os.tmpdir(), 'bad-params.json'); fs.writeFileSync(bad, '{not json'); P.load(bad); assert.equal(P.info().loadedFrom, null);
});

test('values in the file override defaults one by one, and the rest stay', () => {
  const f = path.join(os.tmpdir(), 'p1.json'); fs.writeFileSync(f, JSON.stringify({ market: { minEv: 0.05 }, spread: { points: { a: 5, b: 0.1 } } }));
  P.load(f); assert.equal(P.get().market.minEv, 0.05); assert.equal(P.get().market.modelOnlyKeep, 0.5); assert.equal(P.spreadSd('points', 20), 7);
  assert.equal(P.get().usage.minutesSlope, 0.18, 'untouched sections keep their defaults');
});

test('a file cannot pollute the prototype', () => {
  const f = path.join(os.tmpdir(), 'p2.json'); fs.writeFileSync(f, '{"__proto__":{"polluted":1},"market":{"__proto__":{"polluted":2},"minEv":0.04}}');
  P.load(f); assert.equal(({}).polluted, undefined); assert.equal(P.get().market.minEv, 0.04);
});

test('per-prop tables: the prop wins, then default, then the fallback', () => {
  assert.equal(P.forProp({ default: 0.1, points: 0.05 }, 'points'), 0.05); assert.equal(P.forProp({ default: 0.1, points: 0.05 }, '3pm'), 0.1);
  assert.equal(P.forProp({ points: 0.05 }, 'steals', 0.2), 0.2); assert.equal(P.forProp(null, 'points', 0.3), 0.3); assert.equal(P.forProp({ default: 'x' }, 'points', 0.3), 0.3);
});

test('spread: level-based where fitted, variance-per-mean for count stats, nothing where unknown', () => {
  P.load(path.join(os.tmpdir(), 'no-such-params.json'));
  assert.ok(Math.abs(P.spreadSd('points', 22) - 7.36) < 0.01);
  assert.ok(Math.abs(P.spreadSd('3pm', 2.5) - Math.sqrt(1.24 * 2.5)) < 1e-9);
  assert.equal(P.spreadSd('pra', 30), null);
  assert.ok(P.spreadSd('steals', 0) >= 0.3, 'never a zero spread');
});

test('minutes share of the teammate-out lift is the measured ratio, kept inside sensible bounds', () => {
  P.load(path.join(os.tmpdir(), 'no-such-params.json'));
  assert.ok(Math.abs(P.usageMinutesShare('points') - 0.18 / 0.29) < 0.01);
  assert.equal(P.usageMinutesShare('steals'), 0.9, 'a stat whose lift is below the minutes lift is capped');
  assert.equal(P.usageMinutesShare('blocks'), 0.35, 'a stat with no lift at all uses the fallback (there is no lift to split)');
  assert.equal(P.usageMinutesShare('nonsense'), P.usageMinutesShare('points'));
  const f = path.join(os.tmpdir(), 'p3.json'); const spy = console.warn; console.warn = () => {};
  fs.writeFileSync(f, JSON.stringify({ usage: { sens: {}, minutesSlope: null } })); try { P.load(f); } finally { console.warn = spy; }
  assert.ok(Math.abs(P.usageMinutesShare('points') - 0.18 / 0.29) < 0.01, 'an invalid slope in the file falls back to the fitted default, not to a guess');
  P.load(path.join(os.tmpdir(), 'no-such-params.json'));
});

test('the shipped model_params.json loads and holds sane numbers', () => {
  P.load(); const g = P.get();
  for (const k of ['points', 'rebounds', 'assists']) assert.ok(g.market.weightModelMean[k] ?? g.market.weightModelMean.default <= 0.5);
  assert.ok(g.market.weightModelProb.default <= 0.3, 'the model must not outweigh the market in probabilities');
  assert.ok(g.rest.minutes >= 0.9 && g.rest.minutes <= 1.05 && g.rest.stats >= 0.9 && g.rest.stats <= 1.05);
  for (const v of Object.values(g.usage.sens)) assert.ok(v >= 0 && v < 1.5);
});

test('invalid numbers in the file are replaced by defaults, and listed, instead of breaking the model', () => {
  const f = path.join(os.tmpdir(), 'p-bad.json');
  fs.writeFileSync(f, JSON.stringify({
    market: { minEv: 'lots', weightModelProb: { default: -1, points: 7, steals: 0.2 }, weightModelMean: { default: null }, modelOnlyKeep: 4 },
    rest: { minutes: 0.2, stats: 1.0 }, usage: { sens: { points: 'x', rebounds: 0.5 }, minutesSlope: -3 },
    spread: { points: { a: 'big', b: 1 }, steals: { phi: -2 }, blocks: { phi: 1.3 }, junk: 5 }, decay: { halfLifeGames: { points: 0 }, lambda: { points: 2 } },
  }));
  const spy = console.warn; console.warn = () => {};
  try { P.load(f); } finally { console.warn = spy; }
  const g = P.get(), D = P.DEFAULTS;
  assert.equal(g.market.minEv, D.market.minEv); assert.equal(g.market.modelOnlyKeep, D.market.modelOnlyKeep);
  assert.equal(g.market.weightModelProb.default, D.market.weightModelProb.default, 'a negative weight falls back'); assert.equal(g.market.weightModelProb.points, D.market.weightModelProb.points, 'a weight above 1 falls back');
  assert.equal(g.market.weightModelProb.steals, 0.2, 'valid entries in the same table are kept');
  assert.equal(g.rest.minutes, D.rest.minutes); assert.equal(g.rest.stats, 1.0);
  assert.equal(g.usage.sens.points, D.usage.sens.points); assert.equal(g.usage.sens.rebounds, 0.5); assert.equal(g.usage.minutesSlope, D.usage.minutesSlope);
  assert.deepEqual(g.spread.points, D.spread.points); assert.deepEqual(g.spread.steals, D.spread.steals); assert.deepEqual(g.spread.blocks, { phi: 1.3 }); assert.equal(g.spread.junk, undefined);
  assert.equal(g.decay.halfLifeGames.points, undefined); assert.equal(g.decay.lambda.points, undefined);
  assert.ok(P.info().ignored.length >= 8, JSON.stringify(P.info().ignored));
  assert.ok(Number.isFinite(P.spreadSd('points', 20)) && Number.isFinite(P.usageMinutesShare('points')));
  P.load(path.join(os.tmpdir(), 'no-such-params.json')); assert.deepEqual(P.info().ignored, []);
});
test('the shipped model_params.json has nothing that gets ignored', () => { P.load(); assert.deepEqual(P.info().ignored, []); });
