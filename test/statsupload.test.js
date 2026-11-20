// Stat files uploaded from the owner's computer: only real stat file names, only valid JSON, written safely, restored after a deploy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const U = require('../lib/statsupload');

const body = files => Buffer.from(JSON.stringify({ files }));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'winai-stats-'));

test('the names the fetch scripts produce are accepted', () => {
  for (const n of ['player_stats.json', 'team_advanced.json', 'wnba_player_stats.json', 'playtype_isolation_player_off.json', 'tracking_drives_team.json', 'hustle_team.json',
    'shotdash_general_player.json', 'opp_shotdash_general_team.json', 'defense_overall.json', 'dvp_positions.json', 'season_meta.json', '.shotchart_benchmark_nba_2025-26.json', '.wnba_stats_zonetable_2026.json'])
    assert.ok(U.isStatsFileName(n), n);
});

test('the app\'s own files, paths and odd names are refused', () => {
  for (const n of ['server.js', 'package.json', '.env', 'winai.db', 'scouting_notes.json', 'slate_scan_cache.json', 'model_params.json', 'railway.json', '../player_stats.json', 'sub/player_stats.json',
    'player_stats.json/../../x.json', 'player_stats.js', 'player_stats', '', null, 42, 'player_' + 'x'.repeat(120) + '.json'])
    assert.ok(!U.isStatsFileName(n), String(n));
});

test('an upload must be valid JSON files with allowed names, otherwise nothing is accepted', () => {
  assert.deepEqual(Object.keys(U.parseUpload(body({ 'player_stats.json': '[{"a":1}]' })).files), ['player_stats.json']);
  assert.throws(() => U.parseUpload('nope'), /not valid JSON/);
  assert.throws(() => U.parseUpload(body({})), /No files/);
  assert.throws(() => U.parseUpload(Buffer.from('{"files":[1]}')), /files/);
  assert.throws(() => U.parseUpload(body({ 'server.js': '{}' })), /not a stats file name/);
  assert.throws(() => U.parseUpload(body({ 'player_stats.json': '[1]', '../x.json': '{}' })), /not a stats file name/, 'one bad name rejects the whole upload');
  assert.throws(() => U.parseUpload(body({ 'player_stats.json': '{broken' })), /not valid JSON/);
  assert.throws(() => U.parseUpload(body({ 'player_stats.json': '' })), /empty/);
  assert.throws(() => U.parseUpload(body({ 'player_stats.json': 5 })), /empty/);
});

test('files are written to the app folder and the kept folder, with no temporary files left behind', () => {
  const app = tmp(), keep = path.join(tmp(), 'stats');
  const saved = U.saveFiles({ 'player_stats.json': '[{"p":1}]', 'team_base.json': '{"t":2}' }, [app, keep, null]);
  assert.deepEqual(saved.sort(), ['player_stats.json', 'team_base.json']);
  for (const d of [app, keep]) {
    assert.equal(fs.readFileSync(path.join(d, 'player_stats.json'), 'utf8'), '[{"p":1}]');
    assert.deepEqual(fs.readdirSync(d).sort(), ['player_stats.json', 'team_base.json'], 'no .tmp files');
  }
});

test('after a deploy the kept files come back, newer ones win, and the app\'s own files are never touched', () => {
  const app = tmp(), keep = tmp();
  fs.writeFileSync(path.join(keep, 'player_stats.json'), '[1]'); fs.writeFileSync(path.join(keep, 'team_base.json'), '[2]');
  fs.writeFileSync(path.join(keep, 'server.js'), 'evil'); fs.writeFileSync(path.join(keep, 'notes.txt'), 'x');
  const old = new Date('2026-11-01T00:00:00Z'), fresh = new Date('2026-11-19T00:00:00Z');
  fs.utimesSync(path.join(keep, 'player_stats.json'), fresh, fresh); fs.utimesSync(path.join(keep, 'team_base.json'), old, old);
  fs.writeFileSync(path.join(app, 'team_base.json'), '[newer here]'); fs.utimesSync(path.join(app, 'team_base.json'), fresh, fresh);
  assert.equal(U.restoreFromKeep(keep, app), 1);
  assert.equal(fs.readFileSync(path.join(app, 'player_stats.json'), 'utf8'), '[1]');
  assert.equal(fs.statSync(path.join(app, 'player_stats.json')).mtime.toISOString(), fresh.toISOString(), 'the original time is kept, so freshness checks stay honest');
  assert.equal(fs.readFileSync(path.join(app, 'team_base.json'), 'utf8'), '[newer here]');
  assert.ok(!fs.existsSync(path.join(app, 'server.js')) && !fs.existsSync(path.join(app, 'notes.txt')));
  assert.equal(U.restoreFromKeep(path.join(keep, 'missing'), app), 0, 'no kept folder yet is fine');
});

test('the files keep the time they were really fetched, so a stale file never looks fresh', () => {
  const real = Date.parse('2026-11-18T12:00:00Z');
  const up = U.parseUpload(Buffer.from(JSON.stringify({ files: { 'player_stats.json': '[1]', 'team_base.json': '[2]', 'defense_overall.json': '[3]' },
    mtimes: { 'player_stats.json': real, 'team_base.json': Date.now() + 9e9, 'defense_overall.json': 'yesterday' } })));
  assert.equal(up.mtimes['player_stats.json'], real);
  assert.ok(up.mtimes['team_base.json'] <= Date.now(), 'a time in the future is capped at now');
  assert.ok(!('defense_overall.json' in up.mtimes), 'nonsense is ignored');
  assert.deepEqual(U.parseUpload(body({ 'player_stats.json': '[1]' })).mtimes, {}, 'mtimes are optional');
  const dir = tmp();
  U.saveFiles(up.files, [dir], up.mtimes);
  assert.equal(fs.statSync(path.join(dir, 'player_stats.json')).mtimeMs, real);
});
