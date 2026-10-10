const test = require('node:test');
const assert = require('node:assert/strict');
const cal = require('../lib/calibration');

// deterministic pseudo-random so a failure is reproducible
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function picks(n, trueRate, seed = 7) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) { const p = 55 + Math.floor(r() * 31); out.push({ id: i, modelProb: p, result: r() < trueRate(p / 100) ? 'WIN' : 'LOSS' }); }
  return out;
}

test('only graded wins and losses with a stored chance count', () => {
  const s = cal.samplesFrom([
    { result: 'WIN', modelProb: 60 }, { result: 'LOSS', modelProb: 70 }, { result: 'PUSH', modelProb: 60 },
    { result: null, modelProb: 60 }, { result: 'WIN', modelProb: null }, { result: 'WIN', modelProb: 100 }, { result: 'WIN', modelProb: 0 },
  ]);
  assert.deepEqual(s.map(x => x.y), [1, 0]);
});

test('isotonic fit never decreases', () => {
  const k = cal.isotonic(picks(400, p => p - 0.1).map(e => ({ p: e.modelProb / 100, y: e.result === 'WIN' ? 1 : 0 })));
  for (let i = 1; i < k.length; i++) assert.ok(k[i].y >= k[i - 1].y - 1e-12, 'curve went down');
});

test('stays off, and changes nothing, with too few graded picks', () => {
  const m = cal.fit(picks(cal.MIN_GRADED - 1, p => p));
  assert.equal(m.active, false);
  assert.equal(cal.apply(m, 0.7), 0.7);
  assert.match(m.reason, /Needs 60/);
});

test('turns on for an overconfident model and pulls its chances down toward reality', () => {
  const m = cal.fit(picks(400, p => p - 0.12));
  assert.equal(m.active, true);
  assert.ok(m.cvGain >= cal.MIN_CV_GAIN);
  const out = cal.apply(m, 0.8);
  assert.ok(out < 0.8 && out > 0.6, `0.80 became ${out}`);
});

test('stays off when the model is already honest (calibrating would only add noise)', () => {
  const m = cal.fit(picks(300, p => p));
  assert.equal(m.active, false);
  assert.match(m.reason, /^Off/);
});

test('applied chances stay inside 2% and 98% and keep their order', () => {
  const m = cal.fit(picks(500, p => p - 0.15));
  let last = 0;
  for (let p = 0.5; p <= 0.99; p += 0.01) {
    const v = cal.apply(m, p);
    assert.ok(v >= 0.02 && v <= 0.98);
    assert.ok(v >= last - 1e-9, 'order broke at ' + p);
    last = v;
  }
});

test('more data means more trust in the fitted curve', () => {
  const w60 = 60 / (60 + cal.SHRINK_K), w600 = 600 / (600 + cal.SHRINK_K);
  assert.ok(Math.abs(w60 - 0.286) < 0.01 && Math.abs(w600 - 0.8) < 0.01);
});

test('apply passes values through when there is no model', () => {
  assert.equal(cal.apply(null, 0.61), 0.61);
  assert.equal(cal.apply({ active: false }, 0.61), 0.61);
  assert.equal(cal.apply({ active: true, knots: [{ x: 0.6, y: 0.5, n: 10 }], w: 1 }, null), null);
});
