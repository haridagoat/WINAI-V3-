const test = require('node:test');
const assert = require('node:assert/strict');
const { topPicksPerGame, flattenPicks, pickRanks, isPickable, rowKey, mostConfident } = require('../lib/picks');

let id = 0;
const row = (player, ev, over = {}) => ({ player, propType: 'points', homeTeam: 'Home', awayTeam: 'Away', direction: 'OVER', confidence: 60, realEdge: { expectedValue: ev }, line: 20.5, ...over, _id: ++id });

test('the three best by expected value in each game, best first', () => {
  const rows = [row('A', -0.05), row('B', 0.02), row('C', -0.01), row('D', -0.09), row('E', 0.01)];
  const picks = topPicksPerGame(rows).get('Away@Home');
  assert.deepEqual(picks.map(p => p.player), ['B', 'E', 'C']);
});

test('every game gets its own three, whatever the expected values are', () => {
  const rows = [...['A', 'B', 'C', 'D'].map((p, i) => row(p, -0.02 * (i + 1))), ...['W', 'X', 'Y', 'Z'].map((p, i) => row(p, -0.07 - 0.01 * i, { homeTeam: 'H2', awayTeam: 'A2' }))];
  const m = topPicksPerGame(rows);
  assert.equal(m.size, 2); assert.equal(m.get('Away@Home').length, 3); assert.equal(m.get('A2@H2').length, 3);
  assert.ok(m.get('A2@H2').every(p => p.realEdge.expectedValue < -0.06), 'a game whose props are all poor value still shows its best three');
});

test('one pick per player: a player with several good props counts once, with his best', () => {
  const rows = [row('A', 0.04, { propType: 'points' }), row('A', 0.05, { propType: 'rebounds' }), row('A', 0.03, { propType: 'assists' }), row('B', 0.01), row('C', 0.0), row('D', -0.01)];
  const picks = topPicksPerGame(rows).get('Away@Home');
  assert.deepEqual(picks.map(p => `${p.player}:${p.propType}`), ['A:rebounds', 'B:points', 'C:points']);
});

test('ties go to the higher confidence, then to a stable order', () => {
  const rows = [row('B', 0.02, { confidence: 50 }), row('A', 0.02, { confidence: 70 }), row('C', 0.02, { confidence: 50 })];
  assert.deepEqual(topPicksPerGame(rows).get('Away@Home').map(p => p.player), ['A', 'B', 'C']);
  assert.deepEqual(topPicksPerGame([...rows].reverse()).get('Away@Home').map(p => p.player), ['A', 'B', 'C'], 'the order does not depend on how the rows arrive');
});

test('rows with no price, no side or a broken number are not picks', () => {
  const bad = [row('A', NaN), row('B', undefined), { player: 'C', homeTeam: 'Home', awayTeam: 'Away', direction: 'OVER' }, row('D', 0.01, { direction: null }), null, undefined, row('E', null)];
  assert.equal(topPicksPerGame(bad).size, 0);
  assert.equal(isPickable(row('F', -0.5)), true, 'a poor but real price is still pickable');
  assert.equal(topPicksPerGame(undefined).size, 0);
});

test('n is respected, and fewer props than n are all shown', () => {
  const rows = ['A', 'B', 'C', 'D', 'E'].map((p, i) => row(p, 0.05 - i * 0.01));
  assert.equal(topPicksPerGame(rows, 2).get('Away@Home').length, 2); assert.equal(topPicksPerGame(rows.slice(0, 2)).get('Away@Home').length, 2);
});

test('flattening and ranks: 1 is the best in its game, and only picks have a rank', () => {
  const rows = [row('A', 0.03), row('B', 0.02), row('C', 0.01), row('D', 0.0), row('X', 0.1, { homeTeam: 'H2', awayTeam: 'A2' })];
  assert.equal(flattenPicks(topPicksPerGame(rows)).length, 4);
  const r = pickRanks(rows);
  assert.equal(r.get(rowKey(rows[0])), 1); assert.equal(r.get(rowKey(rows[2])), 3); assert.equal(r.get(rowKey(rows[3])), undefined); assert.equal(r.get(rowKey(rows[4])), 1);
});

test('the headline Top 3 is the most confident props on the whole slate, one per player, whatever the game or the value', () => {
  const rows = [row('A', 0.01, { confidence: 61 }), row('B', 0.30, { confidence: 55 }), row('C', -0.02, { confidence: 80, homeTeam: 'H2', awayTeam: 'A2' }),
    row('C', 0.05, { confidence: 70, propType: 'rebounds', homeTeam: 'H2', awayTeam: 'A2' }), row('D', 0.02, { confidence: 72, homeTeam: 'H3', awayTeam: 'A3' }), row('E', 0.0, { confidence: 40 })];
  assert.deepEqual(mostConfident(rows).map(p => `${p.player}:${p.confidence}`), ['C:80', 'D:72', 'A:61'], 'highest confidence first, a player once, a big EV does not outrank it');
  assert.deepEqual(mostConfident([...rows].reverse()).map(p => p.player), ['C', 'D', 'A'], 'arrival order does not matter');
  assert.equal(mostConfident(rows, 2).length, 2); assert.deepEqual(mostConfident(undefined), []);
  assert.deepEqual(mostConfident([row('X', 0.1, { confidence: 90, direction: null }), row('Y', undefined, { confidence: 95 }), row('Z', 0.0, { confidence: 50 })]).map(p => p.player), ['Z'], 'unpriced or sideless rows are not picks');
  assert.deepEqual(mostConfident([row('F', 0.05, { confidence: 60 }), row('G', 0.01, { confidence: 60 })]).map(p => p.player), ['F', 'G'], 'equal confidence goes to the higher EV');
});
