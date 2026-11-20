// Game-by-game tracking numbers (lib/gametrack.js, /api/tracklog) and the page section that draws them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const G = require('../lib/gametrack');
const { isStatsFileName } = require('../lib/statsupload');

const P = (n, t, m, o = {}) => ({ n, t, m, wl: 'W', min: 34, pts: 20, reb: 6, ast: 7, fg3m: 2, stl: 1, blk: 0, rc: 12, orc: 3, drc: 9, pas: 50, sast: 2, fast: 1, tch: 80, ...o });
const bundle = {
  builtAt: '2026-11-20T16:00:00Z', season: '2026-27',
  games: {
    G1: { date: '2026-11-15', tracked: true, players: { 1: P('Nikola Jokić', 'DEN', 'DEN vs. BOS'), 2: P('Jalen Brunson', 'NYK', 'NYK @ MIN') } },
    G2: { date: '2026-11-19', tracked: true, players: { 1: P('Nikola Jokić', 'DEN', 'DEN @ LAL', { reb: 12, rc: 20 }) } },
    G3: { date: '2026-11-18', tracked: false, players: { 1: P('Nikola Jokić', 'DEN', 'DEN vs. NYK', { rc: undefined }) } },
  },
};
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'winai-gt-')); fs.writeFileSync(path.join(d, 'gametrack_nba.json'), JSON.stringify(bundle)); return d; };

test('a player is found without accents, newest game first, with the opponent and home/away read from the matchup', () => {
  const out = G.lookup(G.index(bundle), 'Nikola Jokic', 20);
  assert.equal(out.name, 'Nikola Jokić'); assert.equal(out.team, 'DEN'); assert.deepEqual(out.games.map(g => g.date), ['2026-11-19', '2026-11-18', '2026-11-15']);
  assert.deepEqual([out.games[0].opp, out.games[0].home, out.games[2].opp, out.games[2].home], ['LAL', false, 'BOS', true]);
  assert.equal(G.lookup(G.index(bundle), 'jalen brunson', 5).games.length, 1);
});

test('tracking numbers are only on games that have them; a game without them keeps its box score', () => {
  const g = G.lookup(G.index(bundle), 'Nikola Jokic', 20).games;
  assert.deepEqual([g[0].rebChances, g[0].passes, g[0].secondaryAst, g[0].touches], [20, 50, 2, 80]);
  assert.equal(g[1].rebChances, undefined); assert.equal(g[1].reb, 6, 'the box score stays');
});

test('the number of games is capped, and an unknown player, an empty file or no file is simply null', () => {
  assert.equal(G.lookup(G.index(bundle), 'Nikola Jokic', 2).games.length, 2);
  assert.equal(G.lookup(G.index(bundle), 'Nikola Jokic', 9999).games.length, 3); assert.equal(G.lookup(G.index(bundle), 'Nikola Jokic', 'x').games.length, 3);
  for (const n of ['Nobody Atall', '', null]) assert.equal(G.lookup(G.index(bundle), n), null);
  assert.equal(G.lookup(null, 'x'), null); assert.equal(G.index({}), null); assert.equal(G.index(null), null);
});

test('the reader reloads when the file changes, and a missing or broken file is null', () => {
  const d = dir(); const read = G.createReader(d); const a = read(); assert.equal(read(), a);
  const f = path.join(d, 'gametrack_nba.json'); fs.writeFileSync(f, '{broken'); const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t); assert.equal(read(), null);
  assert.equal(G.createReader(fs.mkdtempSync(path.join(os.tmpdir(), 'winai-gt-')))(), null);
});

test('the file is accepted by the stats upload; look-alikes are not', () => {
  assert.ok(isStatsFileName('gametrack_nba.json'));
  for (const n of ['gametrack.js', '../gametrack_nba.json', 'gametrack_nba.db']) assert.ok(!isStatsFileName(n), n);
});

test('the page section: only the stat the prop is about, nothing for points, NBA only, fetched once per player', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const src = html.slice(html.indexOf('const TG_PCT'), html.indexOf('function renderTrackGraphs'));
  const f = new Function('PROP_COMBO_KEYS', 'PROP_STATKEY', 'escapeHtml', src + '; return { tgSummary, tgPanels, tgWindow };')({ pra: ['pts', 'reb', 'ast'], ra: ['reb', 'ast'], pr: ['pts', 'reb'], pa: ['pts', 'ast'] }, { points: 'pts', rebounds: 'reb', assists: 'ast', '3pm': 'fg3m' }, s => String(s));
  const log = G.lookup(G.index(bundle), 'Nikola Jokic', 20);
  const ctx = { playerTracking: { passing: { POTENTIAL_AST: 15.2, AST: 9.3 } } };
  // a panel is recognised by its own content (a single panel has no title of its own: the section header says it)
  const titles = prop => { const h = f.tgPanels(log, 10, prop, ctx).html; return [/assists a game, last/.test(h) && 'Potential assists', /chances a game/.test(h) && 'Rebound chances'].filter(Boolean); };
  assert.deepEqual(titles('rebounds'), ['Rebound chances']); assert.deepEqual(titles('assists'), ['Potential assists']);
  assert.deepEqual(titles('pra'), ['Potential assists', 'Rebound chances'], 'both for a combo, assists first'); assert.deepEqual(titles('pr'), ['Rebound chances']); assert.deepEqual(titles('pa'), ['Potential assists']);
  assert.deepEqual(titles('points'), []); assert.deepEqual(titles('3pm'), []);
  assert.equal(f.tgPanels(log, 10, 'pra', ctx).two, true); assert.match(f.tgPanels(log, 10, 'pra', ctx).html, /tg-pt">Potential assists[\s\S]*tg-pt">Rebound chances/, 'a combo keeps both titles'); assert.ok(!/tg-pt/.test(f.tgPanels(log, 10, 'rebounds', ctx).html), 'a single panel has no duplicate title'); assert.equal(f.tgPanels(log, 10, 'rebounds', ctx).two, false);
  assert.match(f.tgPanels(log, 10, 'assists', ctx).html, /potential assists, season avg 15\.2/, 'the season potential is the dashed line');
  assert.deepEqual(f.tgWindow(log.games, 2).map(g => g.date), ['2026-11-18', '2026-11-19'], 'oldest first, like the game log chart');
  const sm = f.tgSummary(f.tgWindow(log.games, 10)); assert.equal(sm.n, 2, 'a game without tracking numbers is left out of the averages'); assert.equal(sm.rebChances, 16);
  assert.equal(f.tgPanels(log, 10, 'rebounds', ctx).gap, 1, 'and reported, not drawn as zero');
  assert.match(html, /function renderTrackGraphs\(league, player, propType, ctx\) \{\s*const keys[\s\S]*?if \(league === 'wnba' \|\| !player \|\| !\(keys\.includes\('reb'\) \|\| keys\.includes\('ast'\)\)\) return '';/);
  assert.match(html, /tgCache\[player\] \|\| \(tgCache\[player\] = fetch\('\/api\/tracklog\?n=20&name='/);
  assert.match(html, /new IntersectionObserver/); assert.match(html, /renderTrackGraphs\(league, player, propType, ctx\)/); assert.ok(!/window\._tgCtx/.test(html), 'each section keeps its own player data');
});
