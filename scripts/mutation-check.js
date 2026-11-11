#!/usr/bin/env node
// Tests the tests. Breaks the code on purpose, one small change at a time (a flipped sign, a reversed sort, a dropped term), and runs the unit
// tests against each broken copy. A change the tests do not notice ("survived") marks a place the suite is not really guarding.
//
//   node scripts/mutation-check.js [--match text]   (about 4 minutes for everything; --match runs only the breakages whose description contains the text; changes are made to a temporary copy of the project, never to the real files)
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// [file, what was changed, exact text to find, replacement]
const ALL_MUTATIONS = [
  ['lib/projection.js', 'market weight flipped (model gets the market\'s share)', 'const marketWeight = 1 - wModel;', 'const marketWeight = wModel;'],
  ['server.js', 'call picks the worse-value side', '.sort((x, y) => (y.ev ?? -9) - (x.ev ?? -9))', '.sort((x, y) => (x.ev ?? -9) - (y.ev ?? -9))'],
  ['server.js', 'model and market swapped in the blend', 'market.blendLogit(modelUsed, marketProb, wProb)', 'market.blendLogit(marketProb, modelUsed, wProb)'],
  ['server.js', 'push chance ignored in the assessment', 'const push = probs.pushProbability || 0;', 'const push = 0;'],
  ['server.js', 'edge over price measured from the model chance, not the final chance', 'o.prob != null && breakEven != null ? parseFloat(((o.prob - breakEven)', 'o.prob != null && breakEven != null ? parseFloat(((o.modelProb - breakEven)'],
  ['lib/projection.js', 'questionable players count in full for missing production', "['out', 'doubtful'].includes((ip.status || '').toLowerCase()) ? 1.0 : 0.5;", "['out', 'doubtful'].includes((ip.status || '').toLowerCase()) ? 1.0 : 1.0;"],
  ['lib/projection.js', 'bench players counted as regulars', "(parseFloat(r.MIN) || 0) / gp >= 20) regulars.push({ name: p.name", "(parseFloat(r.MIN) || 0) / gp >= 2) regulars.push({ name: p.name"],
  ['lib/projection.js', 'whole-number line push band collapsed', 'const lo = cdf(line - 0.5), hi = cdf(line + 0.5)', 'const lo = cdf(line - 0.5), hi = cdf(line - 0.5)'],
  ['lib/projection.js', 'count-model push dropped', 'const push = whole ? pmf[line] || 0 : 0, over', 'const push = 0, over'],
  ['server.js', 'questionable injuries ignored by the late-news signature', "['out', 'doubtful', 'questionable'].includes(String(p.status || '').toLowerCase()))\n    .map(", "['out', 'doubtful'].includes(String(p.status || '').toLowerCase()))\n    .map("],
  ['server.js', 'a status change is reported as a clearance', 'for (const name of b.keys()) if (!a.has(name)) parts.push', 'for (const name of b.keys()) if (true) parts.push'],
  ['server.js', 'Kelly stake cap removed', 'Math.min(fullKelly * kellyMultiplier, maxFraction)', 'fullKelly * kellyMultiplier'],
  ['lib/projection.js', 'projection blend ignores the number of books', 'const bookFactor = bookCount >= 4 ? 1 : bookCount >= 2 ? 0.9 : 0.75;', 'const bookFactor = 1;'],
  ['lib/projection.js', 'negative-binomial branch of the count model removed', 'if (ratio > 1.02) {', 'if (false) {'],
  ['lib/market.js', 'power de-vig solves the wrong way', 'if (Math.pow(po, k) + Math.pow(pu, k) > 1) lo = k; else hi = k;', 'if (Math.pow(po, k) + Math.pow(pu, k) < 1) lo = k; else hi = k;'],
  ['lib/market.js', 'blend weights swapped', 'sigmoid(w * logit(clampP(pModel, 0.005, 0.995)) + (1 - w) * logit(clampP(pMarket, 0.005, 0.995)))', 'sigmoid((1 - w) * logit(clampP(pModel, 0.005, 0.995)) + w * logit(clampP(pMarket, 0.005, 0.995)))'],
  ['lib/market.js', 'EV ignores the push refund', 'const live = 1 - Math.min(0.9, Math.max(0, pPush || 0));', 'const live = 1;'],
  ['lib/market.js', 'best Over line is the highest, not the lowest', 'if (!over || o.point < over.point ||', 'if (!over || o.point > over.point ||'],
  ['lib/market.js', 'far-away books are kept instead of dropped', 'if (Math.abs(gap) > shiftLimit) continue;', 'if (Math.abs(gap) > shiftLimit * 1000) continue;'],
  ['lib/market.js', 'a book on another number is not moved to the line', 'if (gap !== 0) { const mu', 'if (false) { const mu'],
  ['lib/market.js', 'American odds sign flipped', 'return p > 0 ? 100 / (p + 100) : -p / (-p + 100);\n}\nfunction decimalFromAmerican', 'return p > 0 ? -p / (-p + 100) : 100 / (p + 100);\n}\nfunction decimalFromAmerican'],
  ['lib/market.js', 'one-sided book given no margin', 'return clampP(po / TYPICAL_MARGIN);', 'return clampP(po);'],
  ['lib/evaluate.js', 'outcome of the Over reversed', 'const y = a > L ? 1 : 0;', 'const y = a > L ? 0 : 1;'],
  ['lib/evaluate.js', 'rows without a result read as a zero stat', 'if (r.actual == null) continue;                          // no result yet', 'if (false) continue;                          // no result yet'],
  ['lib/lab.js', 'predictions peek at the game being predicted', 'num_ = gamma * num_ + x; den = gamma * den + 1; sum += x; hist.push(x);\n  }', 'num_ = gamma * num_ + x; den = gamma * den + 1; sum += x; hist.push(x);\n  }\n  for (const o of out) { o.ewma = o.actual; o.pred = o.actual; }'],
  ['lib/lab.js', 'missing teammates counted from the whole squad, not regulars', 'if (inLast10 >= 5 && mean(apps.map(a => a.MIN)) >= 20) rotation.push(pid);', 'if (inLast10 >= 1) rotation.push(pid);'],
  ['lib/lanequeue.js', 'background work jumps ahead of visitors', "const lane = waiting.high.length ? 'high' : (waiting.low.length && lowRunning < lowConcurrency ? 'low' : null);", "const lane = waiting.low.length && lowRunning < lowConcurrency ? 'low' : (waiting.high.length ? 'high' : null);"],
  ['lib/lanequeue.js', 'the minimum gap between starts is ignored', 'const wait = minGapMs - (now() - lastStart);', 'const wait = 0;'],
  ['lib/params.js', 'invalid numbers in the tuning file are kept', 'loadProblems = sanitize(merged);', 'loadProblems = [];'],
  ['lib/params.js', 'minutes share no longer capped', 'Math.min(0.9, Math.max(0.1, min / sens))', 'min / sens'],
  ['lib/slatefill.js', 'a game with props is asked again', 'if (i && i.count > 0) return false;', 'if (false) return false;'],
  ['server.js', 'late news never acts on an injury change', 'if (diff) changed.push({ id, i, sigs, diff });', 'if (false) changed.push({ id, i, sigs, diff });'],
  ['server.js', 'players set aside after three days become set aside immediately', 'if (!game) { if (row.date <= threeDaysAgo)', 'if (!game) { if (row.date >= threeDaysAgo)'],
  ['server.js', 're-priced games are not remembered, so they are re-priced every tick', 'info[id].reprojectedAt = now;', ''],
  ['server.js', 'late news ignores low credits', "if (b.known && b.remaining < FILL_COST_PER_GAME + b.critAt && process.env.ODDS_ALLOW_LOW_CREDITS !== '1') { skipped++; continue; }", 'if (false) { skipped++; continue; }'],
  ['server.js', 'top-up leaves yesterday\'s picks cached', 'delete topPlaysCache[league]; delete teamPicksCache[league];\n      if (datachecks.inSeason(league, new Date())) autoLogSlatePicks(league, newResults);', 'if (datachecks.inSeason(league, new Date())) autoLogSlatePicks(league, newResults);'],
  ['lib/db.js', 'the scan log stores duplicates', 'INSERT OR IGNORE INTO scan_props', 'INSERT INTO scan_props'],
  ['lib/report.js', 'the day\'s record includes every earlier day', 'const dayPicks = graded.filter(p => p.day === date)', 'const dayPicks = graded.filter(p => p.day <= date)'],
  ['server.js', 'the report goes out every time the pipeline runs', "if (!force && store.getMeta('grading-report:date') === date) return", "if (false) return"],
  ['server.js', 'people\'s saved props end up in the admin report', "const all = loadCLV().filter(e => e.source === 'auto');", "const all = loadCLV();"],
  ['server.js', 'a failed email stops the day being recorded', "catch (e) { console.error('[Report] email failed:', e.message); store.addEvent('grading-report', 'warn', `The grading report email could not be sent: ${e.message}`); }", "catch (e) { throw e; }"],
  ['lib/picks.js', 'a game\'s picks are the worst three, not the best', 'rows.sort((a, b) => (evOf(b) - evOf(a))', 'rows.sort((a, b) => (evOf(a) - evOf(b))'],
  ['lib/picks.js', 'one player can fill all three spots', 'if (seen.has(r.player)) continue;', ''],
  ['lib/picks.js', 'a game gets more than three picks', 'if (picks.length >= n) break;', ''],
  ['lib/picks.js', 'props without a real price are ranked', 'const isPickable = r => !!(r && r.direction && r.realEdge && Number.isFinite(evOf(r)));', 'const isPickable = r => !!(r && r.direction);'],
  ['server.js', 'only the single best prop slate-wide is logged', 'const withEdge = picksLib.flattenPicks(picksLib.topPicksPerGame(results));      // the top three in each game', 'const withEdge = picksLib.flattenPicks(picksLib.topPicksPerGame(results, 1));'],
  ['server.js', 'picks are logged for games already under way', 'filter(r => !started.has(`${r.awayTeam}@${r.homeTeam}`))', 'filter(r => true)'],
];

const matchArg = process.argv.indexOf('--match') > 0 ? process.argv[process.argv.indexOf('--match') + 1] : null;
const MUTATIONS = matchArg ? ALL_MUTATIONS.filter(m => m[1].includes(matchArg) || m[0].includes(matchArg)) : ALL_MUTATIONS;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-'));
const copy = () => {
  const dst = path.join(tmp, 'p'); fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(ROOT, dst, { recursive: true, filter: s => !/node_modules$|\.git$|lab_data|backups|\.db($|-)|slate_scan_cache|season_raw|prior_season|\.bak$/.test(s) || /prior_season$/.test(s) && false });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dst, 'node_modules'));
  return dst;
};
const tests = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js') && f !== 'season-blend.test.js').map(f => path.join('test', f));
const run = dir => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', ...tests], { cwd: dir, encoding: 'utf8', timeout: 240000 });

console.log(`${MUTATIONS.length} deliberate breakages, ${tests.length} test files.\n`);
const base = run(copy());
if (base.status !== 0) { console.error('The tests fail even without a breakage; fix that first.\n' + (base.stdout || '').split('\n').filter(l => /✖|fail/.test(l)).slice(0, 8).join('\n')); process.exit(2); }

let caught = 0; const survived = [], notFound = [];
for (const [file, what, find, repl] of MUTATIONS) {
  const dir = copy(), fp = path.join(dir, file), src = fs.readFileSync(fp, 'utf8');
  if (!src.includes(find)) { notFound.push(what); console.log(`  ?  not found (the code changed): ${what}`); continue; }
  fs.writeFileSync(fp, src.replace(find, repl));
  const r = run(dir), ok = r.status !== 0;
  if (ok) caught++; else survived.push(`${file}: ${what}`);
  console.log(`  ${ok ? 'caught  ' : 'SURVIVED'}  ${file}  ${what}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
const total = MUTATIONS.length - notFound.length;
console.log(`\n${caught} of ${total} breakages caught${survived.length ? `; ${survived.length} slipped past the tests:\n  - ${survived.join('\n  - ')}` : ''}${notFound.length ? `\n${notFound.length} no longer match the code and need updating` : ''}`);
process.exit(survived.length || notFound.length ? 1 : 0);
