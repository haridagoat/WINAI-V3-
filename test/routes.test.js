// The page's own addresses (/board, /analyze, /track ...). The mapping lives in public/index.html between ROUTES-BEGIN and ROUTES-END;
// these tests run that real code, and check the server answers exactly the addresses the page uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const block = html.slice(html.indexOf('// ROUTES-BEGIN'), html.indexOf('// ROUTES-END'));
assert.ok(block.length > 200, 'the ROUTES block is missing from index.html');
const ctx = vm.createContext({ URLSearchParams, Date, String, Object, parseFloat, isNaN });
vm.runInContext(block + '\n;this.__x = { ROUTES, pageForPath, routeDate, routeAnalysis, analysisQuery };', ctx);
const R = ctx.__x;
const plain = o => JSON.parse(JSON.stringify(o));

test('every page has its own address and the address maps back to the page', () => {
  assert.deepEqual(plain(R.ROUTES), { today: '/board', matchups: '/board/games', analyzer: '/analyze', wnba: '/analyze/wnba', betslip: '/track', history: '/track/history' });
  for (const [page, p] of Object.entries(R.ROUTES)) assert.equal(R.pageForPath(p), page);
});

test('"/" is still the Board; case and a trailing slash do not matter; anything unknown falls back to the Board', () => {
  assert.equal(R.pageForPath('/'), 'today');
  assert.equal(R.pageForPath(''), 'today');
  assert.equal(R.pageForPath('/Analyze/'), 'analyzer');
  assert.equal(R.pageForPath('/TRACK/history'), 'history');
  assert.equal(R.pageForPath('/nope'), 'today');
});

test('the server answers the page at "/" and at exactly the addresses the page uses', () => {
  const m = /const PAGE_PATHS = (\[[^\]]*\]);/.exec(server);
  assert.ok(m, 'PAGE_PATHS is missing from server.js');
  const paths = JSON.parse(m[1].replace(/'/g, '"'));
  assert.deepEqual([...paths].sort(), Object.values(R.ROUTES).sort());
  assert.ok(/app\.get\(\['\/', \.\.\.PAGE_PATHS\], \(req, res\) => res\.sendFile\(path\.join\(__dirname, 'public', 'index\.html'\)\)\);/.test(server));
  assert.ok(!/app\.get\(['"]\*['"]/.test(server), 'a catch-all route would hide mistyped addresses');
});

test('Games date: only a real calendar day is accepted', () => {
  assert.equal(R.routeDate('?date=2026-11-25'), '2026-11-25');
  assert.equal(R.routeDate('?date=2026-02-31'), null);   // rolls into March, not a real day
  assert.equal(R.routeDate('?date=2026-13-01'), null);
  assert.equal(R.routeDate('?date=1999-01-01'), null);
  assert.equal(R.routeDate('?date=tomorrow'), null);
  assert.equal(R.routeDate('?date=2026-11-25<script>'), null);
  assert.equal(R.routeDate(''), null);
});

test('Analyze link: values are checked, trimmed and limited before they reach the form', () => {
  assert.deepEqual(plain(R.routeAnalysis('?player=Nikola+Jokic&opp=Boston+Celtics&prop=assists&line=8.5')), { player: 'Nikola Jokic', opp: 'Boston Celtics', prop: 'assists', line: '8.5' });
  assert.deepEqual(plain(R.routeAnalysis('?prop=<img>&line=abc')), {});
  assert.deepEqual(plain(R.routeAnalysis('?line=0')), {});
  assert.deepEqual(plain(R.routeAnalysis('?line=-5')), {});
  assert.deepEqual(plain(R.routeAnalysis('?line=24.55')), {});
  assert.equal(R.routeAnalysis('?prop=POINTS').prop, 'points');
  assert.equal(R.routeAnalysis('?player=' + 'a'.repeat(500)).player.length, 60);
  assert.equal(R.routeAnalysis('?player=Jok%00ic%E2%80%8B').player, 'Jokic');   // control and zero-width characters are dropped
});

test('Analyze link: building the address and reading it back agree', () => {
  const f = { player: "A'ja Wilson", opp: 'Las Vegas Aces', prop: 'points', line: '22.5' };
  assert.deepEqual(plain(R.routeAnalysis(R.analysisQuery(f))), f);
  assert.equal(R.analysisQuery({ player: '', opp: '', prop: 'points', line: '' }), '');
  assert.equal(R.analysisQuery({ player: 'X', opp: '', prop: 'rebounds', line: '' }), '?player=X&prop=rebounds');
});

test('the page reads the address when it opens and on Back/Forward, and values only go into form fields', () => {
  assert.ok(/window\.addEventListener\('popstate', applyLocation\)/.test(html));
  assert.ok(/if \(pageForPath\(location\.pathname\) === 'today'\) renderTodayPage\(\);\s*\n\s*applyLocation\(\);/.test(html));
  assert.ok(/switchTab\(page, \{ push: false \}\)/.test(html));   // answering Back must not add a history entry
  const fn = html.slice(html.indexOf('function applyLocation()'), html.indexOf("window.addEventListener('popstate'"));
  assert.ok(!/innerHTML/.test(fn), 'address values must never be written as markup');
  assert.ok(/syncAnalyzeUrl\(league\);\s*\/\/ the address now names this analysis/.test(html));
});
