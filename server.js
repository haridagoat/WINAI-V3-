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
let playerStatsCache      = {};   // keyed by player name
let lastPlayerStatsFetch  = {};   // timestamps per player name — unlike every other cache in
                                   // this file, this one used to have no TTL at all, so a
                                   // player's L5/L10 averages froze forever after the first
                                   // fetch instead of picking up new games.
const PLAYER_STATS_TTL = 30 * 60 * 1000; // 30 min
let projectionCache   = {};   // keyed by 'playerName:propType' — persists all day, clears on injury

function injuryHash(playerRoster) {
  if (!playerRoster?.injured?.length) return 'none';
  return playerRoster.injured.map(p => p.name + p.status).sort().join('|');
}
function getCachedProjection(playerName, propType, curSignature) {
  const key = `${playerName}:${propType}`;
  const c = projectionCache[key];
  if (!c) return null;
  if (c.injuryHash !== curSignature) {
    delete projectionCache[key];
    console.log(`[Proj] Context change for ${playerName} — recalculating`);
    return null;
  }
  return c.projection;
}
function setCachedProjection(playerName, propType, projection, curSignature) {
  projectionCache[`${playerName}:${propType}`] = { projection, injuryHash: curSignature };
}
let rosterCache       = {};   // keyed by ESPN team abbreviation
let lastRosterFetch   = {};   // timestamps per team
let lineupCache       = null;
let lastLineupFetch   = null;
let nbaStatsCache     = null; // loaded once from disk, cleared at midnight
let lastStatsDiskRead = 0;

const BALLDONTLIE   = 'https://api.balldontlie.io/v1';
// Real bug found live: this was referenced in two places (BDL supplement
// lookup + BDL fallback search) but never actually defined anywhere in the
// file — a bare ReferenceError, silently swallowed by the surrounding
// try/catch, meant team/position/height supplement data has been failing
// 100% of the time, and the entire BDL-fallback data source (used when the
// nba_api bridge fails for a player) crashed immediately instead of
// searching. Empty for now — no evidence any name needs correcting; add
// entries here only for real, confirmed BDL/nba_api spelling mismatches.
const BDL_NAME_MAP = {};
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
// toISOString() always converts to UTC before formatting, which rolls the
// calendar date over at UTC midnight — for any US timezone that's late
// afternoon/evening local time, so "today" (and every day-locked cache
// keyed off it) would silently flip to tomorrow hours before real local
// midnight. This app runs on the user's own machine, so plain
// getFullYear/Month/Date (which read the OS's local timezone) give the
// correct local calendar day instead.
function toLocalDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getToday()        { return toLocalDateStr(new Date()); }
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

// ── WNBA equivalent — from fetch_wnba_stats.py (stats.nba.com, LeagueID=10) ──
// No Synergy playtypes / SportVU tracking / hustle exist for the WNBA
// (confirmed empty via nba_api), so this only carries the box-score-derived
// categories that actually return real data — see fetch_wnba_stats.py.
let wnbaStatsCache = null;
let lastWnbaStatsDiskRead = 0;

function loadWNBAStats() {
  const now = Date.now();
  if (wnbaStatsCache && (now - lastWnbaStatsDiskRead) < 5 * 60 * 1000) return wnbaStatsCache;

  const load = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { return null; }
  };
  const exists = (f) => fs.existsSync(f);

  wnbaStatsCache = {
    teamTraditional: load('wnba_team_traditional.json'),
    teamAdvanced:    load('wnba_team_advanced.json'),
    teamFourFactors: load('wnba_team_four_factors.json'),
    teamMisc:        load('wnba_team_misc.json'),
    teamScoring:     load('wnba_team_scoring.json'),
    teamOppShooting: load('wnba_team_opp_shooting.json'),
    playerStats:     load('wnba_player_stats.json'),
    playerAdvanced:  load('wnba_player_advanced.json'),
    playerMisc:      load('wnba_player_misc.json'),
    playerScoring:   load('wnba_player_scoring.json'),
    shotDashGeneral: load('wnba_shotdash_general_player.json'),

    dataAvailable: {
      teamAdvanced:    exists('wnba_team_advanced.json'),
      teamFourFactors: exists('wnba_team_four_factors.json'),
      teamMisc:        exists('wnba_team_misc.json'),
      teamOppShooting: exists('wnba_team_opp_shooting.json'),
      playerAdvanced:  exists('wnba_player_advanced.json'),
      shotDash:        exists('wnba_shotdash_general_player.json'),
    }
  };

  lastWnbaStatsDiskRead = now;
  const loaded = Object.values(wnbaStatsCache.dataAvailable).filter(Boolean).length;
  console.log(`[Cache] WNBA stats loaded (${loaded}/6 categories available)`);
  return wnbaStatsCache;
}

// ── TEAM COMPARE — real per-game/rank stats + last-5 + H2H (Daily Matchups) ──
function getTeamStatBlock(league, teamName) {
  const stats = league === 'wnba' ? loadWNBAStats() : loadNBAStats();
  const find = (arr) => arr?.find(t => t.TEAM_NAME?.toLowerCase().includes((teamName || '').toLowerCase()));
  const trad = find(stats?.teamTraditional);
  const adv  = find(stats?.teamAdvanced);
  if (!trad && !adv) return null;
  const gp = trad?.GP || adv?.GP || 1;
  return {
    team:          trad?.TEAM_NAME || adv?.TEAM_NAME || teamName,
    record:        trad ? `${trad.W}-${trad.L}` : null,
    winPctRank:    trad?.W_PCT_RANK ?? null,
    totalTeams:    league === 'wnba' ? Object.keys(WNBA_ABBR_TO_NAME).length : 30,
    ppg:           trad ? (trad.PTS / gp).toFixed(1) : null,     ppgRank:  trad?.PTS_RANK  ?? null,
    rpg:           trad ? (trad.REB / gp).toFixed(1) : null,     rpgRank:  trad?.REB_RANK  ?? null,
    apg:           trad ? (trad.AST / gp).toFixed(1) : null,     apgRank:  trad?.AST_RANK  ?? null,
    topg:          trad ? (trad.TOV / gp).toFixed(1) : null,     topgRank: trad?.TOV_RANK  ?? null,
    fgPct:         trad ? (trad.FG_PCT  * 100).toFixed(1) : null, fgPctRank:  trad?.FG_PCT_RANK  ?? null,
    fg3Pct:        trad ? (trad.FG3_PCT * 100).toFixed(1) : null, fg3PctRank: trad?.FG3_PCT_RANK ?? null,
    pace:          adv?.PACE ?? null,       paceRank:      adv?.PACE_RANK ?? null,
    offRating:     adv?.OFF_RATING ?? null, offRatingRank: adv?.OFF_RATING_RANK ?? null,
    defRating:     adv?.DEF_RATING ?? null, defRatingRank: adv?.DEF_RATING_RANK ?? null,
    netRating:     adv?.NET_RATING ?? null,
  };
}

// stats.nba.com hasn't onboarded the WNBA's 2026 expansion franchises
// (Toronto Tempo, Portland Fire) into any of its endpoints yet — confirmed
// live, both team- and player-level. ESPN's public site API does carry
// real per-game stats for these teams, so use it as an honest fallback
// (no fabricated pace/ratings — ESPN doesn't expose those, so they're left
// null rather than guessed) instead of showing "no data" for a real team.
async function fetchESPNTeamStatFallback(league, teamName) {
  const abbr = league === 'wnba' ? resolveWNBATeam(teamName) : resolveESPNTeam(teamName);
  if (!abbr) return null;
  const base = league === 'wnba' ? ESPN_BASE_WNBA : ESPN_BASE;
  try {
    const [teamRes, statsRes] = await Promise.all([
      axios.get(`${base}/teams/${abbr}`, { timeout: 8000 }),
      axios.get(`${base}/teams/${abbr}/statistics`, { timeout: 8000 }),
    ]);
    const recordItem = teamRes.data?.team?.record?.items?.find(i => i.type === 'total');
    const find = (name) => recordItem?.stats?.find(s => s.name === name)?.value;
    const wins = find('wins'), losses = find('losses');
    const categories = statsRes.data?.results?.stats?.categories || [];
    const stat = (cat, name) => categories.find(c => c.name === cat)?.stats?.find(s => s.name === name)?.value;
    return {
      team: teamRes.data?.team?.displayName || teamName,
      record: (wins != null && losses != null) ? `${wins}-${losses}` : null,
      winPctRank: null,
      totalTeams: league === 'wnba' ? Object.keys(WNBA_ABBR_TO_NAME).length : 30,
      ppg: stat('offensive','avgPoints')?.toFixed?.(1) ?? stat('offensive','avgPoints') ?? null, ppgRank: null,
      rpg: stat('general','avgRebounds')?.toFixed?.(1) ?? stat('general','avgRebounds') ?? null, rpgRank: null,
      apg: stat('offensive','avgAssists')?.toFixed?.(1) ?? stat('offensive','avgAssists') ?? null, apgRank: null,
      topg: stat('offensive','avgTurnovers')?.toFixed?.(1) ?? stat('offensive','avgTurnovers') ?? null, topgRank: null,
      fgPct: stat('offensive','fieldGoalPct')?.toFixed?.(1) ?? stat('offensive','fieldGoalPct') ?? null, fgPctRank: null,
      fg3Pct: stat('offensive','threePointPct')?.toFixed?.(1) ?? stat('offensive','threePointPct') ?? null, fg3PctRank: null,
      pace: null, paceRank: null,
      offRating: null, offRatingRank: null,
      defRating: null, defRatingRank: null,
      netRating: null,
      source: 'ESPN (stats.nba.com has not onboarded this team yet)',
    };
  } catch (_) { return null; }
}

async function getTeamStatBlockWithFallback(league, teamName) {
  const primary = getTeamStatBlock(league, teamName);
  if (primary) return primary;
  return fetchESPNTeamStatFallback(league, teamName);
}

// Diacritic/punctuation/case-insensitive name compare — the season-stats
// files (player_advanced.json) and the live ESPN roster feed don't always
// spell a name identically (e.g. "Nikola Vučević" vs "Nikola Vucevic").
function normalizePlayerName(s) {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[.'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Real per-player usage rate (USG_PCT) — already fetched for both leagues
// (player_advanced.json / wnba_player_advanced.json) but never surfaced in
// the Daily Matchups view, which only ever looked at blunt team totals.
//
// The season-stats file's TEAM_ID reflects the team a player finished that
// SEASON on — once a player is traded (mid-season, or over the following
// offseason), that TEAM_ID goes stale until the stats fetcher re-runs for
// a new season. Cross-checking against the live ESPN roster (already
// fetched/cached elsewhere) means a moved player never gets attributed to
// their old team here, even if the underlying stats file hasn't caught up.
async function getTopUsagePlayers(league, teamName, n = 5) {
  const stats = league === 'wnba' ? loadWNBAStats() : loadNBAStats();
  const teamRow = (stats?.teamAdvanced || stats?.teamTraditional)
    ?.find(t => t.TEAM_NAME?.toLowerCase().includes((teamName || '').toLowerCase()));
  if (!teamRow) return [];
  const adv = stats?.playerAdvanced || [];
  const trad = stats?.playerStats || [];
  const tradById = {};
  for (const p of trad) tradById[p.PLAYER_ID] = p;

  const roster = league === 'wnba' ? await fetchWNBARoster(teamName) : await fetchESPNRoster(teamName);
  const liveNames = new Set((roster?.players || []).map(p => normalizePlayerName(p.name)));
  // If the live roster fetch failed, fall back to trusting the stats file
  // rather than silently returning zero players.
  const rosterKnown = liveNames.size > 0;

  return adv
    .filter(p => p.TEAM_ID === teamRow.TEAM_ID && p.USG_PCT != null && p.MIN >= 8)
    .filter(p => !rosterKnown || liveNames.has(normalizePlayerName(p.PLAYER_NAME)))
    .sort((a, b) => b.USG_PCT - a.USG_PCT)
    .slice(0, n)
    .map(p => {
      const t = tradById[p.PLAYER_ID];
      return {
        id: p.PLAYER_ID,
        name: p.PLAYER_NAME,
        usgPct: (p.USG_PCT * 100).toFixed(1),
        usgPctNum: p.USG_PCT * 100,
        minutes: p.MIN?.toFixed?.(1) ?? p.MIN,
        ppg: (t && t.GP) ? (t.PTS / t.GP).toFixed(1) : null,
        headshot: headshotUrl(league, p.PLAYER_ID),
      };
    });
}

// Real headshot CDNs, keyed by the same stats.nba.com-style PLAYER_ID
// already present in player_advanced.json / wnba_player_advanced.json —
// confirmed working (incl. for players on the two 2026 WNBA expansion
// teams, whose IDs come from the stats.wnba.com zone-table fallback).
function headshotUrl(league, playerId) {
  if (!playerId) return null;
  return league === 'wnba'
    ? `https://cdn.wnba.com/headshots/wnba/latest/1040x760/${playerId}.png`
    : `https://cdn.nba.com/headshots/nba/latest/1040x760/${playerId}.png`;
}

// Real position-group defense — NBA only. stats.nba.com's tracking-based
// Defense Dashboard (defense_overall.json, per-defender D_FG_PCT vs each
// defender's NORMAL_FG_PCT) has no WNBA equivalent (same "no SportVU for
// WNBA" gap as playtypes/hustle, confirmed empty in fetch_wnba_stats.py) —
// returns null for WNBA rather than faking a number.
const POSITION_GROUPS = { Guards: ['PG', 'SG', 'G'], Wings: ['SF', 'PF', 'F'], Bigs: ['C'] };
function getTeamPositionDefense(league, teamName) {
  if (league === 'wnba') return null;
  const stats = loadNBAStats();
  const teamRow = stats?.teamAdvanced?.find(t => t.TEAM_NAME?.toLowerCase().includes((teamName || '').toLowerCase()));
  if (!teamRow || !stats?.defenseOverall?.length) return null;
  const defenders = stats.defenseOverall.filter(d => d.PLAYER_LAST_TEAM_ID === teamRow.TEAM_ID);
  if (!defenders.length) return null;

  const out = {};
  for (const [label, positions] of Object.entries(POSITION_GROUPS)) {
    const rows = defenders.filter(d => positions.includes(d.PLAYER_POSITION));
    let wFga = 0, wDfg = 0, wNfg = 0;
    for (const r of rows) {
      const w = r.D_FGA || 0; // weight by actual volume of shots defended
      wFga += w;
      wDfg += (r.D_FG_PCT || 0) * w;
      wNfg += (r.NORMAL_FG_PCT || 0) * w;
    }
    out[label] = wFga
      ? { defFgPct: (wDfg / wFga * 100).toFixed(1), normalFgPct: (wNfg / wFga * 100).toFixed(1), diffPts: ((wNfg - wDfg) / wFga * 100).toFixed(1) }
      : null;
  }
  return out;
}

// ESPN's site API team-schedule endpoint carries real box scores for every
// completed game this season — used for both "last 5 games" and real H2H
// results (no fabricated betting/ATS records; those aren't available from
// any live source this app has, so they're simply not shown).
// A team's finished-games list only depends on the team itself, not on
// which opponent is being compared against — cached separately so scanning
// several matchups involving the same team (or re-scanning the same
// matchup) doesn't re-fetch a full season schedule from ESPN each time.
const teamScheduleCache = {}; // `${league}:${abbr}` -> { finals, ts }
const TEAM_SCHEDULE_TTL = 30 * 60 * 1000; // 30 min

async function fetchTeamSeasonFinals(league, teamName) {
  const abbr = league === 'wnba' ? resolveWNBATeam(teamName) : resolveESPNTeam(teamName);
  if (!abbr) return { abbr: null, finals: [] };
  const cacheKey = `${league}:${abbr}`;
  const cached = teamScheduleCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < TEAM_SCHEDULE_TTL) return { abbr, finals: cached.finals };

  const base = league === 'wnba' ? ESPN_BASE_WNBA : ESPN_BASE;
  const fetchSchedule = async (season) => {
    try {
      const params = season ? { season } : {};
      const r = await axios.get(`${base}/teams/${abbr}/schedule`, { params, timeout: 8000 });
      return r.data?.events || [];
    } catch (_) { return []; }
  };

  let finals = (await fetchSchedule(null)).filter(e => e.competitions?.[0]?.status?.type?.name === 'STATUS_FINAL');
  // NBA offseason (no season param) returns only next season's preseason —
  // fall back to the just-completed season's real results.
  if (finals.length < 5) {
    const fallbackFinals = (await fetchSchedule(new Date().getFullYear()))
      .filter(e => e.competitions?.[0]?.status?.type?.name === 'STATUS_FINAL');
    if (fallbackFinals.length > finals.length) finals = fallbackFinals;
  }

  teamScheduleCache[cacheKey] = { finals, ts: Date.now() };
  return { abbr, finals };
}

async function fetchTeamRecentGames(league, teamName, oppName) {
  const { abbr, finals } = await fetchTeamSeasonFinals(league, teamName);
  if (!abbr) return { last5: [], h2h: [] };

  const mapGame = (e) => {
    const c = e.competitions[0];
    const home = c.competitors.find(x => x.homeAway === 'home');
    const away = c.competitors.find(x => x.homeAway === 'away');
    const isHome = (home.team.abbreviation || '').toLowerCase() === abbr;
    const own = isHome ? home : away;
    const opp = isHome ? away : home;
    const ownScore = Number(own.score?.value ?? own.score ?? 0);
    const oppScore = Number(opp.score?.value ?? opp.score ?? 0);
    // Real per-game points leader — already present on the schedule payload
    // for the team whose schedule this is (own), no extra API call needed.
    const ptsLeader = (own.leaders || []).find(l => l.name === 'points')?.leaders?.[0] || null;
    const highScorer = ptsLeader ? { name: ptsLeader.athlete?.displayName || null, pts: ptsLeader.displayValue || null } : null;
    return {
      date: e.date,
      opponent: opp.team.displayName,
      isHome, ownScore, oppScore,
      win: ownScore > oppScore,
      result: ownScore > oppScore ? 'W' : 'L',
      highScorer,
    };
  };

  const last5 = finals.slice(-5).map(mapGame);
  let h2h = [];
  if (oppName) {
    const oppAbbr = league === 'wnba' ? resolveWNBATeam(oppName) : resolveESPNTeam(oppName);
    h2h = finals.filter(e => e.competitions[0].competitors.some(x => (x.team.abbreviation || '').toLowerCase() === oppAbbr))
                .map(mapGame);
  }
  return { last5, h2h };
}

// Real "projected starters" — no official pregame lineup feed exists for
// either league (verified: ESPN's game summary only populates a starter
// flag once a game has actually started), so this is built from the best
// available real signal instead of guessed: the actual 5 starters from the
// team's most recently completed game (ESPN boxscore `starter: true`),
// then adjusted against the CURRENT live injury report — any of those 5
// who are now "Out" are dropped, gaps are filled by the next-highest-usage
// healthy player, and a clearly-higher-usage healthy player sitting outside
// the carried-over five (signal: a star who missed that last game to
// injury and has since returned) swaps in for the lowest-usage holdover.
async function getProjectedStarters(league, teamName) {
  const { finals } = await fetchTeamSeasonFinals(league, teamName);
  const abbr = league === 'wnba' ? resolveWNBATeam(teamName) : resolveESPNTeam(teamName);
  if (!finals.length || !abbr) return { starters: [], basedOn: 'no data available' };

  const lastGame = finals[finals.length - 1];
  const base = league === 'wnba' ? ESPN_BASE_WNBA : ESPN_BASE;
  let lastGameStarters = [];
  try {
    const res = await axios.get(`${base}/summary`, { params: { event: lastGame.id }, timeout: 8000 });
    const teamBox = (res.data?.boxscore?.players || []).find(p => (p.team?.abbreviation || '').toLowerCase() === abbr);
    const athletes = teamBox?.statistics?.[0]?.athletes || [];
    lastGameStarters = athletes.filter(a => a.starter).map(a => a.athlete?.displayName).filter(Boolean);
  } catch (_) { /* fall through with an empty carried-over lineup */ }

  const roster = league === 'wnba' ? await fetchWNBARoster(teamName) : await fetchESPNRoster(teamName);
  // Only "Out" excludes a carried-over starter — Day-To-Day/Questionable
  // players routinely still start, so they stay eligible.
  const outNames = new Set((roster?.injured || [])
    .filter(p => (p.status || '').toLowerCase() === 'out')
    .map(p => normalizePlayerName(p.name)));

  const usagePool = await getTopUsagePlayers(league, teamName, 15); // sorted by USG_PCT desc, live-roster-checked
  const usageByName = {};
  for (const p of usagePool) usageByName[normalizePlayerName(p.name)] = p;

  let lineup = lastGameStarters
    .filter(n => !outNames.has(normalizePlayerName(n)))
    .map(n => usageByName[normalizePlayerName(n)] || { name: n, usgPctNum: 0 });

  const inLineup = new Set(lineup.map(p => normalizePlayerName(p.name)));
  const healthyOutsiders = usagePool.filter(p => !inLineup.has(normalizePlayerName(p.name)) && !outNames.has(normalizePlayerName(p.name)));

  while (lineup.length < 5 && healthyOutsiders.length) {
    const next = healthyOutsiders.shift();
    lineup.push(next);
    inLineup.add(normalizePlayerName(next.name));
  }

  if (lineup.length === 5 && healthyOutsiders.length) {
    const bestOutsider = healthyOutsiders[0];
    lineup.sort((a, b) => (a.usgPctNum || 0) - (b.usgPctNum || 0));
    if ((bestOutsider.usgPctNum || 0) > (lineup[0].usgPctNum || 0) + 3) {
      lineup[0] = bestOutsider; // likely a star back from injury
    }
  }

  const posByName = {};
  for (const p of (roster?.players || [])) posByName[normalizePlayerName(p.name)] = p.position;

  return {
    starters: lineup.slice(0, 5).map(p => ({
      name: p.name,
      position: posByName[normalizePlayerName(p.name)] || '',
      headshot: p.headshot || headshotUrl(league, p.id),
    })),
    basedOn: lastGameStarters.length ? 'last game, adjusted for current injuries' : 'season usage (no recent boxscore found)',
  };
}

// Real spread/moneyline/total — sourced free from ESPN's public scoreboard
// (DraftKings-provided), not the-odds-api.com (whose quota is currently
// exhausted — see /api/team-picks). Searches a 14-day window since the
// matchup being viewed isn't always today's actual scheduled game. Returns
// an honest { available: false } when the two teams aren't scheduled to
// play each other in that window — never fabricated numbers.
async function fetchGameOdds(league, team1Name, team2Name) {
  const abbr1 = league === 'wnba' ? resolveWNBATeam(team1Name) : resolveESPNTeam(team1Name);
  const abbr2 = league === 'wnba' ? resolveWNBATeam(team2Name) : resolveESPNTeam(team2Name);
  if (!abbr1 || !abbr2) return { available: false };

  const base = league === 'wnba' ? ESPN_BASE_WNBA : ESPN_BASE;
  const start = getToday().replace(/-/g, '');
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 14);
  const end = toLocalDateStr(endDate).replace(/-/g, '');

  try {
    const res = await axios.get(`${base}/scoreboard`, { params: { dates: `${start}-${end}` }, timeout: 8000 });
    const events = res.data?.events || [];
    const match = events.find(e => {
      const abbrs = (e.competitions?.[0]?.competitors || []).map(c => (c.team?.abbreviation || '').toLowerCase());
      return abbrs.includes(abbr1) && abbrs.includes(abbr2);
    });
    if (!match) return { available: false };

    const comp = match.competitions[0];
    const odds = comp.odds?.[0];
    if (!odds) return { available: false, gameDate: match.date };

    const home = comp.competitors.find(c => c.homeAway === 'home');
    const away = comp.competitors.find(c => c.homeAway === 'away');
    return {
      available: true,
      gameDate: match.date,
      provider: odds.provider?.displayName || null,
      home: { name: home?.team?.displayName, abbr: home?.team?.abbreviation },
      away: { name: away?.team?.displayName, abbr: away?.team?.abbreviation },
      spread: {
        home: odds.pointSpread?.home?.close?.line ?? null,
        away: odds.pointSpread?.away?.close?.line ?? null,
        homeOdds: odds.pointSpread?.home?.close?.odds ?? null,
        awayOdds: odds.pointSpread?.away?.close?.odds ?? null,
      },
      moneyline: {
        home: odds.moneyline?.home?.close?.odds ?? null,
        away: odds.moneyline?.away?.close?.odds ?? null,
      },
      total: odds.overUnder ?? null,
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
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
  if (playerStatsCache[playerName] && (Date.now() - (lastPlayerStatsFetch[playerName] || 0)) < PLAYER_STATS_TTL) {
    return playerStatsCache[playerName];
  }

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
        // bridgeData.l10 (predict_tonight.py's pre-computed summary) doesn't
        // include shooting %, but the raw per-game array (last10, below)
        // does — compute it directly instead of hardcoding 0.
        fg_pct:   calcAvg(last10, 'fg_pct'),
        fg3_pct:  calcAvg(last10, 'fg3_pct'),
        stl:      String(bridgeData.l10.stl  || 0),
        blk:      String(bridgeData.l10.blk  || 0),
        turnover: String(0),
      },
      // Full-season averages come nearly free — nba_api's gamelog call already
      // fetches every game this season, predict_tonight.py just used to throw
      // the rest away after slicing L10. Used as a shrinkage baseline so a hot
      // or cold 5-10 game stretch doesn't get treated as the new normal.
      seasonAvg:   bridgeData.season_avg || null,
      seasonGames: bridgeData.gamesFound || 0,
      last5Games: last5.map(g => ({
        date:     g.date || 'N/A',
        opponent: g.matchup || 'N/A',
        pts: g.pts, reb: g.reb, ast: g.ast, stl: g.stl, blk: g.blk, tov: g.tov,
        fg3m: g.fg3m, min: g.min, home: g.home,
        fga: g.fga, fgm: g.fgm, fg3a: g.fg3a, fta: g.fta, ftm: g.ftm,
        fg_pct: g.fg_pct ? g.fg_pct + '%' : 'N/A',
      })),
      last10Games: last10.map(g => ({
        date:     g.date || 'N/A',
        opponent: g.matchup || 'N/A',
        oppTeamId: null,
        pts: g.pts, reb: g.reb, ast: g.ast, stl: g.stl, blk: g.blk, tov: g.tov,
        fg3m: g.fg3m, min: g.min, home: g.home,
        fga: g.fga, fgm: g.fgm, fg3a: g.fg3a, fta: g.fta, ftm: g.ftm,
        fg_pct: g.fg_pct ? g.fg_pct + '%' : 'N/A',
        plus_minus: g.plus_minus,
      })),
      gameLog20: bridgeData.games.slice(0, 20).map(g => ({
        date: g.date || 'N/A', opponent: g.matchup || 'N/A',
        pts: g.pts, reb: g.reb, ast: g.ast, stl: g.stl, blk: g.blk, tov: g.tov,
        fg3m: g.fg3m, min: g.min, home: g.home,
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
      let bdlPlayers = searchRes.data.data || [];
      // Real bug found live: BDL's search endpoint doesn't match a combined
      // "First Last" query at all (confirmed directly — "LeBron James"
      // returns zero results, but "LeBron" alone finds him) — this was
      // silently leaving team/position/height as "Unknown"/"?" for
      // essentially every player on this path. The BDL-fallback path
      // elsewhere already has this same last-name-only fallback; this path
      // was missing it.
      if (!bdlPlayers.length) {
        const lastName = corrected.split(' ').pop().replace(/[^a-zA-Z]/g, '');
        if (lastName.length >= 3) {
          try {
            const res2 = await axios.get(`${BALLDONTLIE}/players`, {
              params: { search: lastName, per_page: 15 },
              headers: { Authorization: process.env.BALLDONTLIE_KEY },
              timeout: 8000
            });
            bdlPlayers = res2.data.data || [];
          } catch (_) {}
        }
      }
      if (bdlPlayers.length) {
        const p = fuzzyMatchPlayer(bdlPlayers.map(p => ({
          ...p, name: `${p.first_name} ${p.last_name}`
        })), corrected) || bdlPlayers[0];
        result.player.id       = p.id;
        result.player.name     = `${p.first_name} ${p.last_name}`;
        result.player.team     = p.team?.full_name || 'Unknown';
        result.player.position = p.position || 'Unknown';
        // BDL's current API returns a single combined "height" string
        // (e.g. "6-9"), not separate height_feet/height_inches fields —
        // the old code was written against a schema BDL no longer uses.
        result.player.height   = p.height ? p.height.replace('-', "' ") + '"' : '?';
      }
    } catch (_) { /* BDL team lookup optional */ }

    playerStatsCache[playerName] = result;
    lastPlayerStatsFetch[playerName] = Date.now();
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
        height:   player.height ? player.height.replace('-', "' ") + '"' : '?',
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
        // Real scale bug found here: BDL returns fg_pct/fg3_pct as decimals
        // (0.563), not percentages — this was displaying "0.6" instead of
        // "56.3" for anyone who ever hit this fallback path. The per-game
        // mapping below already knew to ×100; this top-level average didn't.
        fg_pct:   (parseFloat(calcAvg(last10, 'fg_pct')) * 100).toFixed(1),
        fg3_pct:  (parseFloat(calcAvg(last10, 'fg3_pct')) * 100).toFixed(1),
        stl:      calcAvg(last10, 'stl'),
        blk:      calcAvg(last10, 'blk'),
        turnover: calcAvg(last10, 'turnover')
      },
      // BDL fallback only pulls up to ~20 games (not a full season like the
      // nba_api bridge), but it's still a larger, more stable sample than L10
      // — worth using as a shrinkage baseline rather than discarding it.
      seasonAvg: {
        pts: parseFloat(calcAvg(games,'pts')), reb: parseFloat(calcAvg(games,'reb')), ast: parseFloat(calcAvg(games,'ast')),
        fga: parseFloat(calcAvg(games,'fga')), fgm: parseFloat(calcAvg(games,'fgm')),
        fg3a: parseFloat(calcAvg(games,'fg3a')), fg3m: parseFloat(calcAvg(games,'fg3m')),
        fta: parseFloat(calcAvg(games,'fta')), ftm: parseFloat(calcAvg(games,'ftm')),
        min: parseFloat(calcAvg(games,'min')),
      },
      seasonGames: games.length,
      last5Games: last5.map(g => ({
        date:     g.game?.date?.split('T')[0] || 'N/A',
        opponent: g.game?.home_team_id === player.team_id
          ? g.game?.visitor_team?.full_name
          : g.game?.home_team?.full_name,
        home: g.game?.home_team_id === player.team_id,
        pts: g.pts, reb: g.reb, ast: g.ast, stl: g.stl, blk: g.blk, tov: g.turnover,
        fg3m: g.fg3m, min: g.min,
        fga: g.fga, fgm: g.fgm, fg3a: g.fg3a, fta: g.fta, ftm: g.ftm,
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
        home: g.game?.home_team_id === player.team_id,
        pts: g.pts, reb: g.reb, ast: g.ast, stl: g.stl, blk: g.blk, tov: g.turnover,
        fg3m: g.fg3m, min: g.min,
        fga: g.fga, fgm: g.fgm, fg3a: g.fg3a, fta: g.fta, ftm: g.ftm,
        fg_pct: g.fg_pct ? (g.fg_pct * 100).toFixed(0) + '%' : 'N/A',
        plus_minus: g.plus_minus
      })),
      gameLog20: games.slice(0, 20).map(g => ({
        date: g.game?.date?.split('T')[0] || 'N/A',
        opponent: g.game?.home_team_id === player.team_id ? g.game?.visitor_team?.full_name : g.game?.home_team?.full_name,
        home: g.game?.home_team_id === player.team_id,
        pts: g.pts, reb: g.reb, ast: g.ast, stl: g.stl, blk: g.blk, tov: g.turnover, fg3m: g.fg3m, min: g.min,
      })),
      gamesAnalyzed: games.length
    };

    playerStatsCache[playerName] = result;
    lastPlayerStatsFetch[playerName] = Date.now();
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

  return enqueueBridge(() => new Promise((resolve) => {
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
  }));
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
// Short cache on prop-line lookups — lines don't meaningfully move minute
// to minute, but every analysis (plus every Top-3/Today-page scan) was
// hitting the paid Odds API fresh every time. This is what actually burned
// through a month's free-tier quota in a single afternoon of testing.
const propLinesCache = {};
const PROP_LINES_TTL = 3 * 60 * 1000;

async function fetchPropLines(playerName, propType) {
  const cacheKey = `nba:${playerName}:${propType}`;
  const cached = propLinesCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < PROP_LINES_TTL) return cached.data;

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
    const result = { lines, softestLine, softestBook, market };
    propLinesCache[cacheKey] = { data: result, ts: Date.now() };
    return result;
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
// These used to be hardcoded snapshots that never changed — every opponent
// adjustment (shooting efficiency, FT rate, rebounding, assists, pace,
// DvP) compares a team's real, freshly-refreshed stat against this "league
// average," so a frozen constant silently drifts out of sync with the
// season even though the underlying team files get refreshed daily (see
// the fetch_stats.py/fetch_wnba_stats.py cron jobs). Now computed live from
// those same cached files each call; only fall back to a fixed snapshot if
// the files genuinely aren't available yet (e.g. first boot before the
// cron has ever run).
const LEAGUE_AVG_PACE_FALLBACK = 99.5;
const LEAGUE_BASELINES_FALLBACK = {
  nba:  { pace: 99.5, defRating: 113.0 },
  wnba: { pace: 94.8, defRating: 103.1 },
};
const LEAGUE_FOUR_FACTORS_FALLBACK = {
  nba:  { oppEfgPct: 0.5456, oppFtaRate: 0.2637, oppOrebPct: 0.3053, oppTovPct: 0.144, rebPct: 0.5 },
  wnba: { oppEfgPct: 0.5,    oppFtaRate: 0.2709, oppOrebPct: 0.2999, oppTovPct: 0.1761, rebPct: 0.5 },
};

function avgField(arr, field) {
  const vals = (arr || []).map(r => parseFloat(r[field])).filter(v => isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function getLeagueBaselines(league) {
  const stats = league === 'wnba' ? loadWNBAStats() : loadNBAStats();
  const fallback = LEAGUE_BASELINES_FALLBACK[league] || LEAGUE_BASELINES_FALLBACK.nba;
  return {
    pace:      avgField(stats?.teamAdvanced, 'PACE') ?? fallback.pace,
    defRating: avgField(stats?.teamAdvanced, 'DEF_RATING') ?? fallback.defRating,
  };
}

function getLeagueFourFactors(league) {
  const stats = league === 'wnba' ? loadWNBAStats() : loadNBAStats();
  const fallback = LEAGUE_FOUR_FACTORS_FALLBACK[league] || LEAGUE_FOUR_FACTORS_FALLBACK.nba;
  return {
    oppEfgPct:  avgField(stats?.teamFourFactors, 'OPP_EFG_PCT')  ?? fallback.oppEfgPct,
    oppFtaRate: avgField(stats?.teamFourFactors, 'OPP_FTA_RATE') ?? fallback.oppFtaRate,
    oppOrebPct: avgField(stats?.teamFourFactors, 'OPP_OREB_PCT') ?? fallback.oppOrebPct,
    oppTovPct:  avgField(stats?.teamFourFactors, 'OPP_TOV_PCT')  ?? fallback.oppTovPct,
    rebPct: 0.5,
  };
}

// Empirical-Bayes-style shrinkage: pulls a small/noisy recent sample toward a
// larger, more stable baseline. weight → 1 (trust the recent value) as the
// recent sample size n grows past k; weight → 0 (trust the baseline) for
// small n. Falls back to the recent value untouched if no baseline exists —
// graceful degradation rather than pretending a season baseline exists.
function shrink(recentValue, baselineValue, n, k = 8) {
  if (recentValue == null) return baselineValue;
  if (baselineValue == null || !isFinite(baselineValue)) return recentValue;
  const sampleN = Math.max(0, n || 0);
  const weight = sampleN / (sampleN + k);
  return recentValue * weight + baselineValue * (1 - weight);
}

function calcPaceAdj(proj, oppPace, playerTeamPace, propType, league = 'nba') {
  if (!proj) return proj;
  // Props where pace has minimal effect — skip adjustment
  const PACE_NEUTRAL = ['3pm', 'steals', 'blocks'];
  if (PACE_NEUTRAL.includes(propType)) return proj;

  const leagueAvgPace = getLeagueBaselines(league).pace;
  // Use blended pace (avg of both teams) vs league average
  const opp = parseFloat(oppPace) || leagueAvgPace;
  const own = parseFloat(playerTeamPace) || leagueAvgPace;
  const blended = (opp + own) / 2;

  // Linear multiplier capped at ±8% — more accurate than sqrt dampening
  const raw = (blended - leagueAvgPace) / leagueAvgPace;
  const multiplier = 1 + Math.max(-0.08, Math.min(0.08, raw));
  return proj * multiplier;
}

function calcDvPCoeff(oppDefRating, playerPosition, playerPlaytypes, oppDefPlaytypes, propType, league = 'nba') {
  // Base: team-level defensive rating (always available)
  let base = 1.0;
  if (oppDefRating) {
    const leagueAvg = getLeagueBaselines(league).defRating;
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
      // Token match (every query word must appear as a whole word in the
      // candidate's name) — a bare last-name substring previously matched
      // an unrelated player sharing a surname (the same bug class fixed in
      // resolveWNBAPlayer earlier — a query for a player missing from this
      // file silently returned a different real player's stats).
      const findPlayerRow = (name) => {
        const nameTokens = new Set(name.toLowerCase().trim().split(' ').filter(Boolean));
        return nbaPlayerStats.find(p => {
          const pTokens = new Set((p.PLAYER_NAME || '').toLowerCase().split(' '));
          return nameTokens.size && [...nameTokens].every(t => pTokens.has(t));
        }) || null;
      };

      // How much should we trust that this player is a real rotation piece
      // whose absence actually frees up meaningful production? A bench/
      // fringe player and a starter shouldn't get the same flat boost just
      // because they share a position — this scales the fallback boost by
      // real recent minutes when we have them, and treats a genuinely
      // unknown player (not in this dataset at all, or too few games to
      // trust) as uncertain rather than assuming they're a rotation regular.
      const getRotationConfidence = (name) => {
        const row = findPlayerRow(name);
        if (!row) return 0.5; // not in the dataset — could be a real rotation player nba.com hasn't added yet, could be deep bench; split the difference
        const gp = parseFloat(row.GP) || 0;
        const min = parseFloat(row.MIN) || 0;
        if (gp < 3) return 0.5; // too few games to trust either way
        if (min >= 20) return 1.0;
        if (min >= 10) return 0.7;
        return 0.35; // real data, but clearly a low-minutes bench piece
      };

      // Look up USG_PCT for every player on the roster from nba.com data
      const getUSG = (name) => {
        const match = findPlayerRow(name);
        if (!match) return null;
        // A raw USG_PCT off a tiny sample (a couple of games, garbage-time
        // minutes) is noise, not signal — real case hit: a bench player
        // with 2 games / 7 total minutes showed a fabricated 35% usage
        // rate, higher than the team's actual star, which blew up the
        // teammate-out redistribution. Below a real sample, don't trust
        // it — fall back to the position-based default a few lines down.
        const gp = parseFloat(match.GP) || 0;
        if (gp < 5) return null;
        return parseFloat(match.USG_PCT || 0);
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
          // Real fix: this position-only estimate used to give a deep bench
          // player the exact same boost as a starter at the same position —
          // scale it by actual recent minutes so a fringe rotation piece
          // being "out" doesn't move the projection like a real starter would.
          const rotationConf = getRotationConfidence(p.name);

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
          boost *= rotationConf;
          mult += boost;
          details.push({ method: 'position-fallback', name: p.name, boost: parseFloat((boost*100).toFixed(1))+'%', rotationConfidence: rotationConf });
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
// MINUTES PROJECTION — modeled separately, BEFORE any per-stat rate.
// Projecting points/rebounds/assists directly off game averages bakes in
// whatever minutes happened to occur recently; this projects playing time
// first (season baseline shrunk with recent trend + role/injury context),
// then everything downstream is minutes × per-minute rate.
// ════════════════════════════════════════════════════════════════
function projectMinutes(playerStats, ctx) {
  const details = [];
  const last10 = playerStats.last10Games || [];
  const last3  = last10.slice(0, 3);
  const recentMin = last10.length
    ? last10.reduce((s, g) => s + (parseFloat(g.min) || 0), 0) / last10.length
    : parseFloat(playerStats.averages?.min) || 0;
  const seasonMin = playerStats.seasonAvg?.min ?? null;
  const seasonGames = playerStats.seasonGames || 0;

  // Shrink recent minutes toward the season baseline — a 3-5 game sample of
  // minutes is noisy (foul trouble, blowouts, a single tweaked role game).
  const K_MIN = 6;
  let projMin = shrink(recentMin, seasonMin, last10.length || seasonGames, K_MIN);
  const baselineMin = projMin;
  if (seasonMin != null) {
    details.push({ label: 'season-shrunk baseline', minutes: parseFloat(projMin.toFixed(1)) });
  }

  // Short-term trend (L3 vs the shrunk baseline) — dampened, minutes trends
  // are real (rotation changes) but shouldn't swing on 1-2 unusual games.
  if (last3.length >= 2 && projMin > 0) {
    const l3Min = last3.reduce((s, g) => s + (parseFloat(g.min) || 0), 0) / last3.length;
    const trendPct = Math.max(-0.12, Math.min(0.12, (l3Min - projMin) / projMin * 0.5));
    const before = projMin;
    projMin *= (1 + trendPct);
    if (Math.abs(projMin - before) > 0.05) details.push({ label: 'recent rotation trend', minutes: parseFloat((projMin - before).toFixed(1)) });
  }

  // Teammate-out role bump — reuses the same USG_PCT-based redistribution
  // signal as usage inflation (a teammate out means more usage AND more
  // time on court), but scaled down: minutes respond less elastically than
  // usage rate to an absence (a bench player's minutes cap still exists).
  const usageMult = calcUsageInflation(ctx.playerRoster, playerStats, 'points', ctx.nbaPlayerStats || []);
  if (usageMult > 1.0 && projMin > 0) {
    const minutesBump = Math.min(0.15, (usageMult - 1.0) * 0.35);
    const before = projMin;
    projMin *= (1 + minutesBump);
    details.push({ label: 'teammate-out role bump', minutes: parseFloat((projMin - before).toFixed(1)) });
  }
  // NOTE on scale: this bump uses 0.35× the usage signal, and buildProjection
  // applies the REMAINING 0.65× to the per-minute rate side. Split this way,
  // minutesMult × rateMult ≈ the original single usageMult — two channels
  // (plays more + produces more per minute) instead of the old one flat
  // multiplier, without double-counting the same signal in both.

  // Back-to-back — half the effect lands on minutes (rest management),
  // the other half on the efficiency/form side in buildProjection.
  if (ctx.gameContext?.isBackToBack && projMin > 0) {
    const before = projMin;
    projMin *= 0.96;
    details.push({ label: 'back-to-back rest management', minutes: parseFloat((projMin - before).toFixed(1)) });
  }

  return {
    projectedMinutes: parseFloat(projMin.toFixed(1)),
    baselineMinutes:  parseFloat(baselineMin.toFixed(1)),
    recentMinutes:    parseFloat(recentMin.toFixed(1)),
    seasonMinutes:    seasonMin != null ? parseFloat(seasonMin.toFixed(1)) : null,
    details,
  };
}

// ════════════════════════════════════════════════════════════════
// STAT-SPECIFIC OPPONENT ADJUSTMENTS — replaces one blanket DEF_RATING
// multiplier applied to every prop type with adjustments keyed to the
// actual stat: shooting efficiency + FT rate allowed for points, offensive
// rebounds allowed for rebounds, pace + forced turnovers for assists.
// Falls back to a neutral 1.0 (not an invented adjustment) when the
// specific four-factors data isn't available.
// ════════════════════════════════════════════════════════════════
function calcOpponentAdjustment(propType, oppFourFact, league = 'nba') {
  const lff = getLeagueFourFactors(league);
  const out = { efficiencyFactor: 1.0, ftaFactor: 1.0, reboundFactor: 1.0, assistFactor: 1.0, details: [] };
  if (!oppFourFact) return out;

  const scaled = (oppVal, leagueAvg, scale, cap) => {
    if (oppVal == null || !leagueAvg) return 1.0;
    const raw = oppVal / leagueAvg;
    return Math.max(1 - cap, Math.min(1 + cap, 1 + (raw - 1) * scale));
  };

  // Points/scoring: how efficiently opponents shoot against this defense,
  // and how often this defense puts opponents on the line — both directly
  // measured (not inferred from a generic rating).
  out.efficiencyFactor = scaled(oppFourFact.OPP_EFG_PCT, lff.oppEfgPct, 0.7, 0.10);
  out.ftaFactor         = scaled(oppFourFact.OPP_FTA_RATE, lff.oppFtaRate, 0.6, 0.10);
  if (['points','pra','pr','pa','3pm'].includes(propType)) {
    out.details.push({ label: 'opp shooting efficiency allowed', factor: out.efficiencyFactor });
    out.details.push({ label: 'opp free-throw rate allowed', factor: out.ftaFactor });
  }

  // Rebounds: opponent's overall team rebound rate (REB_PCT, league-average
  // is definitionally 0.5) — a weak-rebounding opponent leaves more boards
  // on the table regardless of which side of the ball our player is on.
  if (oppFourFact.OPP_OREB_PCT != null) {
    // OPP_OREB_PCT = offensive rebounds this defense ALLOWS — higher means
    // more second-chance opportunity in the game overall.
    out.reboundFactor = scaled(oppFourFact.OPP_OREB_PCT, lff.oppOrebPct, 0.6, 0.10);
    if (['rebounds','pr','ra'].includes(propType)) {
      out.details.push({ label: 'opp offensive rebounds allowed', factor: out.reboundFactor });
    }
  }

  // Assists: possessions that end in a forced turnover never become an
  // assist — a defense with a high forced-TOV rate suppresses assists more
  // than its scoring defense alone would suggest.
  if (oppFourFact.OPP_TOV_PCT != null) {
    const raw = oppFourFact.OPP_TOV_PCT / lff.oppTovPct;
    // Higher forced-TOV% → FEWER clean possessions → suppress, not boost.
    out.assistFactor = Math.max(0.90, Math.min(1.10, 1 - (raw - 1) * 0.5));
    if (['assists','pa','ra'].includes(propType)) {
      out.details.push({ label: 'opp forced-turnover rate', factor: out.assistFactor });
    }
  }

  return out;
}

// ════════════════════════════════════════════════════════════════
// OVER/UNDER PROBABILITY — a real probability from the model's estimated
// distribution, kept separate from calcEdgeScore (raw unit distance) and
// separate from the confidence/reliability score. Uses a normal
// approximation, which is a reasonable fit for a counting stat averaged
// over a full game; not claimed to be exact for very low-count stats.
// ════════════════════════════════════════════════════════════════
function normalCdf(z) {
  // Abramowitz & Stegun approximation — good to ~1e-7, plenty for this use.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}
function calcOverUnderProbability(projection, stdDev, postedLine) {
  if (!projection || !stdDev || stdDev <= 0 || !postedLine) return null;
  const z = (parseFloat(postedLine) - projection) / stdDev;
  const under = normalCdf(z);
  const over  = 1 - under;
  return { overProbability: parseFloat(over.toFixed(3)), underProbability: parseFloat(under.toFixed(3)) };
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
    const yd = toLocalDateStr(yesterday);
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

// ════════════════════════════════════════════════════════════════
// WNBA DATA LAYER — all live, no scraping/paid keys required
// Roster + injuries:  ESPN site API (same shape as NBA roster fetch)
// Player stats/H2H:   ESPN gamelog API (real per-game box scores —
//                      doubles as the H2H source since it already
//                      includes each game's opponent)
// Schedule:           ESPN scoreboard API
// Prop lines/odds:    The Odds API, sport key basketball_wnba
// NOTE: there is no public source for Synergy playtypes / tracking /
// hustle data for the WNBA, so buildProjection() is reused as-is —
// passing null/empty for those NBA-only fields already makes every
// advanced-adjustment step a neutral no-op (verified in calcPaceAdj/
// calcDvPCoeff), which is exactly the honest degraded-confidence
// behavior described to the user rather than something faked here.
// ════════════════════════════════════════════════════════════════
const ESPN_BASE_WNBA         = 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba';
const ESPN_GAMELOG_BASE_WNBA = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes';

const WNBA_TEAM_MAP = {
  'atlanta dream':'atl','dream':'atl','atl':'atl',
  'chicago sky':'chi','sky':'chi','chi':'chi',
  'connecticut sun':'con','sun':'con','con':'con','conn':'con',
  'dallas wings':'dal','wings':'dal','dal':'dal',
  'golden state valkyries':'gs','valkyries':'gs','gs':'gs',
  'indiana fever':'ind','fever':'ind','ind':'ind',
  'las vegas aces':'lv','aces':'lv','lv':'lv','las vegas':'lv',
  'los angeles sparks':'la','sparks':'la','la':'la','los angeles':'la',
  'minnesota lynx':'min','lynx':'min','min':'min',
  'new york liberty':'ny','liberty':'ny','ny':'ny','new york':'ny',
  'phoenix mercury':'phx','mercury':'phx','phx':'phx','phoenix':'phx',
  'portland fire':'por','fire':'por','por':'por','portland':'por',
  'seattle storm':'sea','storm':'sea','sea':'sea','seattle':'sea',
  'toronto tempo':'tor','tempo':'tor','tor':'tor','toronto':'tor',
  'washington mystics':'wsh','mystics':'wsh','wsh':'wsh','washington':'wsh',
};
function resolveWNBATeam(teamName) {
  return WNBA_TEAM_MAP[(teamName || '').toLowerCase().trim()] || null;
}
const WNBA_ABBR_TO_NAME = {
  atl:'Atlanta Dream', chi:'Chicago Sky', con:'Connecticut Sun', dal:'Dallas Wings',
  gs:'Golden State Valkyries', ind:'Indiana Fever', lv:'Las Vegas Aces', la:'Los Angeles Sparks',
  min:'Minnesota Lynx', ny:'New York Liberty', phx:'Phoenix Mercury', por:'Portland Fire',
  sea:'Seattle Storm', tor:'Toronto Tempo', wsh:'Washington Mystics',
};

// ── ROSTER (mirrors fetchESPNRoster) ──────────────────────────────
let wnbaRosterCache     = {};
let lastWnbaRosterFetch = {};

async function fetchWNBARoster(teamName) {
  const abbr = resolveWNBATeam(teamName);
  if (!abbr) return { error: `Unknown WNBA team: ${teamName}`, players: [] };

  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  if (wnbaRosterCache[abbr] && (now - (lastWnbaRosterFetch[abbr] || 0)) < TWO_HOURS) {
    return wnbaRosterCache[abbr];
  }

  try {
    const res = await axios.get(`${ESPN_BASE_WNBA}/teams/${abbr}/roster`, { timeout: 8000 });
    const raw = res.data?.athletes || [];
    const isGrouped = raw.length > 0 && Array.isArray(raw[0]?.items);
    const playerList = isGrouped ? raw.flatMap(g => g.items || []) : raw.filter(p => p.fullName);

    const players = playerList.map(p => ({
      id:         p.id,
      name:       p.fullName || p.displayName || 'Unknown',
      position:   p.position?.abbreviation || p.position?.name || 'N/A',
      jersey:     p.jersey || p.displayNumber || '?',
      height:     p.displayHeight || 'N/A',
      weight:     p.displayWeight || 'N/A',
      status:     p.injuries?.[0]?.status || p.status?.type?.name || 'Active',
      injuryNote: p.injuries?.[0]?.longComment || p.injuries?.[0]?.shortComment || null,
    })).filter(p => p.name !== 'Unknown');

    const result = {
      team: teamName, abbr,
      fetchedAt:   new Date().toISOString(),
      source:      'ESPN WNBA (live)',
      playerCount: players.length,
      players,
      starters: players.filter(p => ['PG','SG','SF','PF','C','G','F'].includes(p.position)).slice(0, 8),
      injured:  players.filter(p => p.status !== 'Active'),
    };
    wnbaRosterCache[abbr]     = result;
    lastWnbaRosterFetch[abbr] = now;
    console.log(`[ESPN-W] Roster fetched: ${teamName} (${players.length} players)`);
    return result;
  } catch (err) {
    console.error(`[ESPN-W] Roster fetch failed for ${teamName}:`, err.message);
    return { error: err.message, team: teamName, players: [] };
  }
}

// ── PLAYER INDEX — name → {id, teamAbbr} built from all 15 rosters ─
let wnbaPlayerIndex     = {};
let lastWnbaIndexBuild  = 0;
const WNBA_INDEX_TTL    = 3 * 60 * 60 * 1000; // 3h

async function buildWNBAPlayerIndex() {
  const now = Date.now();
  if (Object.keys(wnbaPlayerIndex).length && (now - lastWnbaIndexBuild) < WNBA_INDEX_TTL) {
    return wnbaPlayerIndex;
  }
  const abbrs = [...new Set(Object.values(WNBA_TEAM_MAP))];
  const index = {};
  for (const abbr of abbrs) {
    try {
      const res = await axios.get(`${ESPN_BASE_WNBA}/teams/${abbr}/roster`, { timeout: 8000 });
      const raw = res.data?.athletes || [];
      const isGrouped = raw.length > 0 && Array.isArray(raw[0]?.items);
      const playerList = isGrouped ? raw.flatMap(g => g.items || []) : raw.filter(p => p.fullName);
      for (const p of playerList) {
        if (!p.fullName || !p.id) continue;
        index[p.fullName.toLowerCase()] = {
          id: p.id, name: p.fullName, teamAbbr: abbr,
          position: p.position?.abbreviation || 'N/A',
        };
      }
    } catch (_) { /* skip this team, index still usable with the rest */ }
  }
  if (Object.keys(index).length) {
    wnbaPlayerIndex    = index;
    lastWnbaIndexBuild = now;
    console.log(`[ESPN-W] Player index built: ${Object.keys(index).length} players across ${abbrs.length} teams`);
  }
  return wnbaPlayerIndex;
}

async function resolveWNBAPlayer(playerName) {
  await buildWNBAPlayerIndex();
  const lower = playerName.toLowerCase().trim();
  if (wnbaPlayerIndex[lower]) return wnbaPlayerIndex[lower];
  // Fallback requires every query token to appear as a whole token in the
  // candidate's name — not a bare substring, which could match an
  // unrelated player sharing a name fragment (e.g. "taylor" matching both
  // "Camryn Taylor" and "Taylor Thierry") instead of an honest "not found".
  const queryTokens = new Set(lower.split(' ').filter(Boolean));
  const match = Object.values(wnbaPlayerIndex).find(p => {
    const nameTokens = new Set(p.name.toLowerCase().split(' '));
    return [...queryTokens].every(t => nameTokens.has(t));
  });
  return match || null;
}

// ── GAME LOG (real per-game box scores, doubles as H2H source) ────
const WNBA_GAMELOG_LABELS = ['MIN','PTS','REB','AST','STL','BLK','TO','FG','FG%','3PT','3P%','FT','FT%','PF'];
function parseMadeAttempt(s) {
  const parts = String(s || '').split('-');
  return { made: parseInt(parts[0]) || 0, att: parseInt(parts[1]) || 0 };
}

async function fetchWNBAGameLogRaw(playerId, season) {
  const params = season ? { season } : {};
  const res = await axios.get(`${ESPN_GAMELOG_BASE_WNBA}/${playerId}/gamelog`, { params, timeout: 10000 });
  return res.data;
}

// Flattens ESPN's {seasonTypes:[{categories:[{events:[...]}]}], events:{id:meta}}
// shape into a flat, newest-first array of game objects. Regular-season only.
function flattenWNBAGamelog(raw) {
  if (!raw?.seasonTypes?.length) return [];
  const meta = raw.events || {};
  const games = [];
  for (const st of raw.seasonTypes) {
    if (!/regular season/i.test(st.displayName || '')) continue; // skip preseason
    for (const cat of (st.categories || [])) {
      for (const ev of (cat.events || [])) {
        const m = meta[ev.eventId];
        if (!m) continue;
        const oppAbbrRaw = (m.opponent?.abbreviation || '').toLowerCase();
        if (!WNBA_ABBR_TO_NAME[oppAbbrRaw]) continue; // skip All-Star/exhibition games (e.g. "TEAM COOP")
        const stats = ev.stats || [];
        const get = (label) => stats[WNBA_GAMELOG_LABELS.indexOf(label)];
        const fg  = parseMadeAttempt(get('FG'));
        const fg3 = parseMadeAttempt(get('3PT'));
        const ft  = parseMadeAttempt(get('FT'));
        games.push({
          date:       m.gameDate ? m.gameDate.split('T')[0] : '',
          opponent:   m.opponent?.displayName || '',
          oppAbbr:    (m.opponent?.abbreviation || '').toLowerCase(),
          home: (m.atVs || 'vs') !== '@',
          min:  parseFloat(get('MIN')) || 0,
          pts:  parseFloat(get('PTS')) || 0,
          reb:  parseFloat(get('REB')) || 0,
          ast:  parseFloat(get('AST')) || 0,
          stl:  parseFloat(get('STL')) || 0,
          blk:  parseFloat(get('BLK')) || 0,
          tov:  parseFloat(get('TO'))  || 0,
          fgm: fg.made, fga: fg.att, fg3m: fg3.made, fg3a: fg3.att, ftm: ft.made, fta: ft.att,
          fg_pct:  fg.att  ? parseFloat((fg.made/fg.att*100).toFixed(1))   : 0,
          fg3_pct: fg3.att ? parseFloat((fg3.made/fg3.att*100).toFixed(1)) : 0,
        });
      }
    }
  }
  return games; // ESPN already returns newest-first within/across categories
}

function calcWNBAAvg(games, key) {
  if (!games.length) return '0.0';
  return (games.reduce((s, g) => s + (parseFloat(g[key]) || 0), 0) / games.length).toFixed(1);
}
function calcWNBAStdDev(games, key) {
  if (!games.length) return '0.0';
  const avg = games.reduce((s, g) => s + (parseFloat(g[key]) || 0), 0) / games.length;
  return Math.sqrt(games.reduce((s, g) => s + Math.pow((parseFloat(g[key]) || 0) - avg, 2), 0) / games.length).toFixed(1);
}

const wnbaGamelogCache = {}; // playerId → { games, ts }
const WNBA_GAMELOG_TTL = 30 * 60 * 1000;

// Fetches current season + prior season(s) as needed and caches the merged log.
// Each game is tagged with its season year so callers building a "this
// season" baseline (vs. the deeper multi-season pool used for H2H) can tell
// them apart — without this tag a season average would silently blend in
// prior-season games whenever the current season needed backfilling.
async function getWNBAPlayerGameLog(playerId) {
  const cached = wnbaGamelogCache[playerId];
  if (cached && (Date.now() - cached.ts) < WNBA_GAMELOG_TTL) return cached.games;

  const currentYear = new Date().getFullYear();
  let games = flattenWNBAGamelog(await fetchWNBAGameLogRaw(playerId)).map(g => ({ ...g, season: currentYear }));
  // Fall back / supplement with prior seasons if the current one is thin
  // (early season) or we need more games for a reliable H2H sample.
  for (const yr of [currentYear - 1, currentYear - 2]) {
    if (games.length >= 15) break;
    try {
      const prior = flattenWNBAGamelog(await fetchWNBAGameLogRaw(playerId, yr)).map(g => ({ ...g, season: yr }));
      games = games.concat(prior);
    } catch (_) { /* that season just isn't available, keep what we have */ }
  }
  wnbaGamelogCache[playerId] = { games, ts: Date.now() };
  return games;
}

async function fetchWNBAPlayerStats(playerName) {
  const player = await resolveWNBAPlayer(playerName);
  if (!player) return { error: `Player "${playerName}" not found on any WNBA roster.` };

  const games = await getWNBAPlayerGameLog(player.id);
  if (!games.length) return { error: `No game log found for ${player.name}` };

  const last5  = games.slice(0, 5);
  const last10 = games.slice(0, 10);
  const pts5   = parseFloat(calcWNBAAvg(last5, 'pts'));
  const pts10  = parseFloat(calcWNBAAvg(last10, 'pts'));
  const hotCold = pts5 > pts10 + 3 ? 'HOT' : pts5 < pts10 - 3 ? 'COLD' : 'NEUTRAL';

  // Current-season-only games for a stable shrinkage baseline — getWNBAPlayerGameLog
  // backfills prior seasons for H2H depth, which would corrupt a "this season" average.
  const currentYear  = new Date().getFullYear();
  const seasonGamesArr = games.filter(g => g.season === currentYear);

  return {
    player: {
      id: player.id, name: player.name,
      team: WNBA_ABBR_TO_NAME[player.teamAbbr] || player.teamAbbr.toUpperCase(),
      position: player.position, height: '?',
    },
    form: hotCold,
    dataSource: 'ESPN WNBA (live)',
    minutesStability: parseFloat(calcWNBAStdDev(last10, 'min')) > 5 ? 'VOLATILE' : 'STABLE',
    averages: {
      pts: calcWNBAAvg(last10,'pts'), reb: calcWNBAAvg(last10,'reb'), ast: calcWNBAAvg(last10,'ast'),
      min: calcWNBAAvg(last10,'min'), fg3m: calcWNBAAvg(last10,'fg3m'), fg_pct: calcWNBAAvg(last10,'fg_pct'),
      fg3_pct: calcWNBAAvg(last10,'fg3_pct'),
      stl: calcWNBAAvg(last10,'stl'), blk: calcWNBAAvg(last10,'blk'), turnover: calcWNBAAvg(last10,'tov'),
    },
    seasonAvg: seasonGamesArr.length ? {
      pts: parseFloat(calcWNBAAvg(seasonGamesArr,'pts')), reb: parseFloat(calcWNBAAvg(seasonGamesArr,'reb')),
      ast: parseFloat(calcWNBAAvg(seasonGamesArr,'ast')), min: parseFloat(calcWNBAAvg(seasonGamesArr,'min')),
      fga: parseFloat(calcWNBAAvg(seasonGamesArr,'fga')), fgm: parseFloat(calcWNBAAvg(seasonGamesArr,'fgm')),
      fg3a: parseFloat(calcWNBAAvg(seasonGamesArr,'fg3a')), fg3m: parseFloat(calcWNBAAvg(seasonGamesArr,'fg3m')),
      fta: parseFloat(calcWNBAAvg(seasonGamesArr,'fta')), ftm: parseFloat(calcWNBAAvg(seasonGamesArr,'ftm')),
    } : null,
    seasonGames: seasonGamesArr.length,
    last5Games: last5.map(g => ({
      date: g.date, opponent: g.opponent, pts: g.pts, reb: g.reb, ast: g.ast, stl: g.stl, blk: g.blk, tov: g.tov,
      fg3m: g.fg3m, min: g.min, fga: g.fga, fgm: g.fgm, fg3a: g.fg3a, fta: g.fta, ftm: g.ftm, home: g.home,
      fg_pct: g.fg_pct ? g.fg_pct + '%' : 'N/A',
    })),
    last10Games: last10.map(g => ({
      date: g.date, opponent: g.opponent, pts: g.pts, reb: g.reb, ast: g.ast, stl: g.stl, blk: g.blk, tov: g.tov,
      fg3m: g.fg3m, min: g.min, fga: g.fga, fgm: g.fgm, fg3a: g.fg3a, fta: g.fta, ftm: g.ftm, home: g.home,
      fg_pct: g.fg_pct ? g.fg_pct + '%' : 'N/A', plus_minus: null,
    })),
    // Deeper window (up to 20 games) so the UI's Home/Away filters have
    // enough games to draw from — last10Games alone is often only ~5 of
    // each, since games naturally alternate home/away across a schedule.
    gameLog20: games.slice(0, 20).map(g => ({
      date: g.date, opponent: g.opponent, pts: g.pts, reb: g.reb, ast: g.ast, stl: g.stl, blk: g.blk, tov: g.tov,
      fg3m: g.fg3m, min: g.min, home: g.home,
    })),
    gamesAnalyzed: games.length,
  };
}

// H2H is just the same gamelog filtered by opponent — no separate bridge needed
async function fetchWNBAH2HStats(playerName, opponentTeamName) {
  const player = await resolveWNBAPlayer(playerName);
  const oppAbbr = resolveWNBATeam(opponentTeamName);
  if (!player || !oppAbbr) return null;

  const games = await getWNBAPlayerGameLog(player.id);
  const h2h = games.filter(g => g.oppAbbr === oppAbbr);
  if (!h2h.length) return null;

  const avg = (key) => parseFloat(calcWNBAAvg(h2h, key));
  const mid = Math.ceil(h2h.length / 2);
  const recentPts = h2h.slice(0, mid).reduce((s,g) => s+g.pts, 0) / Math.max(mid, 1);
  const olderPts  = h2h.slice(mid).reduce((s,g) => s+g.pts, 0) / Math.max(h2h.length - mid, 1);
  const trend = h2h.length >= 2
    ? (recentPts > olderPts + 2 ? 'IMPROVING' : recentPts < olderPts - 2 ? 'DECLINING' : 'STABLE')
    : 'STABLE';

  return {
    gamesVsOpp: h2h.length, source: 'ESPN WNBA gamelog',
    pts: avg('pts'), reb: avg('reb'), ast: avg('ast'), fg3m: avg('fg3m'),
    stl: avg('stl'), blk: avg('blk'), tov: avg('tov'), min: avg('min'),
    pra: parseFloat((avg('pts')+avg('reb')+avg('ast')).toFixed(1)),
    h2hTrend: trend,
    games: h2h,
    recentGames: h2h.slice(0, 6),
  };
}

// ── SCHEDULE / TODAY'S GAMES (ESPN scoreboard) ────────────────────
let wnbaTodaysGames  = [];
let lastWnbaSchedule = 0;
const WNBA_SCHEDULE_TTL = 10 * 60 * 1000;

async function fetchWNBASchedule(dateStr) {
  if (!dateStr && wnbaTodaysGames.length && (Date.now() - lastWnbaSchedule) < WNBA_SCHEDULE_TTL) {
    return wnbaTodaysGames;
  }
  try {
    // ESPN's scoreboard defaults to a stale "day" when no dates param is
    // passed (observed returning yesterday's already-Final slate instead of
    // today's) — always pass an explicit date so this can't silently drift.
    const params = { dates: dateStr || getTodayCompact() };
    const res = await axios.get(`${ESPN_BASE_WNBA}/scoreboard`, { params, timeout: 8000 });
    const games = (res.data?.events || []).map(e => {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      return {
        id: e.id,
        home: home?.team?.displayName || '',
        away: away?.team?.displayName || '',
        status: e.status?.type?.description || '',
        gameTime: new Date(e.date).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', hour12: true
        }) + ' ET',
      };
    });
    if (!dateStr) { wnbaTodaysGames = games; lastWnbaSchedule = Date.now(); }
    return games;
  } catch (err) {
    console.error('[ESPN-W] Schedule fetch failed:', err.message);
    return dateStr ? [] : wnbaTodaysGames;
  }
}

// ── PROP LINES (The Odds API, sport key basketball_wnba) ──────────
async function fetchWNBAPropLines(playerName, propType) {
  const cacheKey = `wnba:${playerName}:${propType}`;
  const cached = propLinesCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < PROP_LINES_TTL) return cached.data;

  if (!process.env.ODDS_API_KEY || process.env.ODDS_API_KEY.includes('your_')) return { error: 'No odds key' };
  const propMap = {
    points: 'player_points', rebounds: 'player_rebounds',
    assists: 'player_assists', '3pm': 'player_threes',
    pra: 'player_points_rebounds_assists', steals: 'player_steals', blocks: 'player_blocks'
  };
  try {
    const market = propMap[propType] || 'player_points';
    const eventsRes = await axios.get(`${ODDS_BASE}/sports/basketball_wnba/events`, {
      params: { apiKey: process.env.ODDS_API_KEY }, timeout: 8000
    });
    const lines = {};
    const lastName = playerName.toLowerCase().split(' ').pop();
    const eventSlice = (eventsRes.data || []).slice(0, 5);
    await Promise.allSettled(eventSlice.map(async event => {
      try {
        const oddsRes = await axios.get(`${ODDS_BASE}/sports/basketball_wnba/events/${event.id}/odds`, {
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
    const result = { lines, softestLine, softestBook, market };
    propLinesCache[cacheKey] = { data: result, ts: Date.now() };
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

// ── GAME CONTEXT (spread/total from Odds API, B2B from ESPN schedule) ─
async function fetchWNBAGameContext(playerTeam, opponent) {
  const ctx = {
    spread: null, total: null, isBackToBack: false,
    gameTotalAdj: 1.0, spreadAdj: 1.0, b2bAdj: 1.0, details: [],
  };

  try {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const yStr = toLocalDateStr(yesterday).replace(/-/g, '');
    const prevGames = await fetchWNBASchedule(yStr);
    const playedYesterday = prevGames.some(g =>
      g.home.toLowerCase().includes(playerTeam.toLowerCase()) ||
      g.away.toLowerCase().includes(playerTeam.toLowerCase())
    );
    if (playedYesterday) {
      ctx.isBackToBack = true; ctx.b2bAdj = 0.92;
      ctx.details.push('Back-to-back: -8% projection adjustment');
    }
  } catch (_) {}

  if (!process.env.ODDS_API_KEY || process.env.ODDS_API_KEY.includes('your_')) return ctx;

  try {
    const eventsRes = await axios.get(`${ODDS_BASE}/sports/basketball_wnba/events`, {
      params: { apiKey: process.env.ODDS_API_KEY }, timeout: 8000
    });
    const teamLower = playerTeam.toLowerCase().split(' ').pop();
    const oppLower  = opponent.toLowerCase().split(' ').pop();
    const event = (eventsRes.data || []).find(e =>
      (e.home_team?.toLowerCase().includes(teamLower) || e.away_team?.toLowerCase().includes(teamLower)) &&
      (e.home_team?.toLowerCase().includes(oppLower)  || e.away_team?.toLowerCase().includes(oppLower))
    );
    if (event) {
      const oddsRes = await axios.get(`${ODDS_BASE}/sports/basketball_wnba/events/${event.id}/odds`, {
        params: { apiKey: process.env.ODDS_API_KEY, regions: 'us', markets: 'totals,spreads', oddsFormat: 'american' },
        timeout: 8000
      });
      for (const bm of (oddsRes.data.bookmakers || []).slice(0, 3)) {
        for (const mkt of (bm.markets || [])) {
          if (mkt.key === 'totals' && !ctx.total) {
            const over = mkt.outcomes?.find(o => o.name === 'Over');
            if (over?.point) ctx.total = parseFloat(over.point);
          }
          if (mkt.key === 'spreads' && !ctx.spread) {
            const line = mkt.outcomes?.find(o => o.name?.toLowerCase().includes(teamLower));
            if (line?.point != null) ctx.spread = parseFloat(line.point);
          }
        }
      }
    }
  } catch (_) {}

  if (ctx.total) {
    if (ctx.total >= 172) { ctx.gameTotalAdj = 1.05; ctx.details.push(`High total (${ctx.total}): +5% — fast pace game`); }
    else if (ctx.total >= 165) { ctx.gameTotalAdj = 1.02; ctx.details.push(`Above avg total (${ctx.total}): +2%`); }
    else if (ctx.total <= 152) { ctx.gameTotalAdj = 0.95; ctx.details.push(`Low total (${ctx.total}): -5% — defensive game`); }
    else if (ctx.total <= 158) { ctx.gameTotalAdj = 0.97; ctx.details.push(`Below avg total (${ctx.total}): -3%`); }
  }
  if (ctx.spread != null) {
    if (ctx.spread <= -10) { ctx.spreadAdj = 0.93; ctx.details.push(`Heavy favorite (${ctx.spread}): -7% — blowout risk`); }
    else if (ctx.spread <= -6) { ctx.spreadAdj = 0.96; ctx.details.push(`Large favorite (${ctx.spread}): -4% — garbage time risk`); }
    else if (ctx.spread >= 10) { ctx.spreadAdj = 0.96; ctx.details.push(`Heavy underdog (+${ctx.spread}): -4% — may slow pace`); }
    else if (ctx.spread >= -4 && ctx.spread <= 4) { ctx.spreadAdj = 1.03; ctx.details.push(`Close game (${ctx.spread}): +3% — full minutes`); }
  }
  return ctx;
}

function buildProjection(playerStats, ctx, propType) {
  if (!playerStats || playerStats.error) return null;
  const avgs = playerStats.averages || {};
  const h2h  = ctx.h2hStats || null;
  const league = ctx.league || 'nba';
  const drivers = []; // real computed deltas, in stat units — explanation comes FROM these, not invented after the fact

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

  // ── STEP 1: RECENT BASELINE FROM GAME LOG ─────────────────────
  let l10Val = isCombo
    ? isCombo.reduce((s, k) => s + (parseFloat(avgs[k])||0), 0)
    : (parseFloat(avgs[statKey]) || 0);
  if (!l10Val) return null;

  let l10FromLog = l10Val;
  const recentGames = playerStats.last10Games?.length >= 5 ? playerStats.last10Games
                     : playerStats.last5Games?.length >= 3 ? playerStats.last5Games : null;
  if (recentGames) {
    const vals = recentGames.map(getGameVal);
    l10FromLog = vals.reduce((a,b)=>a+b,0) / vals.length;
  }
  const recentGamesCount = recentGames?.length || 0;

  // Determined here (rather than right before it's branched on below)
  // because it gates whether the season-shrink and H2H-blend driver
  // entries below are real: for decomposed points, the actual projection
  // is built from scratch via minutes × shot-attempts × efficiency and
  // never uses shrunkBase/baseProj at all — pushing those as "drivers"
  // would claim credit/blame for an effect that didn't happen to the
  // number the user actually sees (a real bug found via audit: the driver
  // list didn't reconcile to the actual projection for decomposed points,
  // while it reconciled exactly for the general path).
  const canDecomposePoints = propType === 'points' && recentGames?.some(g => g.fga != null) && playerStats.seasonAvg?.fga != null;

  // ── STEP 1b: SHRINK TOWARD SEASON BASELINE ────────────────────
  // A 5-10 game window is noisy. Pull it toward the full-season average,
  // weighted by how many recent games back it up — degrades gracefully to
  // the old L10-only behavior when no season-long data is available.
  let seasonVal = null;
  if (playerStats.seasonAvg) {
    seasonVal = isCombo
      ? isCombo.reduce((s, k) => s + (parseFloat(playerStats.seasonAvg[k]) || 0), 0)
      : parseFloat(playerStats.seasonAvg[statKey]);
    if (!isFinite(seasonVal) || !seasonVal) seasonVal = null;
  }
  const shrunkBase = shrink(l10FromLog, seasonVal, recentGamesCount, 8);
  if (!canDecomposePoints && seasonVal != null && Math.abs(shrunkBase - l10FromLog) > 0.05) {
    drivers.push({ label: 'regression toward season baseline', value: parseFloat((shrunkBase - l10FromLog).toFixed(1)) });
  }

  // ── STEP 2: RECENCY-WEIGHTED H2H BLEND (unchanged — already sound) ──
  let baseProj = shrunkBase;
  let h2hVal   = null;
  let h2hGamesUsed = 0;

  if (h2h && h2h.gamesVsOpp >= 2) {
    const h2hGames = h2h.games || h2h.recentGames || [];
    if (h2hGames.length >= 2) {
      const DECAY = 0.75;
      let weightedSum = 0, totalWeight = 0;
      for (let i = 0; i < Math.min(h2hGames.length, 8); i++) {
        const g = h2hGames[i];
        const weight = Math.pow(DECAY, i);
        const val = isCombo
          ? isCombo.reduce((s, k) => s + (parseFloat(g[k])||0), 0)
          : (parseFloat(g[statKey]) || 0);
        if (val > 0) { weightedSum += val * weight; totalWeight += weight; }
      }
      if (totalWeight > 0) {
        h2hVal = parseFloat((weightedSum / totalWeight).toFixed(2));
        h2hGamesUsed = Math.min(h2hGames.length, 8);
      }
    }
    if (!h2hVal) {
      h2hVal = isCombo
        ? isCombo.reduce((s, k) => s + (h2h[k]||0), 0) || null
        : (h2h[statKey] || null);
      h2hGamesUsed = h2h.gamesVsOpp;
    }
    if (h2hVal) {
      const h2hWeight = Math.min(0.45, 0.12 * h2hGamesUsed);
      const before = baseProj;
      baseProj = (shrunkBase * (1 - h2hWeight)) + (h2hVal * h2hWeight);
      if (!canDecomposePoints) {
        drivers.push({ label: `H2H blend (${h2hGamesUsed} games)`, value: parseFloat((baseProj - before).toFixed(1)) });
      }
    }
  }

  // ── STEP 3: PROJECT MINUTES FIRST ─────────────────────────────
  // Everything downstream is minutes × per-minute rate, not a raw average
  // that silently bakes in whatever playing time happened to occur recently.
  const minutesProj = projectMinutes(playerStats, ctx);
  const recentMinAvg = minutesProj.recentMinutes || parseFloat(avgs.min) || 0;
  const minutesRatio = recentMinAvg > 0 ? minutesProj.projectedMinutes / recentMinAvg : 1.0;

  const playerPos = playerStats?.player?.position;
  const usageMult = calcUsageInflation(ctx.playerRoster, playerStats, propType, ctx.nbaPlayerStats || []);
  // Usage signal is split across two channels so it isn't counted twice:
  // 35% already landed on minutes (projectMinutes' "role bump"), the
  // remaining 65% applies here to the per-minute production rate.
  const rateUsageMult = 1 + 0.65 * (usageMult - 1.0);

  const oppAdj = calcOpponentAdjustment(propType, ctx.oppFourFact, league);
  const leagueAvgPace = getLeagueBaselines(league).pace;
  const playerTeamPace = ctx.playerTeamAdvanced?.PACE;
  const blendedPace = ((parseFloat(ctx.oppAdvanced?.PACE) || leagueAvgPace) + (parseFloat(playerTeamPace) || leagueAvgPace)) / 2;
  const paceRatio = 1 + Math.max(-0.08, Math.min(0.08, (blendedPace - leagueAvgPace) / leagueAvgPace));

  let proj;

  if (canDecomposePoints) {
    // ── OPPORTUNITY × EFFICIENCY DECOMPOSITION (points) ──────────
    // Minutes → shot attempts (opportunity) → make % (efficiency), instead
    // of one opaque scoring number. Efficiency shrinks harder than volume —
    // a hot shooting stretch regresses; a real increase in shot attempts is
    // more sustainable signal (item 7: distinguish signal from noise).
    const sumRecent = (key) => recentGames.reduce((s,g) => s + (parseFloat(g[key])||0), 0);
    const recentMinSum = sumRecent('min');
    const recentFga = sumRecent('fga'), recentFgm = sumRecent('fgm');
    const recentFg3a = sumRecent('fg3a'), recentFg3m = sumRecent('fg3m');
    const recentFta = sumRecent('fta'), recentFtm = sumRecent('ftm');
    const recent2ptA = Math.max(0, recentFga - recentFg3a), recent2ptM = Math.max(0, recentFgm - recentFg3m);

    const sa = playerStats.seasonAvg;
    const season2ptA = Math.max(0, (sa.fga||0) - (sa.fg3a||0)), season2ptM = Math.max(0, (sa.fgm||0) - (sa.fg3m||0));

    // Opportunity — attempts per minute, shrunk on GAME count (volume is
    // trusted fairly quickly; k=10 games).
    const fgaPerMin  = shrink(recentMinSum>0 ? recentFga/recentMinSum : 0,  sa.min>0 ? sa.fga/sa.min : null,  recentGamesCount, 10);
    const fg3aPerMin = shrink(recentMinSum>0 ? recentFg3a/recentMinSum : 0, sa.min>0 ? sa.fg3a/sa.min : null, recentGamesCount, 10);
    const ftaPerMin  = shrink(recentMinSum>0 ? recentFta/recentMinSum : 0,  sa.min>0 ? sa.fta/sa.min : null,  recentGamesCount, 10);

    // Efficiency — make %, shrunk on ATTEMPT count (shooting variance
    // depends on shots taken, not games played; k tuned much higher —
    // this is the "don't let a hot streak become the new baseline" rule).
    const twoPtPct   = shrink(recent2ptA>0 ? recent2ptM/recent2ptA : null, season2ptA>0 ? season2ptM/season2ptA : null, recent2ptA, 35);
    const threePtPct = shrink(recentFg3a>0 ? recentFg3m/recentFg3a : null, sa.fg3a>0 ? sa.fg3m/sa.fg3a : null, recentFg3a, 35);
    const ftPct      = shrink(recentFta>0 ? recentFtm/recentFta : null,   sa.fta>0 ? sa.ftm/sa.fta : null,   recentFta, 25);

    const projFga  = minutesProj.projectedMinutes * fgaPerMin  * paceRatio * rateUsageMult;
    const proj3ptA = Math.min(projFga, minutesProj.projectedMinutes * fg3aPerMin * paceRatio * rateUsageMult);
    const proj2ptA = Math.max(0, projFga - proj3ptA);
    const projFta  = minutesProj.projectedMinutes * ftaPerMin * rateUsageMult * oppAdj.ftaFactor;

    const adjTwoPtPct   = Math.max(0.05, Math.min(0.95, (twoPtPct ?? 0.45) * oppAdj.efficiencyFactor));
    const adjThreePtPct = Math.max(0.05, Math.min(0.95, (threePtPct ?? 0.34) * oppAdj.efficiencyFactor));
    const adjFtPct      = ftPct ?? 0.78; // FT% is a personal skill, not opponent-dependent

    const proj2ptM = proj2ptA * adjTwoPtPct;
    const proj3ptM = proj3ptA * adjThreePtPct;
    const projFtm  = projFta * adjFtPct;

    proj = 2*proj2ptM + 3*proj3ptM + projFtm;

    // Exact counterfactual drivers: minutes/pace/usage are pure multiplicative
    // factors applied identically across the FGA and FTA channels, so
    // subtracting the "with this factor neutralized" total is exact, not
    // approximated. Efficiency isn't uniform (it doesn't touch FT makes),
    // so that driver is computed by re-summing 2PM/3PM without the
    // opponent-efficiency factor and comparing against the actual total.
    if (minutesProj.projectedMinutes !== minutesProj.baselineMinutes && minutesProj.projectedMinutes > 0) {
      const projAtBaselineMin = proj * (minutesProj.baselineMinutes / minutesProj.projectedMinutes);
      drivers.push({ label: 'projected minutes vs baseline', value: parseFloat((proj - projAtBaselineMin).toFixed(1)) });
    }
    if (Math.abs(paceRatio - 1) > 0.001) {
      drivers.push({ label: 'pace environment', value: parseFloat((proj - proj/paceRatio).toFixed(1)) });
    }
    if (Math.abs(rateUsageMult - 1) > 0.001) {
      drivers.push({ label: 'usage rate (teammate/role)', value: parseFloat((proj - proj/rateUsageMult).toFixed(1)) });
    }
    if (Math.abs(oppAdj.efficiencyFactor - 1) > 0.001) {
      const unadjTwoPtPct   = Math.max(0.05, Math.min(0.95, twoPtPct ?? 0.45));
      const unadjThreePtPct = Math.max(0.05, Math.min(0.95, threePtPct ?? 0.34));
      const pointsWithoutOppEfficiency = 2*(proj2ptA*unadjTwoPtPct) + 3*(proj3ptA*unadjThreePtPct) + projFtm;
      drivers.push({ label: 'opponent shooting efficiency allowed', value: parseFloat((proj - pointsWithoutOppEfficiency).toFixed(1)) });
    }
    if (Math.abs(oppAdj.ftaFactor - 1) > 0.001) {
      const projFtaUnadj = minutesProj.projectedMinutes * ftaPerMin * rateUsageMult;
      const ftmUnadj = projFtaUnadj * adjFtPct;
      drivers.push({ label: 'opponent free-throw rate allowed', value: parseFloat((projFtm - ftmUnadj).toFixed(1)) });
    }
  } else {
    // ── GENERAL PATH (rebounds/assists/steals/blocks/combos, or points
    // without attempt-level data) — same minutes-first + shrinkage
    // structure, without the full shot-decomposition (no clean "attempts"
    // concept for these stats without tracking data we don't have access to).
    proj = baseProj * minutesRatio;
    if (Math.abs(minutesRatio - 1) > 0.01) {
      drivers.push({ label: 'projected minutes vs recent avg', value: parseFloat((proj - baseProj).toFixed(1)) });
    }

    const before1 = proj;
    proj = calcPaceAdj(proj, ctx.oppAdvanced?.PACE, playerTeamPace, propType, league);
    if (Math.abs(proj - before1) > 0.05) drivers.push({ label: 'pace environment', value: parseFloat((proj - before1).toFixed(1)) });

    const before2 = proj;
    if (['rebounds','pr','ra'].includes(propType) && ctx.oppFourFact) {
      proj *= oppAdj.reboundFactor;
    } else if (['assists','pa'].includes(propType) && ctx.oppFourFact) {
      proj *= oppAdj.assistFactor;
    } else {
      proj *= calcDvPCoeff(ctx.oppAdvanced?.DEF_RATING, playerPos, ctx.playerPlaytypes, ctx.oppDefPlaytypes, propType, league);
    }
    if (Math.abs(proj - before2) > 0.05) drivers.push({ label: 'opponent matchup', value: parseFloat((proj - before2).toFixed(1)) });

    const before3 = proj;
    proj *= rateUsageMult;
    if (Math.abs(proj - before3) > 0.05) drivers.push({ label: 'usage rate (teammate/role)', value: parseFloat((proj - before3).toFixed(1)) });

    // Recency form nudge — only for the general path; the points
    // decomposition above already handles signal-vs-noise more precisely
    // via differential shrinkage, so applying this too would double-count it.
    if (playerStats.form === 'HOT')  proj *= 1.04;
    if (playerStats.form === 'COLD') proj *= 0.96;
  }

  // ── GAME CONTEXT (spread/total/back-to-back) — applies to all paths ──
  const gc = ctx.gameContext;
  let gameContextMult = 1.0;
  if (gc) {
    gameContextMult = gc.gameTotalAdj * gc.spreadAdj * gc.b2bAdj;
    gameContextMult = Math.max(0.85, Math.min(1.15, gameContextMult));
    const before = proj;
    proj = proj * gameContextMult;
    if (Math.abs(proj - before) > 0.05) drivers.push({ label: 'game context (total/spread/rest)', value: parseFloat((proj - before).toFixed(1)) });
  }
  if (playerStats.minutesStability === 'VOLATILE') proj *= 0.97;

  // ── DISTRIBUTION + PROBABILITY ─────────────────────────────────
  // Estimated from actual recent game-to-game variance, floored by a
  // per-stat minimum coefficient of variation so a small, coincidentally
  // consistent sample doesn't produce a falsely narrow distribution. Normal
  // approximation — reasonable for higher-count stats like points/rebounds/
  // assists; a real weakness for low-count stats (steals/blocks/3PM), which
  // are closer to Poisson-shaped — flagged, not pretended away.
  const gameVals = (recentGames || []).map(getGameVal);
  let sampleStdDev = null;
  if (gameVals.length >= 3) {
    const mean = gameVals.reduce((a,b)=>a+b,0) / gameVals.length;
    sampleStdDev = Math.sqrt(gameVals.reduce((s,v)=>s+Math.pow(v-mean,2),0) / gameVals.length);
  }
  const MIN_CV = { points:0.28, pra:0.25, pr:0.28, pa:0.28, ra:0.32, rebounds:0.35, assists:0.35, '3pm':0.55, steals:0.6, blocks:0.6 };
  const stdDev = Math.max(sampleStdDev || 0, (MIN_CV[propType] || 0.35) * Math.max(proj, 0.1));
  const zRange = 1.28; // ~80% interval

  // ── CONFIDENCE / RELIABILITY (separate from probability) ──────
  let conf = 50;
  if (playerStats.minutesStability === 'STABLE')       conf += 10;
  if ((playerStats.gamesAnalyzed || 0) >= 10)          conf += 8;
  else if ((playerStats.gamesAnalyzed || 0) >= 5)      conf += 4;
  if (ctx.oppAdvanced)                                  conf += 8;
  if (ctx.playerTeamAdvanced)                           conf += 3;
  if (h2h && h2h.gamesVsOpp >= 3)                      conf += 10;
  else if (h2h && h2h.gamesVsOpp >= 1)                 conf += 5;
  if (ctx.playerRoster)                                 conf += 4;
  if (gc?.total)                                        conf += 5;
  if (gc?.spread != null)                               conf += 5;
  if (gc?.isBackToBack)                                 conf -= 5;
  if (Object.keys(ctx.playerPlaytypes||{}).length >= 3) conf += 5;
  if (!ctx.dataAvailable?.teamAdvanced)                 conf -= 8;
  if ((playerStats.seasonGames || 0) >= 15)             conf += 4; // real season baseline, not just L10
  if (canDecomposePoints)                               conf += 3; // opportunity/efficiency model, not a flat average
  conf = Math.max(30, Math.min(90, Math.round(conf)));

  const dvpCoeff = calcDvPCoeff(ctx.oppAdvanced?.DEF_RATING, playerPos, ctx.playerPlaytypes, ctx.oppDefPlaytypes, propType, league);

  return {
    projection:        parseFloat(proj.toFixed(1)),
    medianProjection:  parseFloat(proj.toFixed(1)), // normal approx — see stdDev note above
    lowerBound:        parseFloat(Math.max(0, proj - zRange*stdDev).toFixed(1)),
    upperBound:        parseFloat((proj + zRange*stdDev).toFixed(1)),
    stdDev:            parseFloat(stdDev.toFixed(2)),
    projectedMinutes:  minutesProj.projectedMinutes,
    baselineMinutes:   minutesProj.baselineMinutes,
    minutesDetails:    minutesProj.details,
    sampleSize:        recentGamesCount,
    seasonGames:       playerStats.seasonGames || 0,
    baselineSource:    seasonVal != null ? 'season+recent (shrunk)' : 'recent-only (no season baseline available)',
    decomposed:        canDecomposePoints,
    l10Avg:            parseFloat(l10FromLog.toFixed(1)),
    h2hAvg:            h2hVal ? parseFloat(h2hVal.toFixed(1)) : null,
    h2hGames:          h2h?.gamesVsOpp || 0,
    h2hGamesUsed:      h2hGamesUsed || 0,
    h2hBlend:          h2hVal ? parseFloat(baseProj.toFixed(1)) : null,
    h2hWeighted:       true,
    h2hTrend:          h2h?.h2hTrend || h2h?.trend || null,
    // null for decomposed points — that path uses the stat-specific
    // opponent efficiency/FTA factors instead (already reflected in the
    // 'opponent shooting efficiency allowed' / 'opponent free-throw rate
    // allowed' drivers below), so this coefficient was never applied and
    // showing it would misrepresent what actually moved the number.
    dvpCoeff:          canDecomposePoints ? null : parseFloat(dvpCoeff.toFixed(3)),
    usageMult:         parseFloat(usageMult.toFixed(3)),
    injuryBreakdown:   calcInjuryBreakdown(ctx.playerRoster, playerStats, propType, ctx.nbaPlayerStats || []),
    opponentAdjustment: oppAdj.details,
    gameContextMult:   parseFloat(gameContextMult.toFixed(3)),
    gameTotal:         gc?.total || null,
    spread:            gc?.spread ?? null,
    isBackToBack:      gc?.isBackToBack || false,
    gameContextDetails: gc?.details || [],
    form:              playerStats.form,
    confidence:        conf,
    drivers:           drivers.filter(d => Math.abs(d.value) > 0.05),
    oppPace:           ctx.oppAdvanced?.PACE || null,
    playerTeamPace:    playerTeamPace || null,
    oppDefRtg:         ctx.oppAdvanced?.DEF_RATING || null,
    playerPosition:    playerPos || null,
    playtypeMatchup:   Object.keys(ctx.playerPlaytypes||{}).length >= 3,
    methodology: [
      canDecomposePoints ? 'minutes→opportunity→efficiency' : 'minutes→rate (general)',
      h2hVal ? `L10(${Math.round((1-Math.min(0.45,0.12*h2hGamesUsed))*100)}%)+H2H-recency(${Math.round(Math.min(0.45,0.12*h2hGamesUsed)*100)}%)` : 'season-shrunk-L10',
      'blended-pace', 'stat-specific-opponent-adj',
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

// ─────────────────────────────────────────────────────
// BRIDGE CONCURRENCY LIMITER — nba.com rate-limits aggressively.
// Every predict_tonight.py spawn (regular + H2H) runs through this
// one queue with a minimum gap between calls, so this app never hits
// nba.com with parallel requests no matter how many players are
// looked up at once.
// ─────────────────────────────────────────────────────
let bridgeChain = Promise.resolve();
let lastBridgeCallTs = 0;
const BRIDGE_MIN_GAP_MS = 600;

function enqueueBridge(taskFn) {
  const scheduled = bridgeChain.then(async () => {
    const wait = BRIDGE_MIN_GAP_MS - (Date.now() - lastBridgeCallTs);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try {
      return await taskFn();
    } finally {
      lastBridgeCallTs = Date.now();
    }
  });
  // Keep the queue alive regardless of whether this task succeeds or fails
  bridgeChain = scheduled.then(() => {}, () => {});
  return scheduled;
}

async function fetchViaBridge(playerName, season = '2025-26') {
  const cacheKey = `${playerName}:${season}`;
  const cached = nbaApiBridgeCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < NBA_BRIDGE_TTL) {
    console.log(`[Bridge] Cache hit: ${playerName}`);
    return cached.data;
  }

  return enqueueBridge(() => new Promise((resolve) => {
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
    }, 20000);

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
  }));
}

// ── SHOT CHARTS — real per-shot LOC_X/LOC_Y from stats.nba.com, works for
// both leagues (LeagueID 00=NBA, 10=WNBA — same backend, verified live).
// Routed through the same bridge queue as predict_tonight.py so this never
// adds parallel load against nba.com on top of the player-stats bridge.
const shotChartCache = {};
const SHOT_CHART_TTL = 30 * 60 * 1000;

async function fetchShotChart(league, mode, name, season = '2025-26') {
  const cacheKey = `${league}:${mode}:${name}:${season}`;
  const cached = shotChartCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < SHOT_CHART_TTL) {
    return cached.data;
  }

  return enqueueBridge(() => new Promise((resolve) => {
    const py = spawn('python3', [
      path.join(__dirname, 'shotchart.py'),
      league, mode, name, season
    ]);

    let output = '', errout = '';
    py.stdout.on('data', d => { output += d.toString(); });
    py.stderr.on('data', d => { errout += d.toString(); });

    // The first call of the day per league also has to fetch+cache a
    // league-wide zone benchmark (30-100k shots) before it can even start
    // on the actual request — budget for that cold-cache case, not just
    // the normal warm-cache path.
    const timer = setTimeout(() => {
      py.kill();
      resolve({ error: 'Shot chart bridge timeout — nba.com took too long' });
    }, 70000);

    py.on('close', () => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(output.trim());
        if (!data.error) shotChartCache[cacheKey] = { data, ts: Date.now() };
        resolve(data);
      } catch (e) {
        resolve({ error: `Shot chart parse error: ${errout || output}` });
      }
    });
  }));
}

// GET /api/shotchart?league=nba|wnba&mode=player|defense&name=<player or team>
app.get('/api/shotchart', async (req, res) => {
  const league = (req.query.league || 'nba').toLowerCase() === 'wnba' ? 'wnba' : 'nba';
  const mode   = req.query.mode === 'defense' ? 'defense' : 'player';
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  console.log(`[ShotChart] ${league} ${mode}: ${name}`);
  const data = await fetchShotChart(league, mode, name);
  res.json(data);
});

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

// Full real player list for autocomplete — the frontend used to only
// suggest from a hardcoded ~40-65 star-player list, so anyone else (a real,
// fully analyzable player) got zero autocomplete help unless the exact
// spelling was already known.
let playersListCache = {}; // league -> { players, ts }
const PLAYERS_LIST_TTL = 6 * 60 * 60 * 1000; // 6h
app.get('/api/players', async (req, res) => {
  const league = req.query.league === 'wnba' ? 'wnba' : 'nba';
  const cached = playersListCache[league];
  if (cached && (Date.now() - cached.ts) < PLAYERS_LIST_TTL) {
    return res.json({ players: cached.players });
  }
  const stats = league === 'wnba' ? loadWNBAStats() : loadNBAStats();
  let names = (stats?.playerStats || []).map(p => p.PLAYER_NAME).filter(Boolean);
  if (league === 'wnba') {
    // wnba_player_stats.json doesn't have the 2026 expansion teams
    // (confirmed elsewhere this session) — fill that gap with live ESPN
    // rosters for just those two teams.
    try {
      const [tor, por] = await Promise.all([
        fetchWNBARoster('Toronto Tempo'),
        fetchWNBARoster('Portland Fire'),
      ]);
      names = names.concat((tor.players || []).map(p => p.name), (por.players || []).map(p => p.name));
    } catch (_) {}
  }
  const players = Array.from(new Set(names)).filter(Boolean).sort();
  playersListCache[league] = { players, ts: Date.now() };
  res.json({ players });
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
// WNBA ROUTES — mirror the NBA routes above, live ESPN/Odds API data
// ─────────────────────────────────────────────────────
app.get('/api/wnba/today', async (req, res) => {
  const games = await fetchWNBASchedule();
  res.json({ date: getToday(), games });
});

// Date-scoped schedule for both leagues, used by the Daily Matchups week
// picker — real BDL/ESPN data for any day, not just "today".
app.get('/api/schedule', async (req, res) => {
  const { date } = req.query; // YYYY-MM-DD
  if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
  const [nbaRes, wnbaGames] = await Promise.all([
    axios.get(`${BALLDONTLIE}/games`, {
      params: { dates: [date], per_page: 30 },
      headers: { Authorization: process.env.BALLDONTLIE_KEY },
      timeout: 10000
    }).then(r => r.data.data || []).catch(() => []),
    fetchWNBASchedule(date.replace(/-/g, '')).catch(() => [])
  ]);
  const nbaGames = nbaRes.map(g => {
    let gameTime = 'TBD';
    const s = g.status || '';
    if (s.includes('T') && s.includes(':')) {
      try {
        gameTime = new Date(s).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', hour12: true }) + ' ET';
      } catch (_) { gameTime = s; }
    } else if (s) gameTime = s;
    return { league: 'nba', home: g.home_team.full_name, away: g.visitor_team.full_name, status: g.status, gameTime,
      homeScore: g.home_team_score, awayScore: g.visitor_team_score };
  });
  const wGames = wnbaGames.map(g => ({ league: 'wnba', home: g.home, away: g.away, status: g.status, gameTime: g.gameTime }));
  res.json({ date, games: [...nbaGames, ...wGames] });
});

// Real team-vs-team comparison for the Daily Matchups dashboard: season
// record/rank/pace/ratings (stats.nba.com via fetch_stats.py) + real last-5
// and head-to-head results (ESPN box scores). No fabricated fields.
app.get('/api/team-compare', async (req, res) => {
  const { team1, team2 } = req.query;
  const league = req.query.league === 'wnba' ? 'wnba' : 'nba';
  if (!team1 || !team2) return res.status(400).json({ error: 'team1 and team2 required' });
  try {
    const [t1Recent, t2Recent, s1, s2, topUsage1, topUsage2, starters1, starters2] = await Promise.all([
      fetchTeamRecentGames(league, team1, team2),
      fetchTeamRecentGames(league, team2, team1),
      getTeamStatBlockWithFallback(league, team1),
      getTeamStatBlockWithFallback(league, team2),
      getTopUsagePlayers(league, team1),
      getTopUsagePlayers(league, team2),
      getProjectedStarters(league, team1),
      getProjectedStarters(league, team2),
    ]);
    res.json({
      league,
      team1: { name: team1, stats: s1, last5: t1Recent.last5, topUsage: topUsage1, positionDefense: getTeamPositionDefense(league, team1), projectedStarters: starters1 },
      team2: { name: team2, stats: s2, last5: t2Recent.last5, topUsage: topUsage2, positionDefense: getTeamPositionDefense(league, team2), projectedStarters: starters2 },
      h2h: t1Recent.h2h,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/game-odds', async (req, res) => {
  const { team1, team2 } = req.query;
  const league = req.query.league === 'wnba' ? 'wnba' : 'nba';
  if (!team1 || !team2) return res.status(400).json({ error: 'team1 and team2 required' });
  try {
    res.json(await fetchGameOdds(league, team1, team2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real, data-driven "top targets" for a matchup — ranked by opportunity
// (real USG_PCT) and recent form (real L3-vs-L10 hot/cold trend), not
// Claude's free-text guessing. Split into its own endpoint (rather than
// folded into /api/team-compare) since it fans out to several per-player
// stat fetches — on NBA those go through the slow, serialized nba_api
// bridge, so this shouldn't block the fast team-level dashboard parts.
app.get('/api/matchup-targets', async (req, res) => {
  const { team1, team2 } = req.query;
  const league = req.query.league === 'wnba' ? 'wnba' : 'nba';
  if (!team1 || !team2) return res.status(400).json({ error: 'team1 and team2 required' });
  try {
    const fetchStats = league === 'wnba' ? fetchWNBAPlayerStats : fetchPlayerStats;
    const [top1, top2] = await Promise.all([
      getTopUsagePlayers(league, team1, 3),
      getTopUsagePlayers(league, team2, 3),
    ]);
    const candidates = [
      ...top1.map(p => ({ ...p, team: team1 })),
      ...top2.map(p => ({ ...p, team: team2 })),
    ];
    const results = await Promise.all(candidates.map(async (c) => {
      try {
        const stats = await fetchStats(c.name);
        if (!stats || stats.error) return null;
        const form = stats.form || 'NEUTRAL';
        const recentPpg = parseFloat(stats.averages?.pts) || null;
        const formBonus = form === 'HOT' ? 5 : form === 'COLD' ? -5 : 0;
        return {
          id: c.id, name: c.name, team: c.team, league,
          usgPct: c.usgPct, minutes: c.minutes,
          recentPpg, form,
          lean: form === 'HOT' ? 'Trending OVER' : form === 'COLD' ? 'Trending UNDER' : 'Volume play (neutral form)',
          headshot: headshotUrl(league, c.id),
          score: parseFloat(((c.usgPctNum || 0) + formBonus).toFixed(1)),
        };
      } catch (_) { return null; }
    }));
    const targets = results.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 3);
    res.json({ targets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/wnba/player-stats', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(await fetchWNBAPlayerStats(name));
});

app.get('/api/wnba/roster', async (req, res) => {
  const { team } = req.query;
  if (!team) return res.status(400).json({ error: 'team required' });
  res.json(await fetchWNBARoster(team));
});

// Given a player name, finds today's WNBA opponent automatically
app.get('/api/wnba/player-matchup', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const player = await resolveWNBAPlayer(name);
    if (!player) return res.json({ found: false, error: 'Player not found' });

    const teamName = WNBA_ABBR_TO_NAME[player.teamAbbr] || player.teamAbbr.toUpperCase();
    const games = await fetchWNBASchedule();
    const todayGame = games.find(g =>
      g.home.toLowerCase() === teamName.toLowerCase() || g.away.toLowerCase() === teamName.toLowerCase()
    );

    if (!todayGame) {
      return res.json({ found: true, playing: false, player: player.name, team: teamName, message: `${teamName} does not play today` });
    }
    const isHome = todayGame.home.toLowerCase() === teamName.toLowerCase();
    const opponent = isHome ? todayGame.away : todayGame.home;
    return res.json({
      found: true, playing: true, player: player.name, team: teamName,
      opponent, isHome, gameTime: todayGame.gameTime, gameId: todayGame.id,
    });
  } catch (err) {
    res.json({ found: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// WNBA PROP CONTEXT — same shape as /api/prop-context so the
// frontend can reuse its render functions across both leagues
// ─────────────────────────────────────────────────────
function sameTeam(a, b) {
  if (!a || !b) return false;
  const la = a.toLowerCase(), lb = b.toLowerCase();
  return la === lb || la.split(' ').pop() === lb.split(' ').pop();
}

app.get('/api/wnba/prop-context', async (req, res) => {
  const { player, opponent, propType } = req.query;
  if (!player || !opponent) return res.status(400).json({ error: 'player and opponent required' });

  console.log(`[Analyze-W] ${player} vs ${opponent} — ${propType}`);

  const playerStatsPre = await fetchWNBAPlayerStats(player);
  if (sameTeam(playerStatsPre?.player?.team, opponent)) {
    return res.status(400).json({
      error: `${player} plays for ${playerStatsPre.player.team} — that's the same team you entered as the opponent. Enter who ${playerStatsPre.player.team} is actually facing.`
    });
  }

  const [playerStats, oppRoster, propLines, todaysGames] = await Promise.all([
    Promise.resolve(playerStatsPre),
    fetchWNBARoster(opponent),
    fetchWNBAPropLines(player, propType || 'points'),
    fetchWNBASchedule(),
  ]);

  const playerTeamName = playerStats?.player?.team || '';

  const [playerRoster, h2hStats, gameContext] = await Promise.all([
    playerTeamName ? fetchWNBARoster(playerTeamName) : Promise.resolve(null),
    fetchWNBAH2HStats(player, opponent),
    fetchWNBAGameContext(playerTeamName || player, opponent),
  ]);

  const todayGame = todaysGames.find(g =>
    g.home.toLowerCase().includes(opponent.toLowerCase()) ||
    g.away.toLowerCase().includes(opponent.toLowerCase()) ||
    g.home.toLowerCase().includes(playerTeamName.toLowerCase()) ||
    g.away.toLowerCase().includes(playerTeamName.toLowerCase())
  ) || null;

  // Real stats.nba.com data (LeagueID=10) — same backend as NBA, just no
  // Synergy/tracking/hustle exist for the WNBA (confirmed empty, omitted).
  const wnbaStats = loadWNBAStats();
  const findTeam = (arr) => arr?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())) || null;
  const oppAdvanced        = findTeam(wnbaStats?.teamAdvanced);
  const oppShootingRaw     = findTeam(wnbaStats?.teamOppShooting);
  const oppFourFact        = findTeam(wnbaStats?.teamFourFactors);
  const oppMiscRaw         = findTeam(wnbaStats?.teamMisc);
  // OPP_PTS / OPP_PTS_PAINT / OPP_PTS_FB / OPP_PTS_2ND_CHANCE are season
  // totals in the raw file, not per-game — normalize before this goes
  // anywhere near the UI (which labels them "/g").
  const oppShooting = normalizePerGame(oppShootingRaw, ['OPP_PTS']);
  const oppMisc      = normalizePerGame(oppMiscRaw, ['OPP_PTS_PAINT', 'OPP_PTS_FB', 'OPP_PTS_2ND_CHANCE', 'OPP_PTS_OFF_TOV']);
  const oppRanks     = getWNBARanksFromFields(oppAdvanced, oppShootingRaw, oppFourFact, oppMiscRaw);
  // The real league has 15 teams (WNBA_ABBR_TO_NAME) but stats.nba.com's
  // team-stats endpoint hasn't onboarded the two newest 2026 expansion
  // franchises yet (Toronto Tempo, Portland Fire — confirmed via a live
  // API call, not just a stale local cache: it genuinely only returns 13
  // teams right now). Use the real league size for the "#X/N" label so a
  // team's rank reflects its actual standing in the league, not just how
  // many teams happen to have data yet.
  const totalTeamsInLeague = Object.keys(WNBA_ABBR_TO_NAME).length || wnbaStats?.teamAdvanced?.length || 13;
  const playerTeamAdvanced = wnbaStats?.teamAdvanced?.find(t => t.TEAM_NAME?.toLowerCase().includes(playerTeamName.toLowerCase())) || null;
  const playerAdvancedStats = wnbaStats?.playerAdvanced ? fuzzyMatchPlayer(wnbaStats.playerAdvanced, player) : null;
  const playerMiscStats     = wnbaStats?.playerMisc     ? fuzzyMatchPlayer(wnbaStats.playerMisc, player)     : null;
  const playerScoringDist   = wnbaStats?.playerScoring  ? fuzzyMatchPlayer(wnbaStats.playerScoring, player)  : null;
  const playerShotDashRow   = wnbaStats?.shotDashGeneral ? fuzzyMatchPlayer(wnbaStats.shotDashGeneral, player) : null;
  const playerShotDash      = playerShotDashRow ? { general: playerShotDashRow } : {};

  // Cache key namespaced with 'wnba:' so it can't collide with the NBA cache
  const cacheKey = `wnba:${player}`;
  const currentInjuryHash = injuryHash(playerRoster);
  const gcSig = gameContext?.total ? `t${gameContext.total}s${gameContext.spread}` : 'noGC';
  const cacheSignature = `${currentInjuryHash}|${gcSig}|${gameContext?.isBackToBack}`;
  let mathProjection = getCachedProjection(cacheKey, propType || 'points', cacheSignature);
  if (!mathProjection) {
    mathProjection = buildProjection(playerStats, {
      oppAdvanced, oppShooting, oppPaintDef: null, oppFourFact,
      playerRoster, playerTeamAdvanced,
      playerPlaytypes: {}, oppDefPlaytypes: {}, // no Synergy source exists for the WNBA
      dataAvailable: wnbaStats?.dataAvailable || {},
      h2hStats, gameContext, nbaPlayerStats: wnbaStats?.playerAdvanced || [],
      league: 'wnba',
    }, propType || 'points');
    if (mathProjection) {
      setCachedProjection(cacheKey, propType || 'points', mathProjection, cacheSignature);
      console.log(`[Proj-W] Calculated: ${player} ${propType} → ${mathProjection.projection}`);
    }
  }

  res.json({
    fetchedAt: new Date().toISOString(),
    date: getToday(),
    league: 'wnba',
    dataAvailable: wnbaStats?.dataAvailable || {},
    mathProjection,
    playerStats, playerRoster,
    playerAdvancedStats, playerMiscStats, playerScoringDist, playerShotDash,
    oppRoster, oppAdvanced, oppShooting, oppFourFact, oppMisc, playerTeamAdvanced,
    oppRanks, totalTeamsInLeague,
    todayGame,
    allTodaysGames: todaysGames.map(g => `${g.away} @ ${g.home}`),
    lineups: null, // no public WNBA lineup source (Tank01/RapidAPI is NBA-only)
    propLines: propLines?.error ? null : propLines,
    h2hStats,
    h2hGamesLog: h2hStats?.games || [],
    gameContext,
  });
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

  if (sameTeam(playerTeamName, opponent)) {
    return res.status(400).json({
      error: `${player} plays for ${playerTeamName} — that's the same team you entered as the opponent. Enter who ${playerTeamName} is actually facing.`
    });
  }

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

  // OPP_PTS is a season total in the raw file, not per-game — same bug
  // confirmed on the WNBA side, normalize before it reaches the UI.
  const oppShooting = normalizePerGame(nbaStats?.teamOppShooting?.find(t =>
    t.TEAM_NAME.toLowerCase().includes(opponent.toLowerCase())) || null, ['OPP_PTS']);

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
    ['post','trackingPost'],
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
  // PTS_PAINT/PTS_FB/PTS_2ND_CHANCE/PTS_OFF_TOV (and their OPP_ counterparts)
  // are season totals in the raw file, not per-game.
  const oppMisc       = normalizePerGame(nbaStats?.teamMisc?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())) || null,
    ['OPP_PTS_PAINT', 'OPP_PTS_FB', 'OPP_PTS_2ND_CHANCE', 'OPP_PTS_OFF_TOV']);
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
  // Include spread/total in cache signature so line moves invalidate projection
  const gcSig = gameContext?.total ? `t${gameContext.total}s${gameContext.spread}` : 'noGC';
  // Also invalidate cache if game context changed (b2b, big spread move)
  const cacheSignature = `${currentInjuryHash}|${gcSig}|${gameContext?.isBackToBack}`;
  let mathProjection = getCachedProjection(player, propType || 'points', cacheSignature);
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
      setCachedProjection(player, propType || 'points', mathProjection, cacheSignature);
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

// ════════════════════════════════════════════════════════════════════
// TOP-3 MOST CONFIDENT PLAYS — scans tonight's live sportsbook player
// lines (points/rebounds/assists) for a league, projects each one, and
// surfaces the 3 biggest real edges (either direction). This is a
// lighter-weight pass than /api/prop-context per candidate — it skips
// the live H2H bridge and live spread/total lookups per player to stay
// fast and within Odds API quota when scanning a whole slate — so
// treat it as a shortlist to investigate further, not a replacement
// for the full single-player analysis.
// ════════════════════════════════════════════════════════════════════
const SLATE_PROP_MARKETS = { points: 'player_points', rebounds: 'player_rebounds', assists: 'player_assists' };
// Locked per calendar day, not a rolling TTL — the top 3 for today should
// stay the same all day rather than shuffling as odds move or the scan reruns.
const topPlaysCache = {}; // league -> { data, dateKey }
const MAX_SLATE_EVENTS           = 6;
const MAX_CANDIDATES_PER_EVENT   = 20; // fair per-game share — see note below
const MAX_SLATE_CANDIDATES       = 150; // generous overall safety ceiling only

async function fetchSlateCandidates(sportKey) {
  const eventsRes = await axios.get(`${ODDS_BASE}/sports/${sportKey}/events`, {
    params: { apiKey: process.env.ODDS_API_KEY }, timeout: 10000
  });
  const events = (eventsRes.data || []).slice(0, MAX_SLATE_EVENTS);

  // Cap PER EVENT, not globally across the concatenated list — events are
  // fetched concurrently, so a global cap applied after the fact effectively
  // just keeps whichever event's odds response happened to arrive first,
  // silently starving every other game out of "today's picks" (a real bug:
  // one fast-responding game could eat the entire candidate budget).
  const perEventResults = await Promise.allSettled(events.map(async (event) => {
    const candidates = [];
    try {
      const oddsRes = await axios.get(`${ODDS_BASE}/sports/${sportKey}/events/${event.id}/odds`, {
        params: {
          apiKey: process.env.ODDS_API_KEY, regions: 'us',
          markets: Object.values(SLATE_PROP_MARKETS).join(','), oddsFormat: 'american'
        },
        timeout: 10000
      });
      const seen = {}; // `${player}|${propType}` → first line found
      for (const bm of (oddsRes.data.bookmakers || [])) {
        for (const mkt of (bm.markets || [])) {
          const propType = Object.entries(SLATE_PROP_MARKETS).find(([, v]) => v === mkt.key)?.[0];
          if (!propType) continue;
          for (const o of (mkt.outcomes || [])) {
            if (o.name !== 'Over' || !o.description) continue;
            const key = `${o.description}|${propType}`;
            if (!seen[key]) seen[key] = { line: o.point, book: bm.title };
          }
        }
      }
      for (const [key, v] of Object.entries(seen)) {
        const [player, propType] = key.split('|');
        candidates.push({ player, propType, line: v.line, book: v.book, homeTeam: event.home_team, awayTeam: event.away_team });
      }
    } catch (_) { /* skip this event, keep scanning the rest */ }
    return candidates.slice(0, MAX_CANDIDATES_PER_EVENT);
  }));
  const candidates = perEventResults.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  return candidates.slice(0, MAX_SLATE_CANDIDATES);
}

function inferOpponent(playerTeam, homeTeam, awayTeam) {
  const p = (playerTeam || '').toLowerCase();
  const homeLower = (homeTeam || '').toLowerCase();
  const awayLower = (awayTeam || '').toLowerCase();
  const last = p.split(' ').pop();
  if (homeLower.includes(last)) return awayTeam;
  if (awayLower.includes(last)) return homeTeam;
  return null;
}

async function evaluateNBACandidate(cand) {
  const playerStats = await fetchPlayerStats(cand.player);
  if (!playerStats || playerStats.error) return null;
  const playerTeam = playerStats.player?.team || '';
  const opponent = inferOpponent(playerTeam, cand.homeTeam, cand.awayTeam);
  if (!opponent) return null;

  const nbaStats = loadNBAStats();
  const findTeam = (arr) => arr?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())) || null;
  const oppAdvanced      = findTeam(nbaStats?.teamAdvanced);
  const oppShooting      = findTeam(nbaStats?.teamOppShooting);
  const oppPaintDef      = findTeam(nbaStats?.teamPaintDef);
  const oppFourFact      = findTeam(nbaStats?.teamFourFactors);
  const playerTeamAdvanced = nbaStats?.teamAdvanced?.find(t => t.TEAM_NAME?.toLowerCase().includes(playerTeam.toLowerCase())) || null;
  const [playerRoster, gameContext] = await Promise.all([
    fetchESPNRoster(playerTeam),
    fetchGameContext(playerTeam, opponent, null),
  ]);

  // H2H is intentionally still skipped here (unlike the WNBA slate scan,
  // which now includes it — that one's nearly free, just filtering an
  // already-fetched gamelog). NBA H2H goes through the nba_api Python
  // bridge, which would mean up to MAX_SLATE_CANDIDATES more serialized
  // bridge calls on top of the one fetchPlayerStats already makes per
  // candidate — real risk of the once-daily scan taking many minutes.
  // So an NBA slate-scan projection can still differ slightly from the
  // full single-player analysis (which does include H2H); WNBA's cannot.
  const projection = buildProjection(playerStats, {
    oppAdvanced, oppShooting, oppPaintDef, oppFourFact,
    playerRoster, playerTeamAdvanced,
    playerPlaytypes: {}, oppDefPlaytypes: {}, // skipped in the slate scan for speed — see note above
    dataAvailable: nbaStats?.dataAvailable || {},
    h2hStats: null, gameContext,
    nbaPlayerStats: nbaStats?.playerAdvanced || nbaStats?.playerStats || [],
  }, cand.propType);
  if (!projection) return null;

  return {
    league: 'nba', player: playerStats.player.name, team: playerTeam, opponent,
    propType: cand.propType, line: cand.line, book: cand.book,
    projection: projection.projection, confidence: projection.confidence,
    edge: calcEdgeScore(projection.projection, cand.line),
    ...calcOverUnderProbability(projection.projection, projection.stdDev, cand.line),
  };
}

async function evaluateWNBACandidate(cand) {
  const playerStats = await fetchWNBAPlayerStats(cand.player);
  if (!playerStats || playerStats.error) return null;
  const playerTeam = playerStats.player?.team || '';
  const opponent = inferOpponent(playerTeam, cand.homeTeam, cand.awayTeam);
  if (!opponent) return null;

  // Same H2H + game-context treatment as the individual analyzer (not a
  // cut-down version) — this scan is day-locked to once per league per day,
  // so the extra calls are cheap and it means a Today-page pick and the
  // full analysis for that same player/prop always agree on the number.
  const [playerRoster, h2hStats, gameContext] = await Promise.all([
    fetchWNBARoster(playerTeam),
    fetchWNBAH2HStats(cand.player, opponent),
    fetchWNBAGameContext(playerTeam, opponent),
  ]);
  const wnbaStats = loadWNBAStats();
  const findTeam = (arr) => arr?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())) || null;
  const oppAdvanced = findTeam(wnbaStats?.teamAdvanced);
  const playerTeamAdvanced = wnbaStats?.teamAdvanced?.find(t => t.TEAM_NAME?.toLowerCase().includes(playerTeam.toLowerCase())) || null;

  const projection = buildProjection(playerStats, {
    oppAdvanced, oppShooting: findTeam(wnbaStats?.teamOppShooting), oppPaintDef: null,
    oppFourFact: findTeam(wnbaStats?.teamFourFactors),
    playerRoster, playerTeamAdvanced,
    playerPlaytypes: {}, oppDefPlaytypes: {},
    dataAvailable: wnbaStats?.dataAvailable || {}, h2hStats, gameContext,
    nbaPlayerStats: wnbaStats?.playerAdvanced || [], league: 'wnba',
  }, cand.propType);
  if (!projection) return null;

  return {
    league: 'wnba', player: playerStats.player.name, team: playerTeam, opponent,
    propType: cand.propType, line: cand.line, book: cand.book,
    projection: projection.projection, confidence: projection.confidence,
    edge: calcEdgeScore(projection.projection, cand.line),
    ...calcOverUnderProbability(projection.projection, projection.stdDev, cand.line),
  };
}

// Shared by /api/top-plays and /api/team-picks — both are just different
// ways of slicing the same slate-wide candidate scan. Memoized per day so
// the two endpoints see the exact same scan instead of each independently
// re-hitting the odds API — otherwise they can disagree if evaluate() (or
// the odds API itself) flakes differently between two separate live calls,
// and each visit doubles real odds-API quota usage for no reason.
const slateScanCache = {}; // league -> { data: {candidates, results}, dateKey }
async function collectSlateResults(league) {
  const today = getToday();
  const cached = slateScanCache[league];
  if (cached && cached.dateKey === today) return cached.data;

  const sportKey = league === 'wnba' ? 'basketball_wnba' : 'basketball_nba';
  const candidates = await fetchSlateCandidates(sportKey);
  const evaluate = league === 'wnba' ? evaluateWNBACandidate : evaluateNBACandidate;

  const results = [];
  for (const cand of candidates) {
    try {
      const r = await evaluate(cand);
      if (r) results.push({ ...r, homeTeam: cand.homeTeam, awayTeam: cand.awayTeam });
    } catch (_) { /* one bad candidate shouldn't sink the whole scan */ }
  }
  const data = { candidates, results };
  slateScanCache[league] = { data, dateKey: today };
  return data;
}

async function computeTopPlays(league) {
  const { candidates, results } = await collectSlateResults(league);

  // Only surface real edges — matches the app's existing "never bet on a
  // PASS-tier signal" rule (see calcEdgeScore/verdict thresholds elsewhere).
  const withEdge = results.filter(r => Math.abs(r.edge) >= 1.0);
  withEdge.sort((a, b) => (b.confidence - a.confidence) || (Math.abs(b.edge) - Math.abs(a.edge)));

  return {
    league, generatedAt: new Date().toISOString(),
    scanned: candidates.length, evaluated: results.length,
    topPlays: withEdge.slice(0, 3).map(r => ({
      player: r.player, team: r.team, opponent: r.opponent,
      propType: r.propType, line: r.line, book: r.book,
      direction: r.edge > 0 ? 'OVER' : 'UNDER',
      projection: r.projection, edge: r.edge, confidence: r.confidence,
      overProbability: r.overProbability ?? null, underProbability: r.underProbability ?? null,
    })),
  };
}

// One top pick per team per game — for the "today's games" landing view,
// as opposed to /api/top-plays' single cross-slate top 3.
async function computeTeamPicks(league) {
  const { results } = await collectSlateResults(league);

  const games = {};
  for (const r of results) {
    if (Math.abs(r.edge) < 1.0) continue; // same "real edge only" rule as top plays
    const gameKey = `${r.awayTeam}@${r.homeTeam}`;
    if (!games[gameKey]) games[gameKey] = { home: r.homeTeam, away: r.awayTeam, byTeam: {} };
    const existing = games[gameKey].byTeam[r.team];
    const better = !existing || r.confidence > existing.confidence ||
      (r.confidence === existing.confidence && Math.abs(r.edge) > Math.abs(existing.edge));
    if (better) games[gameKey].byTeam[r.team] = r;
  }

  return {
    league, generatedAt: new Date().toISOString(),
    games: Object.values(games).map(g => ({
      home: g.home, away: g.away,
      picks: Object.values(g.byTeam).map(r => ({
        team: r.team, player: r.player, opponent: r.opponent,
        propType: r.propType, line: r.line, book: r.book,
        direction: r.edge > 0 ? 'OVER' : 'UNDER',
        projection: r.projection, edge: r.edge, confidence: r.confidence,
        overProbability: r.overProbability ?? null, underProbability: r.underProbability ?? null,
      })),
    })),
  };
}

app.get('/api/top-plays', async (req, res) => {
  const league  = (req.query.league || 'nba').toLowerCase() === 'wnba' ? 'wnba' : 'nba';
  const today   = getToday();
  const cached  = topPlaysCache[league];
  if (cached && cached.dateKey === today) {
    return res.json({ ...cached.data, cached: true });
  }
  if (!process.env.ODDS_API_KEY || process.env.ODDS_API_KEY.includes('your_')) {
    return res.status(500).json({ error: 'No odds key configured' });
  }
  try {
    const data = await computeTopPlays(league);
    topPlaysCache[league] = { data, dateKey: today };
    res.json({ ...data, cached: false });
  } catch (err) {
    console.error(`[TopPlays] ${league} scan failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

const teamPicksCache = {}; // league -> { data, dateKey } — same day-lock as topPlaysCache
app.get('/api/team-picks', async (req, res) => {
  const league = (req.query.league || 'nba').toLowerCase() === 'wnba' ? 'wnba' : 'nba';
  const today  = getToday();
  const cached = teamPicksCache[league];
  if (cached && cached.dateKey === today) {
    return res.json({ ...cached.data, cached: true });
  }
  if (!process.env.ODDS_API_KEY || process.env.ODDS_API_KEY.includes('your_')) {
    return res.status(500).json({ error: 'No odds key configured' });
  }
  try {
    const data = await computeTeamPicks(league);
    teamPicksCache[league] = { data, dateKey: today };
    res.json({ ...data, cached: false });
  } catch (err) {
    console.error(`[TeamPicks] ${league} scan failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
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
      {
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      },
      { headers: { 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 60000 }
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
// Same as above but for wnba_*.json (stats.nba.com, LeagueID=10) — offset
// 15 min later so the two python processes never hit nba.com at once.
cron.schedule('15 7 * * *', () => {
  console.log('[CRON] Auto-running fetch_wnba_stats.py to refresh WNBA data...');
  const py = spawn('python3', ['fetch_wnba_stats.py'], { cwd: __dirname });
  py.stdout.on('data', d => console.log('[fetch_wnba_stats]', d.toString().trim()));
  py.stderr.on('data', d => console.error('[fetch_wnba_stats ERR]', d.toString().trim()));
  py.on('close', code => {
    console.log(`[CRON] fetch_wnba_stats.py finished (exit ${code})`);
    wnbaStatsCache = null;
    lastWnbaStatsDiskRead = 0;
  });
});
cron.schedule('0 0 * * *', () => {                                                      // midnight reset
  playerStatsCache = {};
  projectionCache  = {};   // clear projections for new day
  lineupCache      = null;
  rosterCache      = {};   // clear rosters — trades announced overnight
  lastRosterFetch  = {};
  nbaStatsCache    = null;
  wnbaStatsCache      = null;
  wnbaRosterCache     = {};
  lastWnbaRosterFetch = {};
  wnbaPlayerIndex     = {};
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

// Some nba.com team-stat files store the raw SEASON TOTAL for count stats
// (e.g. OPP_PTS_PAINT: 1590 across 44 games) while the UI displays them
// labeled "/g" — confirmed real bug: Atlanta Dream showed "OPP PTS/g 3378"
// (season total) instead of the real average of ~76.8. Normalize by GP
// right here so what's rendered is an actual average, not a total.
function normalizePerGame(obj, fields) {
  if (!obj || !obj.GP) return obj;
  const out = { ...obj };
  for (const f of fields) {
    if (out[f] != null && isFinite(parseFloat(out[f]))) out[f] = parseFloat((parseFloat(out[f]) / out.GP).toFixed(1));
  }
  return out;
}

// WNBA's team files only have ~13 teams — calcTeamRankings' rankStat()
// requires 15+ to compute a rank, so it always silently returned {} for
// the WNBA (confirmed real bug: ranks showed "—" for every WNBA stat).
// nba_api already computes a real, correctly-scoped rank per stat directly
// in the same file (e.g. DEF_RATING_RANK) — just read that instead of
// trying to recompute a ranking that needs a bigger league to work.
function getWNBARanksFromFields(oppAdvanced, oppShooting, oppFourFact, oppMiscNorm) {
  const r = {};
  if (oppAdvanced) {
    if (oppAdvanced.DEF_RATING_RANK) r.defRating = oppAdvanced.DEF_RATING_RANK;
    if (oppAdvanced.OFF_RATING_RANK) r.offRating = oppAdvanced.OFF_RATING_RANK;
    if (oppAdvanced.PACE_RANK)       r.pace      = oppAdvanced.PACE_RANK;
  }
  if (oppShooting) {
    if (oppShooting.OPP_PTS_RANK)     r.oppPts     = oppShooting.OPP_PTS_RANK;
    if (oppShooting.OPP_FG_PCT_RANK)  r.oppFgPct   = oppShooting.OPP_FG_PCT_RANK;
    if (oppShooting.OPP_FG3_PCT_RANK) r.oppFg3Pct  = oppShooting.OPP_FG3_PCT_RANK;
  }
  if (oppFourFact) {
    if (oppFourFact.OPP_EFG_PCT_RANK) r.oppEfgPct = oppFourFact.OPP_EFG_PCT_RANK;
  }
  if (oppMiscNorm) {
    if (oppMiscNorm.OPP_PTS_PAINT_RANK)      r.oppPtsPaint  = oppMiscNorm.OPP_PTS_PAINT_RANK;
    if (oppMiscNorm.OPP_PTS_FB_RANK)         r.oppPtsFb     = oppMiscNorm.OPP_PTS_FB_RANK;
    if (oppMiscNorm.OPP_PTS_2ND_CHANCE_RANK) r.oppPts2ndCh  = oppMiscNorm.OPP_PTS_2ND_CHANCE_RANK;
  }
  return r;
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
    date:        gameDate || getToday(),
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

