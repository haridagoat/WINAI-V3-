// The day's Top 3 is locked once there are three, and stays until the date changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('./helpers/extract');
const { createStore } = require('../lib/db');

const play = (n, conf = 70) => ({ player: n, team: 'T', opponent: 'O', propType: 'points', line: 20.5, direction: 'OVER', confidence: conf, realEdge: { expectedValue: 0.04 } });
const data = (names, extra = {}) => ({ league: 'nba', scanned: 90, evaluated: 80, topPlays: names.map(n => play(n)), ...extra });
function setup(version = 5, store = createStore({ dbPath: ':memory:', log: () => {} })) {
  const f = extract({ functions: ['frozenTopPlays', 'freezeTopPlays', 'parseMeta'], consts: ['TOP3_KEY'], globals: { store, getToday: () => '2026-11-10', SLATE_LOGIC_VERSION: version, console } });
  return { f, store };
}

test('three plays are saved for the day and served back; fewer than three are not', () => {
  const { f } = setup();
  assert.equal(f.freezeTopPlays('nba', data(['A', 'B'])), false); assert.equal(f.frozenTopPlays('nba'), null, 'a partial scan is not locked');
  assert.equal(f.freezeTopPlays('nba', data(['A', 'B', 'C'])), true);
  assert.deepEqual(f.frozenTopPlays('nba').topPlays.map(p => p.player), ['A', 'B', 'C']);
  assert.equal(f.frozenTopPlays('wnba'), null, 'each league has its own list');
});

test('a model-only fallback is never locked', () => { const { f } = setup(); assert.equal(f.freezeTopPlays('nba', data(['A', 'B', 'C'], { fallback: true })), false); assert.equal(f.frozenTopPlays('nba'), null); });

test('yesterday\'s list is not served today, and a new day replaces it', () => {
  const { f } = setup();
  f.freezeTopPlays('nba', data(['A', 'B', 'C']), '2026-11-09');
  assert.equal(f.frozenTopPlays('nba', '2026-11-10'), null);
  assert.deepEqual(f.frozenTopPlays('nba', '2026-11-09').topPlays.map(p => p.player), ['A', 'B', 'C']);
  f.freezeTopPlays('nba', data(['X', 'Y', 'Z']), '2026-11-10');
  assert.deepEqual(f.frozenTopPlays('nba', '2026-11-10').topPlays.map(p => p.player), ['X', 'Y', 'Z']);
});

test('every locked day is kept in a history, one entry per league and day', () => {
  const { f, store } = setup();
  f.freezeTopPlays('nba', data(['A', 'B', 'C']), '2026-11-09'); f.freezeTopPlays('nba', data(['X', 'Y', 'Z']), '2026-11-10'); f.freezeTopPlays('nba', data(['P', 'Q', 'R']), '2026-11-10');
  const h = JSON.parse(store.getMeta('top3:history'));
  assert.equal(h.length, 2); assert.deepEqual(h[0].plays.map(p => p.player), ['P', 'Q', 'R']); assert.equal(h[0].plays[0].confidence, 70);
});

test('a lock made before a change in how lines are read is not served: the day is worked out again', () => {
  const { f: old, store } = setup(4);
  old.freezeTopPlays('nba', data(['Wrong1', 'Wrong2', 'Wrong3']));
  assert.deepEqual(old.frozenTopPlays('nba').topPlays.map(p => p.player), ['Wrong1', 'Wrong2', 'Wrong3']);
  const { f: now } = setup(5, store);                                      // same database, the new scan logic
  assert.equal(now.frozenTopPlays('nba'), null, 'the old lock is not kept');
  now.freezeTopPlays('nba', data(['Right1', 'Right2', 'Right3']));
  assert.deepEqual(now.frozenTopPlays('nba').topPlays.map(p => p.player), ['Right1', 'Right2', 'Right3']);
  assert.equal(JSON.parse(store.getMeta('top3:history')).length, 1, 'and the history still holds one entry for the day');
});

test('all ten plays are kept in the history with their ranks, while the page still gets the Top 3 first', () => {
  const { f, store } = setup();
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const d = data(names.slice(0, 3), { topTen: names.map((n, i) => play(n, 90 - i)) });
  assert.equal(f.freezeTopPlays('nba', d), true);
  const h = JSON.parse(store.getMeta('top3:history'));
  assert.equal(h[0].plays.length, 10); assert.deepEqual(h[0].plays.map(p => p.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(h[0].plays.map(p => p.player), names);
  assert.equal(f.frozenTopPlays('nba').topTen.length, 10);
  assert.equal(f.frozenTopPlays('nba').topPlays.length, 3);
  // a lock that only has the Top 3 (older code) still works and keeps three ranked plays
  const { f: g, store: s2 } = setup();
  assert.equal(g.freezeTopPlays('nba', data(['X', 'Y', 'Z'])), true);
  assert.deepEqual(JSON.parse(s2.getMeta('top3:history'))[0].plays.map(p => p.rank), [1, 2, 3]);
});

test('a lock saved before the Top 10 existed is rebuilt once, so today gets its ten', () => {
  const { f, store } = setup();
  store.setMeta('top3:nba', JSON.stringify({ dateKey: '2026-11-10', v: 5, frozenAt: 'x', data: data(['A', 'B', 'C']) }));   // the old format: no fmt, only three plays
  assert.equal(f.frozenTopPlays('nba'), null, 'an old-format lock is not served');
  const d = data(['A', 'B', 'C'], { topTen: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map(n => play(n)) });
  assert.equal(f.freezeTopPlays('nba', d), true);
  assert.equal(f.frozenTopPlays('nba').topTen.length, 10, 'the rebuilt lock carries all ten');
  assert.equal(JSON.parse(store.getMeta('top3:history')).length, 1, 'and the day still has one history entry');
});
