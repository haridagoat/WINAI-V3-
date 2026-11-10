const test = require('node:test');
const assert = require('node:assert/strict');
const dvp = require('../lib/dvp');
const lab = require('../lib/lab');

const NAMES = ['Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'Charlotte Hornets', 'Chicago Bulls', 'Cleveland Cavaliers', 'Dallas Mavericks', 'Denver Nuggets', 'Detroit Pistons', 'Golden State Warriors',
  'Houston Rockets', 'Indiana Pacers', 'Los Angeles Clippers', 'Los Angeles Lakers', 'Memphis Grizzlies', 'Miami Heat', 'Milwaukee Bucks', 'Minnesota Timberwolves', 'New Orleans Pelicans', 'New York Knicks',
  'Oklahoma City Thunder', 'Orlando Magic', 'Philadelphia 76ers', 'Phoenix Suns', 'Portland Trail Blazers', 'Sacramento Kings', 'San Antonio Spurs', 'Toronto Raptors', 'Utah Jazz', 'Washington Wizards'];
const LEAGUE = { G: { pts: 40, reb: 12, ast: 14, fg3m: 5, stl: 4, blk: 1.5 }, F: { pts: 46, reb: 18, ast: 9, fg3m: 4.5, stl: 3, blk: 3 }, C: { pts: 24, reb: 14, ast: 5, fg3m: 1, stl: 2, blk: 1.5 } };
const scale = (g, f) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v * (f[k] ?? f.all ?? 1)]));
function table({ gp = 20, team = 'Atlanta Hawks', change = {}, fetchedAt = new Date().toISOString() } = {}) {
  const teams = {};
  for (const n of NAMES) teams[n] = { gp, G: { ...LEAGUE.G }, F: { ...LEAGUE.F }, C: { ...LEAGUE.C } };
  for (const [g, f] of Object.entries(change)) teams[team][g] = scale(LEAGUE[g], f);
  return { fetchedAt, windows: { season: teams, last15: teams } };
}
const PARAMS = { sens: { rebounds: 0.2, assists: 0.42, '3pm': 0.29, steals: 0.46, blocks: 0.51 }, shrinkGames: 10, cap: 0.06 };
const ask = (o, over = {}) => dvp.positionAllowedMultiplier({ data: table(o), team: 'Atlanta Hawks', position: 'C', propType: 'rebounds', params: PARAMS, ...over });

test('positions fall into guards, forwards and centers by their first letter', () => {
  for (const [p, g] of [['PG', 'G'], ['SG', 'G'], ['G', 'G'], ['G-F', 'G'], ['GF', 'G'], ['SF', 'F'], ['PF', 'F'], ['F', 'F'], ['F-C', 'F'], ['FC', 'F'], ['C', 'C'], ['C-F', 'C'], [' c ', 'C']]) assert.equal(dvp.groupOf(p), g, p);
  for (const p of ['', null, undefined, 'N/A', 'Unknown', 'X']) assert.equal(dvp.groupOf(p), null, String(p));
});

test('a team is found by its nickname, so "LA Clippers" and "Los Angeles Clippers" are the same', () => {
  const t = table().windows.season;
  assert.equal(dvp.findTeam(t, 'LA Clippers'), t['Los Angeles Clippers']);
  assert.equal(dvp.findTeam(t, 'Trail Blazers'), t['Portland Trail Blazers']);
  assert.equal(dvp.findTeam(t, 'Nobody'), null);
  assert.equal(dvp.findTeam(null, 'Atlanta Hawks'), null);
});

test('a defense that gives centers many rebounds raises a center\'s rebounds, and one that gives few lowers them', () => {
  const soft = ask({ change: { C: { reb: 1.25 } } }), tough = ask({ change: { C: { reb: 0.75 } } });
  assert.ok(soft.mult > 1.005 && soft.mult <= 1.06, `soft ${soft.mult}`);
  assert.ok(tough.mult < 0.995 && tough.mult >= 0.94, `tough ${tough.mult}`);
  assert.equal(soft.detail.group, 'C');
});

test('it is the player\'s own group that counts', () => {
  const data = { change: { C: { reb: 1.25 } } };
  assert.ok(ask(data, { position: 'PG' }).mult < ask(data, { position: 'C' }).mult);
  assert.ok(Math.abs(ask(data, { position: 'PG' }).mult - 1) < 0.01);
});

test('a defense that is simply worse everywhere, points included, is not counted twice', () => {
  const r = ask({ change: { G: { all: 1.2 }, F: { all: 1.2 }, C: { all: 1.2 } } });
  assert.ok(Math.abs(r.mult - 1) < 0.002, `mult ${r.mult}`);
});

test('few games played pull the answer toward no adjustment', () => {
  const big = { change: { C: { reb: 1.5 } } };
  assert.ok(ask({ ...big, gp: 2 }).mult - 1 < (ask({ ...big, gp: 30 }).mult - 1) / 2);
});

test('the adjustment is capped', () => {
  const r = ask({ gp: 60, change: { C: { reb: 5 } } }, { params: { ...PARAMS, cap: 0.03 } });
  assert.ok(Math.abs(r.mult - 1.03) < 1e-9, String(r.mult));
});

test('combos blend their parts in proportion; points alone has no adjustment because the lab found none', () => {
  const ra = ask({ change: { C: { reb: 1.3, ast: 1.3 } } }, { propType: 'ra' }), r = ask({ change: { C: { reb: 1.3, ast: 1.3 } } });
  assert.ok(ra.mult > r.mult, 'assists carry more weight than rebounds, so the combo moves more than rebounds alone');
  assert.equal(ask({ change: { C: { pts: 1.3, reb: 1.3 } } }, { propType: 'points' }), null);
});

test('it says nothing when it cannot be trusted: old data, no data, unknown team or position, no strengths', () => {
  const old = new Date(Date.now() - 6 * 86400000).toISOString();
  assert.equal(ask({ fetchedAt: old }), null);
  assert.equal(ask({}, { data: null }), null);
  assert.equal(ask({}, { team: 'Nobody' }), null);
  assert.equal(ask({}, { team: undefined }), null);
  assert.equal(ask({}, { position: 'N/A' }), null);
  assert.equal(ask({}, { params: { sens: {} } }), null);
  assert.equal(ask({}, { params: undefined }), null);
  assert.equal(ask({}, { data: { fetchedAt: new Date().toISOString(), windows: { season: { 'Atlanta Hawks': table().windows.season['Atlanta Hawks'] } } } }), null);   // too few teams to compare with
  assert.equal(ask({}, { propType: 'fantasy' }), null);
});

// ── the lab's side ──────────────────────────────────────────────────────────────────────────────────────
// Eight teams, one guard, forward and center each, every team plays every day. Teams 1 and 2 give centers 25% more rebounds.
function league(effect) {
  let seed = 11; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const teamRows = [], playerRows = [], ids = [1, 2, 3, 4, 5, 6, 7, 8], base = { G: 3, F: 6, C: 10 };
  const players = t => ['G', 'F', 'C'].map((g, i) => ({ id: t * 10 + i, g, t }));
  const posById = {}; for (const t of ids) for (const p of players(t)) posById[p.id] = p.g;
  for (let day = 0; day < 70; day++) {
    const order = ids.slice(1); const rot = order.map((_, i) => order[(i + day) % 7]);
    const ring = [ids[0], ...rot], pairs = [0, 1, 2, 3].map(i => [ring[i], ring[7 - i]]);
    const date = new Date(Date.UTC(2025, 9, 20 + day)).toISOString().slice(0, 10);
    pairs.forEach(([a, b], k) => {
      const gameId = String(2000 + day * 10 + k);
      for (const [me, foe, home] of [[a, b, true], [b, a, false]]) {
        teamRows.push({ TEAM_ID: me, GAME_ID: gameId, GAME_DATE: date, MATCHUP: home ? `T${me} vs. T${foe}` : `T${me} @ T${foe}`, WL: 'W', PTS: 100, PLUS_MINUS: 0 });
        for (const p of players(me)) {
          const boost = p.g === 'C' && effect && (foe === 1 || foe === 2) ? 1.25 : 1;
          playerRows.push({ PLAYER_ID: p.id, PLAYER_NAME: 'P' + p.id, TEAM_ID: me, GAME_ID: gameId, GAME_DATE: date, MIN: 30, PTS: 12 + rnd(), REB: base[p.g] * boost * (1 + (rnd() - 0.5) * 0.3), AST: 3, FG3M: 1, STL: 1, BLK: 1 });
        }
      }
    });
  }
  return { teamRows, playerRows, groupOf: id => posById[id] };
}

test('lab: what a defense has given up is known only from earlier games', () => {
  const { teamRows, playerRows, groupOf } = league(true), info = lab.prepareTeams(teamRows);
  const base = lab.allowedByGroup(playerRows, info, groupOf);
  const last = playerRows[playerRows.length - 1], key = `${last.GAME_ID}|${info.get(`${last.GAME_ID}|${last.TEAM_ID}`).oppId}`;
  const future = playerRows.map(r => (r.GAME_ID >= '2600' ? { ...r, REB: 999 } : r));
  const changed = lab.allowedByGroup(future, info, groupOf);
  for (const [k, v] of base) if (k.split('|')[0] <= '2600') assert.deepEqual(changed.get(k), v, `game ${k} saw the future`);
  assert.ok(base.get(key).n > 50);
});

test('lab: a planted weakness shows up as a positive slope, and no weakness shows none', () => {
  for (const [effect, check] of [[true, s => s.slope > 0.5 && s.stderr < 0.3], [false, s => Math.abs(s.slope) < 0.4]]) {
    const { teamRows, playerRows, groupOf } = league(effect), info = lab.prepareTeams(teamRows), players = lab.preparePlayers(playerRows, info);
    const fit = lab.fitPositionAllowed(players, lab.allowedByGroup(playerRows, info, groupOf), groupOf);
    assert.ok(check(fit.REB.net), `effect=${effect} ${JSON.stringify(fit.REB.net)}`);
  }
});

test('lab: positions group by their first letter', () => {
  assert.deepEqual(['G', 'G-F', 'F', 'F-C', 'C', 'C-F', '', null, 'X'].map(lab.groupOfPosition), ['G', 'G', 'F', 'F', 'C', 'C', null, null, null]);
});

test('position table: each group\'s figures with a rank among all teams (1 = gives up the fewest), and the player\'s own group', () => {
  const data = table({ change: { C: { reb: 1.5, pts: 0.5 } } });
  const t = dvp.positionTable({ data, team: 'Atlanta Hawks', position: 'C' });
  assert.equal(t.yourGroup, 'C'); assert.equal(t.of, 30); assert.equal(t.games, 20); assert.deepEqual(t.rows.map(r => r.label), ['Guards', 'Forwards', 'Centers']);
  const c = t.rows.find(r => r.group === 'C').stats;
  assert.equal(c.reb.value, 21); assert.equal(c.reb.rank, 30, 'the most rebounds allowed ranks last');
  assert.equal(c.pts.value, 12); assert.equal(c.pts.rank, 1, 'the fewest points allowed ranks first');
  assert.equal(t.rows.find(r => r.group === 'G').stats.pts.rank, 1, 'ties share the best rank');
  assert.equal(dvp.positionTable({ data, team: 'LA Clippers', position: 'PG' }).yourGroup, 'G');
  assert.equal(dvp.positionTable({ data, team: 'Atlanta Hawks', position: 'N/A' }).yourGroup, null, 'an unknown position still shows the table, with nothing lit');
});

test('position table: nothing is shown for old data, no data, or an unknown team', () => {
  const old = new Date(Date.now() - 6 * 86400000).toISOString();
  for (const o of [{ data: table({ fetchedAt: old }), team: 'Atlanta Hawks' }, { data: null, team: 'Atlanta Hawks' }, { data: table(), team: 'Nobody' }, { data: table(), team: undefined }, { data: { fetchedAt: new Date().toISOString(), windows: {} }, team: 'Atlanta Hawks' }]) assert.equal(dvp.positionTable({ ...o, position: 'C' }), null);
});
