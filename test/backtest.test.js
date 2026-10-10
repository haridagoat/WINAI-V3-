const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReport, summarize, wilson } = require('../lib/backtest');

const pick = (o) => ({ id: Math.random(), source: 'auto', league: 'wnba', propType: 'points', verdict: 'OVER', ...o });

test('Wilson range is wide for small samples and narrows with more', () => {
  const small = wilson(6, 10), big = wilson(600, 1000);
  assert.ok(small[1] - small[0] > 40);
  assert.ok(big[1] - big[0] < 8);
  assert.deepEqual(wilson(5, 10).map(Math.round), [24, 76]);
  assert.equal(wilson(0, 0), null);
});

test('summarize counts wins, losses, pushes and ignores pushes in the win rate', () => {
  const s = summarize([pick({ result: 'WIN' }), pick({ result: 'WIN' }), pick({ result: 'LOSS' }), pick({ result: 'PUSH' })]);
  assert.equal(s.wins, 2); assert.equal(s.losses, 1); assert.equal(s.pushes, 1);
  assert.equal(s.winRate, 66.7);
});

test('ROI uses the stored price and only the picks that have one', () => {
  const s = summarize([pick({ result: 'WIN', price: 100 }), pick({ result: 'LOSS', price: 100 }), pick({ result: 'WIN' })]);
  assert.equal(s.pricedPicks, 2);
  assert.equal(s.roi, 0);   // +1 and -1 at even money
  const w = summarize([pick({ result: 'WIN', price: -110 })]);
  assert.equal(w.roi, 90.9);
});

test('an empty history reports zero without blowing up', () => {
  const r = buildReport([]);
  assert.equal(r.totals.graded, 0);
  assert.equal(r.enoughForWinRate, false);
  assert.equal(r.overall.winRate, null);
  assert.deepEqual(r.flags, []);
});

test('picks are split by prop type, side and confidence tier', () => {
  const rows = [
    pick({ result: 'WIN', propType: 'points', confidence: 80, confVersion: 2 }),
    pick({ result: 'LOSS', propType: 'assists', verdict: 'UNDER', confidence: 40, confVersion: 2 }),
    pick({ result: 'WIN', propType: 'points', verdict: 'LEAN_OVER', confidence: 60, confVersion: 2 }),
    pick({ result: 'WIN', propType: 'points', confidence: 90, confVersion: 1 }),   // an older formula: left out of tiers
  ];
  const r = buildReport(rows, { confVersion: 2 });
  assert.equal(r.slices.propType.points.wins, 3);
  assert.equal(r.slices.side.OVER.n, 3);
  assert.equal(r.slices.side.UNDER.losses, 1);
  assert.equal(r.slices.confidenceTier.strong.n, 1);
  assert.equal(r.slices.confidenceTier.thin.n, 1);
  assert.equal(r.slices.confidenceTier.lean.n, 1);
});

test('waiting and set-aside picks are counted apart', () => {
  const r = buildReport([pick({ result: null }), pick({ result: null, gradeNote: 'no game' }), pick({ result: 'WIN' })]);
  assert.equal(r.totals.waitingToGrade, 1);
  assert.equal(r.totals.unmatched, 1);
});

test('calibration bins compare what was said with what happened', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(pick({ result: i < 6 ? 'WIN' : 'LOSS', modelProb: 72 }));   // says 72, wins 60
  const r = buildReport(rows);
  const bin = r.probability.bins.find(b => b.from === 70);
  assert.equal(bin.n, 10);
  assert.equal(bin.predicted, 72);
  assert.equal(bin.actual, 60);
  assert.ok(r.probability.brier > 0.2 && r.probability.brier < 0.3);
});

test('projection error reports the average miss and which way it leans', () => {
  const r = buildReport([pick({ actualStat: 18, projection: 20 }), pick({ actualStat: 22, projection: 24 })]);
  assert.equal(r.projection.overall.mae, 2);
  assert.equal(r.projection.overall.bias, -2);   // real stats ran below the projection
});

test('a slice is only flagged once it has enough picks and a clear range', () => {
  const bad = Array.from({ length: 40 }, (_, i) => pick({ propType: 'assists', result: i < 8 ? 'WIN' : 'LOSS' }));    // 20% over 40
  const good = Array.from({ length: 60 }, (_, i) => pick({ propType: 'points', result: i < 48 ? 'WIN' : 'LOSS' }));   // 80% over 60
  const few = Array.from({ length: 10 }, () => pick({ propType: 'rebounds', result: 'LOSS' }));                        // 0 for 10: too few to say
  const r = buildReport([...bad, ...good, ...few]);
  const names = r.flags.map(f => `${f.level}:${f.slice}`);
  assert.ok(names.includes('skip:assists'));
  assert.ok(names.includes('keep:points'));
  assert.ok(!names.some(n => n.endsWith(':rebounds')));
});

test('closing line value tallies better, flat and worse', () => {
  const r = buildReport([pick({ clv: 1 }), pick({ clv: 0 }), pick({ clv: -0.5 }), pick({ clv: 0 })]);
  assert.deepEqual([r.clv.beat, r.clv.flat, r.clv.worse], [1, 2, 1]);
  assert.equal(r.clv.avg, 0.13);
});
