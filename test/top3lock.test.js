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
