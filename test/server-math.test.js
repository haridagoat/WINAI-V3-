// The odds and grading math in server.js and the probability math in lib/projection.js, run exactly as written.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('./helpers/extract');
const { makeProjection } = require('./helpers/projection');
const P = makeProjection();

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

const odds0 = extract({
  functions: ['americanToDecimal', 'calcKellyStake', 'consensusFromLines'],
  globals: {},
});
const odds = { ...odds0, calcOverUnderProbability: P.calcOverUnderProbability, usesCountModel: P.usesCountModel, countPmf: P.countPmf, countOverUnder: P.countOverUnder };

test('american odds convert to decimal odds (implied chances are tested with the market module)', () => {
  near(odds.americanToDecimal(-110), 1.9091, 1e-3);
  near(odds.americanToDecimal(200), 3);
  assert.equal(odds.americanToDecimal(0), null);
  assert.equal(odds.americanToDecimal(null), null);
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

// With no posted line (the Odds API is out of credits) there is no probability. The model-only picks depend on that
// being a plain null that the evaluators tolerate; reading prob.overProbability unguarded crashed every one of them.
test('no posted line means no probability, not an error', () => {
  assert.equal(odds.calcOverUnderProbability(20, 6, null), null);
  assert.equal(odds.calcOverUnderProbability(20, 6, undefined), null);
  assert.equal(odds.calcOverUnderProbability(20, 6, 0), null);
});
test('nothing reads a probability without checking it exists, and both evaluators go through the shared builder', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!/[^?]\bprob\.(over|under)Probability/.test(src), 'prob.overProbability / prob.underProbability must be read as prob?.');
  assert.ok(!/[^?]\bprobs\.(over|under)Probability/.test(src.replace(/const probs = calcOverUnderProbability[^\n]*\n\s*if \(!probs\) return null;[\s\S]*?const modelProb[^\n]*\n/, '')), 'probs may only be read after the null check');
  assert.equal((src.match(/return buildCandidateResult\(/g) || []).length, 2, 'NBA and WNBA evaluators both end in buildCandidateResult');
});

// ── small-count props use a count distribution instead of a bell curve ──
test('only low-count props switch to the count model; points and combos keep the bell curve', () => {
  for (const t of ['3pm', 'steals', 'blocks']) assert.equal(odds.usesCountModel(t, 12), true, t);       // always, whatever the mean
  assert.equal(odds.usesCountModel('rebounds', 3.2), true); assert.equal(odds.usesCountModel('assists', 4.9), true);
  assert.equal(odds.usesCountModel('rebounds', 9), false); assert.equal(odds.usesCountModel('assists', 7), false);
  for (const t of ['points', 'pra', 'pr', 'pa', 'ra', undefined]) assert.equal(odds.usesCountModel(t, 2), false, String(t));
});
test('count distributions sum to 1 and have the requested mean, in all three regimes', () => {
  for (const [mu, v] of [[2.5, 2.5], [2, 4], [3, 2.1], [0.8, 0.5], [1.2, 3]]) {
    const pmf = odds.countPmf(mu, v, 200), sum = pmf.reduce((a, b) => a + b, 0), mean = pmf.reduce((a, p, k) => a + k * p, 0);
    near(sum, 1, 1e-6); near(mean, mu, 0.02 * Math.max(1, mu));
  }
});
test('Poisson: matches the textbook values (mean 2.5)', () => {
  const pmf = odds.countPmf(2.5, 2.5, 100);
  near(pmf[0], 0.082085, 1e-5); near(pmf[2], 0.256516, 1e-5);
  near(pmf[0] + pmf[1] + pmf[2], 0.543813, 1e-5);
  const r = odds.countOverUnder(2.5, Math.sqrt(2.5), 2.5);
  near(r.underProbability, 0.5438, 1e-3); near(r.overProbability, 0.4562, 1e-3);                      // over 2.5 is 3 or more
});
test('negative binomial: mean 2, variance 4 gives .25, .25, .1875 and a fat upper tail', () => {
  const pmf = odds.countPmf(2, 4, 200);
  near(pmf[0], 0.25, 1e-9); near(pmf[1], 0.25, 1e-9); near(pmf[2], 0.1875, 1e-9);
  const wide = odds.countOverUnder(2, 2, 5.5), poisson = odds.countOverUnder(2, Math.sqrt(2), 5.5);
  assert.ok(wide.overProbability > poisson.overProbability);                                           // more spread, more big games
});
test('binomial: mean 3, variance 2.1 is the n=10, p=0.3 distribution, with a thinner tail than Poisson', () => {
  const pmf = odds.countPmf(3, 2.1, 100);
  near(pmf[0], 0.028248, 1e-5); near(pmf[3], 0.266828, 1e-5); near(pmf[0] + pmf[1] + pmf[2] + pmf[3], 0.649611, 1e-5);
  assert.equal(pmf[11], 0);
  assert.ok(odds.countOverUnder(3, Math.sqrt(2.1), 6.5).overProbability < odds.countOverUnder(3, Math.sqrt(3), 6.5).overProbability);
});
test('a whole-number line leaves the push out, so over and under still add to 1', () => {
  const r = odds.countOverUnder(3, Math.sqrt(3), 3);                  // Poisson 3: P(0..2)=.4232, P(3)=.2240, P(4+)=.3528
  near(r.underProbability, 0.4232 / (1 - 0.2240), 2e-3); near(r.overProbability, 0.3528 / (1 - 0.2240), 2e-3);
  near(r.overProbability + r.underProbability, 1, 1e-9);
  const half = odds.countOverUnder(3, Math.sqrt(3), 3.5); near(half.overProbability, 0.3528, 2e-3);
});
test('through the main function: 3-pointers use the count model, points do not, and bad input is still null', () => {
  const direct = odds.countOverUnder(2.4, 1.3, 2.5), via = odds.calcOverUnderProbability(2.4, 1.3, 2.5, '3pm');
  assert.deepEqual(via, direct);
  const bell = odds.calcOverUnderProbability(2.4, 1.3, 2.5);
  assert.deepEqual(odds.calcOverUnderProbability(2.4, 1.3, 2.5, 'points'), bell);                   // unchanged for points
  assert.notDeepEqual(via, bell);
  assert.equal(odds.calcOverUnderProbability(2.4, 1.3, null, '3pm'), null);
  assert.equal(odds.calcOverUnderProbability(0, 1.3, 2.5, '3pm'), null);
  for (const line of [0.5, 1.5, 2.5, 3, 6.5]) { const r = odds.calcOverUnderProbability(1.1, 0.7, line, 'blocks'); near(r.overProbability + r.underProbability, 1, 1e-3); }
});
test('the bell curve misprices low counts: a 0.5 line on a 0.9 projection', () => {
  const bell = odds.calcOverUnderProbability(0.9, 0.55, 0.5), count = odds.calcOverUnderProbability(0.9, 0.55, 0.5, 'blocks');
  assert.ok(count.overProbability > 0.5 && count.overProbability < 1);
  assert.ok(Math.abs(count.overProbability - bell.overProbability) > 0.02, `${count.overProbability} vs ${bell.overProbability}`);
});

// ── player lookup ignores accents ──
test('a player is found whichever way their name is accented', async () => {
  const index = {
    'luka doncic': { id: 1, name: 'Luka Doncic', team: 'Los Angeles Lakers' },
    'kristaps porzingis': { id: 2, name: 'Kristaps Porzingis', team: 'Atlanta Hawks' },
    'nikola jovic': { id: 3, name: 'Nikola Jovic', team: 'Miami Heat' },
    'jaylin williams': { id: 4, name: 'Jaylin Williams', team: 'Oklahoma City Thunder' },
    'jalen williams': { id: 5, name: 'Jalen Williams', team: 'Oklahoma City Thunder' },
  };
  const lookup = extract({
    functions: ['normalizePlayerName', 'resolveNBAPlayer'],
    globals: { nbaPlayerIndex: index, buildNBAPlayerIndex: async () => {} },
  });
  for (const [typed, id] of [['Luka Dončić', 1], ['Luka Doncic', 1], ['luka dončić', 1], ['Kristaps Porziņģis', 2], ['Nikola Jović', 3], ['Jalen Williams', 5], ['Williams Jaylin', 4]])
    assert.equal((await lookup.resolveNBAPlayer(typed))?.id, id, typed);
  assert.equal(await lookup.resolveNBAPlayer('Somebody Else'), null);
  assert.equal(await lookup.resolveNBAPlayer('Williams'), (await lookup.resolveNBAPlayer('Williams')) && (await lookup.resolveNBAPlayer('Williams')), 'a bare surname still resolves to some Williams, as before');
});

// ── the season follows the calendar ──
test('the NBA season is named for the year it starts: October begins a new one', () => {
  const { currentNbaSeason } = extract({ functions: ['currentNbaSeason'] });
  const at = d => currentNbaSeason(new Date(d + 'T12:00:00'));
  assert.equal(at('2026-10-01'), '2026-27'); assert.equal(at('2026-12-31'), '2026-27'); assert.equal(at('2027-02-14'), '2026-27');
  assert.equal(at('2027-09-30'), '2026-27');                         // the off season still points at the season just finished
  assert.equal(at('2027-10-01'), '2027-28'); assert.equal(at('2025-10-22'), '2025-26');
});

// ── slow evaluations are shared, not repeated ──
test('callers who arrive while the model-only evaluation is running share it; a later call runs it again', async () => {
  let calls = 0;
  const lib = extract({ functions: ['computeFallbackProjected'], globals: { fallbackInflight: {}, computeFallbackProjectedOnce: async league => { calls++; await new Promise(r => setTimeout(r, 30)); return { league, n: calls }; } } });
  const five = await Promise.all([1, 2, 3, 4, 5].map(() => lib.computeFallbackProjected('nba')));
  assert.equal(calls, 1); assert.ok(five.every(r => r.n === 1));
  await lib.computeFallbackProjected('nba'); assert.equal(calls, 2);                       // finished, so the next one is a fresh run
  await Promise.all([lib.computeFallbackProjected('nba'), lib.computeFallbackProjected('wnba')]); assert.equal(calls, 4);   // leagues do not share
});
