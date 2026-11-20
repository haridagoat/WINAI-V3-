#!/usr/bin/env node
// Builds every player's and team's shot chart on this computer (nba.com answers it; Railway does not) into shotcharts_nba.json, which
// scripts/push-stats.js then uploads with the stat files. The live site serves these when it cannot reach nba.com itself.
//
//   node scripts/build-shotcharts.js            NBA (players averaging 10+ minutes, and all 30 teams' defense)
//   node scripts/build-shotcharts.js wnba       WNBA
//   node scripts/build-shotcharts.js --limit 5  only the first 5 players (to try it)
//
// A chart that fails this time keeps its previous copy, so one bad answer never empties the file. Takes about 10 minutes.
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');
const { keyOf, fileFor } = require('../lib/shotcharts');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const league = args.includes('wnba') ? 'wnba' : 'nba';
const limit = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) || 0 : 0; })();
const MIN_PER_GAME = 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function season() {
  try { const m = JSON.parse(fs.readFileSync(path.join(root, 'season_meta.json'), 'utf8')); if (m.season) return m.season; } catch (_) {}
  const d = new Date(), y = d.getMonth() >= 9 ? d.getFullYear() : d.getFullYear() - 1;
  return league === 'wnba' ? String(d.getFullYear()) : `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch (_) { return null; } };

function chart(mode, name, seasonStr) {
  const r = spawnSync('python3', [path.join(root, 'shotchart.py'), league, mode, name, seasonStr], { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0 && !r.stdout) return { error: (r.stderr || 'failed').slice(0, 120) };
  try { return JSON.parse(r.stdout.trim()); } catch (_) { return { error: 'not json' }; }
}

(async () => {
  const seasonStr = season();
  const statsFile = league === 'wnba' ? 'wnba_player_stats.json' : 'player_stats.json';
  // The blended stat file keeps last season's rows for players who have not played yet, so use this season's own file when it is here
  // (season_raw/), else keep only rows whose games played fit this season so far.
  let stats = readJson(path.join('season_raw', statsFile));
  if (!Array.isArray(stats) || !stats.length) {
    stats = readJson(statsFile);
    if (Array.isArray(stats)) { const teamGp = Math.max(0, ...(readJson(league === 'wnba' ? 'wnba_team_advanced.json' : 'team_advanced.json') || []).map(t => t.GP || 0)); if (teamGp) stats = stats.filter(r => r.GP <= teamGp); }
  }
  if (!Array.isArray(stats) || !stats.length) { console.error(`No ${statsFile} here. Run the stats fetch first.`); process.exit(1); }
  let players = stats.filter(r => r.PLAYER_NAME && r.GP && (r.MIN / r.GP) >= MIN_PER_GAME).sort((a, b) => b.MIN - a.MIN).map(r => r.PLAYER_NAME);
  const teams = [...new Set(stats.map(r => r.TEAM_ABBREVIATION).filter(Boolean))];
  const teamNames = readJson(league === 'wnba' ? 'wnba_team_advanced.json' : 'team_advanced.json');
  const teamList = Array.isArray(teamNames) ? teamNames.map(t => t.TEAM_NAME).filter(Boolean) : [];
  if (limit) players = players.slice(0, limit);

  const file = fileFor(root, league);
  let old = {}; try { old = JSON.parse(fs.readFileSync(file, 'utf8')).charts || {}; } catch (_) {}
  const charts = {};
  let ok = 0, failed = 0, kept = 0, blocked = 0, empty = 0;
  const jobs = [...players.map(n => ['player', n]), ...(limit ? [] : teamList.map(n => ['defense', n]))];
  console.log(`${league.toUpperCase()} ${seasonStr}: ${players.length} players and ${limit ? 0 : teamList.length} teams`);
  for (const [i, [mode, name]] of jobs.entries()) {
    const c = chart(mode, name, seasonStr);
    const k = keyOf(mode, name);
    if (c && !c.error && (c.zones || []).length) { charts[k] = c; ok++; blocked = 0; }
    else if (c && !c.error && (c.totalShots === 0 || c.totalShotsFaced === 0)) { empty++; blocked = 0; }   // answered, but no shots this season (injured, new)
    else { failed++; blocked++; if (old[k]) { charts[k] = old[k]; kept++; } }
    if (blocked >= 12) { console.error('nba.com stopped answering (12 failures in a row). Keeping what was built so far plus the previous copies.'); for (const k2 of Object.keys(old)) if (!charts[k2]) { charts[k2] = old[k2]; kept++; } break; }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${jobs.length}  ok ${ok}  no shots ${empty}  failed ${failed}`);
    await sleep(500);
  }
  if (!ok) { console.error(empty && !failed ? 'Every one tried had no shots yet.' : 'Nothing new could be built, so the existing file was left alone.'); process.exit(1); }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ builtAt: new Date().toISOString(), season: seasonStr, league, charts }));
  fs.renameSync(tmp, file);
  console.log(`Done: ${Object.keys(charts).length} charts (${ok} new, ${kept} kept from before, ${empty} with no shots yet, ${failed} failed) -> ${path.basename(file)}, ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
})();
