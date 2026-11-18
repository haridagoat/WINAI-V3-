const test = require('node:test');
const assert = require('node:assert/strict');
const { lockedTopPlays, lockedTeamPicks, lockedBoard } = require('../lib/plangate');

const play = (player, line = 24.5) => ({ player, playerId: 123, team: 'Knicks', opponent: 'Raptors', propType: 'points', line, book: 'FanDuel', direction: 'OVER', projection: 27.1, confidence: 80, realEdge: { price: -115, expectedValue: -0.04 } });
const SECRET = ['Jalen Brunson', 'Karl-Anthony Towns', 'Josh Hart', 'Mikal Bridges', 'OG Anunoby'];

test('a free account gets the first top pick and nothing about the rest', () => {
  const data = { league: 'nba', generatedAt: 'x', scanned: 99, topPlays: [play('Luka Doncic', 35.5), play(SECRET[0], 26.5), play(SECRET[1], 12.5)],
    topTen: [play('Luka Doncic', 35.5), play(SECRET[0], 26.5), play(SECRET[1], 12.5), play(SECRET[2], 5.5), play(SECRET[3], 18.5), play(SECRET[4], 15.5)], frozen: true };
  const before = JSON.stringify(data);
  const out = lockedTopPlays(data);
  assert.equal(out.topPlays[0].player, 'Luka Doncic'); assert.equal(out.topPlays[0].line, 35.5);
  assert.deepEqual(out.topPlays.slice(1), [{ locked: true, rank: 2 }, { locked: true, rank: 3 }]);
  assert.deepEqual(out.topTen, []); assert.deepEqual(out.locked, { shown: 1, hidden: 5 });
  assert.equal(out.league, 'nba'); assert.equal(out.frozen, true); assert.equal(out.scanned, 99);
  const wire = JSON.stringify(out);
  for (const s of SECRET) assert.ok(!wire.includes(s), `${s} must not be in what is sent`);
  assert.ok(!wire.includes('26.5') && !wire.includes('12.5'), 'nor the locked lines');
  assert.equal(JSON.stringify(data), before, 'the shared list is not changed');
});

test('the model-only fallback picks are locked the same way', () => {
  const out = lockedTopPlays({ league: 'nba', fallback: true, topPlays: [], fallbackPlays: [play('Free Pick', null), play(SECRET[0], null), play(SECRET[1], null)] });
  assert.equal(out.fallbackPlays[0].player, 'Free Pick'); assert.deepEqual(out.fallbackPlays.slice(1), [{ locked: true, rank: 2 }, { locked: true, rank: 3 }]);
  assert.ok(!JSON.stringify(out).includes(SECRET[0]));
});

test('with fewer picks than the free allowance, or none, nothing breaks and nothing extra is hidden', () => {
  assert.deepEqual(lockedTopPlays({ topPlays: [play('Only One')] }).locked, { shown: 1, hidden: 0 });
  const empty = lockedTopPlays({ topPlays: [], scanned: 0 }); assert.deepEqual(empty.topPlays, []); assert.deepEqual(empty.locked, { shown: 0, hidden: 0 });
  assert.equal(lockedTopPlays(null), null); assert.equal(lockedTopPlays(undefined), undefined);
  assert.deepEqual(lockedTopPlays({ topPlays: [play('A'), play('B')] }, { shown: 0 }).topPlays, [{ locked: true, rank: 1 }, { locked: true, rank: 2 }]);
});

test('each game keeps its teams and loses every pick', () => {
  const data = { league: 'nba', generatedAt: 'x', scanned: 60, games: [
    { home: 'Boston Celtics', away: 'Orlando Magic', picks: [{ rank: 1, player: SECRET[0], line: 26.5, realEdge: {} }, { rank: 2, player: SECRET[1] }, { rank: 3, player: SECRET[2] }], extra: 'internal' },
    { home: 'Denver Nuggets', away: 'Phoenix Suns', picks: [] }] };
  const before = JSON.stringify(data), out = lockedTeamPicks(data);
  assert.deepEqual(out.games[0], { home: 'Boston Celtics', away: 'Orlando Magic', picks: [{ locked: true, rank: 1 }, { locked: true, rank: 2 }, { locked: true, rank: 3 }] });
  assert.deepEqual(out.games[1].picks, []); assert.equal(out.locked, true); assert.equal(out.scanned, 60);
  const wire = JSON.stringify(out); for (const s of SECRET) assert.ok(!wire.includes(s)); assert.ok(!wire.includes('internal') && !wire.includes('26.5'));
  assert.equal(JSON.stringify(data), before);
  assert.deepEqual(lockedTeamPicks({ games: undefined }).games, []);
});

test('the prop board is just a count', () => {
  const rows = [play(SECRET[0]), play(SECRET[1]), play(SECRET[2])];
  const out = lockedBoard(rows, { league: 'nba', date: '2026-11-18', scanned: 99 });
  assert.deepEqual(out, { props: [], locked: true, total: 3, league: 'nba', date: '2026-11-18', scanned: 99 });
  const wire = JSON.stringify(out); for (const s of SECRET.slice(0, 3)) assert.ok(!wire.includes(s));
  assert.equal(lockedBoard(null).total, 0);
});
