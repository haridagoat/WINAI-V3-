// How picks get logged: the top three in each game, once, never with a game under way.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('./helpers/extract');
const picksLib = require('../lib/picks');

const NOW = Date.parse('2026-11-04T23:00:00Z'), HOUR = 3600e3;
function world({ inSeason = true } = {}) {
  const w = { entries: [], saved: 0, id: 0, slateScanCache: {} };
  const f = extract({
    functions: ['autoLogSlatePicks', 'logPicksForUnstartedGames'],
    globals: { picksLib, getToday: () => '2026-11-04', loadCLV: () => w.entries, saveCLV: e => { w.entries = e; w.saved++; }, nextId: () => ++w.id, CONFIDENCE_FORMULA_VERSION: 3, console: { log() {}, error() {} },
      slateScanCache: w.slateScanCache, SLATE_LOGIC_VERSION: 3, datachecks: { inSeason: () => inSeason }, Date: Object.assign(function (...a) { return a.length ? new Date(...a) : new Date(NOW); }, { now: () => NOW, UTC: Date.UTC, parse: Date.parse }) },
  });
  return { w, f };
}
const r = (player, ev, game = ['Heat', 'Celtics'], over = {}) => ({ player, propType: 'points', awayTeam: game[0], homeTeam: game[1], team: game[1], opponent: game[0], direction: 'OVER', line: 20.5, book: 'DK', projection: 22, modelProjection: 23, blendedProjection: 21, edge: 1.5, confidence: 60, consensusLine: 21, realEdge: { expectedValue: ev, modelProb: 60, price: -110, fairMarketProb: 50, finalProb: 52 }, ...over });

test('the top three in each game are logged, whatever their value, with the numbers needed to grade and score them', () => {
  const { w, f } = world();
  const rows = [r('A', -0.02), r('B', -0.04), r('C', -0.01), r('D', -0.09), r('X', 0.02, ['Nets', 'Knicks']), r('Y', -0.05, ['Nets', 'Knicks'])];
  assert.equal(f.autoLogSlatePicks('nba', rows), 5);
  assert.deepEqual(w.entries.map(e => e.player).sort(), ['A', 'B', 'C', 'X', 'Y']);
  const e = w.entries.find(x => x.player === 'A');
  assert.equal(e.source, 'auto'); assert.equal(e.verdict, 'OVER'); assert.equal(e.line, 20.5); assert.equal(e.date, '2026-11-04'); assert.equal(e.modelProb, 60); assert.equal(e.price, -110); assert.equal(e.ev, -0.02); assert.equal(e.finalProb, 52); assert.equal(e.blendedProjection, 21);
});

test('logging twice, or logging a game again after news, does not duplicate a pick', () => {
  const { w, f } = world();
  const rows = [r('A', 0.01), r('B', 0.0), r('C', -0.01)];
  assert.equal(f.autoLogSlatePicks('nba', rows), 3); assert.equal(f.autoLogSlatePicks('nba', rows), 0); assert.equal(w.entries.length, 3);
});

test('a line that moves between scans is not a second pick for the same player and prop', () => {
  const { w, f } = world();
  assert.equal(f.autoLogSlatePicks('nba', [r('A', 0.01), r('B', 0.0), r('C', -0.01)]), 3);
  assert.equal(f.autoLogSlatePicks('nba', [r('A', 0.02, undefined, { line: 21.5 }), r('B', 0.0, undefined, { line: 19.5 })]), 0);
  assert.equal(w.entries.length, 3); assert.equal(w.entries.find(e => e.player === 'A').line, 20.5, 'the first line logged is the one kept');
});

test('rows with no price or no side are never logged, and nothing happens with no rows', () => {
  const { w, f } = world();
  assert.equal(f.autoLogSlatePicks('nba', [r('A', NaN), r('B', 0.01, undefined, { direction: null }), { player: 'C' }]), 0);
  assert.equal(f.autoLogSlatePicks('nba', []), 0); assert.equal(f.autoLogSlatePicks('nba', undefined), 0); assert.equal(w.entries.length, 0);
});

test('catching up from the saved scan logs only games that have not started', () => {
  const { w, f } = world();
  const info = { e1: { home: 'Celtics', away: 'Heat', commence: new Date(NOW + 2 * HOUR).toISOString() }, e2: { home: 'Knicks', away: 'Nets', commence: new Date(NOW - HOUR).toISOString() } };
  w.slateScanCache.nba = { dateKey: '2026-11-04', v: 3, data: { eventInfo: info, results: [r('A', 0.01), r('B', 0.0), r('X', 0.05, ['Nets', 'Knicks'])] } };
  assert.equal(f.logPicksForUnstartedGames('nba'), 2);
  assert.deepEqual(w.entries.map(e => e.player).sort(), ['A', 'B'], 'the game already under way is skipped');
});

test('catching up does nothing out of season, for yesterday\'s scan, for an old scoring version, or with no scan', () => {
  for (const [label, cache, opts] of [['no scan', undefined, {}], ['yesterday', { dateKey: '2026-11-03', v: 3, data: { results: [r('A', 0.01)] } }, {}], ['old version', { dateKey: '2026-11-04', v: 2, data: { results: [r('A', 0.01)] } }, {}], ['out of season', { dateKey: '2026-11-04', v: 3, data: { results: [r('A', 0.01)] } }, { inSeason: false }]]) {
    const { w, f } = world(opts); if (cache) w.slateScanCache.nba = cache;
    assert.equal(f.logPicksForUnstartedGames('nba'), 0, label); assert.equal(w.entries.length, 0, label);
  }
});
