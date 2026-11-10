const test = require('node:test');
const assert = require('node:assert/strict');
const bb = require('../lib/bestbets');
const { buildGradingReport } = require('../lib/report');

const p = (id, day, confidence, ev, result = null) => ({ id, day, confidence, ev, result });

test('the rules: confidence 65 or more and expected value 0 or more, nothing else', () => {
  assert.equal(bb.qualifies(p(1, 'd', 65, 0)), true);
  assert.equal(bb.qualifies(p(1, 'd', 64.9, 0.05)), false);
  assert.equal(bb.qualifies(p(1, 'd', 80, -0.001)), false);
  for (const bad of [{ confidence: NaN, ev: 0.1 }, { confidence: 70, ev: null }, { confidence: '70', ev: 0.1 }, { ev: 0.1 }, null, undefined]) assert.equal(bb.qualifies(bad), false, JSON.stringify(bad));
});

test('at most six a day, the best expected value first, ties broken by confidence then order', () => {
  const picks = Array.from({ length: 9 }, (_, i) => p(i + 1, 'd', 70, 0.01 * (i + 1)));
  const sel = bb.selectForDay(picks);
  assert.equal(sel.length, 6); assert.deepEqual(sel.map(x => x.id), [9, 8, 7, 6, 5, 4]);
  const ties = bb.selectForDay([p(1, 'd', 70, 0.02), p(2, 'd', 80, 0.02), p(3, 'd', 80, 0.02)]);
  assert.deepEqual(ties.map(x => x.id), [2, 3, 1]);
  assert.deepEqual(bb.selectForDay([]), []); assert.deepEqual(bb.selectForDay(null), []);
});

test('the cap is per day, and the choice never depends on a result', () => {
  const a = [p(1, 'd1', 70, 0.02, 'WIN'), p(2, 'd1', 70, 0.03, 'LOSS'), p(3, 'd2', 70, 0.01, null)];
  const flipped = a.map(x => ({ ...x, result: x.result === 'WIN' ? 'LOSS' : x.result === 'LOSS' ? 'WIN' : 'WIN' }));
  assert.deepEqual([...bb.bestBetIds(a)].sort(), [1, 2, 3]);
  assert.deepEqual([...bb.bestBetIds(a)].sort(), [...bb.bestBetIds(flipped)].sort());
  const many = Array.from({ length: 8 }, (_, i) => p(i, 'd1', 70, 0.01)).concat(Array.from({ length: 8 }, (_, i) => p(100 + i, 'd2', 70, 0.01)));
  assert.equal(bb.bestBetIds(many).size, 12);
  assert.equal(bb.bestBetIds([{ confidence: 70, ev: 0.1 }, { id: 5, confidence: 70, ev: 0.1 }]).size, 0, 'a pick with no id or day cannot be tracked');
});

test('live picks are marked the same way', () => {
  const live = [{ confidence: 70, realEdge: { expectedValue: 0.02 } }, { confidence: 70, realEdge: { expectedValue: -0.02 } }, { confidence: 60, realEdge: { expectedValue: 0.04 } }, { confidence: 70 }, { confidence: 90, realEdge: { expectedValue: 0.5 } }];
  bb.markLive(live);
  assert.deepEqual(live.map(x => x.bestBet), [true, false, false, false, true]);
  assert.doesNotThrow(() => bb.markLive(null));
});

const graded = (id, day, result, confidence = 70, ev = 0.02) => ({ id, league: 'nba', day, result, player: 'P' + id, propType: 'points', verdict: 'OVER', line: 20.5, actualStat: 24, confidence, ev });

test('the report scores best bets since the rules were fixed apart from the reference record before them', () => {
  const picks = [graded(1, '2026-11-04', 'WIN'), graded(2, '2026-11-04', 'LOSS', 50), graded(3, '2026-11-05', 'WIN'), graded(4, '2026-11-05', 'LOSS'), graded(5, '2026-11-05', 'LOSS', 40)];
  const allPicks = [...picks, p(6, '2026-11-05', 70, 0.02, null)];
  const r = buildGradingReport({ date: '2026-11-05', picks, allPicks });
  const b = r.data.bestBets;
  assert.equal(b.sinceLock.n, 2); assert.equal(b.sinceLock.wins, 1); assert.equal(b.earlier.n, 1); assert.equal(b.day.n, 2);
  assert.equal(b.waiting, 1, 'a best bet that is logged but not graded yet is counted as waiting');
  assert.equal(b.restOfPicks.n, 1);
  assert.equal(r.data.picks.list.find(x => x.player === 'P3').bestBet, true); assert.equal(r.data.picks.list.find(x => x.player === 'P5').bestBet, false);
  for (const s of ['BEST BETS (confidence 65+, expected value 0%+, the best 6 a day; rules fixed on 2026-11-05', 'since 2026-11-05: 1-1 (50.0%)', 'before 2026-11-05 (reference only', '★ best bet', '1 waiting']) assert.ok(r.text.includes(s), `missing "${s}"\n${r.text}`);
});

test('a best bet that never gets graded does not let a lower-ranked pick take its place', () => {
  const day = '2026-11-05';
  const allPicks = [p(1, day, 80, 0.09, null), ...Array.from({ length: 6 }, (_, i) => p(10 + i, day, 70, 0.01, 'WIN'))];
  const picks = allPicks.filter(x => x.result).map(x => ({ ...graded(x.id, day, 'WIN'), ev: x.ev, confidence: x.confidence }));
  const r = buildGradingReport({ date: day, picks, allPicks });
  assert.equal(r.data.bestBets.sinceLock.n, 5, 'the sixth slot stays with the ungraded pick that ranked first');
});

test('without a full log the report still works from the graded picks', () => {
  const r = buildGradingReport({ date: '2026-11-05', picks: [graded(1, '2026-11-05', 'WIN')] });
  assert.equal(r.data.bestBets.sinceLock.n, 1);
  assert.doesNotThrow(() => buildGradingReport());
});

test('a best bet that was set aside (no matching game) is not counted as waiting', () => {
  const allPicks = [{ ...p(1, '2026-11-04', 70, 0.02, null), setAside: true }, p(2, '2026-11-04', 70, 0.02, null)];
  assert.equal(buildGradingReport({ date: '2026-11-04', picks: [], allPicks }).data.bestBets.waiting, 1);
});
