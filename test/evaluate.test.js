const test = require('node:test');
const assert = require('node:assert/strict');
const { scanMetrics, scoreRows, calibrationBands } = require('../lib/evaluate');

const row = (actual, d, propType = 'points') => ({ actual, propType, data: { evalLine: 20.5, modelProjection: 24, blended: 21, modelOver: 0.7, marketOver: 0.5, finalOver: 0.52, ...d } });

test('errors, bias and chances are scored against the line, the model and the market-blended estimate', () => {
  const rows = [row(22), row(18), row(25), row(15)];
  const s = scoreRows(rows);
  assert.equal(s.n, 4);
  assert.equal(s.mae.market, ((1.5 + 2.5 + 4.5 + 5.5) / 4));              // |actual - 20.5|
  assert.equal(s.mae.model, ((2 + 6 + 1 + 9) / 4));                        // |actual - 24|
  assert.equal(s.mae.blended, ((1 + 3 + 4 + 6) / 4));                      // |actual - 21|
  assert.ok(s.bias.model < 0, 'the model projects above what happened');
  assert.equal(s.decided, 4); assert.equal(s.overRate, 0.5);
  assert.ok(s.brier.market < s.brier.model, 'a 50% market beats a 70% model on a coin-flip result');
  assert.ok(s.logloss.final < s.logloss.model);
});

test('a push is scored on error but decides no outcome; incomplete rows are skipped', () => {
  const s = scoreRows([row(20.5), { actual: 20, propType: 'points', data: {} }, { actual: null, data: { evalLine: 20.5, modelProjection: 22 } }]);
  assert.equal(s.n, 1); assert.equal(s.decided, 0); assert.equal(s.brier.model, null);
});

test('metrics split by prop type once there are enough rows', () => {
  const rows = [...Array.from({ length: 25 }, (_, i) => row(18 + (i % 5), {}, 'points')), ...Array.from({ length: 5 }, () => row(5, {}, 'assists'))];
  const m = scanMetrics(rows); assert.ok(m.byProp.points); assert.equal(m.byProp.assists, undefined); assert.equal(m.overall.n, 30);
});

test('calibration bands compare claimed chance with how often the Over hit', () => {
  const rows = [row(25, { modelOver: 0.8 }), row(18, { modelOver: 0.8 }), row(26, { modelOver: 0.5 }), row(10, { modelOver: 0.5 })];
  const b = calibrationBands(rows, 'modelOver'); const high = b.find(x => x.range.startsWith('65'));
  assert.equal(high.n, 2); assert.equal(high.hitRate, 0.5); assert.ok(high.claimed > 0.75);
});

test('the Over outcome is not reversed: a model that says Over and is right scores well, one that is wrong scores badly', () => {
  const allOver = Array.from({ length: 20 }, () => row(26, { modelOver: 0.9, marketOver: 0.5, finalOver: 0.6 }));
  const right = scoreRows(allOver);
  assert.equal(right.overRate, 1);
  assert.ok(right.brier.model < 0.02, `a 90% Over that happened should score near 0.01, got ${right.brier.model}`);
  assert.ok(right.brier.model < right.brier.market && right.brier.final < right.brier.market);
  const allUnder = scoreRows(Array.from({ length: 20 }, () => row(12, { modelOver: 0.9, marketOver: 0.5, finalOver: 0.6 })));
  assert.equal(allUnder.overRate, 0);
  assert.ok(allUnder.brier.model > 0.7, 'a 90% Over that missed scores badly');
  const bands = calibrationBands(allOver, 'modelOver'); assert.equal(bands[0].hitRate, 1);
});

const { valuePickRecord } = require('../lib/evaluate');
test('the value-pick record counts wins, losses and pushes against each pick\'s own best line and side', () => {
  const pick = (actual, best) => ({ actual, data: { evalLine: 20.5, best } });
  const rows = [
    pick(25, { side: 'over', line: 21.5, prob: 0.55, ev: 0.05 }),     // win
    pick(18, { side: 'over', line: 21.5, prob: 0.55, ev: 0.05 }),     // loss
    pick(18, { side: 'under', line: 22.5, prob: 0.6, ev: 0.04 }),     // win
    pick(22, { side: 'under', line: 22, prob: 0.5, ev: 0.03 }),       // push
    pick(30, { side: 'over', line: 21.5, prob: 0.5, ev: 0.01 }),      // below the bar: not a pick
    { actual: null, data: { best: { side: 'over', line: 20, prob: 0.5, ev: 0.2 } } },    // no result yet
  ];
  const r = valuePickRecord(rows);
  assert.deepEqual([r.picks, r.wins, r.losses, r.pushes], [4, 2, 1, 1]);
  assert.equal(r.winRate, 0.667); assert.equal(r.avgEv, 0.0425);
  assert.equal(valuePickRecord([]).winRate, null);
});

const fwRow = (actual, proj, extra = {}, propType = 'points') => ({ actual, propType, data: { modelProjection: proj, ...extra } });

test('forward check, teammate-out lift: boosted props still missed high are called too small, and nothing is called before there is enough', () => {
  const { forwardChecks } = require('../lib/evaluate');
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(fwRow(24 + (i % 3 - 1) * 2, 20, { tmBoost: 0.05 }));            // boosted, finished ~20% above the projection
  for (let i = 0; i < 40; i++) rows.push(fwRow(20 + (i % 3 - 1) * 2, 20, { tmBoost: 0 }));               // not boosted, right on
  rows.push(fwRow(99, 20));                                                                               // logged before the field existed: ignored
  const r = forwardChecks(rows).teammateOut.all;
  assert.equal(r.boosted.n, 40); assert.equal(r.none.n, 40); assert.equal(r.verdict, 'lift looks too small'); assert.ok(r.t >= 2);
  assert.equal(forwardChecks(rows.slice(30, 50)).teammateOut.all.verdict, 'too early');
  const big = []; for (let i = 0; i < 40; i++) { big.push(fwRow(16 + (i % 3 - 1) * 2, 20, { tmBoost: 0.05 })); big.push(fwRow(20 + (i % 3 - 1) * 2, 20, { tmBoost: 0 })); }
  assert.equal(forwardChecks(big).teammateOut.all.verdict, 'lift looks too big');
  const fine = []; for (let i = 0; i < 40; i++) { fine.push(fwRow(20 + (i % 5 - 2), 20, { tmBoost: 0.05 })); fine.push(fwRow(20 + (i % 5 - 2), 20, { tmBoost: 0 })); }
  assert.equal(forwardChecks(fine).teammateOut.all.verdict, 'about right');
});

test('forward check, position allowed: slope 1 when the miss follows the multiplier, none or negative when it does not', () => {
  const { forwardChecks } = require('../lib/evaluate');
  const follows = [], noise = [];
  for (let i = 0; i < 60; i++) { const m = 1 + (i % 5 - 2) * 0.02; follows.push(fwRow(20 * m, 20, { posMult: m }, 'rebounds')); noise.push(fwRow(20 + (i % 2 ? 1 : -1), 20, { posMult: m }, 'rebounds')); }
  assert.ok(Math.abs(forwardChecks(follows).position.rebounds.slope - 1) < 0.01); assert.equal(forwardChecks(follows).position.rebounds.verdict, 'adds value');
  assert.notEqual(forwardChecks(noise).position.rebounds.verdict, 'adds value');
  assert.deepEqual(forwardChecks([]).position, {}); assert.deepEqual(forwardChecks(undefined).teammateOut, {});
});
