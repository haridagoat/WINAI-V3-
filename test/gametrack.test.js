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

// ── the page cards ──
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function page() {
  const src = html.slice(html.indexOf('const TG_PCT'), html.indexOf('const TG_INFO'));
  return new Function('PROP_COMBO_KEYS', 'PROP_STATKEY', 'escapeHtml', src + '; return { tgHit, tgWindow, tgRebModel, tgAstModel, tgChart, tgKeys };')(
    { pra: ['pts', 'reb', 'ast'], ra: ['reb', 'ast'], pr: ['pts', 'reb'], pa: ['pts', 'ast'] }, { points: 'pts', rebounds: 'reb', assists: 'ast', '3pm': 'fg3m' }, s => String(s));
}
const gm = (d, reb, rc, ast = 5, o = {}) => ({ date: d, opp: 'BOS', home: true, min: 34, pts: 20, reb, ast, rebChances: rc, orebChances: 3, drebChances: rc - 3, ...o });
// newest first, as the endpoint sends them
const rebLog = { games: [gm('2026-11-19', 8, 20), gm('2026-11-17', 7, 21), gm('2026-11-15', 13, 21), gm('2026-11-13', 16, 22), gm('2026-11-11', 12, 19, 5, { rebChances: undefined })] };

test('a game clears the line when its stat is over it (or under, for the under side); no line means no verdict; combos add their stats', () => {
  const P = page();
  assert.equal(P.tgHit({ reb: 9 }, ['reb'], 8.5, 'over'), true); assert.equal(P.tgHit({ reb: 8 }, ['reb'], 8.5, 'over'), false); assert.equal(P.tgHit({ reb: 8 }, ['reb'], 8.5, 'under'), true);
  assert.equal(P.tgHit({ reb: 8 }, ['reb'], undefined, 'over'), null); assert.equal(P.tgHit({ reb: 8 }, ['reb'], 0, 'over'), null);
  assert.equal(P.tgHit({ pts: 20, reb: 8, ast: 5 }, ['pts', 'reb', 'ast'], 32.5, 'over'), true);
});

test('rebound card model: bars oldest first, a game with no tracking numbers is n/a (not zero), the average ignores it', () => {
  const m = page().tgRebModel(rebLog, 10, 'rebounds', 8.5, 'over');
  assert.deepEqual(m.bars.map(b => b.g.date), ['2026-11-11', '2026-11-13', '2026-11-15', '2026-11-17', '2026-11-19']);
  assert.equal(m.bars[0].ok, false); assert.equal(m.bars[0].pct, null); assert.equal(m.gap, 1); assert.equal(m.n, 4);
  assert.deepEqual([m.avg.chances, m.avg.reb, m.avg.pct], [21, 11, 52.4]);
  assert.deepEqual(m.bars.filter(b => b.ok).map(b => b.hit), [true, true, false, false], 'hit = over 8.5');
});

test('the READ sentence: misses with normal chances are not an opportunity problem; misses with few chances are; all hits or all misses say so', () => {
  const P = page();
  const a = P.tgRebModel(rebLog, 10, 'rebounds', 8.5, 'over').read;
  assert.match(a, /2 misses weren't an opportunity problem/); assert.match(a, /20\.5 chances a game/, 'the misses saw 20.5 chances, right at his 21 average'); assert.match(a, /converted <b class="miss">36\.6%<\/b> of them vs <b class="hit">/);
  const few = { games: [gm('d4', 5, 10), gm('d3', 12, 24), gm('d2', 13, 24), gm('d1', 14, 24)] };
  assert.match(P.tgRebModel(few, 10, 'rebounds', 8.5, 'over').read, /1 miss was an opportunity problem[\s\S]*only <b>10 chances a game/);
  assert.match(P.tgRebModel(rebLog, 10, 'rebounds', 3.5, 'over').read, /cleared the over 3\.5 in all <b>4<\/b>/);
  assert.match(P.tgRebModel(rebLog, 10, 'rebounds', 30.5, 'over').read, /missed the over 30\.5 in all <b>4<\/b>/);
  assert.equal(P.tgRebModel(rebLog, 10, 'rebounds', undefined, 'over').read, '', 'no posted line: no sentence');
  assert.deepEqual(P.tgRebModel({ games: [gm('d', 5, undefined)] }, 10, 'rebounds', 8.5, 'over').avg, null);
});

test('assist card model: bars are measured against the season potential average, and the READ works out how many potential assists the line needs', () => {
  const P = page(); const ctx = { playerTracking: { passing: { POTENTIAL_AST: 15.185, AST: 9.255 } } };
  const log = { games: [gm('d3', 5, 10, 10), gm('d2', 5, 10, 8), gm('d1', 5, 10, 9)] };
  const m = P.tgAstModel(log, 10, 'assists', 8.5, 'over', ctx);
  assert.equal(m.pot, 15.2); assert.equal(m.conv, 60.9); assert.equal(m.avgAst, 9); assert.deepEqual(m.bars.map(b => b.inner), [9, 8, 10]);
  assert.deepEqual(m.bars.map(b => b.hit), [true, false, true]);
  assert.match(m.read, /At his <b>60\.9%<\/b> conversion, clearing 8\.5 takes about <b>14 potential assists<\/b>[\s\S]*<b>15\.2<\/b>[\s\S]*roughly <b>one pass<\/b>[\s\S]*Thin edge/);
  assert.match(P.tgAstModel(log, 10, 'assists', 4.5, 'over', ctx).read, /Comfortable/); assert.match(P.tgAstModel(log, 10, 'assists', 11.5, 'over', ctx).read, /<b>none<\/b>/);
  assert.match(P.tgAstModel(log, 10, 'assists', 8.5, 'under', ctx).read, /under 8\.5 holds if he gets fewer than about <b>14 potential assists/);
  assert.equal(P.tgAstModel(log, 10, 'pa', 28.5, 'over', ctx).read, '', 'a combo line is not an assist line');
  assert.equal(P.tgAstModel(log, 10, 'assists', 8.5, 'over', {}), null, 'no season potential: no card');
});

test('the chart: faint bar with the solid part inside, an n/a bar, an average bar, and the % under each game coloured by prop hit/miss', () => {
  const P = page(); const m = P.tgRebModel(rebLog, 10, 'rebounds', 8.5, 'over');
  const out = P.tgChart(m.bars, { avg: true, outer: 20.5, inner: 11, pct: 53.7, label: '11/20.5' }, { label: b => `${b.inner}/${b.outer}`, tip: () => 't', avgName: 'AVG', avgTip: 'a' });
  assert.equal((out.match(/class="tg-col/g) || []).length, 6); assert.match(out, /tg-col na[\s\S]*n\/a/); assert.match(out, /tg-col avg/);
  assert.match(out, /<em class="hit">62%<\/em>/); assert.match(out, /<em class="miss">33%<\/em>/); assert.match(out, /<em class="miss">40%<\/em>/); assert.match(out, /<em class="">–<\/em>/);
});

test('the page: one blue for both cards, only the stat the prop is about (nothing for points), NBA only, loaded once per player and only when near the screen', () => {
  const P = page();
  assert.deepEqual(P.tgKeys('pra').filter(k => ['reb', 'ast'].includes(k)), ['reb', 'ast']);
  assert.match(html, /\.tg\{--tgb:#4aa3ff;/); assert.ok(!/#c084fc|#8aa4ff|#22d3ee|#a78bfa/i.test(html.slice(html.indexOf('.tg{--tgb'), html.indexOf('/* Game log chart'))), 'no purple or cyan in the cards');
  assert.match(html, /kinds = \['ast', 'reb'\]\.filter\(k => keys\.includes\(k\)\)/); assert.match(html, /if \(league === 'wnba' \|\| !player \|\| !kinds\.length\) return '';/);
  assert.match(html, /tgCache\[player\] \|\| \(tgCache\[player\] = fetch\('\/api\/tracklog\?n=20&name='/); assert.match(html, /new IntersectionObserver/);
  assert.match(html, /renderTrackGraphs\(league, player, propType, ctx, line, isUnderSide \? 'under' : 'over'\)/);
  assert.ok(!/window\._tgCtx/.test(html));
});
