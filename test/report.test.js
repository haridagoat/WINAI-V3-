const test = require('node:test');
const assert = require('node:assert/strict');
const { top3Result, buildGradingReport } = require('../lib/report');

const pick = (day, result, over = {}) => ({ league: 'nba', day, result, player: 'P' + Math.random().toString(36).slice(2, 5), propType: 'points', verdict: 'OVER', line: 20.5, actualStat: 24, ...over });
const scanRow = (date, actual, best = null) => ({ date, actual, propType: 'points', data: { evalLine: 20.5, modelProjection: 23, blended: 21, modelOver: 0.6, marketOver: 0.5, finalOver: 0.52, best } });

test('a normal day: the record, by-type split, each pick, the running record and what is waiting', () => {
  const picks = [pick('2026-11-03', 'WIN', { player: 'Jalen Brunson' }), pick('2026-11-03', 'LOSS', { propType: 'assists', verdict: 'LEAN_UNDER', line: 5.5, actualStat: 7 }), pick('2026-11-03', 'PUSH'), pick('2026-11-02', 'WIN'), pick('2026-11-02', 'LOSS'), pick('2026-11-04', 'WIN')];
  const r = buildGradingReport({ date: '2026-11-03', picks, pickCounts: { waiting: 4, setAside: 2 }, calibration: { active: false, reason: 'Needs 60.' }, credits: 150 });
  assert.match(r.headline, /3 picks graded, 1-1-1/);
  assert.equal(r.data.picks.day.wins, 1); assert.equal(r.data.picks.toDate.n, 5, 'a pick graded after the report date is not in it');
  for (const s of ['Jalen Brunson OVER 20.5 pts  (actual 24)', '✗', 'UNDER 5.5 ast', 'by type: pts 1-0-1 (100.0%) | ast 0-1 (0.0%)', 'WAITING: 4 picks ungraded, 2 set aside', 'CALIBRATION: off. Needs 60.', 'ODDS CREDITS LEFT: 150', 'SINCE TRACKING BEGAN: 2-2-1']) assert.ok(r.text.includes(s), `missing "${s}"\n${r.text}`);
  assert.ok(!r.text.includes('LEAN_'), 'a lean is shown as its side');
});

test('a day with nothing graded still produces a clear report', () => {
  const r = buildGradingReport({ date: '2026-11-03', picks: [], pickCounts: {} });
  assert.match(r.headline, /no picks were graded/); assert.match(r.text, /PICKS GRADED: none/); assert.match(r.text, /SINCE TRACKING BEGAN: 0-0/);
  assert.doesNotThrow(() => buildGradingReport());
});

test('long days are capped, with the count of the rest', () => {
  const picks = Array.from({ length: 30 }, (_, i) => pick('2026-11-03', i % 2 ? 'WIN' : 'LOSS'));
  const r = buildGradingReport({ date: '2026-11-03', picks, maxListed: 12 });
  assert.match(r.text, /\.\.\. and 18 more/); assert.equal(r.text.split('\n').filter(l => /^  [✓✗–] /.test(l)).length, 12);
});

test('both leagues are split when both played', () => {
  const picks = [pick('2026-11-03', 'WIN'), pick('2026-11-03', 'LOSS', { league: 'wnba' }), pick('2026-11-03', 'LOSS', { league: 'wnba' })];
  const r = buildGradingReport({ date: '2026-11-03', picks });
  assert.match(r.text, /NBA: 1-0/); assert.match(r.text, /WNBA: 0-2/); assert.ok(r.data.picks.byLeague.nba && r.data.picks.byLeague.wnba);
  assert.match(r.text, /SINCE TRACKING BEGAN: 1-2 \(33\.3%\) \(NBA 1-0 \(100\.0%\) \| WNBA 0-2 \(0\.0%\)\) over 3 graded picks/, 'the running record is split by league too');
});

test('the scan-log section scores the model against the line and the market, for the day and since logging began', () => {
  const good = { side: 'over', line: 20.5, prob: 0.55, ev: 0.05 };
  const rows = [scanRow('2026-11-03', 25, good), scanRow('2026-11-03', 18, good), scanRow('2026-11-03', 22), scanRow('2026-11-02', 30)];
  const r = buildGradingReport({ date: '2026-11-03', picks: [], scan: { nba: { counts: { total: 280, graded: 4, waiting: 270, setAside: 6 }, graded: rows } } });
  assert.match(r.text, /EVERY PROP THE NBA SCAN LOGGED \(not just picks\): 280 logged, 4 graded, 270 waiting, 6 set aside/);
  assert.match(r.text, /Nov 3 \(3 props\): average miss/); assert.match(r.text, /Since logging began \(4 props\)/);
  assert.match(r.text, /picks that also cleared the 3% value bar: 1-1, won 50\.0% against 55\.0% expected/);
  assert.equal(r.data.scan.nba.day.graded, 3); assert.equal(r.data.scan.nba.toDate.graded, 4);
  assert.match(r.text, /(The model beat the posted line|The posted line was closer than the model) that day/);
});

test('nothing graded yet from the scan log is said plainly, and a league with no logging is left out', () => {
  const r = buildGradingReport({ date: '2026-11-03', scan: { nba: { counts: { total: 277, graded: 0, waiting: 277, setAside: 0 }, graded: [] }, wnba: { counts: { total: 0 }, graded: [] } } });
  assert.match(r.text, /Nothing from .*Nov 3 has been graded yet/); assert.ok(!/WNBA SCAN/.test(r.text));
});

test('a small record is called too small to judge', () => {
  const r = buildGradingReport({ date: '2026-11-03', picks: [pick('2026-11-03', 'WIN')] });
  assert.match(r.text, /cannot separate skill from luck yet/);
  const big = buildGradingReport({ date: '2026-11-03', picks: Array.from({ length: 450 }, (_, i) => pick('2026-11-03', i % 2 ? 'WIN' : 'LOSS')), maxListed: 1 });
  assert.match(big.text, /treat small gaps from 50-52% as noise/);
});

test('hostile or missing fields never break the report', () => {
  const r = buildGradingReport({ date: '2026-11-03', picks: [{ day: '2026-11-03', result: 'WIN' }, { result: 'WIN' }, null && {}].filter(Boolean), scan: { nba: { counts: { total: 3 }, graded: [{ date: '2026-11-03', actual: 5, data: {} }] } } });
  assert.match(r.text, /WIN AI grading report/);
});

test('strength: every pick is shown with its confidence, and the record is split by strength and by expected value', () => {
  const { strengthOf, evTierOf } = require('../lib/report');
  for (const [c, k] of [[88, 'strong'], [70, 'strong'], [69.9, 'solid'], [60, 'solid'], [55, 'fair'], [50, 'fair'], [49.9, 'light'], [29, 'light']]) assert.equal(strengthOf(c).key, k, String(c));
  for (const c of [null, undefined, NaN, '70', Infinity]) assert.equal(strengthOf(c), null, String(c));
  for (const [v, k] of [[0.05, 'value'], [0.03, 'value'], [0.0299, 'small'], [0, 'small'], [-0.01, 'negative']]) assert.equal(evTierOf(v).key, k, String(v));
  assert.equal(evTierOf(null), null);

  const picks = [
    pick('2026-11-03', 'WIN', { player: 'Strong One', confidence: 75, ev: 0.04 }), pick('2026-11-03', 'LOSS', { confidence: 72, ev: 0.01 }),
    pick('2026-11-03', 'WIN', { confidence: 45, ev: -0.02 }), pick('2026-11-02', 'LOSS', { confidence: 62, ev: 0.05 }), pick('2026-11-02', 'WIN'),
  ];
  const r = buildGradingReport({ date: '2026-11-03', picks });
  const c = Object.fromEntries(r.data.strength.confidence.tiers.map(t => [t.key, t]));
  assert.equal(c.strong.day.wins, 1); assert.equal(c.strong.day.losses, 1); assert.equal(c.strong.toDate.n, 2);
  assert.equal(c.solid.day.n, 0); assert.equal(c.solid.toDate.losses, 1); assert.equal(c.light.day.wins, 1);
  assert.equal(r.data.strength.confidence.unrated, 1, 'a pick with no strength is counted but not placed in a band');
  const e = Object.fromEntries(r.data.strength.ev.tiers.map(t => [t.key, t]));
  assert.equal(e.value.toDate.n, 2); assert.equal(e.small.day.losses, 1); assert.equal(e.negative.day.wins, 1);
  const listed = r.data.picks.list.find(p => p.player === 'Strong One');
  assert.equal(listed.strength, 'Strong'); assert.equal(listed.confidence, 75); assert.equal(listed.ev, 0.04);
  for (const s of ['[Strong 75, EV 4.0%]', 'BY STRENGTH', 'Strong 70+: 1-1 (50.0%) that day | 1-1 (50.0%) all picks', 'BY EXPECTED VALUE', 'Value 3%+:']) assert.ok(r.text.includes(s), `missing "${s}"\n${r.text}`);
});

test('strength: with no strength recorded on any pick, the report has no strength section', () => {
  const r = buildGradingReport({ date: '2026-11-03', picks: [pick('2026-11-03', 'WIN')] });
  assert.ok(!r.text.includes('BY STRENGTH')); assert.equal(r.data.picks.list[0].strength, null);
});

test('the same bet logged twice at different lines counts once, as first logged', () => {
  const a = { ...pick('2026-11-03', 'WIN', { player: 'Booker', line: 25.5 }), id: 5 }, b = { ...pick('2026-11-03', 'WIN', { player: 'Booker', line: 24.5 }), id: 9 };
  const c = { ...pick('2026-11-03', 'LOSS', { player: 'Booker', propType: 'assists' }), id: 7 };
  const r = buildGradingReport({ date: '2026-11-03', picks: [b, a, c] });
  assert.equal(r.data.picks.day.n, 2); assert.equal(r.data.picks.toDate.n, 2);
  assert.equal(r.data.picks.list.find(x => x.player === 'Booker' && x.line != null && x.propType === 'points').line, 25.5);
  assert.equal(buildGradingReport({ date: '2026-11-03', picks: [{ ...pick('2026-11-03', 'WIN'), id: 1 }, { ...pick('2026-11-03', 'WIN'), id: 2 }] }).data.picks.day.n, 2, 'different players are different bets');
});

const t3 = (date, player, direction, line, actual, over = {}) => ({ date, league: 'nba', player, propType: 'points', direction, line, actual, confidence: 70, ev: 0.04, ...over });

test('a locked Top 3 pick is graded against the line it was locked at, with pushes and waiting picks kept apart', () => {
  assert.equal(top3Result(t3('d', 'A', 'OVER', 20.5, 24)), 'WIN'); assert.equal(top3Result(t3('d', 'A', 'OVER', 20.5, 18)), 'LOSS');
  assert.equal(top3Result(t3('d', 'A', 'UNDER', 20.5, 18)), 'WIN'); assert.equal(top3Result(t3('d', 'A', 'UNDER', 20.5, 24)), 'LOSS');
  assert.equal(top3Result(t3('d', 'A', 'OVER', 20, 20)), 'PUSH');
  assert.equal(top3Result(t3('d', 'A', 'OVER', 20.5, null)), null); assert.equal(top3Result(null), null);
});

test('the report tracks the Top 3 from the first locked day: that day, all days, what is waiting, and every pick over the same period', () => {
  const top3 = [t3('2026-11-10', 'A', 'OVER', 20.5, 24), t3('2026-11-10', 'B', 'UNDER', 5.5, 7), t3('2026-11-10', 'C', 'OVER', 9.5, null),
    t3('2026-11-11', 'D', 'OVER', 10.5, 12), t3('2026-11-11', 'E', 'OVER', 10.5, 8, { league: 'wnba' }), t3('2026-11-12', 'F', 'OVER', 1.5, 3)];   // the 12th is after the report date
  const picks = [pick('2026-11-09', 'WIN'), pick('2026-11-10', 'LOSS'), pick('2026-11-11', 'WIN')];
  const r = buildGradingReport({ date: '2026-11-11', picks, top3 });
  const d = r.data.top3;
  assert.equal(d.startedOn, '2026-11-10'); assert.equal(d.days, 3, 'nba and wnba on the 11th and nba on the 10th');
  assert.deepEqual([d.toDate.wins, d.toDate.losses, d.toDate.n], [2, 2, 4]); assert.equal(d.waiting, 1);
  assert.deepEqual([d.day.wins, d.day.losses], [1, 1]); assert.equal(d.byLeague.wnba.losses, 1);
  assert.equal(d.restOfPicks.n, 2, 'picks from the 10th on, not the 9th');
  assert.equal(d.list.length, 2); assert.match(r.text, /TOP 3 \(the most confident picks of the day.*tracked since 2026-11-10/); assert.match(r.text, /✓ D OVER 10.5/);
});

test('with no locked Top 3 yet the report says so and nothing breaks', () => {
  const r = buildGradingReport({ date: '2026-11-11', picks: [pick('2026-11-11', 'WIN')] });
  assert.equal(r.data.top3.days, 0); assert.equal(r.data.top3.startedOn, null); assert.match(r.text, /none locked yet/);
});

test('the Top 10 is scored from the same locked list: ranks 1 to 3 are the Top 3, ranks 4 to 10 are extra, and old plays without a rank stay in the Top 3', () => {
  const day = '2026-11-12';
  const ten = Array.from({ length: 10 }, (_, i) => t3(day, `P${i + 1}`, 'OVER', 10.5, i % 2 ? 8 : 14, { rank: i + 1 }));   // odd ranks win, even ranks lose
  const old = t3('2026-11-11', 'Old1', 'OVER', 10.5, 14);                                                                    // locked before ranks existed
  const r = buildGradingReport({ date: day, picks: [], top3: [old, ...ten] });
  assert.equal(r.data.top3.toDate.n, 4, 'the Top 3 is ranks 1 to 3 plus the old day: 4 graded');
  assert.deepEqual([r.data.top3.toDate.wins, r.data.top3.toDate.losses], [3, 1]);
  assert.equal(r.data.top10.toDate.n, 11, 'the Top 10 is all ten plus the old day');
  assert.deepEqual([r.data.top10.toDate.wins, r.data.top10.toDate.losses], [6, 5]);
  assert.equal(r.data.top10.day.n, 10); assert.equal(r.data.top3.day.n, 3);
  assert.deepEqual(r.data.top10.list.map(p => p.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(r.text, /TOP 10 \(the ten most confident picks of the day/); assert.match(r.text, /✓ #1 P1 OVER 10.5/); assert.match(r.text, /✗ #10 P10 OVER 10.5/);
  // waiting picks (no stat yet) are counted as waiting in both, and never as a loss
  const w = buildGradingReport({ date: day, picks: [], top3: [t3(day, 'W1', 'OVER', 10.5, null, { rank: 5 })] });
  assert.equal(w.data.top10.waiting, 1); assert.equal(w.data.top3.waiting, 0); assert.equal(w.data.top10.toDate.n, 0);
});
