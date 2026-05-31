require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cron = require('node-cron');
const path    = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────
// CACHE LAYER — everything lives here, read once
// ─────────────────────────────────────────────────────
let todaysGames       = [];
let playerStatsCache  = {};   // keyed by player name
let projectionCache   = {};   // keyed by 'playerName:propType' — persists all day, clears on injury

function injuryHash(playerRoster) {
  if (!playerRoster?.injured?.length) return 'none';
  return playerRoster.injured.map(p => p.name + p.status).sort().join('|');
}
function getCachedProjection(playerName, propType, curInjuryHash) {
  const key = `${playerName}:${propType}`;
  const c = projectionCache[key];
  if (!c) return null;
  if (c.injuryHash !== curInjuryHash) {
    delete projectionCache[key];
    console.log(`[Proj] Injury change for ${playerName} — recalculating`);
    return null;
  }
  return c.projection;
}
function setCachedProjection(playerName, propType, projection, curInjuryHash) {
  projectionCache[`${playerName}:${propType}`] = { projection, injuryHash: curInjuryHash };
}
let rosterCache       = {};   // keyed by ESPN team abbreviation
let lastRosterFetch   = {};   // timestamps per team
let lineupCache       = null;
let lastLineupFetch   = null;
let nbaStatsCache     = null; // loaded once from disk, cleared at midnight
let lastStatsDiskRead = 0;

const BALLDONTLIE   = 'https://api.balldontlie.io/v1';
const ODDS_BASE     = 'https://api.the-odds-api.com/v4';
const RAPIDAPI_HOST = 'tank01-fantasy-stats.p.rapidapi.com';
const ESPN_BASE     = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';

// ESPN team abbreviation map — covers all 30 teams + common aliases
const ESPN_TEAM_MAP = {
  'atlanta hawks': 'atl', 'hawks': 'atl',
  'boston celtics': 'bos', 'celtics': 'bos',
  'brooklyn nets': 'bkn', 'nets': 'bkn',
  'charlotte hornets': 'cha', 'hornets': 'cha',
  'chicago bulls': 'chi', 'bulls': 'chi',
  'cleveland cavaliers': 'cle', 'cavaliers': 'cle', 'cavs': 'cle',
  'dallas mavericks': 'dal', 'mavericks': 'dal', 'mavs': 'dal',
  'denver nuggets': 'den', 'nuggets': 'den',
  'detroit pistons': 'det', 'pistons': 'det',
  'golden state warriors': 'gs', 'warriors': 'gs', 'golden state': 'gs',
  'houston rockets': 'hou', 'rockets': 'hou',
  'indiana pacers': 'ind', 'pacers': 'ind',
  'la clippers': 'lac', 'clippers': 'lac', 'los angeles clippers': 'lac',
  'los angeles lakers': 'lal', 'lakers': 'lal', 'la lakers': 'lal',
  'memphis grizzlies': 'mem', 'grizzlies': 'mem',
  'miami heat': 'mia', 'heat': 'mia',
  'milwaukee bucks': 'mil', 'bucks': 'mil',
  'minnesota timberwolves': 'min', 'timberwolves': 'min', 'wolves': 'min',
  'new orleans pelicans': 'no', 'pelicans': 'no', 'new orleans': 'no',
  'new york knicks': 'ny', 'knicks': 'ny', 'new york': 'ny',
  'oklahoma city thunder': 'okc', 'thunder': 'okc', 'oklahoma city': 'okc',
  'orlando magic': 'orl', 'magic': 'orl',
  'philadelphia 76ers': 'phi', '76ers': 'phi', 'sixers': 'phi',
  'phoenix suns': 'phx', 'suns': 'phx',
  'portland trail blazers': 'por', 'trail blazers': 'por', 'blazers': 'por',
  'sacramento kings': 'sac', 'kings': 'sac',
  'san antonio spurs': 'sa', 'spurs': 'sa', 'san antonio': 'sa',
  'toronto raptors': 'tor', 'raptors': 'tor',
  'utah jazz': 'utah', 'jazz': 'utah',
  'washington wizards': 'wsh', 'wizards': 'wsh', 'washington': 'wsh',
};

function resolveESPNTeam(teamName) {
  const lower = teamName.toLowerCase().trim();
  return ESPN_TEAM_MAP[lower] || null;
}

// ─────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────
function getToday()        { return new Date().toISOString().split('T')[0]; }
function getTodayCompact() { return getToday().replace(/-/g, ''); }

function calcAvg(games, key) {
  const vals = games.map(g => parseFloat(g[key]) || 0).filter(v => v >= 0);
  if (!vals.length) return '0.0';
  return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
}

function calcStdDev(games, key) {
  const vals = games.map(g => parseFloat(g[key]) || 0);
  if (!vals.length) return '0.0';
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / vals.length).toFixed(1);
}

// Full-name fuzzy match — avoids wrong-player errors from last-name-only search
function fuzzyMatchPlayer(list, fullName) {
  const lower = fullName.toLowerCase();
  const parts = lower.split(' ');
  const first = parts[0];
  const last  = parts[parts.length - 1];
  // Exact full name match first
  let match = list.find(p => (p.PLAYER_NAME || p.name || '').toLowerCase() === lower);
  // Then first + last
  if (!match) match = list.find(p => {
    const n = (p.PLAYER_NAME || p.name || '').toLowerCase();
    return n.includes(first) && n.includes(last);
  });
  // Last name only as last resort
  if (!match) match = list.find(p => (p.PLAYER_NAME || p.name || '').toLowerCase().includes(last));
  return match || null;
}

// ─────────────────────────────────────────────────────
// NBA STATS FILE LOADER — cached in memory, not re-read every request
// ─────────────────────────────────────────────────────
function loadNBAStats() {
  const now = Date.now();
  if (nbaStatsCache && (now - lastStatsDiskRead) < 5 * 60 * 1000) return nbaStatsCache;

  const load = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { return null; }
  };

  const exists = (f) => fs.existsSync(f);

  // Core files
  nbaStatsCache = {
    // General
    teamAdvanced:       load('team_advanced.json'),
    teamBase:           load('team_base.json'),
    teamTraditional:    load('team_traditional.json'),
    teamFourFactors:    load('team_four_factors.json'),
    teamMisc:           load('team_misc.json'),
    teamScoring:        load('team_scoring.json'),
    teamOppShooting:    load('team_opp_shooting.json'),
    teamDefense:        load('team_defense.json'),
    teamPaintDef:       load('team_paint_defense.json'),
    // Player general
    playerStats:        load('player_stats.json'),
    playerAdvanced:     load('player_advanced.json'),
    playerMisc:         load('player_misc.json'),
    playerScoring:      load('player_scoring.json'),
    playerOpponent:     load('player_opponent.json'),
    playerPaint:        load('player_paint_stats.json'),
    // Playtypes (player offense)
    playtypeIso:        load('playtype_isolation_player_off.json'),
    playtypeTransition: load('playtype_transition_player_off.json'),
    playtypePRBall:     load('playtype_ballhandler_player_off.json'),
    playtypePRRoll:     load('playtype_rollman_player_off.json'),
    playtypePostUp:     load('playtype_postup_player_off.json'),
    playtypeSpotUp:     load('playtype_spotup_player_off.json'),
    playtypeCut:        load('playtype_cut_player_off.json'),
    playtypeHandoff:    load('playtype_handoff_player_off.json'),
    playtypeOffScreen:  load('playtype_offscreen_player_off.json'),
    playtypePutbacks:   load('playtype_putbacks_player_off.json'),
    // Playtypes (team defense)
    teamDefIso:         load('playtype_isolation_team_def.json'),
    teamDefTransition:  load('playtype_transition_team_def.json'),
    teamDefPRBall:      load('playtype_ballhandler_team_def.json'),
    teamDefPRRoll:      load('playtype_rollman_team_def.json'),
    teamDefPostUp:      load('playtype_postup_team_def.json'),
    teamDefSpotUp:      load('playtype_spotup_team_def.json'),
    teamDefCut:         load('playtype_cut_team_def.json'),
    teamDefHandoff:     load('playtype_handoff_team_def.json'),
    teamDefOffScreen:   load('playtype_offscreen_team_def.json'),
    // Tracking
    trackingDrives:     load('tracking_drives_player.json'),
    trackingCatchShoot: load('tracking_catchshoot_player.json'),
    trackingPassing:    load('tracking_passing_player.json'),
    trackingTouches:    load('tracking_touches_player.json'),
    trackingPullUp:     load('tracking_pullupshot_player.json'),
    trackingElbow:      load('tracking_elbowtouch_player.json'),
    trackingPost:       load('tracking_posttouch_player.json'),
    trackingPaint:      load('tracking_painttouch_player.json'),
    trackingSpeed:      load('tracking_speeddistance_player.json'),
    trackingEfficiency: load('tracking_efficiency_player.json'),
    trackingOffReb:     load('tracking_offensivereboundchances_player.json'),
    trackingDefReb:     load('tracking_defensivereboundchances_player.json'),
    // Defense dashboard
    defenseOverall:     load('defense_overall.json'),
    defense3PT:         load('defense_3pt.json'),
    defense2PT:         load('defense_2pt.json'),
    defenseLT6ft:       load('defense_lt6ft.json'),
    defenseLT10ft:      load('defense_lt10ft.json'),
    defenseGT15ft:      load('defense_gt15ft.json'),
    // Shot dashboard
    shotDashGeneral:    load('shotdash_general_player.json'),
    shotDashShotClock:  load('shotdash_shotclock_player.json'),
    shotDashDribbles:   load('shotdash_dribbles_player.json'),
    shotDashTouch:      load('shotdash_touchtime_player.json'),
    shotDashCloseDef:   load('shotdash_closestdef_player.json'),
    // Opponent shot dashboard (team)
    oppShotGeneral:     load('opp_shotdash_general_team.json'),
    oppShotClock:       load('opp_shotdash_shotclock_team.json'),
    oppShotDribbles:    load('opp_shotdash_dribbles_team.json'),
    oppShotTouch:       load('opp_shotdash_touchtime_team.json'),
    oppShotCloseDef:    load('opp_shotdash_closestdef_team.json'),
    // Hustle
    hustlePlayer:       load('hustle_player.json'),
    hustleTeam:         load('hustle_team.json'),

    dataAvailable: {
      teamAdvanced:    exists('team_advanced.json'),
      teamPaintDef:    exists('team_paint_defense.json'),
      teamOppShooting: exists('team_opp_shooting.json'),
      teamMisc:        exists('team_misc.json'),
      teamFourFactors: exists('team_four_factors.json'),
      playerStats:     exists('player_stats.json'),
      playerAdvanced:  exists('player_advanced.json'),
      playerPaint:     exists('player_paint_stats.json'),
      playtypes:       exists('playtype_isolation_player_off.json'),
      tracking:        exists('tracking_drives_player.json'),
      defense:         exists('defense_overall.json'),
      shotDash:        exists('shotdash_general_player.json'),
      hustle:          exists('hustle_player.json'),
    }
  };

  lastStatsDiskRead = now;
  const loaded = Object.values(nbaStatsCache.dataAvailable).filter(Boolean).length;
  console.log(`[Cache] NBA stats loaded (${loaded}/13 categories available)`);
  return nbaStatsCache;
}

// ─────────────────────────────────────────────────────
// ESPN ROSTER FETCHER — cached 6 hours per team
// ─────────────────────────────────────────────────────
async function fetchESPNRoster(teamName) {
  const abbr = resolveESPNTeam(teamName);
  if (!abbr) return { error: `Unknown team: ${teamName}`, players: [] };

  const now = Date.now();
  const SIX_HOURS = 2 * 60 * 60 * 1000; // 2hr cache — keeps rosters fresh
  if (rosterCache[abbr] && (now - (lastRosterFetch[abbr] || 0)) < SIX_HOURS) {
    return rosterCache[abbr];
  }

  try {
    const res = await axios.get(`${ESPN_BASE}/teams/${abbr}/roster`, { timeout: 5000 });
    const raw = res.data?.athletes || [];

    // ESPN has two response formats:
    // Grouped: [ { position: 'G', items: [players] } ]  -- older format
    // Flat:    [ { id, fullName, ... } ]                 -- newer format
    // Detect which by checking if first element has 'items'
    const isGrouped = raw.length > 0 && Array.isArray(raw[0]?.items);
    const playerList = isGrouped
      ? raw.flatMap(group => group.items || [])
      : raw.filter(p => p.fullName); // flat format — filter out non-player entries

    const mapPlayer = (p) => ({
      name:       p.fullName || p.displayName || 'Unknown',
      position:   p.position?.abbreviation || p.position?.name || 'N/A',
      jersey:     p.jersey || p.displayNumber || '?',
      height:     p.height
        ? `${Math.floor(p.height/12)}'${p.height%12}"`
        : (p.displayHeight || 'N/A'),
      weight:     p.weight ? `${p.weight}lbs` : (p.displayWeight || 'N/A'),
      status:     p.injuries?.[0]?.status || p.status?.type?.name || 'Active',
      injuryNote: p.injuries?.[0]?.longComment || p.injuries?.[0]?.shortComment || null,
    });

    const players = playerList.map(mapPlayer).filter(p => p.name !== 'Unknown');

    const result = {
      team: teamName,
      abbr,
      fetchedAt: new Date().toISOString(),
      source: 'ESPN (live)',
      playerCount: players.length,
      players,
      starters: players.filter(p => ['PG','SG','SF','PF','C'].includes(p.position)).slice(0, 8),
      injured:  players.filter(p => p.status !== 'Active'),
    };

    rosterCache[abbr] = result;
    lastRosterFetch[abbr] = now;
    console.log(`[ESPN] Roster fetched: ${teamName} (${players.length} players)`);
    return result;
  } catch (err) {
    console.error(`[ESPN] Roster fetch failed for ${teamName}:`, err.message);
    return { error: err.message, team: teamName, players: [] };
  }
}

// ─────────────────────────────────────────────────────
// TODAY'S GAMES
// ─────────────────────────────────────────────────────
async function fetchTodaysGames() {
  try {
    const res = await axios.get(`${BALLDONTLIE}/games`, {
      params: { dates: [getToday()], per_page: 30 },
      headers: { Authorization: process.env.BALLDONTLIE_KEY },
      timeout: 10000
    });
    todaysGames = res.data.data || [];
    console.log(`[BDL] ${todaysGames.length} games fetched for ${getToday()}`);
  } catch (err) {
    console.error('[BDL] Games fetch failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────
// PLAYER STATS (BallDontLie)
// ─────────────────────────────────────────────────────
async function fetchPlayerStats(playerName) {
  if (playerStatsCache[playerName]) return playerStatsCache[playerName];

  // ── STEP 1: Try nba_api bridge first (most current, direct from nba.com) ──
  console.log(`[Stats] Fetching via nba_api bridge: ${playerName}`);
  const bridgeData = await fetchViaBridge(playerName);

  if (bridgeData && !bridgeData.error && bridgeData.l10 && bridgeData.games?.length >= 3) {
    console.log(`[Bridge] ✓ Got ${bridgeData.games.length} games for ${playerName} from nba_api`);

    // Build game arrays from bridge data
    const last10 = bridgeData.games.slice(0, 10);
    const last5  = bridgeData.games.slice(0, 5);

    // Calc form: compare L5 pts to L10 pts
    const pts5  = last5.reduce((s,g) => s + (g.pts||0), 0) / Math.max(last5.length, 1);
    const pts10 = last10.reduce((s,g) => s + (g.pts||0), 0) / Math.max(last10.length, 1);
    const hotCold = pts5 > pts10 + 3 ? 'HOT' : pts5 < pts10 - 3 ? 'COLD' : 'NEUTRAL';

    // Calc minutes stability from last10
    const mins = last10.map(g => parseFloat(g.min) || 0).filter(m => m > 0);
    const avgMin = mins.reduce((s,m) => s+m, 0) / Math.max(mins.length, 1);
    const stdMin = Math.sqrt(mins.reduce((s,m) => s + Math.pow(m-avgMin,2), 0) / Math.max(mins.length,1));

    const result = {
      player: {
        id:       bridgeData.id,
        name:     bridgeData.player,
        team:     'Unknown', // bridge doesn't return team — filled below via BDL
        position: 'Unknown',
        height:   '?',
      },
      form:             hotCold,
      minutesStability: stdMin > 5 ? 'VOLATILE' : 'STABLE',
      dataSource:       'nba_api (primary)',
      averages: {
        pts:      String(bridgeData.l10.pts  || 0),
        reb:      String(bridgeData.l10.reb  || 0),
        ast:      String(bridgeData.l10.ast  || 0),
        min:      String(bridgeData.l10.min  || 0),
        fg3m:     String(bridgeData.l10.fg3m || 0),
        fg_pct:   String(0), // not in bridge l10 summary
        stl:      String(bridgeData.l10.stl  || 0),
        blk:      String(bridgeData.l10.blk  || 0),
        turnover: String(0),
      },
      last5Games: last5.map(g => ({
        date:     g.date || 'N/A',
        opponent: g.matchup || 'N/A',
        pts: g.pts, reb: g.reb, ast: g.ast,
        fg3m: g.fg3m, min: g.min,
        fg_pct: g.fg_pct ? g.fg_pct + '%' : 'N/A',
      })),
      last10Games: last10.map(g => ({
        date:     g.date || 'N/A',
        opponent: g.matchup || 'N/A',
        oppTeamId: null,
        pts: g.pts, reb: g.reb, ast: g.ast,
        fg3m: g.fg3m, min: g.min,
        fg_pct: g.fg_pct ? g.fg_pct + '%' : 'N/A',
        plus_minus: g.plus_minus,
      })),
      gamesAnalyzed: bridgeData.games.length,
      _bridgeEnhanced: true,
      _bridgeL5:  bridgeData.l5,
      _bridgeL10: bridgeData.l10,
    };

    // Supplement with BDL just for team/position/height info
    try {
      const corrected = BDL_NAME_MAP[playerName.toLowerCase()] || playerName;
      const searchRes = await axios.get(`${BALLDONTLIE}/players`, {
        params: { search: corrected, per_page: 5 },
        headers: { Authorization: process.env.BALLDONTLIE_KEY },
        timeout: 8000
      });
      const bdlPlayers = searchRes.data.data || [];
      if (bdlPlayers.length) {
        const p = fuzzyMatchPlayer(bdlPlayers.map(p => ({
          ...p, name: `${p.first_name} ${p.last_name}`
        })), corrected) || bdlPlayers[0];
        result.player.id       = p.id;
        result.player.name     = `${p.first_name} ${p.last_name}`;
        result.player.team     = p.team?.full_name || 'Unknown';
        result.player.position = p.position || 'Unknown';
        result.player.height   = `${p.height_feet || '?'}' ${p.height_inches || '?'}"`;
      }
    } catch (_) { /* BDL team lookup optional */ }

    playerStatsCache[playerName] = result;
    return result;
  }

  // ── STEP 2: Bridge failed or insufficient — fall back to BDL ──
  console.log(`[Bridge] Failed for ${playerName} (${bridgeData?.error || 'no data'}) — falling back to BDL`);

  try {
    const bdlKey = process.env.BALLDONTLIE_KEY;
    const corrected = BDL_NAME_MAP[playerName.toLowerCase()] || playerName;

    let bdlPlayers = [];
    const res1 = await axios.get(`${BALLDONTLIE}/players`, {
      params: { search: corrected, per_page: 10 },
      headers: { Authorization: bdlKey },
      timeout: 10000
    });
    bdlPlayers = res1.data.data || [];

    // Last-name fallback
    if (!bdlPlayers.length) {
      const lastName = corrected.split(' ').pop().replace(/[^a-zA-Z]/g, '');
      if (lastName.length >= 4) {
        const res2 = await axios.get(`${BALLDONTLIE}/players`, {
          params: { search: lastName, per_page: 15 },
          headers: { Authorization: bdlKey },
          timeout: 10000
        });
        bdlPlayers = res2.data.data || [];
      }
    }

    if (!bdlPlayers.length) {
      return { error: `Player "${playerName}" not found in nba_api or BallDontLie.` };
    }

    const player = fuzzyMatchPlayer(bdlPlayers.map(p => ({
      ...p, name: `${p.first_name} ${p.last_name}`
    })), corrected) || bdlPlayers[0];

    const statsRes = await axios.get(`${BALLDONTLIE}/stats`, {
      params: { player_ids: [player.id], per_page: 20, seasons: [2025] },
      headers: { Authorization: process.env.BALLDONTLIE_KEY },
      timeout: 10000
    });

    const allGames = (statsRes.data.data || [])
      .filter(g => g.min && g.min !== '0' && parseInt(g.min) > 5)
      .sort((a, b) => new Date(b.game.date) - new Date(a.game.date));

    let games = allGames;
    if (games.length < 3) {
      const fallback = await axios.get(`${BALLDONTLIE}/stats`, {
        params: { player_ids: [player.id], per_page: 20, seasons: [2024] },
        headers: { Authorization: process.env.BALLDONTLIE_KEY },
        timeout: 10000
      });
      games = (fallback.data.data || [])
        .filter(g => g.min && g.min !== '0' && parseInt(g.min) > 5)
        .sort((a, b) => new Date(b.game.date) - new Date(a.game.date));
    }

    const last5  = games.slice(0, 5);
    const last10 = games.slice(0, 10);
    const pts5   = parseFloat(calcAvg(last5, 'pts'));
    const pts10  = parseFloat(calcAvg(last10, 'pts'));
    const hotCold = pts5 > pts10 + 3 ? 'HOT' : pts5 < pts10 - 3 ? 'COLD' : 'NEUTRAL';

    const result = {
      player: {
        id:       player.id,
        name:     `${player.first_name} ${player.last_name}`,
        team:     player.team?.full_name || 'Unknown',
        position: player.position || 'Unknown',
        height:   `${player.height_feet || '?'}' ${player.height_inches || '?'}"`,
      },
      form: hotCold,
      dataSource: 'BallDontLie (fallback)',
      minutesStability: parseFloat(calcStdDev(last10, 'min')) > 5 ? 'VOLATILE' : 'STABLE',
      averages: {
        pts:      calcAvg(last10, 'pts'),
        reb:      calcAvg(last10, 'reb'),
        ast:      calcAvg(last10, 'ast'),
        min:      calcAvg(last10, 'min'),
        fg3m:     calcAvg(last10, 'fg3m'),
        fg_pct:   calcAvg(last10, 'fg_pct'),
        stl:      calcAvg(last10, 'stl'),
        blk:      calcAvg(last10, 'blk'),
        turnover: calcAvg(last10, 'turnover')
      },
      last5Games: last5.map(g => ({
        date:     g.game?.date?.split('T')[0] || 'N/A',
        opponent: g.game?.home_team_id === player.team_id
          ? g.game?.visitor_team?.full_name
          : g.game?.home_team?.full_name,
        pts: g.pts, reb: g.reb, ast: g.ast,
        fg3m: g.fg3m, min: g.min,
        fg_pct: g.fg_pct ? (g.fg_pct * 100).toFixed(0) + '%' : 'N/A'
      })),
      last10Games: last10.map(g => ({
        date:     g.game?.date?.split('T')[0] || 'N/A',
        opponent: g.game?.home_team_id === player.team_id
          ? g.game?.visitor_team?.full_name
          : g.game?.home_team?.full_name,
        oppTeamId: g.game?.home_team_id === player.team_id
          ? g.game?.visitor_team_id
          : g.game?.home_team_id,
        pts: g.pts, reb: g.reb, ast: g.ast,
        fg3m: g.fg3m, min: g.min,
        fg_pct: g.fg_pct ? (g.fg_pct * 100).toFixed(0) + '%' : 'N/A',
        plus_minus: g.plus_minus
      })),
      gamesAnalyzed: games.length
    };

    playerStatsCache[playerName] = result;
    return result;
  } catch (err) {
    return { error: err.message };
  }
}


// ─────────────────────────────────────────────────────────────────
// H2H STATS — Player's historical stats vs specific opponent team
// ─────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════
// H2H VIA NBA API BRIDGE
// Calls predict_tonight.py with opponent arg → full game log filtered
// Returns every individual game as a box score — not just averages
// ════════════════════════════════════════════════════════════════
async function fetchH2HViaBridge(playerName, opponent, season = '2025-26') {
  const cacheKey = `h2h:${playerName}:${opponent}`;
  const cached = nbaApiBridgeCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < NBA_BRIDGE_TTL) {
    console.log(`[H2H Bridge] Cache hit: ${playerName} vs ${opponent}`);
    return cached.data;
  }

  return new Promise((resolve) => {
    const py = spawn('python3', [
      path.join(__dirname, 'predict_tonight.py'),
      playerName, season, opponent
    ]);
    let out = '', err = '';
    py.stdout.on('data', d => { out += d.toString(); });
    py.stderr.on('data', d => { err += d.toString(); });

    const timer = setTimeout(() => {
      py.kill();
      console.warn(`[H2H Bridge] Timeout after 25s: ${playerName} vs ${opponent}`);
      resolve(null);
    }, 25000);

    py.on('close', () => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(out.trim());
        if (data?.h2h?.gamesVsOpp > 0) {
          nbaApiBridgeCache[cacheKey] = { data: data.h2h, ts: Date.now() };
          console.log(`[H2H Bridge] ✓ ${data.h2h.gamesVsOpp} games — ${playerName} vs ${opponent}`);
          resolve(data.h2h);
        } else {
          console.warn(`[H2H Bridge] No games found: ${data?.error || 'empty'}`);
          resolve(null);
        }
      } catch(e) {
        console.warn(`[H2H Bridge] Parse error: ${err || out}`);
        resolve(null);
      }
    });
  });
}

async function fetchH2HStats(playerId, playerTeamId, opponentTeamId, seasons = [2025, 2024]) {
  if (!playerId || !opponentTeamId) return null;
  try {
    // Pull stats from both seasons to get enough H2H games
    // Fetch all seasons in parallel instead of sequentially
    const seasonResults = await Promise.all(seasons.map(season =>
      axios.get(`${BALLDONTLIE}/stats`, {
        params: { player_ids: [playerId], per_page: 100, seasons: [season] },
        headers: { Authorization: process.env.BALLDONTLIE_KEY },
        timeout: 8000
      }).catch(() => ({ data: { data: [] } }))
    ));
    const allGames = seasonResults.flatMap(r => r.data?.data || []);

    // Filter to games vs the specific opponent
    const h2hGames = allGames.filter(g => {
      if (!g.min || g.min === '0' || parseInt(g.min) < 5) return false;
      const homeId    = g.game?.home_team_id;
      const visitorId = g.game?.visitor_team_id;
      // Game involves the opponent team
      return homeId === opponentTeamId || visitorId === opponentTeamId;
    }).sort((a, b) => new Date(b.game.date) - new Date(a.game.date));

    if (!h2hGames.length) return null;

    // Calculate H2H averages
    const avg = (key) => {
      const vals = h2hGames.map(g => parseFloat(g[key]) || 0);
      return parseFloat((vals.reduce((a,b)=>a+b,0) / vals.length).toFixed(1));
    };

    const avgPct = (key) => {
      const vals = h2hGames.map(g => parseFloat(g[key])).filter(v => !isNaN(v) && v > 0);
      return vals.length ? parseFloat((vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(3)) : null;
    };
    // Trend: recent half vs older half
    const mid = Math.ceil(h2hGames.length / 2);
    const recentPts = h2hGames.slice(0,mid).reduce((s,g)=>s+(g.pts||0),0)/Math.max(mid,1);
    const olderPts  = h2hGames.slice(mid).reduce((s,g)=>s+(g.pts||0),0)/Math.max(h2hGames.length-mid,1);
    const h2hTrend  = recentPts > olderPts+2 ? 'IMPROVING' : recentPts < olderPts-2 ? 'DECLINING' : 'STABLE';

    return {
      gamesVsOpp: h2hGames.length,
      source: 'BallDontLie',
      // Averages
      pts:  avg('pts'),  reb:  avg('reb'),  ast:  avg('ast'),
      fg3m: avg('fg3m'), fga:  avg('fga'),  fg3a: avg('fg3a'),
      fta:  avg('fta'),  oreb: avg('oreb'), dreb: avg('dreb'),
      stl:  avg('stl'),  blk:  avg('blk'),  tov:  avg('turnover'),
      min:  avg('min'),
      pra:  parseFloat((avg('pts')+avg('reb')+avg('ast')).toFixed(1)),
      fgPct:  avgPct('fg_pct'),
      fg3Pct: avgPct('fg3_pct'),
      h2hTrend,
      // Full box score for every H2H game
      games: h2hGames.map(g => ({
        date:      g.game?.date?.split('T')[0] || 'N/A',
        season:    g.game?.season || '?',
        matchup:   'vs/@ ' + (g.game?.visitor_team?.full_name || g.game?.home_team?.full_name || 'Opp'),
        result:    null,
        pts:  g.pts,  reb:  g.reb,  ast:  g.ast,
        fgm:  g.fgm,  fga:  g.fga,
        fg3m: g.fg3m, fg3a: g.fg3a,
        ftm:  g.ftm,  fta:  g.fta,
        oreb: g.oreb, dreb: g.dreb,
        stl:  g.stl,  blk:  g.blk,  tov: g.turnover,
        min:  g.min,
        fgPct:  g.fg_pct  ? (g.fg_pct*100).toFixed(0)+'%'  : 'N/A',
        fg3Pct: g.fg3_pct ? (g.fg3_pct*100).toFixed(0)+'%' : 'N/A',
        plusMinus: g.plus_minus,
      })),
      recentGames: h2hGames.slice(0,5).map(g => ({
        date: g.game?.date?.split('T')[0]||'N/A', season: g.game?.season||'?',
        pts: g.pts, reb: g.reb, ast: g.ast, fg3m: g.fg3m, fga: g.fga,
        fgPct: g.fg_pct?(g.fg_pct*100).toFixed(0)+'%':'N/A', min: g.min,
        plusMinus: g.plus_minus
      }))
    };
  } catch (err) {
    console.error('[H2H] Error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────
// LINEUPS (Tank01 / RapidAPI)
// ─────────────────────────────────────────────────────
async function fetchLineups() {
  const THIRTY_MIN = 30 * 60 * 1000;
  if (lineupCache && lastLineupFetch && (Date.now() - lastLineupFetch) < THIRTY_MIN) return lineupCache;
  try {
    const res = await axios.get(`https://${RAPIDAPI_HOST}/getNBAGamesForDate`, {
      params: { gameDate: getTodayCompact() },
      headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST },
      timeout: 10000
    });
    lineupCache = res.data;
    lastLineupFetch = Date.now();
    return lineupCache;
  } catch (err) {
    return { error: 'Lineups unavailable' };
  }
}

// ─────────────────────────────────────────────────────
// PROP LINES (The Odds API) — with timeout guard
// ─────────────────────────────────────────────────────
async function fetchPropLines(playerName, propType) {
  if (!process.env.ODDS_API_KEY || process.env.ODDS_API_KEY.includes('your_')) return { error: 'No odds key' };
  const propMap = {
    points: 'player_points', rebounds: 'player_rebounds',
    assists: 'player_assists', '3pm': 'player_threes',
    pra: 'player_points_rebounds_assists', steals: 'player_steals', blocks: 'player_blocks'
  };
  try {
    const market = propMap[propType] || 'player_points';
    const eventsRes = await axios.get(`${ODDS_BASE}/sports/basketball_nba/events`, {
      params: { apiKey: process.env.ODDS_API_KEY },
      timeout: 8000
    });

    const lines = {};
    const lastName = playerName.toLowerCase().split(' ').pop();

    // Run event lookups in parallel with a 5-event cap and timeout
    const eventSlice = (eventsRes.data || []).slice(0, 5);
    await Promise.allSettled(eventSlice.map(async event => {
      try {
        const oddsRes = await axios.get(`${ODDS_BASE}/sports/basketball_nba/events/${event.id}/odds`, {
          params: { apiKey: process.env.ODDS_API_KEY, regions: 'us', markets: market, oddsFormat: 'american' },
          timeout: 6000
        });
        for (const bm of (oddsRes.data.bookmakers || [])) {
          for (const mkt of (bm.markets || [])) {
            for (const o of (mkt.outcomes || [])) {
              if (o.description?.toLowerCase().includes(lastName)) {
                if (!lines[bm.title]) lines[bm.title] = {};
                lines[bm.title][o.name] = { point: o.point, price: o.price };
              }
            }
          }
        }
      } catch (_) {}
    }));

    let softestLine = null, softestBook = null;
    for (const [book, data] of Object.entries(lines)) {
      const ol = data['Over']?.point;
      if (ol && (!softestLine || ol < softestLine)) { softestLine = ol; softestBook = book; }
    }
    return { lines, softestLine, softestBook, market };
  } catch (err) {
    return { error: err.message };
  }
}

// ─────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// MATHEMATICAL PROJECTION ENGINE
// Calculates projection independently of posted line
// Prevents anchoring bias where Claude mirrors the user's line
// ─────────────────────────────────────────────────────────────────
const LEAGUE_AVG_PACE = 99.5; // updated each season from nba.com data

function calcWeightedAvg(l5, l10, season) {
  const v5 = parseFloat(l5) || 0;
  const v10 = parseFloat(l10) || 0;
  const vs  = parseFloat(season) || v10;
  if (!v5 && !v10) return null;
  return (v5 * 0.45) + (v10 * 0.30) + (vs * 0.25);
}

function calcPaceAdj(proj, oppPace, playerTeamPace, propType) {
  if (!proj) return proj;
  // Props where pace has minimal effect — skip adjustment
  const PACE_NEUTRAL = ['3pm', 'steals', 'blocks'];
  if (PACE_NEUTRAL.includes(propType)) return proj;

  // Use blended pace (avg of both teams) vs league average
  const opp = parseFloat(oppPace) || LEAGUE_AVG_PACE;
  const own = parseFloat(playerTeamPace) || LEAGUE_AVG_PACE;
  const blended = (opp + own) / 2;

  // Linear multiplier capped at ±8% — more accurate than sqrt dampening
  const raw = (blended - LEAGUE_AVG_PACE) / LEAGUE_AVG_PACE;
  const multiplier = 1 + Math.max(-0.08, Math.min(0.08, raw));
  return proj * multiplier;
}

function calcDvPCoeff(oppDefRating, playerPosition, playerPlaytypes, oppDefPlaytypes, propType) {
  // Base: team-level defensive rating (always available)
  let base = 1.0;
  if (oppDefRating) {
    const leagueAvg = 113.0;
    const raw = leagueAvg / parseFloat(oppDefRating);
    base = 1 + (raw - 1) * 0.6;
  }

  // Rebounding and assists — defensive rating matters less than paint/scheme
  if (!playerPlaytypes || !oppDefPlaytypes || propType === 'rebounds' || propType === 'assists') {
    return base;
  }

  // Position group → relevant play types for scoring
  const pos = (playerPosition || '').toUpperCase();
  let relevantTypes = [];
  if (['PG','SG','G'].includes(pos)) {
    // Guards: ISO, transition, P&R ball handler, spot up
    relevantTypes = [
      ['iso', 0.30], ['transition', 0.25], ['prBall', 0.25], ['spotUp', 0.20]
    ];
  } else if (['SF','GF','F'].includes(pos)) {
    // Wings: spot up, cut, off screen, ISO
    relevantTypes = [
      ['spotUp', 0.35], ['cut', 0.20], ['offScreen', 0.20], ['iso', 0.25]
    ];
  } else if (['PF','C','FC'].includes(pos)) {
    // Bigs: post up, P&R roll man, putbacks, spot up
    relevantTypes = [
      ['postUp', 0.35], ['prRoll', 0.30], ['putbacks', 0.20], ['spotUp', 0.15]
    ];
  }

  if (!relevantTypes.length) return base;

  // Build playtype-weighted DvP coefficient
  let playtypeCoeff = 0;
  let totalWeight = 0;

  for (const [ptype, weight] of relevantTypes) {
    const playerPT = playerPlaytypes[ptype];
    const oppDefPT = oppDefPlaytypes[ptype];

    if (!playerPT || !oppDefPT) continue;

    // Player's efficiency on this play type vs opponent's defense on same play type
    // Lower opp PPP allowed = tougher defense
    const playerPPP = parseFloat(playerPT.PPP || playerPT.POINTS || 0);
    const oppPPP    = parseFloat(oppDefPT.PPP || oppDefPT.POINTS || 1);

    if (!playerPPP || !oppPPP) continue;

    // How much harder/easier is this matchup vs league average (1.0 PPP baseline)
    const matchupRatio = oppPPP / 1.0; // > 1 = easy D, < 1 = tough D
    playtypeCoeff += matchupRatio * weight;
    totalWeight   += weight;
  }

  if (!totalWeight) return base;

  // Blend base DEF_RATING (50%) with playtype matchup (50%)
  const playtypeAdj = playtypeCoeff / totalWeight;
  const blended = (base * 0.50) + (playtypeAdj * 0.50);

  // Cap at ±12% from neutral
  return Math.max(0.88, Math.min(1.12, parseFloat(blended.toFixed(4))));
}

// ════════════════════════════════════════════════════════════════════
// USG_PCT-BASED USAGE REDISTRIBUTION ENGINE
// Uses real individual usage rates from player_advanced.json
// When teammates are out, their USG% redistributes proportionally
// to healthy players based on their own USG% share
//
// Example: Reaves (18% USG) + DFS (12% USG) both out for Lakers
// 30% of possessions freed. LeBron (30% USG) among healthy players
// absorbs ~his proportional share → projection gets boosted accordingly
// ════════════════════════════════════════════════════════════════════

function calcUsageInflation(playerRoster, playerStats, propType, nbaPlayerStats) {
  let mult = 1.0;
  const details = [];

  // ── STEP 1: USG_PCT-based redistribution ─────────────────────
  if (playerRoster?.injured?.length && nbaPlayerStats?.length) {

    const allRosterPlayers = playerRoster.players || [];
    const injuredPlayers   = playerRoster.injured.filter(p => {
      const s = (p.status || '').toLowerCase();
      return s === 'out' || s === 'doubtful' || s === 'questionable';
    });

    if (injuredPlayers.length > 0) {
      // Look up USG_PCT for every player on the roster from nba.com data
      const getUSG = (name) => {
        // Fuzzy match by last name first, then full name
        const last = name.split(' ').pop().toLowerCase();
        const match = nbaPlayerStats.find(p => {
          const pName = (p.PLAYER_NAME || '').toLowerCase();
          return pName.includes(last) && pName.split(' ').some(w => name.toLowerCase().includes(w));
        }) || nbaPlayerStats.find(p =>
          (p.PLAYER_NAME || '').toLowerCase().includes(last)
        );
        return match ? parseFloat(match.USG_PCT || 0) : null;
      };

      // Get player's own USG_PCT
      const playerName    = playerStats?.player?.name || '';
      const playerUSG     = getUSG(playerName);

      // Sum up USG of injured players (freed possessions)
      let freedUSG = 0;
      const injuredWithUSG = [];
      for (const p of injuredPlayers) {
        const usg = getUSG(p.name);
        const statusWeight = ['out','doubtful'].includes((p.status||'').toLowerCase()) ? 1.0 : 0.5;
        const effectiveUSG = usg ? usg * statusWeight : 0.08 * statusWeight; // 8% default if unknown
        freedUSG += effectiveUSG;
        injuredWithUSG.push({ ...p, usg, effectiveUSG });
      }

      // Sum USG of all HEALTHY players (who will absorb the freed possessions)
      let healthyTotalUSG = 0;
      for (const p of allRosterPlayers) {
        const isInjured = injuredPlayers.some(ip => ip.name === p.name);
        if (!isInjured) {
          const usg = getUSG(p.name) || 0.10; // 10% default
          healthyTotalUSG += usg;
        }
      }

      if (healthyTotalUSG > 0 && playerUSG && freedUSG > 0) {
        // Player's share of healthy team USG
        const playerShare = playerUSG / healthyTotalUSG;
        // How much of freed USG flows to this player
        const playerGainedUSG = freedUSG * playerShare;
        // Boost = gained USG / original USG (how much their usage increases)
        const usageBoost = playerGainedUSG / playerUSG;

        // Prop-type scaling: scoring benefits most from usage, rebounds less
        const PROP_SCALE = {
          points: 1.0, pra: 0.85, pa: 0.90, pr: 0.75,
          assists: 0.90, rebounds: 0.55, ra: 0.65,
          '3pm': 0.80, steals: 0.40, blocks: 0.30,
        };
        const scale = PROP_SCALE[propType] || 0.80;
        const scaledBoost = usageBoost * scale;

        mult += scaledBoost;

        details.push({
          method:       'USG_PCT redistribution',
          playerUSG:    parseFloat((playerUSG*100).toFixed(1)) + '%',
          playerShare:  parseFloat((playerShare*100).toFixed(1)) + '%',
          freedUSG:     parseFloat((freedUSG*100).toFixed(1)) + '%',
          playerGain:   parseFloat((playerGainedUSG*100).toFixed(1)) + '%',
          rawBoost:     parseFloat((usageBoost*100).toFixed(1)) + '%',
          scaledBoost:  parseFloat((scaledBoost*100).toFixed(1)) + '%',
          injuredPlayers: injuredWithUSG.map(p => ({
            name:   p.name,
            status: p.status,
            usg:    p.usg ? parseFloat((p.usg*100).toFixed(1))+'%' : 'unknown',
          })),
        });
      } else {
        // Fallback: position-based estimation when USG_PCT data unavailable
        for (const p of injuredPlayers) {
          const pos = (p.position || '').toUpperCase();
          const isBallHandler = ['PG','SG','G'].includes(pos);
          const isScorer      = ['SF','GF','F'].includes(pos);
          const isBig         = ['PF','C','FC'].includes(pos);
          const statusMult    = ['out','doubtful'].includes((p.status||'').toLowerCase()) ? 1.0 : 0.5;

          let boost = 0;
          if (propType === 'points' || propType === 'pra' || propType === 'pa') {
            boost = (isBallHandler ? 0.10 : isScorer ? 0.08 : 0.05) * statusMult;
          } else if (propType === 'rebounds' || propType === 'pr' || propType === 'ra') {
            boost = (isBig ? 0.10 : 0.05) * statusMult;
          } else if (propType === 'assists') {
            boost = (isBallHandler ? 0.08 : 0.04) * statusMult;
          } else {
            boost = 0.05 * statusMult;
          }
          mult += boost;
          details.push({ method: 'position-fallback', name: p.name, boost: parseFloat((boost*100).toFixed(1))+'%' });
        }
      }

      // Cap: realistic max redistribution
      mult = Math.min(1.30, mult);
    }
  }

  // ── STEP 2: Usage trend L3 vs L10 ────────────────────────────
  if (playerStats?.last10Games?.length >= 5) {
    const statKey = {
      points:'pts', rebounds:'reb', assists:'ast',
      '3pm':'fg3m', steals:'stl', blocks:'blk',
      pra:null, pr:null, pa:null, ra:null
    }[propType];

    if (statKey) {
      const l10avg = playerStats.last10Games.reduce((s,g) => s+(parseFloat(g[statKey])||0),0)
                   / playerStats.last10Games.length;
      const l3avg  = playerStats.last10Games.slice(0,3).reduce((s,g) => s+(parseFloat(g[statKey])||0),0)/3;
      if (l10avg > 0) {
        const trend = (l3avg - l10avg) / l10avg;
        mult += Math.max(-0.05, Math.min(0.05, trend * 0.5));
      }
    }
  }

  const result = parseFloat(Math.max(0.85, Math.min(1.30, mult)).toFixed(4));
  // Attach breakdown for display (non-destructive)
  calcUsageInflation._lastDetails = details;
  return result;
}

// Returns full redistribution breakdown for UI display and Claude prompt
function calcInjuryBreakdown(playerRoster, playerStats, propType, nbaPlayerStats) {
  const details = calcUsageInflation._lastDetails || [];
  const mult    = calcUsageInflation(playerRoster, playerStats, propType, nbaPlayerStats);
  return {
    mult,
    totalBoost:     parseFloat((mult - 1.0).toFixed(3)),
    details,
    usgBased:       details.some(d => d.method === 'USG_PCT redistribution'),
    injuredPlayers: (playerRoster?.injured || []).map(p => ({
      name:     p.name,
      status:   p.status,
      position: p.position,
    })),
  };
}


// ════════════════════════════════════════════════════════════════
// GAME CONTEXT ENGINE — spread, total, back-to-back
// Pulls from The Odds API and schedule data
// ════════════════════════════════════════════════════════════════
async function fetchGameContext(playerTeam, opponent, todayGame) {
  const ctx = {
    spread:      null,  // positive = playerTeam favored
    total:       null,  // projected combined score
    isBackToBack: false,
    gameImportance: 'normal', // 'normal' | 'must-win' | 'rest-likely'
    gameTotalAdj:   1.0,
    spreadAdj:      1.0,
    b2bAdj:         1.0,
    details:        [],
  };

  // ── Back-to-back detection ────────────────────────────────────
  // Check if player's team played yesterday
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yd = yesterday.toISOString().split('T')[0];
    const prevRes = await axios.get(`${BALLDONTLIE}/games`, {
      params: { dates: [yd], per_page: 30 },
      headers: { Authorization: process.env.BALLDONTLIE_KEY },
      timeout: 6000
    });
    const prevGames = prevRes.data?.data || [];
    const playedYesterday = prevGames.some(g =>
      g.home_team.full_name.toLowerCase().includes(playerTeam.toLowerCase()) ||
      g.visitor_team.full_name.toLowerCase().includes(playerTeam.toLowerCase())
    );
    if (playedYesterday) {
      ctx.isBackToBack = true;
      ctx.b2bAdj = 0.92; // -8% on second night of back-to-back
      ctx.details.push('Back-to-back: -8% projection adjustment');
    }
  } catch (_) {}

  // ── Game total and spread from Odds API ──────────────────────
  if (!process.env.ODDS_API_KEY || process.env.ODDS_API_KEY.includes('your_')) {
    return ctx;
  }

  try {
    const eventsRes = await axios.get(`${ODDS_BASE}/sports/basketball_nba/events`, {
      params: { apiKey: process.env.ODDS_API_KEY },
      timeout: 8000
    });

    const teamLower = playerTeam.toLowerCase().split(' ').pop();
    const oppLower  = opponent.toLowerCase().split(' ').pop();

    const event = (eventsRes.data || []).find(e =>
      (e.home_team?.toLowerCase().includes(teamLower) || e.away_team?.toLowerCase().includes(teamLower)) &&
      (e.home_team?.toLowerCase().includes(oppLower)  || e.away_team?.toLowerCase().includes(oppLower))
    );

    if (event) {
      const oddsRes = await axios.get(`${ODDS_BASE}/sports/basketball_nba/events/${event.id}/odds`, {
        params: {
          apiKey: process.env.ODDS_API_KEY,
          regions: 'us',
          markets: 'totals,spreads',
          oddsFormat: 'american'
        },
        timeout: 8000
      });

      for (const bm of (oddsRes.data.bookmakers || []).slice(0, 3)) {
        for (const mkt of (bm.markets || [])) {
          if (mkt.key === 'totals' && !ctx.total) {
            const over = mkt.outcomes?.find(o => o.name === 'Over');
            if (over?.point) ctx.total = parseFloat(over.point);
          }
          if (mkt.key === 'spreads' && !ctx.spread) {
            const playerTeamLine = mkt.outcomes?.find(o =>
              o.name?.toLowerCase().includes(teamLower)
            );
            if (playerTeamLine?.point != null) {
              ctx.spread = parseFloat(playerTeamLine.point); // negative = favorite
            }
          }
        }
      }
    }
  } catch (_) {}

  // ── Apply game total adjustment ──────────────────────────────
  if (ctx.total) {
    if (ctx.total >= 230) {
      ctx.gameTotalAdj = 1.05;
      ctx.details.push(`High total (${ctx.total}): +5% — fast pace game`);
    } else if (ctx.total >= 220) {
      ctx.gameTotalAdj = 1.02;
      ctx.details.push(`Above avg total (${ctx.total}): +2%`);
    } else if (ctx.total <= 210) {
      ctx.gameTotalAdj = 0.95;
      ctx.details.push(`Low total (${ctx.total}): -5% — defensive game`);
    } else if (ctx.total <= 215) {
      ctx.gameTotalAdj = 0.97;
      ctx.details.push(`Below avg total (${ctx.total}): -3%`);
    }
  }

  // ── Apply spread adjustment ──────────────────────────────────
  if (ctx.spread != null) {
    if (ctx.spread <= -12) {
      // Player's team is a heavy favorite — blowout risk
      ctx.spreadAdj = 0.93;
      ctx.details.push(`Heavy favorite (${ctx.spread}): -7% — blowout risk, 4th quarter off`);
    } else if (ctx.spread <= -8) {
      ctx.spreadAdj = 0.96;
      ctx.details.push(`Large favorite (${ctx.spread}): -4% — garbage time risk`);
    } else if (ctx.spread >= 12) {
      // Player's team is a heavy underdog — may play slower to stay in it
      ctx.spreadAdj = 0.96;
      ctx.details.push(`Heavy underdog (+${ctx.spread}): -4% — may slow pace, limited possessions`);
    } else if (ctx.spread >= -5 && ctx.spread <= 5) {
      // Close game — full minutes, crunch time usage
      ctx.spreadAdj = 1.03;
      ctx.details.push(`Close game (${ctx.spread}): +3% — full minutes, crunch time usage`);
    }
  }

  return ctx;
}

function buildProjection(playerStats, ctx, propType) {
  if (!playerStats || playerStats.error) return null;
  const avgs = playerStats.averages || {};
  const h2h  = ctx.h2hStats || null;

  // ── STEP 1: L10 BASE from game log ────────────────────────────
  const COMBO_PROPS = {
    'pra':['pts','reb','ast'], 'pr':['pts','reb'],
    'pa':['pts','ast'],        'ra':['reb','ast'],
  };
  const isCombo = COMBO_PROPS[propType];
  const statKey = { points:'pts', rebounds:'reb', assists:'ast',
                    '3pm':'fg3m', steals:'stl', blocks:'blk' }[propType] || 'pts';

  const getGameVal = (g) => isCombo
    ? isCombo.reduce((s, k) => s + (parseFloat(g[k])||0), 0)
    : (parseFloat(g[statKey]) || 0);

  let l10Val = isCombo
    ? isCombo.reduce((s, k) => s + (parseFloat(avgs[k])||0), 0)
    : (parseFloat(avgs[statKey]) || 0);
  if (!l10Val) return null;

  let l10FromLog = l10Val;
  if (playerStats.last10Games?.length >= 5) {
    const vals = playerStats.last10Games.map(getGameVal);
    l10FromLog = vals.reduce((a,b)=>a+b,0) / vals.length;
  } else if (playerStats.last5Games?.length >= 3) {
    const vals = playerStats.last5Games.map(getGameVal);
    l10FromLog = vals.reduce((a,b)=>a+b,0) / vals.length;
  }

  // ── STEP 2: RECENCY-WEIGHTED H2H BLEND ───────────────────────
  // Recent H2H games matter more — exponential decay so game 1 (most recent)
  // counts ~3x more than game 5, game 5 counts ~2x more than game 10
  let baseProj = l10FromLog;
  let h2hVal   = null;
  let h2hGamesUsed = 0;

  if (h2h && h2h.gamesVsOpp >= 2) {
    // Try to use individual game log for recency weighting
    const h2hGames = h2h.games || h2h.recentGames || [];

    if (h2hGames.length >= 2) {
      // Exponential decay weights: game 0 (most recent) = 1.0, game 1 = 0.75, game 2 = 0.56...
      const DECAY = 0.75;
      let weightedSum = 0;
      let totalWeight = 0;

      for (let i = 0; i < Math.min(h2hGames.length, 8); i++) {
        const g = h2hGames[i];
        const weight = Math.pow(DECAY, i);
        const val = isCombo
          ? isCombo.reduce((s, k) => s + (parseFloat(g[k])||0), 0)
          : (parseFloat(g[statKey]) || 0);
        if (val > 0) {
          weightedSum += val * weight;
          totalWeight += weight;
        }
      }

      if (totalWeight > 0) {
        h2hVal = parseFloat((weightedSum / totalWeight).toFixed(2));
        h2hGamesUsed = Math.min(h2hGames.length, 8);
      }
    }

    // Fallback to flat H2H average if no game log
    if (!h2hVal) {
      h2hVal = isCombo
        ? isCombo.reduce((s, k) => s + (h2h[k]||0), 0) || null
        : (h2h[statKey] || null);
      h2hGamesUsed = h2h.gamesVsOpp;
    }

    if (h2hVal) {
      // H2H weight scales with games found, capped at 45%
      // More H2H games = more confident = more weight on H2H
      const h2hWeight = Math.min(0.45, 0.12 * h2hGamesUsed);
      baseProj = (l10FromLog * (1 - h2hWeight)) + (h2hVal * h2hWeight);
    }
  }

  // ── STEP 3: BLENDED PACE ADJUSTMENT ───────────────────────────
  // Uses both team paces for accuracy; zero effect on pace-neutral props
  const playerTeamPace = ctx.playerTeamAdvanced?.PACE;
  let proj = calcPaceAdj(baseProj, ctx.oppAdvanced?.PACE, playerTeamPace, propType);

  // ── STEP 4: POSITION-AWARE DvP COEFFICIENT ────────────────────
  // Blends team DEF_RATING with playtype-specific matchup data
  const playerPos = playerStats?.player?.position;
  proj = proj * calcDvPCoeff(
    ctx.oppAdvanced?.DEF_RATING,
    playerPos,
    ctx.playerPlaytypes,
    ctx.oppDefPlaytypes,
    propType
  );

  // ── STEP 5: USAGE INFLATION (prop-type + position aware) ──────
  proj = proj * calcUsageInflation(ctx.playerRoster, playerStats, propType, ctx.nbaPlayerStats || []);

  // ── STEP 6: GAME CONTEXT (spread/total/back-to-back) ─────────
  const gc = ctx.gameContext;
  let gameContextMult = 1.0;
  if (gc) {
    gameContextMult = gc.gameTotalAdj * gc.spreadAdj * gc.b2bAdj;
    // Cap combined game context effect at ±15%
    gameContextMult = Math.max(0.85, Math.min(1.15, gameContextMult));
    proj = proj * gameContextMult;
  }

  // ── STEP 7: FORM ADJUSTMENT ───────────────────────────────────
  if (playerStats.form === 'HOT')                  proj *= 1.04;
  if (playerStats.form === 'COLD')                 proj *= 0.96;
  if (playerStats.minutesStability === 'VOLATILE') proj *= 0.97;

  // ── CONFIDENCE SCORE ──────────────────────────────────────────
  let conf = 50;
  if (playerStats.minutesStability === 'STABLE')       conf += 10;
  if ((playerStats.gamesAnalyzed || 0) >= 10)          conf += 8;
  else if ((playerStats.gamesAnalyzed || 0) >= 5)      conf += 4;
  if (ctx.oppAdvanced)                                  conf += 8;
  if (ctx.playerTeamAdvanced)                           conf += 3; // own team pace available
  if (h2h && h2h.gamesVsOpp >= 3)                      conf += 10;
  else if (h2h && h2h.gamesVsOpp >= 1)                 conf += 5;
  if (ctx.playerRoster)                                 conf += 4;
  if (gc?.total)                                        conf += 5; // game total known
  if (gc?.spread != null)                               conf += 5; // spread known
  if (gc?.isBackToBack)                                 conf -= 5; // uncertainty on b2b
  if (Object.keys(ctx.playerPlaytypes||{}).length >= 3) conf += 5; // playtype data
  if (!ctx.dataAvailable?.teamAdvanced)                 conf -= 8;
  conf = Math.max(30, Math.min(90, Math.round(conf)));

  // ── COMPUTE DvP for return ─────────────────────────────────────
  const dvpCoeff = calcDvPCoeff(
    ctx.oppAdvanced?.DEF_RATING, playerPos,
    ctx.playerPlaytypes, ctx.oppDefPlaytypes, propType
  );
  const usageMult = calcUsageInflation(ctx.playerRoster, playerStats, propType);
  const h2hWeight = h2hVal ? Math.min(0.45, 0.15 * h2h.gamesVsOpp) : 0;

  return {
    projection:        parseFloat(proj.toFixed(1)),
    l10Avg:            parseFloat(l10FromLog.toFixed(1)),
    h2hAvg:            h2hVal ? parseFloat(h2hVal.toFixed(1)) : null,
    h2hGames:          h2h?.gamesVsOpp || 0,
    h2hGamesUsed:      h2hGamesUsed || 0,
    h2hBlend:          h2hVal ? parseFloat(baseProj.toFixed(1)) : null,
    h2hWeighted:       true,  // recency-weighted (recent games count more)
    h2hTrend:          h2h?.h2hTrend || h2h?.trend || null,
    dvpCoeff:          parseFloat(dvpCoeff.toFixed(3)),
    usageMult:         parseFloat(usageMult.toFixed(3)),
    injuryBreakdown:   calcInjuryBreakdown(ctx.playerRoster, playerStats, propType, ctx.nbaPlayerStats || []),
    gameContextMult:   parseFloat(gameContextMult.toFixed(3)),
    gameTotal:         gc?.total || null,
    spread:            gc?.spread ?? null,
    isBackToBack:      gc?.isBackToBack || false,
    gameContextDetails: gc?.details || [],
    form:              playerStats.form,
    confidence:        conf,
    oppPace:           ctx.oppAdvanced?.PACE || null,
    playerTeamPace:    playerTeamPace || null,
    oppDefRtg:         ctx.oppAdvanced?.DEF_RATING || null,
    playerPosition:    playerPos || null,
    playtypeMatchup:   Object.keys(ctx.playerPlaytypes||{}).length >= 3,
    methodology: [
      h2hVal ? `L10(${Math.round((1-Math.min(0.45,0.12*h2hGamesUsed))*100)}%)+H2H-recency(${Math.round(Math.min(0.45,0.12*h2hGamesUsed)*100)}%)` : 'L10',
      'blended-pace', 'position-DvP',
      gc?.isBackToBack ? 'B2B-adj' : null,
      gc?.total ? `total:${gc.total}` : null,
      gc?.spread != null ? `spread:${gc.spread}` : null,
    ].filter(Boolean).join(' → '),
  };
}

function calcEdgeScore(mathProj, postedLine) {
  if (!mathProj || !postedLine) return 0;
  const line = parseFloat(postedLine);
  if (!line || line <= 0) return 0;
  // Absolute unit difference: proj - line
  // e.g. proj=22.5, line=24.5 → diff=-2.0 → edge=-2.0
  // Scale for display: cap at ±10
  const diff = mathProj - line;
  return Math.max(-10, Math.min(10, parseFloat(diff.toFixed(1))));
}


// ════════════════════════════════════════════════════════════════
// NBA API BRIDGE — Live stats via nba_api Python library
// Calls predict_tonight.py as a child process, returns JSON
// Supplements BallDontLie with direct nba.com game logs
// ════════════════════════════════════════════════════════════════

// Cache bridge results for 30 min (nba.com rate limits)
const nbaApiBridgeCache = {};
const NBA_BRIDGE_TTL = 30 * 60 * 1000;

async function fetchViaBridge(playerName, season = '2025-26') {
  const cacheKey = `${playerName}:${season}`;
  const cached = nbaApiBridgeCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < NBA_BRIDGE_TTL) {
    console.log(`[Bridge] Cache hit: ${playerName}`);
    return cached.data;
  }

  return new Promise((resolve) => {
    const py = spawn('python3', [
      path.join(__dirname, 'predict_tonight.py'),
      playerName,
      season
    ]);

    let output = '';
    let errout = '';

    py.stdout.on('data', d => { output += d.toString(); });
    py.stderr.on('data', d => { errout += d.toString(); });

    // Timeout after 20 seconds (nba.com can be slow)
    const timer = setTimeout(() => {
      py.kill();
      resolve({ error: 'Bridge timeout — nba.com took too long' });
    }, 5000);

    py.on('close', (code) => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(output.trim());
        if (!data.error) {
          nbaApiBridgeCache[cacheKey] = { data, ts: Date.now() };
        }
        resolve(data);
      } catch(e) {
        resolve({ error: `Bridge parse error: ${errout || output}` });
      }
    });
  });
}

// GET /api/nba-bridge?player=Shai+Gilgeous-Alexander&season=2025-26
app.get('/api/nba-bridge', async (req, res) => {
  const { player, season } = req.query;
  if (!player) return res.status(400).json({ error: 'player required' });

  console.log(`[Bridge] Fetching: ${player}`);
  const data = await fetchViaBridge(player, season || '2025-26');
  res.json(data);
});

// POST /api/nba-bridge/batch — fetch multiple players at once
app.post('/api/nba-bridge/batch', async (req, res) => {
  const { players: playerList, season } = req.body;
  if (!playerList?.length) return res.status(400).json({ error: 'players array required' });

  const results = {};
  for (const name of playerList.slice(0, 10)) { // cap at 10
    results[name] = await fetchViaBridge(name, season || '2025-26');
    await new Promise(r => setTimeout(r, 1500)); // respect rate limits
  }
  res.json(results);
});

app.get('/api/health', (req, res) => {
  const stats = loadNBAStats();
  res.json({
    status: 'WIN AI running',
    gamesLoaded: todaysGames.length,
    rostersCached: Object.keys(rosterCache).length,
    dataAvailable: stats?.dataAvailable || {},
    time: new Date().toISOString()
  });
});

app.get('/api/today', async (req, res) => {
  if (!todaysGames.length) await fetchTodaysGames();
  res.json({
    date: getToday(),
    games: todaysGames.map(g => {
      // BDL status field: upcoming games have ISO time, live/final have text
      let gameTime = 'TBD';
      const s = g.status || '';
      if (s.includes('T') && s.includes(':')) {
        // Parse ISO datetime to ET time
        try {
          const d = new Date(s);
          gameTime = d.toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit',
            timeZone: 'America/New_York', hour12: true
          }) + ' ET';
        } catch(_) { gameTime = s; }
      } else if (s) {
        gameTime = s; // 'Final', '3rd Qtr', etc.
      }
      return {
        id: g.id,
        home: g.home_team.full_name,
        away: g.visitor_team.full_name,
        status: g.status,
        gameTime
      };
    })
  });
});

app.get('/api/player-stats', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(await fetchPlayerStats(name));
});

// ESPN roster endpoint
app.get('/api/roster', async (req, res) => {
  const { team } = req.query;
  if (!team) return res.status(400).json({ error: 'team required' });
  res.json(await fetchESPNRoster(team));
});

app.get('/api/nba-stats', (req, res) => {
  const stats = loadNBAStats();
  if (!stats) return res.status(404).json({ error: 'Run fetch_stats.py first' });
  const { team } = req.query;
  if (team) {
    return res.json({
      advanced:    stats.teamAdvanced?.find(t => t.TEAM_NAME.toLowerCase().includes(team.toLowerCase())),
      oppShooting: stats.teamOppShooting?.find(t => t.TEAM_NAME.toLowerCase().includes(team.toLowerCase())),
      paintDef:    stats.teamPaintDef?.find(t => t.TEAM_NAME.toLowerCase().includes(team.toLowerCase())),
      dataAvailable: stats.dataAvailable
    });
  }
  res.json(stats);
});

// ─────────────────────────────────────────────────────
// MAIN PROP CONTEXT — assembles everything for Claude
// ─────────────────────────────────────────────────────
app.get('/api/prop-context', async (req, res) => {
  const { player, opponent, propType } = req.query;
  if (!player || !opponent) return res.status(400).json({ error: 'player and opponent required' });

  console.log(`[Analyze] ${player} vs ${opponent} — ${propType}`);

  // Load nba stats from cache (disk read at most every 5 min)
  const nbaStats = loadNBAStats();

  // ═══════════════════════════════════════════════════════════════
  // WAVE 1 — All external calls fire simultaneously
  // H2H bridge fires first (slowest) alongside everything else
  // ═══════════════════════════════════════════════════════════════
  // Start H2H bridge immediately — it takes longest (nba_api multi-season)
  const h2hBridgePromise = fetchH2HViaBridge(player, opponent);

  const [playerStats, oppRoster, lineups, propLines] = await Promise.all([
    fetchPlayerStats(player),
    fetchESPNRoster(opponent),
    fetchLineups(),
    fetchPropLines(player, propType || 'points'),
  ]);

  const playerTeamName = playerStats?.player?.team || '';

  // ═══════════════════════════════════════════════════════════════
  // WAVE 2 — Player roster + game context simultaneously
  // BDL H2H fallback runs here only if bridge found nothing
  // ═══════════════════════════════════════════════════════════════
  const oppTeamId =
    todaysGames.find(g => g.home_team.full_name.toLowerCase().includes(opponent.toLowerCase()))?.home_team?.id ||
    todaysGames.find(g => g.visitor_team.full_name.toLowerCase().includes(opponent.toLowerCase()))?.visitor_team?.id ||
    todaysGames.find(g => g.home_team.full_name.toLowerCase().includes(opponent.toLowerCase().split(' ').pop()))?.home_team?.id ||
    todaysGames.find(g => g.visitor_team.full_name.toLowerCase().includes(opponent.toLowerCase().split(' ').pop()))?.visitor_team?.id ||
    null;

  // Await H2H bridge (was started before wave 1 — likely done by now)
  const bridgeH2H = await h2hBridgePromise;

  const [playerRoster, gameContext, bdlH2HFallback] = await Promise.all([
    playerTeamName ? fetchESPNRoster(playerTeamName) : Promise.resolve(null),
    fetchGameContext(playerTeamName || player, opponent, null),
    // BDL H2H runs in parallel — only if bridge returned nothing
    (!bridgeH2H && playerStats?.player?.id && oppTeamId)
      ? fetchH2HStats(playerStats.player.id, null, oppTeamId, [2025, 2024, 2023])
      : Promise.resolve(null),
  ]);

  // ═══════════════════════════════════════════════════════════════
  // ASSEMBLE H2H — pick best available source
  // ═══════════════════════════════════════════════════════════════
  let h2hStats = null;
  if (bridgeH2H && bridgeH2H.gamesVsOpp > 0) {
    const avgs = bridgeH2H.avgs || {};
    h2hStats = {
      gamesVsOpp: bridgeH2H.gamesVsOpp,
      source:     'nba_api',
      pts:  avgs.pts  || 0, reb:  avgs.reb  || 0, ast:  avgs.ast  || 0,
      fg3m: avgs.fg3m || 0, fga:  avgs.fga  || 0, fg3a: avgs.fg3a || 0,
      fta:  avgs.fta  || 0, oreb: avgs.oreb || 0, dreb: avgs.dreb || 0,
      stl:  avgs.stl  || 0, blk:  avgs.blk  || 0, tov:  avgs.tov  || 0,
      min:  avgs.min  || 0,
      pra:  parseFloat(((avgs.pts||0)+(avgs.reb||0)+(avgs.ast||0)).toFixed(1)),
      fgPct:    avgs.fg_pct  || null,
      fg3Pct:   avgs.fg3_pct || null,
      h2hTrend: bridgeH2H.trend || 'STABLE',
      games:       bridgeH2H.recentGames || [],
      recentGames: (bridgeH2H.recentGames || []).slice(0, 6),
    };
    console.log(`[H2H] ✓ nba_api: ${h2hStats.gamesVsOpp} games — PTS:${h2hStats.pts} REB:${h2hStats.reb} AST:${h2hStats.ast}`);
  } else if (bdlH2HFallback) {
    h2hStats = bdlH2HFallback;
    console.log(`[H2H] BDL fallback: ${h2hStats.gamesVsOpp} games`);
  } else {
    console.warn(`[H2H] No H2H data — ${player} vs ${opponent}`);
  }

  // Team-level stats from nba.com files
  const oppAdvanced = nbaStats?.teamAdvanced?.find(t =>
    t.TEAM_NAME.toLowerCase().includes(opponent.toLowerCase())) || null;

  const oppShooting = nbaStats?.teamOppShooting?.find(t =>
    t.TEAM_NAME.toLowerCase().includes(opponent.toLowerCase())) || null;

  const oppPaintDef = nbaStats?.teamPaintDef?.find(t =>
    t.TEAM_NAME.toLowerCase().includes(opponent.toLowerCase())) || null;

  const playerTeamAdvanced = nbaStats?.teamAdvanced?.find(t =>
    t.TEAM_NAME.toLowerCase().includes(playerTeamName.toLowerCase())) || null;

  // Player-level stats from nba.com files — full name fuzzy match
  const playerSeasonStats = nbaStats?.playerStats
    ? fuzzyMatchPlayer(nbaStats.playerStats, player) : null;

  const playerPaintStats = nbaStats?.playerPaint
    ? fuzzyMatchPlayer(nbaStats.playerPaint, player) : null;

  // Today's confirmed game
  const todayGame = todaysGames.find(g =>
    g.home_team.full_name.toLowerCase().includes(opponent.toLowerCase()) ||
    g.visitor_team.full_name.toLowerCase().includes(opponent.toLowerCase()) ||
    g.home_team.full_name.toLowerCase().includes(playerTeamName.toLowerCase()) ||
    g.visitor_team.full_name.toLowerCase().includes(playerTeamName.toLowerCase())
  ) || null;

  // ── Pull ALL new stat categories for this player and opponent ──

  // Player playtypes (which play types they score on and how efficiently)
  const playerPlaytypes = {};
  const playtypeKeys = [
    ['iso','playtypeIso'],['transition','playtypeTransition'],
    ['prBall','playtypePRBall'],['prRoll','playtypePRRoll'],
    ['postUp','playtypePostUp'],['spotUp','playtypeSpotUp'],
    ['cut','playtypeCut'],['handoff','playtypeHandoff'],
    ['offScreen','playtypeOffScreen'],['putbacks','playtypePutbacks'],
  ];
  for (const [key, src] of playtypeKeys) {
    const match = nbaStats?.[src] ? fuzzyMatchPlayer(nbaStats[src], player) : null;
    if (match) playerPlaytypes[key] = match;
  }

  // Opponent team defense by playtype (how well they defend each play type)
  const oppDefPlaytypes = {};
  const teamDefKeys = [
    ['iso','teamDefIso'],['transition','teamDefTransition'],
    ['prBall','teamDefPRBall'],['prRoll','teamDefPRRoll'],
    ['postUp','teamDefPostUp'],['spotUp','teamDefSpotUp'],
    ['cut','teamDefCut'],['handoff','teamDefHandoff'],['offScreen','teamDefOffScreen'],
  ];
  for (const [key, src] of teamDefKeys) {
    const match = nbaStats?.[src]?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase()));
    if (match) oppDefPlaytypes[key] = match;
  }

  // Player tracking stats
  const playerTracking = {};
  const trackingKeys = [
    ['drives','trackingDrives'],['catchShoot','trackingCatchShoot'],
    ['passing','trackingPassing'],['touches','trackingTouches'],
    ['pullUp','trackingPullUp'],['elbow','trackingElbow'],
    ['post','trackingPost'],['paint','trackingPaint'],
    ['speed','trackingSpeed'],['offReb','trackingOffReb'],['defReb','trackingDefReb'],
  ];
  for (const [key, src] of trackingKeys) {
    const match = nbaStats?.[src] ? fuzzyMatchPlayer(nbaStats[src], player) : null;
    if (match) playerTracking[key] = match;
  }

  // Player shot dashboard (where/how they shoot)
  const playerShotDash = {};
  const shotDashKeys = [
    ['general','shotDashGeneral'],['shotClock','shotDashShotClock'],
    ['dribbles','shotDashDribbles'],['touchTime','shotDashTouch'],
    ['closestDef','shotDashCloseDef'],
  ];
  for (const [key, src] of shotDashKeys) {
    const match = nbaStats?.[src] ? fuzzyMatchPlayer(nbaStats[src], player) : null;
    if (match) playerShotDash[key] = match;
  }

  // Opponent shot defense dashboard (how they defend by shot type/situation)
  const oppShotDefense = {};
  const oppShotKeys = [
    ['general','oppShotGeneral'],['shotClock','oppShotClock'],
    ['dribbles','oppShotDribbles'],['touchTime','oppShotTouch'],
    ['closestDef','oppShotCloseDef'],
  ];
  for (const [key, src] of oppShotKeys) {
    const match = nbaStats?.[src]?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase()));
    if (match) oppShotDefense[key] = match;
  }

  // Defense dashboard for opponent (how they defend by shot distance)
  const oppDefDashboard = {};
  const defZoneKeys = [
    ['overall','defenseOverall'],['threePT','defense3PT'],
    ['twoPT','defense2PT'],['lt6ft','defenseLT6ft'],
    ['lt10ft','defenseLT10ft'],['gt15ft','defenseGT15ft'],
  ];
  for (const [key, src] of defZoneKeys) {
    const match = nbaStats?.[src]?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())
      || t.CLOSE_DEF_PERSON_ID !== undefined); // player-level defense
    if (match) oppDefDashboard[key] = match;
  }

  // Misc stats (paint points, second chance, fast break)
  const playerMiscStats  = nbaStats?.playerMisc ? fuzzyMatchPlayer(nbaStats.playerMisc, player) : null;
  const playerScoringDist = nbaStats?.playerScoring ? fuzzyMatchPlayer(nbaStats.playerScoring, player) : null;
  const playerAdvancedStats = nbaStats?.playerAdvanced ? fuzzyMatchPlayer(nbaStats.playerAdvanced, player) : null;
  const playerHustle = nbaStats?.hustlePlayer ? fuzzyMatchPlayer(nbaStats.hustlePlayer, player) : null;

  // Team misc/four factors for opponent
  const oppMisc       = nbaStats?.teamMisc?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())) || null;
  const oppFourFact   = nbaStats?.teamFourFactors?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())) || null;
  const oppScoring    = nbaStats?.teamScoring?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())) || null;
  const oppHustle     = nbaStats?.hustleTeam?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())) || null;

  // Calculate team rankings
  const allRankings = calcTeamRankings(nbaStats);
  const oppRanks    = getTeamRanks(opponent, allRankings);
  const playerTeamRanks = getTeamRanks(playerTeamName, allRankings);

  // Game context fetched in parallel above
  console.log(`[GameCtx] ${player}: total=${gameContext?.total} spread=${gameContext?.spread} b2b=${gameContext?.isBackToBack}`);

  // Calculate math-based projection — cached per player+propType for the day
  // Cache key includes injury hash — recalculates when lineup changes
  const currentInjuryHash = injuryHash(playerRoster);
  // Include spread/total in cache key so line moves invalidate projection
  const gcSig = gameContext?.total ? `t${gameContext.total}s${gameContext.spread}` : 'noGC';
  // Also invalidate cache if game context changed (b2b, big spread move)
  const cacheKey = `${player}:${propType}:${currentInjuryHash}:${gameContext.isBackToBack}`;
  let mathProjection = getCachedProjection(player, propType || 'points', currentInjuryHash);
  if (!mathProjection) {
    mathProjection = buildProjection(playerStats, {
      oppAdvanced, oppShooting, oppPaintDef, oppFourFact,
      playerRoster, playerTeamAdvanced,
      playerPlaytypes, oppDefPlaytypes,
      dataAvailable: nbaStats?.dataAvailable || {},
      h2hStats,
      gameContext,  // spread, total, back-to-back adjustments
      nbaPlayerStats: nbaStats?.playerAdvanced || nbaStats?.playerStats || [],  // for USG_PCT
    }, propType || 'points');
    if (mathProjection) {
      setCachedProjection(player, propType || 'points', mathProjection, currentInjuryHash);
      console.log(`[Proj] Calculated: ${player} ${propType} → ${mathProjection.projection} (${mathProjection.methodology})`);
    }
  } else {
    console.log(`[Proj] Cache hit: ${player} ${propType} → ${mathProjection.projection}`);
  }

  res.json({
    fetchedAt:          new Date().toISOString(),
    date:               getToday(),
    dataAvailable:      nbaStats?.dataAvailable || {},
    mathProjection,     // Independent mathematical projection
    // Player
    playerStats,
    playerSeasonStats,
    playerAdvancedStats,
    playerPaintStats,
    playerMiscStats,
    playerScoringDist,
    playerHustle,
    playerPlaytypes,
    playerTracking,
    playerShotDash,
    playerRoster,
    // Opponent team
    oppAdvanced,
    oppShooting,
    oppPaintDef,
    oppMisc,
    oppFourFact,
    oppScoring,
    oppHustle,
    oppDefPlaytypes,
    oppDefDashboard,
    oppShotDefense,
    oppRoster,
    oppRanks,          // rank 1-30 for each key stat
    playerTeamRanks,
    // Player team
    playerTeamAdvanced,
    // Schedule
    todayGame,
    allTodaysGames: todaysGames.map(g => `${g.visitor_team.full_name} @ ${g.home_team.full_name}`),
    lineups:   lineups?.error ? null : lineups,
    propLines: propLines?.error ? null : propLines,
    h2hStats,            // Historical stats vs this specific opponent (includes full box score log)
    h2hGamesLog: h2hStats?.games || h2hStats?.recentGames || [],  // individual game box scores
    oppTeamId,
    gameContext,         // spread, total, back-to-back, adjustment details
  });
});

// ─────────────────────────────────────────────────────
// CLAUDE PROXY
// ─────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  if (!process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_KEY.includes('your_')) {
    return res.status(500).json({ error: 'Anthropic API key not configured in .env' });
  }
  try {
    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-20250514', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 }
    );
    res.json({ response: claudeRes.data.content.map(b => b.text || '').join('') });
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || 'Unknown error';
    const errStatus = err.response?.status || 500;
    console.error(`[Claude] Error ${errStatus}:`, errMsg);
    console.error('[Claude] Full error:', JSON.stringify(err.response?.data || {}, null, 2));
    res.status(500).json({ error: errMsg, status: errStatus });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── PLAYER MATCHUP LOOKUP ─────────────────────────────────────────
// Given a player name, finds today's opponent automatically
app.get('/api/player-matchup', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });

  // Make sure today's games are loaded
  if (!todaysGames.length) await fetchTodaysGames();

  try {
    // Fast path: use cached player stats if available
    let playerTeam = '';
    let playerTeamId = null;
    let playerFullName = name;

    const cached = playerStatsCache[name];
    if (cached?.player?.team && cached?.player?.id) {
      playerTeam   = cached.player.team;
      playerFullName = cached.player.name;
      console.log(`[matchup] Using cached team for ${name}: ${playerTeam}`);
    } else {
      // Search BDL for the player to get their team
      const searchRes = await axios.get(`${BALLDONTLIE}/players`, {
        params: { search: name, per_page: 5 },
        headers: { Authorization: process.env.BALLDONTLIE_KEY },
        timeout: 8000
      });

      const players = searchRes.data.data || [];
      if (!players.length) return res.json({ found: false, error: 'Player not found' });

      // Fuzzy match
      const player = fuzzyMatchPlayer(
        players.map(p => ({ ...p, name: `${p.first_name} ${p.last_name}` })),
        name
      ) || players[0];

      playerTeam   = player.team?.full_name || '';
      playerTeamId = player.team?.id;
      playerFullName = `${player.first_name} ${player.last_name}`;
    }

    // Find today's game — match by ID first, then full name, then partial name
    const todayGame = todaysGames.find(g =>
      g.home_team.id === playerTeamId ||
      g.visitor_team.id === playerTeamId
    ) || todaysGames.find(g =>
      g.home_team.full_name === playerTeam ||
      g.visitor_team.full_name === playerTeam
    ) || todaysGames.find(g =>
      // Partial match — handles "76ers" vs "Philadelphia 76ers"
      playerTeam && (
        g.home_team.full_name.toLowerCase().includes(playerTeam.toLowerCase().split(' ').pop()) ||
        g.visitor_team.full_name.toLowerCase().includes(playerTeam.toLowerCase().split(' ').pop())
      )
    );

    if (!todayGame) {
      return res.json({
        found: true,
        playing: false,
        player: playerFullName,
        team: playerTeam,
        message: `${playerTeam} does not play today`
      });
    }

    // Determine opponent
    const isHome = todayGame.home_team.full_name === playerTeam ||
                   todayGame.home_team.id === playerTeamId;
    const opponent = isHome
      ? todayGame.visitor_team.full_name
      : todayGame.home_team.full_name;

    // Parse game time from BDL status field
    let gameTime = 'TBD';
    const rawStatus = todayGame.status || '';
    if (rawStatus.includes('T') && rawStatus.includes(':')) {
      try {
        const d = new Date(rawStatus);
        gameTime = d.toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit',
          timeZone: 'America/New_York', hour12: true
        }) + ' ET';
      } catch(_) { gameTime = rawStatus; }
    } else if (rawStatus) {
      gameTime = rawStatus; // 'Final', 'Halftime', etc.
    }

    return res.json({
      found: true,
      playing: true,
      player: playerFullName,
      team: playerTeam,
      opponent,
      isHome,
      gameTime,
      gameId: todayGame.id
    });

  } catch (err) {
    console.error('[matchup] Error:', err.message);
    res.json({ found: false, error: err.message });
  }
});


// ── MATCHUP DEBUG ─────────────────────────────────────────────────
app.get('/api/debug-matchup', async (req, res) => {
  if (!todaysGames.length) await fetchTodaysGames();
  res.json({
    gamesLoaded: todaysGames.length,
    games: todaysGames.map(g => ({
      home: g.home_team.full_name,
      homeId: g.home_team.id,
      away: g.visitor_team.full_name,
      awayId: g.visitor_team.id,
      status: g.status
    })),
    cachedPlayers: Object.keys(playerStatsCache)
  });
});



// ─────────────────────────────────────────────────────────────
// CACHE CLEAR — force fresh data on next request
// Clears: projections, player stats, H2H bridge, rosters, nba stats
// ─────────────────────────────────────────────────────────────
app.post('/api/cache-clear', (req, res) => {
  const { target } = req.body || {};

  if (!target || target === 'all') {
    projectionCache  = {};
    playerStatsCache = {};
    Object.keys(nbaApiBridgeCache).forEach(k => delete nbaApiBridgeCache[k]);
    rosterCache      = {};
    lastRosterFetch  = {};
    nbaStatsCache    = null;
    lastStatsDiskRead = 0;
    console.log('[Cache] ALL caches cleared by user request');
    return res.json({ ok: true, cleared: ['projections','playerStats','h2hBridge','rosters','nbaStats'] });
  }

  const cleared = [];
  if (target === 'projections' || target === 'projection') {
    projectionCache = {};
    cleared.push('projections');
  }
  if (target === 'stats' || target === 'player') {
    playerStatsCache = {};
    Object.keys(nbaApiBridgeCache).forEach(k => delete nbaApiBridgeCache[k]);
    cleared.push('playerStats', 'h2hBridge');
  }
  if (target === 'rosters' || target === 'roster') {
    rosterCache     = {};
    lastRosterFetch = {};
    cleared.push('rosters');
  }
  if (target === 'h2h') {
    Object.keys(nbaApiBridgeCache)
      .filter(k => k.startsWith('h2h:'))
      .forEach(k => delete nbaApiBridgeCache[k]);
    cleared.push('h2hBridge');
  }

  console.log(`[Cache] Cleared: ${cleared.join(', ')}`);
  res.json({ ok: true, cleared });
});

// Also expose as GET for quick browser testing
app.get('/api/cache-clear', (req, res) => {
  projectionCache  = {};
  playerStatsCache = {};
  Object.keys(nbaApiBridgeCache).forEach(k => delete nbaApiBridgeCache[k]);
  rosterCache      = {};
  lastRosterFetch  = {};
  nbaStatsCache    = null;
  lastStatsDiskRead = 0;
  console.log('[Cache] ALL caches cleared via GET');
  res.json({ ok: true, cleared: 'all', message: 'All caches cleared — next analysis will fetch fresh data' });
});

// ── ROSTER REFRESH ────────────────────────────────────────────────
// Force-clear all cached rosters so next request gets fresh data
app.post('/api/roster-refresh', (req, res) => {
  rosterCache    = {};
  lastRosterFetch = {};
  console.log('[API] Roster cache force-cleared');
  res.json({ ok: true, message: 'All roster caches cleared — next request will fetch fresh data' });
});

// ── DEBUG ROUTE ───────────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  const results = { time: new Date().toISOString() };
  try {
    const r = await axios.get(`${BALLDONTLIE}/games`, {
      params: { dates: [getToday()], per_page: 3 },
      headers: { Authorization: process.env.BALLDONTLIE_KEY },
      timeout: 8000
    });
    results.balldontlie = { ok: true, games: r.data.data?.length || 0 };
  } catch (e) {
    results.balldontlie = { ok: false, status: e.response?.status, error: e.response?.data?.error || e.message };
  }
  try {
    const r = await axios.get(`${ESPN_BASE}/teams/bos/roster`, { timeout: 5000 });
    const espnRaw = r.data?.athletes || [];
    const espnIsGrouped = espnRaw.length > 0 && Array.isArray(espnRaw[0]?.items);
    const espnCount = espnIsGrouped
      ? espnRaw.flatMap(g => g.items||[]).length
      : espnRaw.filter(p => p.fullName).length;
    results.espn = {
      ok: true,
      players: espnCount,
      format: espnIsGrouped ? 'grouped' : 'flat',
      rawGroups: espnRaw.length
    };
  } catch (e) {
    results.espn = { ok: false, error: e.message };
  }
  results.env = {
    balldontlie: !!process.env.BALLDONTLIE_KEY,
    anthropic: !!(process.env.ANTHROPIC_KEY && !process.env.ANTHROPIC_KEY.includes('your_')),
    oddsApi: !!process.env.ODDS_API_KEY,
    rapidApi: !!process.env.RAPIDAPI_KEY,
    anthropicKeyPrefix: process.env.ANTHROPIC_KEY?.slice(0,12) + '...'
  };
  const fs = require('fs');
  results.dataFiles = {
    teamAdvanced: fs.existsSync('team_advanced.json'),
    playerStats:  fs.existsSync('player_stats.json'),
    teamPaint:    fs.existsSync('team_paint_defense.json'),
    teamOppShoot: fs.existsSync('team_opp_shooting.json'),
    playerPaint:  fs.existsSync('player_paint_stats.json'),
  };
  results.gamesLoaded = todaysGames.length;
  results.cacheSize = Object.keys(playerStatsCache).length;
  res.json(results);
});


// ─────────────────────────────────────────────────────
// SCHEDULED JOBS
// ─────────────────────────────────────────────────────
cron.schedule('0 9 * * *', fetchTodaysGames);

// Auto-refresh nba.com stat files every morning at 7am
// This keeps playtypes, tracking, shot dashboard etc current
cron.schedule('0 7 * * *', () => {
  console.log('[CRON] Auto-running fetch_stats.py to refresh nba.com data...');
  const py = spawn('python', ['fetch_stats.py'], { cwd: __dirname });
  py.stdout.on('data', d => console.log('[fetch_stats]', d.toString().trim()));
  py.stderr.on('data', d => console.error('[fetch_stats ERR]', d.toString().trim()));
  py.on('close', code => {
    console.log(`[CRON] fetch_stats.py finished (exit ${code})`);
    // Clear stats cache so new files are loaded
    nbaStatsCache = null;
    lastStatsDiskRead = 0;
  });
});                                          // refresh games 9am daily
cron.schedule('0 0 * * *', () => {                                                      // midnight reset
  playerStatsCache = {};
  projectionCache  = {};   // clear projections for new day
  lineupCache      = null;
  rosterCache      = {};   // clear rosters — trades announced overnight
  lastRosterFetch  = {};
  nbaStatsCache    = null;
  console.log('[CRON] All caches cleared');
});
cron.schedule('0 12,17 * * *', () => { lastLineupFetch = null; fetchLineups(); });     // lineup refresh at noon + 5pm
cron.schedule('0 8,12,16 * * *', () => { rosterCache = {}; lastRosterFetch = {}; });         // roster refresh every morning

// ─────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
// Clear roster cache on startup to ensure fresh rosters
rosterCache   = {};
lastRosterFetch = {};
console.log('[STARTUP] Roster cache cleared — fetching fresh rosters on first request');

fetchTodaysGames().then(() => {
  app.listen(PORT, () => {
    console.log('\n  WIN AI — NBA Props Engine');
    console.log(`  Running → http://localhost:${PORT}`);
    console.log('  ESPN rosters: LIVE (no key needed)');
    console.log('  Stat files: run python fetch_stats.py to refresh\n');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEAM RANKINGS ENGINE
// Calculates rank (1-30) for each team stat across all 30 teams
// Lower rank = better (rank 1 = best)
// ═══════════════════════════════════════════════════════════════════
function calcTeamRankings(nbaStats) {
  if (!nbaStats?.teamAdvanced) return null;

  const teams   = nbaStats.teamAdvanced    || [];
  const base    = nbaStats.teamBase        || [];
  const opp     = nbaStats.teamOppShooting || [];
  const misc    = nbaStats.teamMisc        || [];
  const paint   = nbaStats.teamPaintDef    || [];
  const ff      = nbaStats.teamFourFactors || [];
  const scoring = nbaStats.teamScoring     || [];

  // Rank a stat — require at least 20 teams (not 28) since some files may be partial
  function rankStat(arr, key, lowerBetter = false, altKey = null) {
    let vals = arr
      .map(t => ({ name: t.TEAM_NAME, val: parseFloat(t[key]) }))
      .filter(t => t.name && !isNaN(t.val) && t.val !== null);

    // Try alternate key if primary has too few values
    if (vals.length < 20 && altKey) {
      vals = arr
        .map(t => ({ name: t.TEAM_NAME, val: parseFloat(t[altKey]) }))
        .filter(t => t.name && !isNaN(t.val) && t.val !== null);
    }

    if (vals.length < 15) return {}; // not enough teams to rank
    const sorted = [...vals].sort((a,b) => lowerBetter ? a.val-b.val : b.val-a.val);
    const rankMap = {};
    sorted.forEach((t,i) => { rankMap[t.name] = i+1; });
    return rankMap;
  }

  return {
    // ── OFFENSIVE ──────────────────────────────────
    offRating:    rankStat(teams,   'OFF_RATING',    false), // higher=better
    pace:         rankStat(teams,   'PACE',          false),
    ts_pct:       rankStat(teams,   'TS_PCT',        false),
    netRating:    (() => {
      // Try direct NET_RATING field, fall back to OFF - DEF
      const direct = rankStat(teams, 'NET_RATING', false);
      if (Object.keys(direct).length >= 28) return direct;
      const computed = teams.map(t => ({
        TEAM_NAME: t.TEAM_NAME,
        NET_RATING: (parseFloat(t.OFF_RATING)||0) - (parseFloat(t.DEF_RATING)||0)
      }));
      return rankStat(computed, 'NET_RATING', false);
    })(),
    pctPts3:      rankStat(scoring, 'PCT_PTS_3PT',   false), // 3pt heavy offense
    pctPtsPaint:  rankStat(scoring, 'PCT_PTS_PAINT', false), // paint heavy offense
    // ── DEFENSIVE ─────────────────────────────────
    defRating:    rankStat(teams, 'DEF_RATING',    true),  // lower=better defense
    // OPP shooting file uses PTS (per game) — try OPP_PTS as fallback
    oppPts:       rankStat(opp,   'PTS',           true, 'OPP_PTS'),
    oppFgPct:     rankStat(opp,   'FG_PCT',        true, 'OPP_FG_PCT'),
    oppFg3Pct:    rankStat(opp,   'FG3_PCT',       true, 'OPP_FG3_PCT'),
    oppReb:       rankStat(opp,   'REB',           true, 'OPP_REB'),
    oppAst:       rankStat(opp,   'AST',           true, 'OPP_AST'),
    // ── PAINT DEFENSE ─────────────────────────────
    // Paint defense file: FGA and FG_PCT are per-game
    paintFga:     rankStat(paint, 'FGA',     true),
    paintFgPct:   rankStat(paint, 'FG_PCT',  true),
    // ── MISC ──────────────────────────────────────
    // Misc file: these are per-game values
    oppPtsPaint:  rankStat(misc, 'OPP_PTS_PAINT',      true),
    oppPtsFb:     rankStat(misc, 'OPP_PTS_FB',         true),
    oppPts2ndCh:  rankStat(misc, 'OPP_PTS_2ND_CHANCE', true),
    oppPtsOff:    rankStat(misc, 'OPP_PTS_OFF_TOV',    true),
    // ── FOUR FACTORS ──────────────────────────────
    oppEfgPct:    rankStat(ff, 'OPP_EFG_PCT', true),
    oppTovPct:    rankStat(ff, 'OPP_TOV_PCT', false), // higher=forces more turnovers
    oppOrebPct:   rankStat(ff, 'OPP_OREB_PCT',true),
    // ── TEAM ADVANCED (always available from team_advanced.json) ──
    astPct:       rankStat(teams, 'AST_PCT', false),
  };
}

function getTeamRanks(teamName, rankings) {
  if (!rankings || !teamName) return null;
  const result = {};
  for (const [stat, rankMap] of Object.entries(rankings)) {
    const rank = rankMap[teamName] || null;
    if (rank) result[stat] = rank;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// CLV TRACKING — Closing Line Value
// Stores analyses and closing lines for long-term edge measurement
// ═══════════════════════════════════════════════════════════════════
// fs already required at top
const CLV_FILE = 'clv_tracker.json';

function loadCLV() {
  try {
    if (!fs.existsSync(CLV_FILE)) return [];
    return JSON.parse(fs.readFileSync(CLV_FILE, 'utf8'));
  } catch (_) { return []; }
}

function saveCLV(data) {
  try {
    fs.writeFileSync(CLV_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (_) { return false; }
}

// Save a new analysis entry
app.post('/api/clv/save', (req, res) => {
  const { player, opp, propType, line, projection, verdict, edge, confidence, gameDate } = req.body;
  if (!player || !line) return res.status(400).json({ error: 'player and line required' });

  const entries = loadCLV();
  const entry = {
    id:          Date.now(),
    date:        gameDate || new Date().toISOString().split('T')[0],
    savedAt:     new Date().toISOString(),
    player, opp, propType, line: parseFloat(line),
    projection:  parseFloat(projection) || null,
    verdict,
    edge:        parseFloat(edge) || null,
    confidence:  parseInt(confidence) || null,
    // These get filled in after the game
    closingLine: null,
    result:      null,   // 'WIN' | 'LOSS' | 'PUSH' | 'NO_BET'
    actualStat:  null,
    clv:         null,   // closingLine - openLine (positive = beat closing)
    notes:       ''
  };
  entries.unshift(entry);
  saveCLV(entries);
  res.json({ ok: true, id: entry.id, entry });
});

// Update with closing line and result after game
app.post('/api/clv/update', (req, res) => {
  const { id, closingLine, result, actualStat, notes } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });

  const entries = loadCLV();
  const idx = entries.findIndex(e => e.id === parseInt(id));
  if (idx < 0) return res.status(404).json({ error: 'Entry not found' });

  entries[idx].closingLine = closingLine ? parseFloat(closingLine) : entries[idx].closingLine;
  entries[idx].result      = result || entries[idx].result;
  entries[idx].actualStat  = actualStat ? parseFloat(actualStat) : entries[idx].actualStat;
  entries[idx].notes       = notes || entries[idx].notes;

  // Calculate CLV: how much better was our line vs closing line
  if (entries[idx].closingLine && entries[idx].line) {
    if (entries[idx].verdict === 'OVER') {
      // For OVER bets: lower closing line = positive CLV (we got better number)
      entries[idx].clv = parseFloat((entries[idx].closingLine - entries[idx].line).toFixed(1));
    } else if (entries[idx].verdict === 'UNDER') {
      // For UNDER bets: higher closing line = positive CLV
      entries[idx].clv = parseFloat((entries[idx].line - entries[idx].closingLine).toFixed(1));
    }
  }

  saveCLV(entries);
  res.json({ ok: true, entry: entries[idx] });
});

// Get all CLV entries with summary stats
app.get('/api/clv', (req, res) => {
  const entries = loadCLV();
  const withResult = entries.filter(e => e.result && e.result !== 'NO_BET');
  const wins   = withResult.filter(e => e.result === 'WIN').length;
  const losses = withResult.filter(e => e.result === 'LOSS').length;
  const pushes = withResult.filter(e => e.result === 'PUSH').length;
  const clvEntries = entries.filter(e => e.clv !== null);
  const avgCLV = clvEntries.length
    ? parseFloat((clvEntries.reduce((s, e) => s + e.clv, 0) / clvEntries.length).toFixed(2))
    : null;

  res.json({
    entries,
    summary: {
      total: entries.length,
      graded: withResult.length,
      wins, losses, pushes,
      winRate: withResult.length ? parseFloat((wins / withResult.length * 100).toFixed(1)) : null,
      avgCLV,
      positiveCLV: clvEntries.filter(e => e.clv > 0).length,
      negativeCLV: clvEntries.filter(e => e.clv < 0).length,
    }
  });
});

// Delete entry
app.delete('/api/clv/:id', (req, res) => {
  const entries = loadCLV().filter(e => e.id !== parseInt(req.params.id));
  saveCLV(entries);
  res.json({ ok: true });
});

