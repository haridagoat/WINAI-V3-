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
  assert.equal(P.tgRebModel(rebLog, 10, 'ra', 19.5, 'over').read, '', 'a combo line is not a rebound line');
  assert.deepEqual(P.tgRebModel({ games: [gm('d', 5, undefined)] }, 10, 'rebounds', 8.5, 'over').avg, null);
});

test('assist card model: each bar is measured against THAT game\'s own potential assists, the READ uses the games shown, and a game without potential assists is n/a', () => {
  const P = page();
  const log = { games: [gm('d3', 5, 10, 10, { potentialAst: 16 }), gm('d2', 5, 10, 8, { potentialAst: 14 }), gm('d1', 5, 10, 9, { potentialAst: undefined })] };   // newest first
  const m = P.tgAstModel(log, 10, 'assists', 8.5, 'over');
  assert.deepEqual(m.bars.map(b => b.g.date), ['d1', 'd2', 'd3'], 'oldest first');
  assert.deepEqual(m.bars.map(b => b.ok), [false, true, true]); assert.deepEqual(m.bars.map(b => b.outer), [0, 14, 16]); assert.deepEqual(m.bars.map(b => b.inner), [0, 8, 10]);
  assert.deepEqual(m.bars.map(b => b.pct), [null, 57.1, 62.5], 'a real per-game conversion');
  assert.deepEqual(m.bars.map(b => b.hit), [true, false, true], 'prop hit or miss comes from his assists, even in a game without potential');
  assert.deepEqual([m.avg.pot, m.avg.ast, m.avg.pct, m.n, m.gap], [15, 9, 60, 2, 1], 'averages cover only the games that have it');
  assert.match(m.read, /At his <b>60%<\/b> conversion in these games, clearing 8\.5 takes about <b>14 potential assists<\/b>[\s\S]*<b>15<\/b> in them[\s\S]*roughly <b>one pass<\/b>[\s\S]*Thin edge/);
  assert.match(P.tgAstModel(log, 10, 'assists', 4.5, 'over').read, /Comfortable/); assert.match(P.tgAstModel(log, 10, 'assists', 11.5, 'over').read, /<b>none<\/b>/);
  assert.match(P.tgAstModel(log, 10, 'assists', 8.5, 'under').read, /under 8\.5 holds if he gets fewer than about <b>14 potential assists/);
  assert.equal(P.tgAstModel(log, 10, 'pa', 28.5, 'over').read, '', 'a combo line is not an assist line');
  assert.equal(P.tgAstModel({ games: [gm('d1', 5, 10, 9)] }, 10, 'assists', 8.5, 'over'), null, 'no potential assists in any game: no card');
  const chron = P.tgAstModel([gm('d2', 5, 10, 8, { potentialAst: 14 }), gm('d3', 5, 10, 10, { potentialAst: 16 })], 99, 'assists', 8.5, 'over');
  assert.deepEqual([chron.avg.pot, chron.avg.pct], [15, 60], 'a list of games already chosen (the game log chart\'s) is used as it is, in its order');
});

test('every bar shows both numbers: the actual inside the solid part, that game\'s potential above the bar, both sized on one axis from zero', () => {
  const P = page();
  const m = P.tgAstModel([gm('d1', 5, 10, 10, { potentialAst: 16 }), gm('d2', 5, 10, 8, { potentialAst: 14 }), gm('d3', 5, 10, 3, { potentialAst: 2 }), gm('d4', 5, 10, 7, { potentialAst: undefined })], 99, 'assists', 8.5, 'over');
  const out = P.tgChart(m.bars, { avg: true, outer: m.avg.pot, inner: m.avg.ast, pct: m.avg.pct }, { hatch: true, tip: () => 't', avgName: 'AVG', avgTip: 'a' });
  const cols = [...out.matchAll(/tg-ghost[^"]*" style="height:([\d.]+)%"><span class="tg-of"><i>of <\/i>([\d.]+)<\/span><div class="tg-solid" style="height:([\d.]+)%"><span class="tg-in">([\d.]+)<\/span>/g)].map(x => x.slice(1).map(Number));
  // axis max = largest of potential and assists (16) x 1.2 = 19.2
  assert.deepEqual(cols[0], [83.3, 16, 62.5, 10]); assert.deepEqual(cols[1], [72.9, 14, 57.1, 8], 'each game has its own potential, so the faint bars differ');
  assert.deepEqual(cols[2], [15.6, 2, 100, 3], 'assists above potential (nba.com does this in about 6% of games): the bar is as tall as the assists, the potential is still printed as 2');
  assert.match(out, /tg-col na[\s\S]*n\/a/); assert.match(out, /<span class="tg-of"><i>of <\/i>10\.7<\/span>/, 'the average bar is the average of the games shown');
  assert.ok(!/axis starts at|zbar|tg-ref/.test(out));
  const m2 = P.tgRebModel(rebLog, 10, 'rebounds', 8.5, 'over'); const rout = P.tgChart(m2.bars, { avg: true, outer: m2.avg.chances, inner: m2.avg.reb, pct: m2.avg.pct }, { tip: () => 't', avgName: 'AVG', avgTip: 'a' });
  assert.match(rout, /<span class="tg-of"><i>of <\/i>22<\/span><div class="tg-solid" style="height:72\.7%"><span class="tg-in">16<\/span>/);
});

test('the cards show exactly the games the game log chart shows: its range, and its line and side for the hit/miss colours; a game not in the tracking data stays as an n/a bar', () => {
  const src = html.slice(html.indexOf('function tgIso(d)'), html.indexOf('function renderTrackGraphs'));
  const GL_RANGES = [['l5', 'L5'], ['l10', 'L10'], ['l20', 'L20'], ['h2h', 'H2H'], ['home', 'HOME'], ['away', 'AWAY']];
  const glGameMeta = g => { const m = String(g.opponent || g.matchup || '').match(/(vs\.?|@)\s*([A-Za-z0-9]+)\s*$/i); return { abbr: m ? m[2].toUpperCase() : '', home: m ? !m[1].startsWith('@') : null }; };
  const make = gl => new Function('window', 'GL_RANGES', 'glGameMeta', src + '; return { tgIso, tgSeries };')({ _gl: { nba: gl } }, GL_RANGES, glGameMeta);
  const T = make(null);
  assert.equal(T.tgIso('2026-11-19'), '2026-11-19'); assert.equal(T.tgIso('2026-11-19T01:00:00Z'), '2026-11-19'); assert.equal(T.tgIso('Nov 19, 2026'), '2026-11-19'); assert.equal(T.tgIso('Nov 07, 2026'), '2026-11-07'); assert.equal(T.tgIso('N/A'), ''); assert.equal(T.tgIso(null), '');
  const log = { games: [{ date: '2026-11-19', opp: 'MIN', home: false, potentialAst: 17, ast: 9 }, { date: '2026-11-17', opp: 'BOS', home: true, potentialAst: 15, ast: 7 }] };
  const st = { league: 'nba', log, n: 10, propType: 'assists', line: 8.5, side: 'over' };
  const alone = T.tgSeries(st); assert.deepEqual([alone.synced, alone.label, alone.n], [false, 'last 10', 10], 'no game log chart on the page: the card keeps its own L5/L10/L20');
  const gl = { range: 'l5', side: 'under', lines: { assists: 6.5 }, sets: { l5: [{ date: 'Nov 17, 2026', matchup: 'NYK vs. BOS', ast: 7 }, { date: 'Nov 19, 2026', matchup: 'NYK @ MIN', ast: 9 }], h2h: [{ date: '2025-01-12', matchup: 'NYK vs. BOS', ast: 5 }, { date: '2026-11-17', matchup: 'NYK vs. BOS', ast: 7 }] } };
  const sy = make(gl).tgSeries(st);
  assert.deepEqual([sy.synced, sy.label, sy.n, sy.line, sy.side], [true, 'L5', 2, 6.5, 'under'], 'the chart\'s own line and side');
  assert.deepEqual(sy.src.map(g => [g.date, g.potentialAst]), [['2026-11-17', 15], ['2026-11-19', 17]], 'the chart\'s games, oldest first as the chart has them, matched by date');
  gl.range = 'h2h'; const h = make(gl).tgSeries(st);
  assert.deepEqual([h.label, h.src.length], ['H2H', 2]); assert.equal(h.src[0].potentialAst, undefined, 'a head-to-head game from an earlier season is not in this season\'s tracking file'); assert.equal(h.src[0].opp, 'BOS'); assert.equal(h.src[0].ast, 5); assert.equal(h.src[1].potentialAst, 15);
  const none = make({ range: 'l5', sets: {} }).tgSeries(st); assert.equal(none.synced, false, 'a chart without that range is ignored');
  const noLine = make({ range: 'l5', side: 'over', lines: {}, sets: { l5: [] } }).tgSeries(st); assert.equal(noLine.line, 8.5, 'with no line in the chart the posted line is used');
  assert.match(html, /root\.innerHTML = glInner\(league\);\s*glMount\(league\);\s*if \(typeof tgSync === 'function'\) tgSync\(league\);/, 'the chart tells the cards every time it redraws');
  assert.match(html, /if \(pills\) pills\.hidden = sr\.synced;/); assert.match(html, /Same games as the game log above: \$\{sr\.label\}/);
});

test('the tracking endpoint carries each game\'s potential assists, even for a game with no other tracking numbers', () => {
  const b = { builtAt: 'T', games: { G1: { date: '2026-11-19', tracked: true, players: { 1: { n: 'A B', t: 'X', m: 'X @ Y', min: 30, pts: 1, reb: 1, ast: 9, fg3m: 0, stl: 0, blk: 0, rc: 5, pot: 17 } } }, G2: { date: '2026-11-17', tracked: false, players: { 1: { n: 'A B', t: 'X', m: 'X vs. Z', min: 30, pts: 1, reb: 1, ast: 4, fg3m: 0, stl: 0, blk: 0, pot: 11 } } } } };
  const g = G.lookup(G.index(b), 'A B', 5).games;
  assert.equal(g[0].potentialAst, 17); assert.equal(g[0].rebChances, 5); assert.equal(g[1].potentialAst, 11); assert.equal(g[1].rebChances, undefined);
  assert.equal(G.lookup(G.index({ games: { G: { date: '2026-11-19', players: { 1: { n: 'C D', t: 'X', m: 'X @ Y', ast: 2 } } } } }), 'C D', 5).games[0].potentialAst, undefined, 'no value is invented');
  const py = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-gametrack.py'), 'utf8');
  assert.match(py, /pt_measure_type='Passing', per_mode_simple='Totals'[\s\S]*date_from_nullable=f'\{m\}\/\{dd\}\/\{y\}', date_to_nullable=f'\{m\}\/\{dd\}\/\{y\}'/, 'one call per game day');
  assert.match(py, /TRACK_KEYS = \('rc', 'orc', 'drc', 'pas', 'sast', 'fast', 'tch', 'pot'\)/, 'what is already built is kept');
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

test('accessibility: a keyboard-focusable scroll region, a real table of the same numbers for screen readers, a tap-for-details line, marks as well as colours, no page-widening hidden table', () => {
  const P = page(); const m = P.tgRebModel(rebLog, 10, 'rebounds', 8.5, 'over');
  const out = P.tgChart(m.bars, { avg: true, outer: m.avg.chances, inner: m.avg.reb, pct: m.avg.pct }, { caption: 'Rebounds and rebound chances, last 4 games', actualName: 'Rebounds', potentialName: 'Chances', tip: g => `${g.reb} on ${g.rebChances}`, avgName: 'AVG', avgTip: 'a' });
  assert.match(out, /class="tg-scroll" tabindex="0" role="region" aria-label="Rebounds and rebound chances, last 4 games: chart, scroll sideways for more games"/);
  assert.match(out, /class="tg-plot"[^>]*aria-hidden="true"/, 'the drawing is hidden from screen readers; the table speaks for it');
  assert.match(out, /<div class="tg-sr"><table><caption>Rebounds and rebound chances/); assert.match(out, /<th scope="col">Rebounds<\/th><th scope="col">Chances<\/th>/);
  assert.equal((out.match(/<tr><th scope="row">/g) || []).length, 5, 'one row per game, the one without numbers included');
  assert.match(out, /<td>16<\/td><td>22<\/td><td>73%<\/td><td>cleared the line<\/td>/); assert.match(out, /<td>7<\/td><td>21<\/td><td>33%<\/td><td>missed the line<\/td>/); assert.match(out, /no tracking numbers yet/);
  assert.match(out, /data-tip="[^"]+cleared the line"/, 'tap details say the verdict in words');
  assert.match(out, /<p class="tg-detail" aria-hidden="true">Tap a bar/);
  assert.match(html, /\.tg-x em\.hit::before\{content:"\\2713/); assert.match(html, /\.tg-x em\.miss::before\{content:"\\2715/);
  assert.match(html, /\.tg-sr\{position:absolute;width:1px;height:1px;[^}]*clip-path:inset\(50%\)/); assert.match(html, /\.tg\{position:relative;overflow:hidden;\}/);
  assert.match(html, /aria-label="Last \$\{n\} games" aria-pressed/);
  assert.match(html, /\.tg-in\{[^}]*background:rgba\(5,14,26,\.86\)/, 'the number sits on a dark chip, readable on any background');
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)\{\.tg \*\{transition:none!important;animation:none!important;\}\}/);
  for (const need of ['.tg-pill{min-height:44px;min-width:48px', '.tg-stats{grid-template-columns:minmax(0,1fr);}', '.tg-plot{min-width:calc(var(--n) * 46px);}', '.tg-of i{display:none;}']) assert.ok(html.includes(need), need);
  const small = [...html.slice(html.indexOf('.tg{--tgb'), html.indexOf('/* Game log chart')).matchAll(/font-size:(\d+(?:\.\d+)?)px/g)].map(x => +x[1]);
  assert.ok(small.length && Math.min(...small.filter(v => v > 0)) >= 10, 'no text below 10px even before the phone rules lift it');
});
