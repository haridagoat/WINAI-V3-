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

test('the play-type card: lean, soft-D share, best edge and watch come out as designed, and unranked types stay out', () => {
  const vm = require('node:vm');
  const start = html.indexOf('function ptSummary(');
  assert.ok(start > 0, 'ptSummary not found');
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}' && --depth === 0) break; }
  const ctx = {}; vm.createContext(ctx); vm.runInContext(`${html.slice(start, i + 1)}\nthis.f = ptSummary;`, ctx);
  // Tyrese Maxey against Orlando, from the Synergy files (rank 1 = toughest defense)
  const pt = { iso: { POSS_PCT: .1112, PPP: .8943, PTS: 2.69 }, transition: { POSS_PCT: .24105, PPP: 1.3255, PTS: 7.455 }, postUp: { POSS_PCT: .015, PPP: 1.115, PTS: .4 },
    spotUp: { POSS_PCT: .1726, PPP: 1.37485, PTS: 5.825 }, cut: { POSS_PCT: .031, PPP: 1.4, PTS: 1.1 }, handoff: { POSS_PCT: .0977, PPP: 1.0998, PTS: 2.94 },
    offScreen: { POSS_PCT: .047, PPP: 1.193, PTS: 1.5 }, prBall: { POSS_PCT: .15, PPP: 1, PTS: 3 } };
  const rk = { iso: 9, transition: 21, postUp: 29, spotUp: 26, cut: 5, handoff: 18, offScreen: 22 };
  const def = Object.fromEntries(Object.entries(rk).map(([k, r]) => [k, { rank: r, rankOf: 30 }]));
  const s = ctx.f(pt, def);
  assert.equal(s.lean, 'FAVORABLE');
  assert.equal(s.wtd.toFixed(1), '19.5');
  assert.equal(s.softPct, 83);
  assert.equal(s.best.key, 'spotUp');
  assert.equal(s.watch.key, 'iso', 'a low-volume play type (cut, 3.1%) is never the headline watch');
  assert.equal(s.rows.length, 7);
  assert.equal(s.unranked.map(u => u.key).join(), 'prBall', 'pick and roll has no defensive rank, so it is listed as unranked, not guessed');
  assert.equal(ctx.f(pt, {}), null, 'no defensive ranks at all: no card');
  assert.equal(ctx.f({}, def), null);
});

test('phones: fields are 16px (no iPhone auto-zoom) and the controls a thumb must hit are at least 44px', () => {
  const m = html.match(/@media \(max-width:760px\)\{\s*input:not\(\[type="checkbox"\]\)[\s\S]*?\n  \}\n<\/style>/);
  assert.ok(m, 'the phone accessibility block is missing');
  const block = m[0];
  assert.match(block, /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\),select,textarea\{font-size:16px !important;min-height:44px;\}/);
  for (const sel of ['.acct-btn', '.td-chip', '.bd-bar .td-chip', '.gp-pill', '.top-plays-refresh', '.suggestion-item', '.gs-i', '.gp-gm']) assert.ok(block.includes(sel), `${sel} must be sized for touch`);
  assert.ok(!/user-scalable\s*=\s*no|maximum-scale/i.test(html), 'pinch-zoom must stay allowed');
});

test('phones: the header is positioned (so its z-index works and the Tonight list opens above the search bar), and the games row is phone-only', () => {
  assert.match(html, /@media \(max-width:760px\)\{ header\{position:relative;top:auto;\} \}/, 'a static header ignores z-index and the search bar paints over the games list');
  assert.ok(!/@media \(max-width:760px\)\{ header\{position:static;\} \}/.test(html));
  assert.match(html, /\.td-strip\{display:none;\}\s*@media \(max-width:760px\)\{\s*\.td-strip\{display:flex;/, 'the games row is hidden on wide screens');
  assert.match(html, /data-goto-gm=/); assert.match(html, /data-gm="\$\{escapeHtml\(key\)\}"/, 'each chip must have a card to jump to');
  assert.ok(html.indexOf('${gameStrip}') < html.indexOf('tdUpStrip() :'), 'the games row sits above the free-plan banner');
});

test('player result: potential assists show for assist props and rebound chances for rebound props (combos get both), only from NBA tracking', () => {
  const src = html.match(/function v2TrackingChips\(ctx, propType\) \{[\s\S]*?\n\}\n/)[0];
  const f = new Function('PROP_COMBO_KEYS', 'PROP_STATKEY', 'v2F', 'v2Pct', src + '; return v2TrackingChips;')(
    { pra: ['pts', 'reb', 'ast'], pr: ['pts', 'reb'], pa: ['pts', 'ast'], ra: ['reb', 'ast'] }, { points: 'pts', rebounds: 'reb', assists: 'ast' },
    n => (Math.round(n * 10) / 10).toString(), x => { const n = parseFloat(x); return isFinite(n) ? (n <= 1 ? n * 100 : n) : null; });
  const ctx = { playerTracking: { passing: { POTENTIAL_AST: 15.185, AST: 9.255 }, rebounding: { REB_CHANCES: 20.3, REB_CHANCE_PCT: 0.516 } } };
  const names = (p, c = ctx) => f(c, p).map(x => x[0]);
  assert.deepEqual(f(ctx, 'assists'), [['Potential AST', '15.2', ''], ['AST ÷ potential', '60.9', '%']]);
  assert.deepEqual(f(ctx, 'rebounds'), [['Reb chances', '20.3', ''], ['REB ÷ chances', '51.6', '%']]);
  assert.deepEqual(names('pra'), ['Potential AST', 'AST ÷ potential', 'Reb chances', 'REB ÷ chances']); assert.deepEqual(names('ra'), names('pra')); assert.deepEqual(names('pa'), ['Potential AST', 'AST ÷ potential']); assert.deepEqual(names('pr'), ['Reb chances', 'REB ÷ chances']);
  for (const p of ['points', '3pm', 'steals']) assert.deepEqual(f(ctx, p), [], p);
  assert.deepEqual(f({}, 'assists'), []); assert.deepEqual(f({ playerTracking: { passing: { POTENTIAL_AST: 0, AST: 0 } } }, 'assists'), [], 'no zero or missing numbers shown');
  assert.match(html, /\.\.\.v2TrackingChips\(ctx, propType\)/);
});

test('one-column pages: the confidence and recommendation are repeated under the player header, with the tier, and hidden when the sidebar is beside the page', () => {
  const src = html.match(/function v2ConfBar\(confidence, vc, line, edge, propType\) \{[\s\S]*?\n\}\n/)[0];
  const f = new Function('fmtConf', 'escapeHtml', src + '; return v2ConfBar;')(c => (Math.round(c * 10) / 10).toFixed(1), s => String(s));
  const strong = f(84.5, 'over', 8.5, 2.9, 'rebounds'), lean = f(62, 'lean-under', 24.5, -1.2, 'points'), thin = f(40, 'pass', 20.5, 0.1, 'points');
  assert.match(strong, /class="v2-cbar strong"/); assert.match(strong, /84\.5<small>%<\/small>/); assert.match(strong, /<b class="strong">STRONG<\/b>/); assert.match(strong, /OVER 8\.5/); assert.match(strong, /\+2\.9 vs line/);
  assert.match(lean, /class="v2-cbar lean"/); assert.match(lean, /LEAN UNDER 24\.5/); assert.match(lean, /-1\.2 vs line/); assert.match(lean, /v2-cbar-rec under/);
  assert.match(thin, /class="v2-cbar thin"/); assert.match(thin, /<b>PASS<\/b>/, 'a pass has no line after it');
  assert.match(strong, /role="group" aria-label="Confidence 84\.5 percent, strong\. Recommendation OVER 8\.5"/);
  assert.match(strong, /<button type="button" class="v2-cbar-more" onclick="v2JumpToWhy\(this\)">See why/);
  assert.ok(f(150, 'over', 1, 0, 'points').includes('width:100.0%') && f(-5, 'over', 1, 0, 'points').includes('width:0.0%'), 'the bar never leaves its track');
  assert.ok(html.indexOf('${v2Header(ctx, player, opp, propType, line, projection, edge, league, playerId)}\n        ${v2ConfBar(') > 0, 'it sits right under the header, before the tabs');
  assert.match(html, /\.v2-cbar\{display:none;/); assert.match(html, /@media\(max-width:1150px\)\{\.v2-cbar\{display:block;\}\}/, 'shown exactly when the sidebar stacks under the page');
  assert.match(html, /@media\(max-width:1150px\)\{\.result-shell\{grid-template-columns:1fr;\}/);
  assert.match(html, /\.v2-cbar-more\{[^}]*min-height:44px/); assert.match(html, /side\.setAttribute\('tabindex', '-1'\); side\.focus\(\{ preventScroll: true \}\)/);
});
