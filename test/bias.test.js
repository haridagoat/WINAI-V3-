// The learned bias correction: how it is fitted from graded props, that it never compounds, and that it stays inside safe limits.
const test = require('node:test');
const assert = require('node:assert/strict');
const bias = require('../lib/bias');
const cal = require('../lib/calibration');
const ev = require('../lib/evaluate');
const { buildGradingReport } = require('../lib/report');

const rows = (n, { model = 20, actual = 18, propType = 'points', league = 'nba', biasMult } = {}) => Array.from({ length: n }, () => ({ league, propType, actual, modelProjection: model, biasMult }));

test('a model that runs 10% high is scaled back, pulled toward 1 while the sample is small', () => {
  const t = bias.fitBias(rows(300, { model: 20, actual: 18 }));
  assert.equal(t['nba:points'].ratio, 0.9); assert.equal(t['nba:points'].n, 300);
  assert.ok(Math.abs(t['nba:points'].mult - (1 - 0.1 * 300 / 400)) < 1e-4, String(t['nba:points'].mult));
  assert.ok(bias.fitBias(rows(150))['nba:points'].mult > t['nba:points'].mult, 'fewer props, less correction');
});

test('nothing is fitted below the minimum, per league and prop type', () => {
  assert.deepEqual(bias.fitBias(rows(bias.MIN_N - 1)), {});
  const t = bias.fitBias([...rows(120), ...rows(40, { propType: 'assists', model: 6, actual: 5 }), ...rows(120, { league: 'wnba', actual: 22 })]);
  assert.deepEqual(Object.keys(t).sort(), ['nba:points', 'wnba:points']);
  assert.ok(t['wnba:points'].mult > 1, 'a model running low is raised');
});

test('the correction already in force is divided out, so refitting never compounds', () => {
  const first = bias.fitBias(rows(400, { model: 20, actual: 18 }))['nba:points'];
  const afterApplying = rows(400, { model: 20 * first.mult, actual: 18, biasMult: first.mult });   // what the server stores once it is applying the fix
  const second = bias.fitBias(afterApplying)['nba:points'];
  assert.equal(second.ratio, first.ratio); assert.equal(second.mult, first.mult);
});

test('the correction is kept inside its limits and bad rows are ignored', () => {
  assert.equal(bias.fitBias(rows(5000, { model: 20, actual: 5 }))['nba:points'].mult, bias.LO);
  assert.equal(bias.fitBias(rows(5000, { model: 5, actual: 20 }))['nba:points'].mult, bias.HI);
  const junk = [{ league: 'nba', propType: 'points', actual: null, modelProjection: 20 }, { actual: NaN, modelProjection: 20 }, { actual: 10, modelProjection: 0 }, { actual: -1, modelProjection: 10 }, null, undefined];
  assert.deepEqual(bias.fitBias([...junk, ...rows(99)]), {}); assert.deepEqual(bias.fitBias(null), {});
});

test('multFor: 1 when unknown or out of range, the learned number otherwise', () => {
  const t = { 'nba:points': { mult: 0.92 }, 'nba:assists': { mult: 3 }, 'nba:rebounds': { mult: 'x' } };
  assert.equal(bias.multFor(t, 'nba', 'points'), 0.92);
  for (const [lg, p] of [['nba', 'assists'], ['nba', 'rebounds'], ['nba', 'pra'], ['wnba', 'points'], [undefined, 'steals']]) assert.equal(bias.multFor(t, lg, p), 1, `${lg} ${p}`);
  assert.equal(bias.multFor(null, 'nba', 'points'), 1); assert.equal(bias.multFor(undefined), 1);
});

test('calibration: a curve end resting on a handful of picks is dropped, so 95% never maps to 100%', () => {
  const knots = [{ x: 0.55, y: 0.46, n: 54 }, { x: 0.8, y: 0.54, n: 90 }, { x: 0.95, y: 1, n: 1 }, { x: 0.97, y: 1, n: 2 }];
  assert.deepEqual(cal.trimThin(knots).map(k => k.x), [0.55, 0.8]);
  assert.equal(cal.evalKnots(cal.trimThin(knots), 0.99), 0.54, 'beyond the last well-supported point the curve stays flat');
  const lead = [{ x: 0.1, y: 0, n: 3 }, { x: 0.5, y: 0.5, n: 100 }];
  assert.deepEqual(cal.trimThin(lead).map(k => k.x), [0.5]);
  const thin = [{ x: 0.4, y: 0.4, n: 5 }, { x: 0.6, y: 0.6, n: 6 }];
  assert.equal(cal.trimThin(thin).length, 2, 'with no well-supported point at all nothing is trimmed');
  const entries = Array.from({ length: 200 }, (_, i) => ({ result: i < 198 ? (i % 2 ? 'WIN' : 'LOSS') : 'WIN', modelProb: i < 198 ? 50 + (i % 20) : 99 }));
  const m = cal.fit(entries);
  assert.ok(cal.evalKnots(m.knots, 0.99) < 0.9, `a 99% chance resting on two picks must not map near 100% (got ${cal.evalKnots(m.knots, 0.99)})`);
  assert.ok(m.knots.every(k => k.n >= cal.MIN_KNOT_N));
});

test('how much of the model\'s disagreement with the line was real: 1 for a model that is right, 0 for noise', () => {
  const mk = (slope, n = 200) => Array.from({ length: n }, (_, i) => { const gap = ((i % 9) - 4); return { actual: 20 + slope * gap, propType: 'points', data: { evalLine: 20, modelProjection: 20 + gap } }; });
  assert.equal(ev.disagreement(mk(1)).points.slope, 1); assert.equal(ev.disagreement(mk(0)).points.slope, 0); assert.equal(ev.disagreement(mk(0.4)).points.slope, 0.4);
  assert.deepEqual(ev.disagreement(mk(1, 10)), {}, 'too few props to say');
  assert.deepEqual(ev.disagreement([{ actual: null, propType: 'points', data: { evalLine: 1, modelProjection: 2 } }, { actual: 3, propType: 'points', data: {} }]), {});
  assert.deepEqual(ev.disagreement(null), {});
});

test('the report names the bias correction in use and how real the model\'s disagreements were', () => {
  const scanRows = Array.from({ length: 60 }, (_, i) => ({ date: '2026-11-04', actual: 20 + (i % 5 - 2) * 0.5, propType: 'points', data: { evalLine: 20, modelProjection: 20 + (i % 5 - 2), blended: 20, modelOver: 0.5, marketOver: 0.5, finalOver: 0.5 } }));
  const r = buildGradingReport({ date: '2026-11-04', picks: [], scan: { nba: { counts: { total: 60, graded: 60, waiting: 0, setAside: 0 }, graded: scanRows } }, bias: { 'nba:points': { mult: 0.924, ratio: 0.891, n: 234 } } });
  for (const s of ['BIAS CORRECTION IN USE: NBA pts x0.924 (raw ratio 0.891, 234 props)', 'How much of its disagreement with the line was real', 'pts 0.50 (60 props)']) assert.ok(r.text.includes(s), `missing "${s}"\n${r.text}`);
  assert.deepEqual(r.data.bias, [{ league: 'nba', propType: 'points', mult: 0.924, ratio: 0.891, n: 234 }]);
  assert.ok(!buildGradingReport({ date: '2026-11-04' }).text.includes('BIAS CORRECTION'));
});
