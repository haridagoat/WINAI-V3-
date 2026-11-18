// The per-prop assessment (assessProp, buildRealEdge from server.js; blendWithMarket, missingProductionShare and the probability math from lib/projection.js), run exactly as written.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('./helpers/extract');
const market = require('../lib/market');
const params = require('../lib/params');
const { makeProjection } = require('./helpers/projection');
const P = makeProjection();

params.load();
let calibrationModel = null;
const S0 = extract({
  functions: ['americanToDecimal', 'calcKellyStake', 'assessProp', 'buildRealEdge', 'rederiveResult'],
  consts: ['pct1', 'round3'],
  globals: { calcEdgeScore: P.calcEdgeScore, normalCdf: P.normalCdf, market, modelParams: params, get calibrationModel() { return calibrationModel; }, calibrate: p => p, calcOverUnderProbability: P.calcOverUnderProbability, usesCountModel: P.usesCountModel, countPmf: P.countPmf, countOverUnder: P.countOverUnder, blendWithMarket: P.blendWithMarket, calcEdgeScore: P.calcEdgeScore, missingProductionShare: P.missingProductionShare, baselineAbsenceWeight: () => 1 },
});
const S = { ...S0, calcOverUnderProbability: P.calcOverUnderProbability, usesCountModel: P.usesCountModel, countPmf: P.countPmf, countOverUnder: P.countOverUnder, blendWithMarket: P.blendWithMarket, calcEdgeScore: P.calcEdgeScore, missingProductionShare: P.missingProductionShare };
const book = (point, over, under) => ({ Over: { point, price: over }, Under: { point, price: under } });
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

test('with an even market the final chance stays near the market, however high the model is', () => {
  const books = { A: book(22.5, -110, -110), B: book(22.5, -110, -110), C: book(22.5, -108, -112), D: book(22.5, -112, -108) };
  const a = S.assessProp({ propType: 'points', rawProjection: 30, sd: 7, books });
  assert.ok(a.over.modelProb > 0.8, 'the raw model is very bullish');
  assert.ok(a.over.prob < 0.56, `final chance ${a.over.prob} should barely move off 50%`);
  assert.ok(a.over.prob > a.over.marketProb, 'but it does lean the model\'s way');
  assert.ok(a.best.ev < 0.05, 'so no large EV appears from the model alone');
});

test('price shopping is the real edge: a soft price on an even market gives positive EV', () => {
  const books = { Sharp1: book(22.5, -110, -110), Sharp2: book(22.5, -110, -110), Soft: book(22.5, 115, -140) };
  const a = S.assessProp({ propType: 'points', rawProjection: 22.5, sd: 7, books });
  assert.equal(a.over.book, 'Soft'); assert.equal(a.over.price, 115);
  assert.ok(a.over.ev > 0.02, `EV ${a.over.ev} at +115 on a near-fair coin`);   // the soft book is part of the consensus too, so not the full 7.5%
  assert.equal(a.best.side, 'over');
});

test('each side is priced at its own best number: lowest Over line, highest Under line', () => {
  const books = { A: book(21.5, -125, 105), B: book(23.5, 105, -125), C: book(22.5, -110, -110) };
  const a = S.assessProp({ propType: 'points', rawProjection: 22.5, sd: 7, books });
  assert.equal(a.over.line, 21.5); assert.equal(a.under.line, 23.5);
  assert.ok(a.over.marketProb > 0.5 && a.under.marketProb > 0.5, 'both sides are better than a coin flip at their own numbers');
});

test('the call is the side the projection leans; the better price is kept separately as value', () => {
  const books = { A: book(22.5, -105, -115), B: book(22.5, -125, 105) };
  const a = S.assessProp({ propType: 'points', rawProjection: 25, sd: 7, books });
  assert.equal(a.lean, 'over'); assert.equal(a.best.side, 'over', 'a projection above the books\' line is an OVER call');
  assert.equal(a.value.side, a.over.ev >= a.under.ev ? 'over' : 'under');
  const down = S.assessProp({ propType: 'points', rawProjection: 20, sd: 7, books });
  assert.equal(down.lean, 'under'); assert.equal(down.best.side, 'under');
});

test('Nov 17: a projection well above the line stays an OVER even when the under has the better price', () => {
  // Three books at 36.5 and one at 37.5 whose under is priced kindly: shopping for the under's best number gives it the better expected value,
  // but the model projects 41.6. The old rule called this UNDER, 5 points the wrong side of its own projection.
  const books = { A: book(36.5, -125, -105), B: book(36.5, -125, -105), C: book(36.5, -125, -105), D: book(37.5, 110, -115) };
  const a = S.assessProp({ propType: 'points', rawProjection: 41.6, sd: 8.5, books });
  assert.equal(a.lean, 'over');
  assert.equal(a.best.side, 'over', 'the call follows the projection');
  assert.equal(a.value.side, 'under', 'while the better price is on the under');
  assert.ok(a.best.ev < 0 && a.value.ev < 0, 'neither side has a price edge, and that is shown as it is');
  assert.ok(a.best.ev < a.value.ev, 'the call gives up a little on price, which the page reports as EV and does not hide');
  assert.ok(41.6 - a.best.line > 0, 'so the edge column and the call point the same way');
});

test('the call and the edge never point opposite ways, for any books and any projection', () => {
  let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let n = 0;
  for (let i = 0; i < 2000; i++) {
    const line = 5 + Math.floor(rnd() * 40) + 0.5, nb = 2 + Math.floor(rnd() * 5), books = {};
    for (let b = 0; b < nb; b++) { const pt = line + Math.round((rnd() - 0.5) * 2) * 0.5; const o = -(100 + Math.floor(rnd() * 40)), u = -(100 + Math.floor(rnd() * 40)); books['B' + b] = book(pt, o, u); }
    const proj = line + (rnd() - 0.5) * 12; if (proj <= 0) continue;
    const a = S.assessProp({ propType: 'points', rawProjection: proj, sd: 6, books }); if (!a || !a.lean) continue; n++;
    const edge = proj - a.best.line;
    assert.equal(a.best.side, a.lean);
    assert.ok(a.lean === 'over' ? edge > 0 : edge < 0, `lean ${a.lean}, projection ${proj}, call line ${a.best.line}`);
  }
  assert.ok(n > 1500);
});

test('a whole-number line carries a push chance and EV is scaled by it', () => {
  const books = { A: book(2, -120, 100), B: book(2, -115, -105) };
  const a = S.assessProp({ propType: '3pm', rawProjection: 2.4, sd: 1.76, books });
  assert.ok(a.over.push > 0.15, `push chance ${a.over.push}`);
  const noPush = market.expectedValue(a.over.prob, a.over.price, 0);
  assert.ok(Math.abs(a.over.ev) < Math.abs(noPush) + 1e-9 || a.over.ev < noPush, 'a push refunds the stake, which shrinks EV toward zero');
});

test('no usable books: nothing is invented', () => {
  assert.equal(S.assessProp({ propType: 'points', rawProjection: 20, sd: 6, books: null }), null);
  assert.equal(S.assessProp({ propType: 'points', rawProjection: 20, sd: 6, books: {} }), null);
  assert.equal(S.assessProp({ propType: 'points', rawProjection: 0, sd: 6, books: { A: book(20.5, -110, -110) } }), null);
});

test('with a single book the market chance is that book\'s own devigged chance', () => {
  const a = S.assessProp({ propType: 'points', rawProjection: 20.5, sd: 6.5, books: { A: book(20.5, -130, 110) } });
  near(a.over.marketProb, market.devigPower(market.impliedFromAmerican(-130), market.impliedFromAmerican(110)).over, 1e-6);
  assert.equal(a.over.books, 1);
});

test('the real-edge record carries every number the page shows, and EV agrees with the final chance', () => {
  const a = S.assessProp({ propType: 'points', rawProjection: 24, sd: 7, books: { A: book(22.5, -110, -110), B: book(22.5, 105, -125) } });
  const re = S.buildRealEdge(a.best);
  for (const k of ['price', 'modelProb', 'fairMarketProb', 'finalProb', 'breakEvenProb', 'probEdge', 'expectedValue', 'kellyStake', 'bookCount', 'pushProbability']) assert.ok(k in re, k);
  near(re.expectedValue, market.expectedValue(a.best.prob, a.best.price, a.best.push), 1e-9);
  near(re.probEdge, parseFloat(((a.best.prob - market.impliedFromAmerican(a.best.price)) * 100).toFixed(1)), 0.11);
  assert.equal(re.calibrated, false);
  assert.ok(re.modelProb > re.finalProb || re.modelProb < re.finalProb, 'raw model chance and final chance are kept apart');
});

test('the projection stays the model\'s own; the market-blended estimate rides alongside, mostly the market', () => {
  const mp = { projection: 30, stdDev: 6, drivers: [], confidence: 60 };
  const b = S.blendWithMarket(mp, 20, 6, 'points');
  assert.equal(b.projection, 30, 'the headline projection is untouched');
  assert.deepEqual(b.drivers, [], 'no driver is invented: the drivers still add up to the projection shown');
  assert.ok(b.marketBlendProjection < 21.5 && b.marketBlendProjection > 20, `got ${b.marketBlendProjection}`);
  assert.ok(b.marketBlend.weight >= 0.85 && b.marketBlend.bookCount === 6);
  const one = S.blendWithMarket(mp, 20, 1, 'points'); assert.ok(one.marketBlendProjection > b.marketBlendProjection, 'with one book the model keeps a little more say');
  assert.equal(S.blendWithMarket(mp, null, 6, 'points'), mp); assert.equal(S.blendWithMarket(mp, 20, 0, 'points'), mp);
  const close = S.blendWithMarket({ projection: 20.02, stdDev: 6, drivers: [] }, 20, 6, 'points'); assert.equal(close.marketBlendProjection, 20, 'the blend is attached even when the two agree');
});

test('missing production share: counts only regular rotation players, half for questionable, and refuses thin data', () => {
  const row = (name, gp, min, pts, reb, ast) => ({ PLAYER_NAME: name, GP: gp, MIN: min * gp, PTS: pts * gp, REB: reb * gp, AST: ast * gp, FG3M: 2 * gp, STL: gp, BLK: gp });
  const rows = [row('Star One', 10, 34, 28, 6, 6), row('Reg Two', 10, 30, 16, 5, 3), row('Reg Three', 10, 28, 14, 7, 2), row('Reg Four', 10, 26, 12, 4, 4), row('Reg Five', 10, 24, 10, 3, 5), row('Bench Six', 10, 12, 4, 2, 1)];
  const roster = { players: rows.slice(1).map(r => ({ name: r.PLAYER_NAME })), injured: [] };
  const out = S.missingProductionShare(roster, [{ name: 'Star One', status: 'Out' }], rows, {});
  assert.equal(out.regularsCount, 5, 'bench player is not a regular');
  near(out.share.PTS, 28 / (28 + 16 + 14 + 12 + 10), 1e-6);
  const q = S.missingProductionShare(roster, [{ name: 'Star One', status: 'Questionable' }], rows, {});
  near(q.share.PTS, out.share.PTS / 2, 1e-6);
  const fullRoster = { players: rows.map(r => ({ name: r.PLAYER_NAME })), injured: [] };
  const benchOut = S.missingProductionShare(fullRoster, [{ name: 'Bench Six', status: 'Out' }], rows, {}); assert.equal(benchOut.missing.length, 0, 'a bench player being out does not count');
  assert.equal(S.missingProductionShare({ players: roster.players.slice(0, 2) }, [], rows, {}), null, 'too few regulars to trust');
  assert.equal(S.missingProductionShare(roster, [], [], {}), null);
});

// ── late news ──
const L = extract({ functions: ['injurySig', 'describeInjuryChange'], globals: {} });
test('injury signature lists only players who may miss the game, sorted and lower-cased', () => {
  const sig = L.injurySig({ injured: [{ name: 'B Player', status: 'Out' }, { name: 'A Player', status: 'Questionable' }, { name: 'C Player', status: 'Active' }, { name: 'D Player', status: 'Day-To-Day' }] });
  assert.deepEqual(Array.from(sig), ['A Player:questionable', 'B Player:out']);
  assert.deepEqual(Array.from(L.injurySig(null)), []);
});
test('an injury change is described in words, both ways', () => {
  assert.equal(L.describeInjuryChange(['A:questionable'], ['A:out', 'B:out']), 'A out, B out');
  assert.equal(L.describeInjuryChange(['A:out'], []), 'A cleared');
  assert.equal(L.describeInjuryChange(['A:out'], ['A:out']), '');
});

// ── no pick is not a failed scan ──
test('"no pick cleared the value bar" is never mistaken for a failed scan (which switches the page to model-only mode)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  const teamPicks = src.slice(src.indexOf("app.get('/api/team-picks'"), src.indexOf("app.get('/api/team-picks'") + 1200);
  assert.match(teamPicks, /data\.scanned === 0/, 'a scan has failed only when nothing at all was scanned');
  assert.ok(!/!data\.games\.length\) scanFailed/.test(teamPicks), 'zero qualifying games must not trigger the fallback');
  const fn = src.slice(src.indexOf('async function computeTeamPicks'), src.indexOf('async function computeTeamPicks') + 2200);
  assert.match(fn, /scanned: \(candidates \|\| \[\]\)\.length/);
});

test('a scan saved under the old side rule is moved to the projection rule from what each row already carries', () => {
  // Jaden McDaniels points, Nov 17: books at 16.5 (one at 15.5), the model projects 17.1. The saved row said UNDER 16.5 at DraftKings.
  const row = { player: 'Jaden McDaniels', propType: 'points', line: 16.5, book: 'DraftKings', direction: 'UNDER', modelProjection: 17.1, projection: 17.1, consensusLine: 16.5,
    scan: { modelProjection: 17.1, sd: 6.2, books: [['FanDuel', 16.5, -112, -118], ['DraftKings', 16.5, -108, -110], ['BetMGM', 15.5, -125, 100], ['BetRivers', 16.5, -115, -115], ['BetOnline.ag', 16.5, -110, -120], ['Bovada', 16.5, -110, -120]],
      best: { side: 'under', line: 16.5, price: -110, prob: 0.5, ev: -0.029 } } };
  assert.equal(S.rederiveResult(row), true);
  assert.equal(row.direction, 'OVER', 'the call follows the projection');
  assert.ok(row.edge > 0, 'so the edge points the same way');
  assert.equal(row.line, 15.5); assert.equal(row.book, 'BetMGM');            // the best Over number within a point of the books
  assert.ok(['OVER', 'UNDER'].includes(row.priceSide) && Number.isFinite(row.priceEv));
  assert.equal(row.scan.best.side, row.priceSide.toLowerCase(), 'the value-pick record points at the better price, whichever side that is');
  assert.equal(row.scan.best.ev, row.priceEv); assert.ok(row.scan.best.ev >= row.scan.call.ev, 'and the better price is never worse than the call\'s');
  assert.equal(row.scan.call.side, 'over');
  assert.ok(row.realEdge && Number.isFinite(row.realEdge.expectedValue) && row.realEdge.price === -125);
  near(row.overProbability + row.underProbability + (row.pushProbability || 0), 1, 1e-6);
  // rows without what is needed are left alone
  const bare = { player: 'X', propType: 'points', line: 10.5, direction: 'OVER' };
  assert.equal(S.rederiveResult(bare), false); assert.deepEqual(bare, { player: 'X', propType: 'points', line: 10.5, direction: 'OVER' });
  assert.equal(S.rederiveResult(null), false);
});
