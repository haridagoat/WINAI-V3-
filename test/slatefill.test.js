const test = require('node:test');
const assert = require('node:assert');
const { eventsDueForFill, eventInfoFrom } = require('../lib/slatefill');

const NOW = Date.parse('2026-10-30T15:00:00Z');
const H = 3600 * 1000;
const opts = { gapMs: 40 * 60 * 1000, windowMs: 8 * H, tries: 8 };
const ev = (id, hoursAway, home = 'H' + id, away = 'A' + id) => ({ id, home_team: home, away_team: away, commence_time: new Date(NOW + hoursAway * H).toISOString() });
const ids = list => list.map(e => e.id);

test('a game with no props that tips off soon is due', () => {
  assert.deepStrictEqual(ids(eventsDueForFill([ev('a', 4)], { a: { count: 0, attempts: 1, lastTry: NOW - H } }, null, NOW, opts)), ['a']);
});
test('a game that already has props is left alone', () => {
  assert.deepStrictEqual(eventsDueForFill([ev('a', 4)], { a: { count: 9, attempts: 1, lastTry: NOW - H } }, null, NOW, opts), []);
});
test('a game that has started is left alone', () => {
  assert.deepStrictEqual(eventsDueForFill([ev('a', -1)], {}, null, NOW, opts), []);
});
test('a game further out than the window is not asked yet', () => {
  assert.deepStrictEqual(eventsDueForFill([ev('a', 12)], { a: { count: 0, attempts: 1, lastTry: NOW - H } }, null, NOW, opts), []);
});
test('a game asked less than the gap ago waits', () => {
  assert.deepStrictEqual(eventsDueForFill([ev('a', 4)], { a: { count: 0, attempts: 1, lastTry: NOW - 10 * 60 * 1000 } }, null, NOW, opts), []);
});
test('a game stops being asked after the try limit', () => {
  assert.deepStrictEqual(eventsDueForFill([ev('a', 4)], { a: { count: 0, attempts: 8, lastTry: NOW - 2 * H } }, null, NOW, opts), []);
});
test('an old scan without per-game records does not re-ask a game that has props in it', () => {
  const have = new Set(['A1@H1']);
  assert.deepStrictEqual(ids(eventsDueForFill([ev('1', 4), ev('2', 4)], {}, have, NOW, opts)), ['2']);
});
test('eventInfoFrom adds up attempts and props across top-ups', () => {
  const first = eventInfoFrom([{ id: 'a', home: 'H', away: 'A', commence: 'x', count: 0, ok: true }], {}, 100);
  assert.deepStrictEqual(first.a, { home: 'H', away: 'A', commence: 'x', count: 0, attempts: 1, lastTry: 100, ok: true });
  const second = eventInfoFrom([{ id: 'a', home: 'H', away: 'A', commence: 'x', count: 14, ok: true }], first, 200);
  assert.strictEqual(second.a.count, 14);
  assert.strictEqual(second.a.attempts, 2);
  assert.strictEqual(second.a.lastTry, 200);
});

const { balanceCandidates } = require('../lib/slatefill');
const cand = (player, propType, line, extra = {}) => ({ player, propType, line, bookCount: 3, ...extra });
const feedOrder = () => {            // the feed lists every points prop, then assists, then rebounds
  const rows = [];
  for (const t of ['points', 'assists', 'rebounds']) for (let i = 0; i < 12; i++) rows.push(cand(`${i < 6 ? 'H' : 'A'}${i}`, t, 30 - i));
  return rows;
};
const teamOf = name => name[0] === 'H' ? 'Home' : 'Away';
const countBy = (rows, f) => rows.reduce((m, r) => (m[f(r)] = (m[f(r)] || 0) + 1, m), {});

test('balancing: every stat gets a share even when the feed lists one stat first', () => {
  const kept = balanceCandidates(feedOrder(), 20, teamOf);
  assert.strictEqual(kept.length, 20);
  assert.deepStrictEqual(countBy(kept, r => r.propType), { points: 7, rebounds: 7, assists: 6 });
});
test('balancing: both teams are kept inside each stat', () => {
  const kept = balanceCandidates(feedOrder(), 20, teamOf);
  for (const t of ['points', 'rebounds', 'assists']) {
    const c = countBy(kept.filter(r => r.propType === t), r => teamOf(r.player));
    assert.ok(Math.abs(c.Home - c.Away) <= 1, `${t} is split between the teams: ${JSON.stringify(c)}`);
  }
});
test('balancing: bigger lines are kept first inside a stat and team', () => {
  const kept = balanceCandidates([cand('H1', 'points', 10), cand('H2', 'points', 30), cand('H3', 'points', 20)], 2);
  assert.deepStrictEqual(kept.map(r => r.player), ['H2', 'H3']);
});
test('balancing: a stat with few props hands its spare slots to the others', () => {
  const rows = [...Array.from({ length: 10 }, (_, i) => cand('P' + i, 'points', 20 - i)), cand('R1', 'rebounds', 8), ...Array.from({ length: 10 }, (_, i) => cand('A' + i, 'assists', 9 - i))];
  const kept = balanceCandidates(rows, 12);
  assert.strictEqual(kept.length, 12);
  assert.strictEqual(countBy(kept, r => r.propType).rebounds, 1);
  assert.deepStrictEqual(countBy(kept, r => r.propType), { points: 6, rebounds: 1, assists: 5 });
});
test('balancing: without a team lookup only the stats are balanced, and a short list is returned whole', () => {
  assert.deepStrictEqual(countBy(balanceCandidates(feedOrder(), 9), r => r.propType), { points: 3, rebounds: 3, assists: 3 });
  const few = [cand('X', 'points', 5)];
  assert.deepStrictEqual(balanceCandidates(few, 20), few);
  assert.deepStrictEqual(balanceCandidates(undefined, 20), []);
});
test('balancing: an unknown team does not drop a player', () => {
  const kept = balanceCandidates(feedOrder(), 20, name => name === 'H0' ? undefined : teamOf(name));
  assert.strictEqual(kept.length, 20);
});
