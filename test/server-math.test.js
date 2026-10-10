// The projection, odds and grading math in server.js, run exactly as written there.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('./helpers/extract');

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

const odds = extract({
  functions: ['americanToImplied', 'americanToDecimal', 'devigTwoWay', 'calcExpectedValue', 'calcKellyStake', 'consensusFromLines', 'calcOverUnderProbability'],
  globals: { normalCdf: z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; } },
});

test('american odds convert to implied chance and decimal odds', () => {
  near(odds.americanToImplied(-110), 0.5238);
  near(odds.americanToImplied(150), 0.4);
  near(odds.americanToDecimal(-110), 1.9091, 1e-3);
  near(odds.americanToDecimal(200), 3);
  assert.equal(odds.americanToImplied(0), null);
  assert.equal(odds.americanToImplied(null), null);
});

test('devig removes the margin: the two sides sum to 1', () => {
  const d = odds.devigTwoWay(-110, -110);
  near(d.over, 0.5); near(d.under, 0.5);
  const lop = odds.devigTwoWay(-150, 120);
  near(lop.over + lop.under, 1);
  assert.ok(lop.over > lop.under);
});

test('devig falls back to the one side it has', () => {
  const d = odds.devigTwoWay(-150, null);
  near(d.over, 0.6);
  assert.equal(d.under, null);
});

test('expected value per $1: positive when the model beats the price', () => {
  near(odds.calcExpectedValue(0.55, -110), 0.0500, 1e-3);   // 0.55 * 0.909 - 0.45
  near(odds.calcExpectedValue(0.5238, -110), 0, 2e-3);       // exactly the implied chance: break-even
  assert.ok(odds.calcExpectedValue(0.45, -110) < 0);
  assert.equal(odds.calcExpectedValue(null, -110), null);
});

test('Kelly stake is a quarter of full Kelly and never above 5% of bankroll', () => {
  near(odds.calcKellyStake(0.55, -110), 0.0125 * 1.0, 0.0015);   // (0.55*0.909-0.45)/0.909 = 0.055, quarter = 0.0138
  assert.equal(odds.calcKellyStake(0.9, +100), 0.05);            // huge edge hits the cap
  assert.equal(odds.calcKellyStake(0.4, -110), 0);               // no edge, no stake
  assert.equal(odds.calcKellyStake(null, -110), 0);
});

test('over and under probabilities add to 1 and move the right way', () => {
  const a = odds.calcOverUnderProbability(20, 6, 20);
  near(a.overProbability + a.underProbability, 1, 2e-3);
  near(a.overProbability, 0.5, 0.01);
  const lowLine = odds.calcOverUnderProbability(20, 6, 15), highLine = odds.calcOverUnderProbability(20, 6, 25);
  assert.ok(lowLine.overProbability > 0.5 && highLine.overProbability < 0.5);
});

test('probabilities never put mass below zero for low count stats', () => {
  const p = odds.calcOverUnderProbability(0.8, 1.5, 0.5);
  assert.ok(p.overProbability >= 0 && p.overProbability <= 1);
  near(p.overProbability + p.underProbability, 1, 2e-3);
  assert.equal(odds.calcOverUnderProbability(0, 5, 10), null);   // no projection, no answer
});

test('consensus line is the median over line; the softest book is the lowest', () => {
  const c = odds.consensusFromLines({
    A: { Over: { point: 19.5, price: -105 }, Under: { point: 19.5, price: -126 } },
    B: { Over: { point: 20.5, price: -110 } },
    C: { Over: { point: 19.5, price: -115 } },
  });
  assert.equal(c.consensusLine, 19.5);
  assert.equal(c.softestLine, 19.5);
  assert.equal(c.bookCount, 3);
  assert.equal(c.overPrice, -105);
  assert.equal(c.underPrice, -126);
  assert.equal(odds.consensusFromLines({}).consensusLine, null);
});

// ---------- closing-line value and grading ----------
const grade = extract({
  functions: ['toLocalDateStr', 'applyCLV', 'gameDateISO', 'findGameOnDate', 'gradeDateOf', 'findGameForPick', 'gradeStatValue'],
  consts: ['GRADE_COMBO_KEYS', 'GRADE_STAT_KEY'],
});

test('CLV for auto picks is market movement in the pick direction, not softest-book shopping', () => {
  const over = { source: 'auto', verdict: 'OVER', line: 19.5, openConsensus: 20.5, closingLine: 21.5 };
  grade.applyCLV(over);
  assert.equal(over.clv, 1);             // market moved up 1, our over side gained
  assert.equal(over.lineShopGain, 2);    // shopping the soft 19.5 versus the 21.5 close
  const under = { source: 'auto', verdict: 'UNDER', line: 19.5, openConsensus: 20.5, closingLine: 21.5 };
  grade.applyCLV(under);
  assert.equal(under.clv, -1);           // the market moved against an under
});

test('CLV for manual picks compares the posted line to the close', () => {
  const e = { verdict: 'LEAN_UNDER', line: 20, closingLine: 18.5 };
  grade.applyCLV(e);
  assert.equal(e.clv, 1.5);
});

test('CLV does nothing without a closing line or a direction', () => {
  const a = { verdict: 'OVER', line: 20 }; grade.applyCLV(a); assert.equal(a.clv, undefined);
  const b = { verdict: 'PASS', line: 20, closingLine: 22 }; grade.applyCLV(b); assert.equal(b.clv, undefined);
});

test('game dates normalize from both league formats', () => {
  assert.equal(grade.gameDateISO({ date: '2026-10-04T18:00Z' }), '2026-10-04');   // ESPN (WNBA), UTC
  assert.equal(grade.gameDateISO({ date: 'Apr 30, 2026' }), '2026-04-30');         // nba_api, local
  assert.equal(grade.gameDateISO({ date: 'nonsense' }), '');
});

const log = [
  { date: '2026-10-10', opponent: 'Las Vegas Aces', pts: 16 },
  { date: '2026-10-08', opponent: 'Golden State Valkyries', pts: 17 },
  { date: '2026-10-04', opponent: 'Golden State Valkyries', pts: 9 },
];

test('a late WNBA game is found under its UTC date (the bug that left picks ungraded)', () => {
  // tip-off 9:37 PM ET on Oct 9 = 01:37 UTC Oct 10; the log dates it Oct 10
  const pick = { league: 'wnba', date: '2026-10-09', gameStart: '2026-10-10T01:37:00Z', opp: 'Las Vegas Aces' };
  const g = grade.findGameForPick({ gameLog20: log }, pick);
  assert.equal(g.pts, 16);
});

test('a pick with no start time matches the first game against that opponent after it was logged', () => {
  const pick = { league: 'wnba', date: '2026-10-05', savedAt: '2026-10-05T20:32:23Z', opp: 'Golden State Valkyries' };
  const g = grade.findGameForPick({ gameLog20: log }, pick);
  assert.equal(g.date, '2026-10-08');   // not the Oct 4 game, which was before the pick
  assert.equal(g.pts, 17);
});

test('the opponent fallback does not reach past five days or guess when a start time exists', () => {
  const far = { league: 'wnba', date: '2026-09-20', savedAt: '2026-09-20T12:00:00Z', opp: 'Golden State Valkyries' };
  assert.equal(grade.findGameForPick({ gameLog20: log }, far), null);
  const timed = { league: 'wnba', date: '2026-10-05', gameStart: '2026-10-06T00:00:00Z', savedAt: '2026-10-05T20:00:00Z', opp: 'Golden State Valkyries' };
  assert.equal(grade.findGameForPick({ gameLog20: log }, timed), null);   // trust the start time, find nothing
});

test('NBA picks match on the local date', () => {
  const nbaLog = [{ date: 'Apr 30, 2026', opponent: 'BOS @ PHI', pts: 17 }];
  const g = grade.findGameForPick({ gameLog20: nbaLog }, { league: 'nba', date: '2026-04-30', opp: 'Philadelphia 76ers' });
  assert.equal(g.pts, 17);
});

test('combo props add their parts', () => {
  const g = { pts: 20, reb: 5, ast: 7, fg3m: 3 };
  assert.equal(grade.gradeStatValue(g, 'pra'), 32);
  assert.equal(grade.gradeStatValue(g, 'pr'), 25);
  assert.equal(grade.gradeStatValue(g, 'rebounds'), 5);
  assert.equal(grade.gradeStatValue(g, '3pm'), 3);
});
