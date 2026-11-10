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
