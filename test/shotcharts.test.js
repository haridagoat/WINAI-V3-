// Shot charts built on the owner's computer and served when nba.com does not answer the server (lib/shotcharts.js, fetchShotChart).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const S = require('../lib/shotcharts');
const { isStatsFileName } = require('../lib/statsupload');
const { extract } = require('./helpers/extract');

const chart = name => ({ mode: 'player', name, season: '2026-27', totalShots: 300, zones: [{ zone: 'Mid-Range', fga: 10 }], shots: [] });
function bundleDir(charts, builtAt = '2026-11-20T13:00:00Z') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winai-sc-'));
  fs.writeFileSync(path.join(dir, 'shotcharts_nba.json'), JSON.stringify({ builtAt, season: '2026-27', charts }));
  return dir;
}

test('keys ignore accents, dots, hyphens and case, so a sportsbook spelling finds the player', () => {
  assert.equal(S.keyOf('player', 'Nikola Jokić'), S.keyOf('player', 'nikola jokic'));
  assert.equal(S.keyOf('player', 'P.J. Washington'), S.keyOf('player', 'PJ Washington'));
  assert.notEqual(S.keyOf('player', 'Denver Nuggets'), S.keyOf('defense', 'Denver Nuggets'));
  assert.equal(S.keyOf('whatever', 'X'), 'player|x');
});

test('a chart is found by player or team, marked as uploaded, and a missing or errored one is null', () => {
  const b = { builtAt: 'T', charts: { [S.keyOf('player', 'Nikola Jokić')]: chart('Nikola Jokić'), [S.keyOf('defense', 'Denver Nuggets')]: { mode: 'defense', zones: [{}] }, [S.keyOf('player', 'Bad')]: { error: 'x' } } };
  const r = S.lookup(b, 'player', 'Nikola Jokic'); assert.equal(r.name, 'Nikola Jokić'); assert.equal(r.source, 'uploaded'); assert.equal(r.builtAt, 'T');
  assert.equal(S.lookup(b, 'defense', 'denver nuggets').mode, 'defense');
  for (const [m, n] of [['player', 'Nobody'], ['player', 'Bad'], ['defense', 'Nikola Jokic']]) assert.equal(S.lookup(b, m, n), null);
  assert.equal(S.lookup(null, 'player', 'x'), null); assert.equal(S.lookup({}, 'player', 'x'), null);
});

test('the file is read once and again only when it changes; a missing or broken file is just "no charts"', () => {
  const dir = bundleDir({ [S.keyOf('player', 'A B')]: chart('A B') });
  const read = S.createBundleReader(dir);
  const a = read('nba'); assert.equal(read('nba'), a, 'the same object while the file is unchanged');
  assert.equal(read('wnba'), null);
  const file = path.join(dir, 'shotcharts_nba.json');
  fs.writeFileSync(file, JSON.stringify({ builtAt: 'NEW', charts: { [S.keyOf('player', 'C D')]: chart('C D') } })); const t = new Date(Date.now() + 5000); fs.utimesSync(file, t, t);
  assert.equal(read('nba').builtAt, 'NEW');
  fs.writeFileSync(file, '{not json'); const t2 = new Date(Date.now() + 9000); fs.utimesSync(file, t2, t2); assert.equal(read('nba'), null);
});

test('the bundle files are accepted by the stats upload, and look-alike names are not', () => {
  assert.ok(isStatsFileName('shotcharts_nba.json')); assert.ok(isStatsFileName('shotcharts_wnba.json'));
  for (const n of ['shotcharts.js', 'shotcharts_nba.json/../x.json', '../shotcharts_nba.json', 'shotcharts_nba.db']) assert.ok(!isStatsFileName(n), n);
});

// ── the server's fetchShotChart ──
function world({ source = 'auto', python, bundle }) {
  const calls = { python: 0 }; const cache = {};
  const dir = bundle ? bundleDir(bundle) : fs.mkdtempSync(path.join(os.tmpdir(), 'winai-sc-'));
  const read = S.createBundleReader(dir);
  const g = { shotChartCache: cache, SHOT_CHART_TTL: 1800e3, GAMELOG_SOURCE: undefined, shotCharts: S, shotChartBundles: l => read(l), currentNbaSeason: () => '2026-27', security: { badString: () => false },
    enqueueBridge: fn => fn(), path, __dirname: '/app', Buffer, console, Date, setTimeout, clearTimeout, spawn: () => { calls.python++; return python(); } };
  const bridgeHealth = { fails: 0, downUntil: 0 };
  const f = extract({ functions: ['fetchShotChart', 'noteBridge'], consts: ['GAMELOG_SOURCE', 'bridgeHealth', 'bridgeIsDown', 'isBridgeOutage'], globals: { ...g, process: { env: { GAMELOG_SOURCE: source } }, store: { addEvent() {} } } });
  return { f, calls, cache };
}
const fakePy = out => { const hs = {}; const py = { stdout: { on: (e, fn) => { if (e === 'data') hs.o = fn; } }, stderr: { on() {} }, on: (e, fn) => { if (e === 'close') hs.c = fn; }, kill() {} }; setImmediate(() => { if (out && hs.o) hs.o(Buffer.from(out)); hs.c && hs.c(0); }); return py; };
const BUNDLE = { [S.keyOf('player', 'Nikola Jokić')]: chart('Nikola Jokić') };

test('nba.com answering: its chart is used and the upload is not consulted', async () => {
  const w = world({ python: () => fakePy(JSON.stringify(chart('Live One'))), bundle: BUNDLE });
  const r = await w.f.fetchShotChart('nba', 'player', 'Nikola Jokic'); assert.equal(r.name, 'Live One'); assert.equal(w.calls.python, 1);
});

test('nba.com not answering (empty output, as from Railway): the uploaded chart is served instead of an error', async () => {
  const w = world({ python: () => fakePy(''), bundle: BUNDLE });
  const r = await w.f.fetchShotChart('nba', 'player', 'Nikola Jokic'); assert.equal(r.source, 'uploaded'); assert.equal(r.name, 'Nikola Jokić');
  assert.equal((await w.f.fetchShotChart('nba', 'player', 'Nikola Jokic')).source, 'uploaded', 'and it is cached');
});

test('after three failures nba.com is paused and the script is not started at all; the upload answers', async () => {
  const w = world({ python: () => fakePy(''), bundle: BUNDLE });
  for (const n of ['A', 'B', 'C']) await w.f.fetchShotChart('nba', 'player', n);
  const before = w.calls.python; const r = await w.f.fetchShotChart('nba', 'player', 'Nikola Jokic');
  assert.equal(r.source, 'uploaded'); assert.equal(w.calls.python, before);
});

test('GAMELOG_SOURCE=espn (Railway): never starts the script; a player not in the upload gets a plain message, not a crash', async () => {
  const w = world({ source: 'espn', python: () => fakePy(''), bundle: BUNDLE });
  assert.equal((await w.f.fetchShotChart('nba', 'player', 'Nikola Jokic')).source, 'uploaded');
  const miss = await w.f.fetchShotChart('nba', 'player', 'Rookie Nobody'); assert.match(miss.error, /No shot chart is available/); assert.equal(w.calls.python, 0);
});

test('with no upload at all, an outage still returns the same error as before (nothing new breaks)', async () => {
  const w = world({ python: () => fakePy(''), bundle: null });
  const r = await w.f.fetchShotChart('nba', 'player', 'Anyone'); assert.match(r.error, /parse error/i);
});
