const test = require('node:test');
const assert = require('node:assert/strict');
const lab = require('../lib/lab');

// A tiny seeded random source so the synthetic league is the same every run.
const rng = seed => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

// Two teams play each other every second day. Team 1's star scores 20 and is out 25% of the time; when he is out the others score
// `lift` x his share more. Everything else is noise around fixed levels.
function league({ games = 120, lift = 0.5, seed = 7 } = {}) {
  const r = rng(seed), teamRows = [], playerRows = [];
  const star = { id: 1, base: 20 }, others = [2, 3, 4, 5, 6, 7, 8].map(id => ({ id, base: 10 })), foes = [11, 12, 13, 14, 15, 16, 17].map(id => ({ id, base: 10 }));
  const share = star.base / (star.base + others.length * 10);                // the star's share of the team's regular production
  for (let g = 0; g < games; g++) {
    const date = new Date(Date.UTC(2025, 9, 20 + g * 2)).toISOString().slice(0, 10), gameId = String(1000 + g);
    const starOut = g >= 12 && r() < 0.25;
    teamRows.push({ TEAM_ID: 1, GAME_ID: gameId, GAME_DATE: date, MATCHUP: 'AAA vs. BBB', WL: 'W', PTS: 100, PLUS_MINUS: 2 }, { TEAM_ID: 2, GAME_ID: gameId, GAME_DATE: date, MATCHUP: 'BBB @ AAA', WL: 'L', PTS: 98, PLUS_MINUS: -2 });
    const line = (p, teamId, pts, min = 30) => playerRows.push({ PLAYER_ID: p.id, PLAYER_NAME: 'P' + p.id, TEAM_ID: teamId, GAME_ID: gameId, GAME_DATE: date, MIN: min, PTS: pts, REB: 5, AST: 3, FG3M: 1, STL: 1, BLK: 1 });
    if (!starOut) line(star, 1, star.base + (r() - 0.5) * 6);
    for (const o of others) line(o, 1, o.base * (1 + (starOut ? lift * share : 0)) + (r() - 0.5) * 3);
    for (const f of foes) line(f, 2, f.base + (r() - 0.5) * 3);
  }
  return { teamRows, playerRows, share };
}

test('team context: home flag, rest days and a spread stand-in come from the results alone', () => {
  const { teamRows } = league({ games: 30 });
  const info = lab.prepareTeams(teamRows);
  const first = info.get('1000|1'), later = info.get('1020|1');
  assert.equal(first.home, true); assert.equal(first.rest, 7);                // no earlier game: treated as well rested
  assert.equal(later.rest, 2);                                                // games every other day
  assert.ok(typeof later.expMargin === 'number' && isFinite(later.expMargin));
});

test('predictions never use a game that has not been played yet', () => {
  const games = Array.from({ length: 40 }, (_, i) => ({ PTS: 10 + (i % 5), MIN: 30 }));
  const base = lab.walkLevels(games, 'PTS', { halfLife: 6, lambda: 0.7 });
  const future = games.map((g, i) => (i >= 25 ? { ...g, PTS: 999 } : g));      // change what happens from game 25 on
  const changed = lab.walkLevels(future, 'PTS', { halfLife: 6, lambda: 0.7 });
  for (let i = 0; i < base.length; i++) if (base[i].i <= 25) assert.equal(changed[i].pred, base[i].pred, `game ${base[i].i} saw the future`);
  assert.ok(base[0].i >= 10, 'predictions start only after a minimum history');
});

test('a decayed average follows a level shift faster than the season mean', () => {
  const games = [...Array.from({ length: 30 }, () => ({ PTS: 10, MIN: 30 })), ...Array.from({ length: 10 }, () => ({ PTS: 20, MIN: 30 }))];
  const rows = lab.walkLevels(games, 'PTS', { halfLife: 3, lambda: 1 }), last = rows[rows.length - 1];
  assert.ok(last.ewma > last.seasonMean + 2);
});

test('the lab recovers a known teammate-out effect from games where the star is missing', () => {
  const { teamRows, playerRows, share } = league({ games: 220, lift: 0.5 });
  const info = lab.prepareTeams(teamRows), players = lab.preparePlayers(playerRows, info), shares = lab.missingShares(playerRows, info);
  const missingGames = [...shares.values()].filter(s => s.missing.size).length;
  assert.ok(missingGames > 20, `expected games with the star out, saw ${missingGames}`);
  const sample = [...shares.values()].find(s => s.missing.size);
  assert.ok(Math.abs(sample.frac.PTS - share) < 0.06, `missing share ${sample.frac.PTS} should be near ${share}`);
  const fit = lab.fitTeammateOut(players, shares, {});
  assert.ok(Math.abs(fit.PTS.slope - 0.5) < 0.2, `points slope ${fit.PTS.slope} should be near the true 0.5`);
  assert.ok(Math.abs(fit.REB.slope) < 0.2, 'rebounds were not given any lift');
});

test('with no effect built in the fitted slope is near zero', () => {
  const { teamRows, playerRows } = league({ games: 220, lift: 0, seed: 11 });
  const info = lab.prepareTeams(teamRows), fit = lab.fitTeammateOut(lab.preparePlayers(playerRows, info), lab.missingShares(playerRows, info), {});
  assert.ok(Math.abs(fit.PTS.slope) < 0.25, String(fit.PTS.slope));
});

test('level fit compares against the current method on a season it was not fitted on', () => {
  const a = league({ games: 150, seed: 3 }), b = league({ games: 150, seed: 5 });
  const mk = l => { const info = lab.prepareTeams(l.teamRows); return lab.preparePlayers(l.playerRows, info); };
  const res = lab.fitLevel(mk(a), mk(b), 'PTS');
  assert.ok(res.test.n > 100 && res.test.fitted > 0 && res.test.current > 0);
  assert.ok(lab.HALF_LIVES.includes(res.halfLife) && lab.LAMBDAS.includes(res.lambda));
});

test('a fringe player who barely plays is never counted as a missing regular', () => {
  const { teamRows, playerRows } = league({ games: 60, lift: 0.5, seed: 21 });
  // player 99 plays three minutes in two early games, then is simply not used
  for (const g of [12, 13]) { const date = new Date(Date.UTC(2025, 9, 20 + g * 2)).toISOString().slice(0, 10); playerRows.push({ PLAYER_ID: 99, PLAYER_NAME: 'P99', TEAM_ID: 1, GAME_ID: String(1000 + g), GAME_DATE: date, MIN: 3, PTS: 2, REB: 0, AST: 0, FG3M: 0, STL: 0, BLK: 0 }); }
  const info = lab.prepareTeams(teamRows), shares = lab.missingShares(playerRows, info);
  for (const [key, s] of shares) assert.ok(!s.missing.has(99), `${key} counted the fringe player as a missing regular`);
  const starOut = [...shares.values()].filter(s => s.missing.has(1)).length;
  assert.ok(starOut > 5, 'while the real star is still found missing');
});

test('own record without a teammate: a player who always jumps when one teammate sits is predicted better by his own record than by the league-wide lift', () => {
  const games = [], shares = new Map();
  for (let i = 0; i < 80; i++) {
    const out = i % 4 === 3, gameId = 'g' + i, key = `${gameId}|1`;
    games.push({ gameId, teamId: 1, date: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`.replace(/^2026/, i < 40 ? '2025' : '2026'), MIN: 30, PTS: out ? 26 : 20, REB: 5, AST: 4, FG3M: 2, STL: 1, BLK: 1 });
    shares.set(key, out ? { missing: new Set([99]), frac: { PTS: 0.2, REB: 0.2, AST: 0.2, FG3M: 0.2, STL: 0.2, BLK: 0.2, MIN: 0.2 } } : { missing: new Set(), frac: null });
  }
  games.forEach((g, i) => { g.date = new Date(Date.UTC(2025, 9, 1) + i * 86400000).toISOString().slice(0, 10); });
  const players = new Map([[7, { id: 7, name: 'P', games }]]);
  const res = lab.fitPairWithout([{ season: 'S', players }], shares, { PTS: 0.05 }, {}, { ks: [3, 30] });
  const e = res.PTS.S;
  assert.ok(e.n > 5);
  assert.ok(e.pair[3] < e.league, 'his own record beats a small league-wide lift');
  assert.ok(e.league <= e.base * 1.5);
});
