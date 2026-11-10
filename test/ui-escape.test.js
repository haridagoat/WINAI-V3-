// Static guards for the front end. The live red-team pass (feeding hostile text through every endpoint into every page) found
// unescaped insertions and mouse-only controls; these checks stop the same patterns from coming back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');

test('AI text sections are never put into the page as markup', () => {
  for (const v of ['bottomLine', 'alternativePlays', 'blowout', 'shotChart', 'h2h', 'riskFactors', 'matchupConsistency', 'mathOutlook']) {
    assert.ok(!new RegExp('\\$\\{' + v + '\\}').test(html), `\${${v}} is inserted raw; wrap it in aiHtml()`);
  }
  assert.ok(!/ta-block-body[^`]*\$\{t\}/.test(html), 'accordion bodies must go through aiHtml()');
  assert.ok(!/'<div class="analysis-box">'\+h2h\+/.test(html), 'the head-to-head text must go through aiHtml()');
});

test('no inline event handler is built from data (use data attributes and a listener)', () => {
  const bad = [];
  html.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\son(?:click|change|input|keydown|keyup|focus|blur|mouseover)=("[^"]*"|'[^']*')/g)) {
      const v = m[1];
      if (!v.includes('${')) continue;
      // allowed: the page's own constants (league, tab keys, ids from code) and numeric ids
      const exprs = [...v.matchAll(/\$\{([^}]*)\}/g)].map(x => x[1].trim());
      const unsafe = exprs.filter(e => !/^(league|lg|k|id|i|fn|ds|b\.id|escapeHtml\([^)]*\)|initials\([^)]*\)|fb)$/.test(e));
      if (unsafe.length) bad.push(`line ${i + 1}: ${v.slice(0, 80)}`);
    }
  });
  assert.deepEqual(bad, []);
});

test('error messages shown in the page are escaped', () => {
  assert.ok(!/ERROR: \$\{errMsg\}/.test(html));
  assert.ok(!/Could not load — \$\{err\.message\}/.test(html));
});

test('stored verdicts and class names only take known values', () => {
  assert.match(html, /function safeVerdict\(/);
  assert.match(html, /const dir = \/\^\(over\|under\)\$\/i\.test\(p\.direction/);
});

test('clickable divs get keyboard behaviour, and the page has its landmarks', () => {
  for (const sel of ['.result-toptab', '.mu-accordion-header', '.day-chip', '.history-item']) assert.ok(html.includes(`['${sel}'`), `${sel} must be in KB_CONTROLS`);
  assert.match(html, /<main id="main"/);
  assert.match(html, /<footer>/);
  assert.match(html, /class="skip-link" href="#main"/);
});

test('Enter only starts an analysis from the form fields', () => {
  assert.match(html, /e\.target\.closest\?\.\('#player-name,#opp-team,#prop-line/);
  assert.ok(!/if \(e\.key!=='Enter'\) return;\n  if \(document\.getElementById\('panel-analyzer'\)/.test(html), 'the global Enter shortcut is back');
});

test('the admin sign-in inputs have labels', () => {
  assert.match(admin, /id="token-input" aria-label=/);
  assert.match(admin, /id="code-input" aria-label=/);
});

test('a game on the page is matched to its props by team nickname, so "LA Clippers" and "Los Angeles Clippers" are the same team', () => {
  const vm = require('node:vm');
  const grab = name => { const m = html.match(new RegExp(`const ${name} = [^\\n]*`)); assert.ok(m, `${name} not found`); return m[0]; };
  const ctx = {}; vm.createContext(ctx); vm.runInContext(`${grab('tdLast')}\n${grab('tdSameGame')}\nthis.f = tdSameGame;`, ctx);
  const game = { league: 'nba', away: 'Miami Heat', home: 'LA Clippers' };
  assert.equal(ctx.f({ league: 'nba', awayTeam: 'Miami Heat', homeTeam: 'Los Angeles Clippers' }, game), true);
  assert.equal(ctx.f({ league: 'nba', awayTeam: 'Miami Heat', homeTeam: 'Los Angeles Lakers' }, game), false, 'another team in the same city is not the same game');
  assert.equal(ctx.f({ league: 'wnba', awayTeam: 'Miami Heat', homeTeam: 'LA Clippers' }, game), false, 'a game in the other league is never a match');
  assert.equal(ctx.f({ league: 'nba', awayTeam: 'Heat', homeTeam: 'Clippers' }, game), true);
  assert.equal(ctx.f({ league: 'nba', awayTeam: undefined, homeTeam: null }, game), false);
  assert.ok(!/p\.awayTeam === g\.away && p\.homeTeam === g\.home/.test(html), 'games are not matched by exact team spelling');
});
