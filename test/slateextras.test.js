const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSlateExtras, MAX_GAMES } = require('../lib/slateextras');

test('one call answers every game and every team, and each team is asked about once however many games it is in', async () => {
  const oddsCalls = [], rosterCalls = [];
  const out = await buildSlateExtras({
    games: [['A', 'B'], ['C', 'D'], ['A', 'D']],
    fetchOdds: async (a, h) => { oddsCalls.push(`${a}|${h}`); return { available: true, total: 220 + oddsCalls.length }; },
    fetchRoster: async t => { rosterCalls.push(t); return { injured: [{ name: `${t} Player`, status: 'Out' }], players: [] }; },
  });
  assert.deepEqual(Object.keys(out.lines).sort(), ['A|B', 'A|D', 'C|D']);
  assert.equal(out.lines['A|B'].available, true);
  assert.deepEqual(rosterCalls.sort(), ['A', 'B', 'C', 'D'], 'four teams, four roster lookups, not six');
  assert.deepEqual(out.injuries.A, [{ name: 'A Player', status: 'Out' }]);
  assert.equal(oddsCalls[0], 'A|B', 'the first game goes first, to warm the shared schedule cache');
});

test('a lookup that fails or returns nothing useful costs only its own game or team', async () => {
  const out = await buildSlateExtras({
    games: [['A', 'B'], ['C', 'D']],
    fetchOdds: async (a) => { if (a === 'A') throw new Error('feed down'); return { available: true }; },
    fetchRoster: async t => { if (t === 'B') throw new Error('timeout'); if (t === 'C') return null; if (t === 'D') return { error: 'Unknown team', players: [] }; return { injured: [{ name: 'x' }] }; },
  });
  assert.deepEqual(out.lines['A|B'], { available: false }); assert.equal(out.lines['C|D'].available, true);
  assert.deepEqual(out.injuries.A, [{ name: 'x' }]);
  assert.deepEqual([out.injuries.B, out.injuries.C, out.injuries.D], [[], [], []]);
});

test('no games means no lookups and an empty answer', async () => {
  let calls = 0;
  const out = await buildSlateExtras({ games: [], fetchOdds: async () => { calls++; }, fetchRoster: async () => { calls++; } });
  assert.deepEqual(out, { lines: {}, injuries: {} }); assert.equal(calls, 0);
  assert.deepEqual(await buildSlateExtras({ fetchOdds: async () => {}, fetchRoster: async () => {} }), { lines: {}, injuries: {} });
});

test('a day has a ceiling on how many games are looked up', async () => {
  const seen = [];
  const games = Array.from({ length: 50 }, (_, i) => [`A${i}`, `B${i}`]);
  const out = await buildSlateExtras({ games, fetchOdds: async (a, h) => { seen.push(a); return { available: true }; }, fetchRoster: async () => ({ injured: [] }) });
  assert.equal(Object.keys(out.lines).length, MAX_GAMES); assert.equal(seen.length, MAX_GAMES);
});
