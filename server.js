require('dotenv').config();
// Every "today" in this app is an NBA/WNBA day, which runs on US Eastern time. A host like Railway defaults to UTC, which would
// flip the date at 8 PM Eastern, in the middle of evening games, and shift the daily resets, grading dates and cron times.
// Set APP_TIMEZONE to change it. This runs before anything reads the clock.
process.env.TZ = process.env.APP_TIMEZONE || 'America/New_York';
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const path    = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

// ── STORAGE, CALIBRATION, JOB TRACKING, ALERTS (see lib/) ───────────
// Picks live in SQLite (winai.db). On the first start the old clv_tracker.json is
// imported once and left in place. Set WINAI_DB to a path on a persistent volume if
// the host's disk is wiped on every deploy.
const { createStore } = require('./lib/db');
const calibration = require('./lib/calibration');
const { buildReport } = require('./lib/backtest');
const { createAlerts } = require('./lib/alerts');
const { evaluateHealth, creditBudget, envNum } = require('./lib/health');
const { createAuth, sessionCookie, clearCookie, maskEmail, sha, newToken, parseCookies: parseCookiesHeader } = require('./lib/auth');
const { createMailer } = require('./lib/mailer');
const datachecks = require('./lib/datachecks');
const billingLib = require('./lib/billing');
const rg = require('./lib/rg');
const freshness = require('./lib/freshness');
const offsiteLib = require('./lib/offsite');
const errorsLib = require('./lib/errors');
const totp = require('./lib/totp');
const { createGoogleVerifier } = require('./lib/google');

const CLV_FILE = 'clv_tracker.json';   // legacy file, imported into SQLite on first start
const store = createStore({
  dbPath: process.env.WINAI_DB || path.join(__dirname, 'winai.db'),
  jsonPath: path.join(__dirname, CLV_FILE),
  log: m => console.log(m),
});
const alerts = createAlerts({
  store, webhookUrl: process.env.ADMIN_ALERT_WEBHOOK,
  post: (url, body) => axios.post(url, body, { timeout: 8000 }),
  log: m => console.log(m),
});
const errorLog = errorsLib.createErrorLog({ store, alerts });
// The calibrator turns the model's raw win chance into one that matches graded
// results. It stays null/off until it has proven itself (lib/calibration.js).
let calibrationModel = (store.latestCalibration() || {}).model || null;
const calibrate = p => calibration.apply(calibrationModel, p);

// Last run of every scheduled job, for the admin Health page. A failure is only
// announced when a job goes from working to failing, not on every retry.
const jobRuns = {};
function trackJob(name, fn) {
  return async (...args) => {
    const started = Date.now(), wasOk = jobRuns[name]?.ok !== false;
    try {
      const out = await fn(...args);
      jobRuns[name] = { lastRun: new Date().toISOString(), ok: true, ms: Date.now() - started, detail: typeof out === 'string' ? out : null };
      return out;
    } catch (err) {
      jobRuns[name] = { lastRun: new Date().toISOString(), ok: false, ms: Date.now() - started, error: err.message };
      if (wasOk) alerts.notify({ key: 'job:' + name, level: 'warn', kind: 'job', message: `Job "${name}" failed: ${err.message}` }).catch(() => {});
      throw err;
    }
  };
}

const app = express();
app.disable('x-powered-by');
// Plain query-string parsing: nothing here needs nested ?a[b]=c objects, and it keeps the (currently unpatched) qs parser out of the request path.
app.set('query parser', 'simple');
// Behind a proxy (Railway) every visitor looks like the proxy's address unless this is set, which
// puts them all in ONE rate-limit bucket. Set TRUST_PROXY=1 in the host's variables when deployed.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
// No CORS middleware — the frontend is served same-origin from this same
// Express app (express.static below), so it never needs cross-origin
// permission. Wide-open cors() previously let any third-party site's JS
// call every route here, including the paid-API-backed and state-changing
// ones, from a visitor's browser with no server-side signal it wasn't the
// app's own frontend.
const security = require('./lib/security');
app.use(require('compression')());   // gzip: the main page is 400 KB raw and about 100 KB compressed, which matters on a phone
app.use(security.securityHeaders);
// Any answer of 500 or more is written down, even from a route that handled its own error. The error handler at the
// bottom adds the reason; this catches the rest with just the route.
app.use((req, res, next) => {
  res.on('finish', () => { if ([500, 502, 504].includes(res.statusCode) && !res.locals.errorLogged && req.path !== '/api/client-error') errorLog.record({ source: 'server', route: errorsLib.routeOf(req.method, req.originalUrl), message: `answered ${res.statusCode}` }); });
  next();
});
app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { if (req.originalUrl === '/api/stripe/webhook') req.rawBody = buf; } }));   // Stripe signs the exact bytes
// One bad character in a name used to reach a Python launch call and crash the whole server.
// Reject control characters and oversized values before any route sees them.
app.use('/api', (req, res, next) => {
  // Stripe's webhook bodies are nested deeper than anything the app sends, and are authenticated by their
  // signature instead, so only the query is checked for that one route.
  const problem = security.queryProblem(req.query, 200) || (req.path !== '/stripe/webhook' && req.body && security.bodyProblem(req.body));
  if (problem) return res.status(400).json({ error: `Invalid input: ${problem}` });
  next();
});
// A generous ceiling for the whole API, and a tighter one for routes that spend money or CPU
// (Odds credits, Python processes, outbound calls). Per source address.
const apiLimiter = security.createRateLimiter({ windowMs: 60 * 1000, max: 300 });
const costlyLimiter = security.createRateLimiter({ windowMs: 60 * 1000, max: 80, message: 'Too many lookups. Slow down and try again shortly.' });
const writeLimiter = security.createRateLimiter({ windowMs: 60 * 1000, max: 30, message: 'Too many saves. Slow down and try again shortly.' });
app.use('/api', apiLimiter);
app.use(['/api/prop-context', '/api/wnba/prop-context', '/api/current-line', '/api/shotchart', '/api/player-matchup',
  '/api/wnba/player-matchup', '/api/team-compare', '/api/matchup-targets', '/api/game-odds', '/api/top-plays', '/api/team-picks', '/api/prop-board',
  '/api/debug', '/api/grade-prop'], costlyLimiter);
// Who is signed in, for every API call (set early so the gates on the analysis routes below can use it).
app.use('/api', (req, res, next) => { req.user = store.supportsAccounts ? auth.userFromCookieHeader(req.headers.cookie) : null; next(); });
// When the paywall is on, the analyzer's data routes need a ticket from /api/analysis/start (see BILLING below).
app.use(['/api/prop-context', '/api/wnba/prop-context'], (req, res, next) => analysisGate('ctx')(req, res, next));
app.use(express.static(path.join(__dirname, 'public')));

// Lightweight per-IP rate limiter — no user-account system exists to gate
// costly routes behind, and a client-side shared secret would be visible
// in page source anyway, so this caps blast radius by source IP instead.
// Currently applied only to /api/analyze (see CLAUDE PROXY below), which
// forwards straight to the paid Anthropic key with no other cost control.
function makeRateLimiter(windowMs, max) {
  const hits = new Map(); // ip -> { count, windowStart }
  return (req, res, next) => {
    const now = Date.now();
    const entry = hits.get(req.ip);
    if (!entry || now - entry.windowStart > windowMs) {
      hits.set(req.ip, { count: 1, windowStart: now });
      return next();
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests — slow down and try again shortly.' });
    }
    next();
  };
}
const analyzeRateLimiter = makeRateLimiter(60 * 1000, 20); // 20 req/min/IP — generous for real UI use

// Strictly-increasing numeric ID generator — plain Date.now() collides
// when two saves land in the same millisecond (e.g. a client-side loop
// firing multiple saves back to back), which silently corrupts a later
// update/delete-by-id into hitting whichever entry happens to be first.
// Kept as a Number (not a random string) so it stays a drop-in replacement
// for the existing `parseInt(id)` comparisons in the CLV/notes routes.
let lastGeneratedId = 0;
function nextId() {
  const now = Date.now();
  lastGeneratedId = now > lastGeneratedId ? now : lastGeneratedId + 1;
  return lastGeneratedId;
}

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

// ── ODDS API HEALTH TRACKING ────────────────────────────────────────
// Confident picks, prop lines, and CLV/line-movement all depend entirely
// on the-odds-api.com's quota — repeatedly exhausted this session with
// zero visible signal anywhere in the UI (the "DATA SYNCED" badge just
// always said healthy). Tracked passively off real traffic via an axios
// interceptor rather than a dedicated probe call, since a probe would
// itself burn the same scarce quota it's trying to report on.
// Seeded from the last value saved, so the credit meter and its alerts still work right after a restart.
let oddsApiHealth = (() => {
  const r = store.getMeta('odds_remaining'), n = r == null ? NaN : Number(r);
  return { remaining: isFinite(n) ? n : null, exhausted: isFinite(n) && n <= 0, lastError: null, checkedAt: store.getMeta('odds_checked_at') };
})();
// Real credits spent, by kind of call, since server start — read from the
// API's own x-requests-last header (the true cost of that exact call), so
// "where is the quota going" is measured instead of guessed.
const oddsUsage = { since: new Date().toISOString(), credits: 0, byCall: {} };
axios.interceptors.response.use(
  (response) => {
    if (response.config?.url?.includes('the-odds-api.com')) {
      const last = parseInt(response.headers?.['x-requests-last'], 10);
      if (!isNaN(last)) {
        const u = response.config.url;
        const kind = /\/events$/.test(u) ? 'events list'
          : /\/events\/[^/]+\/odds/.test(u) ? `event odds [${response.config.params?.markets}]` : 'other';
        const b = oddsUsage.byCall[kind] || (oddsUsage.byCall[kind] = { calls: 0, credits: 0 });
        b.calls++; b.credits += last; oddsUsage.credits += last;
      }
      const remaining = response.headers?.['x-requests-remaining'];
      if (remaining != null) {
        const n = parseInt(remaining, 10);
        oddsApiHealth = { remaining: n, exhausted: n <= 0, lastError: null, checkedAt: new Date().toISOString() };
        try { store.setMeta('odds_remaining', n); store.setMeta('odds_checked_at', oddsApiHealth.checkedAt); } catch (_) {}
      }
    }
    return response;
  },
  (error) => {
    if (error.config?.url?.includes('the-odds-api.com')) {
      oddsApiHealth = { ...oddsApiHealth, lastError: error.response?.data?.message || error.message, checkedAt: new Date().toISOString() };
    }
    return Promise.reject(error);
  }
);

// ── SHARED, CACHED ODDS FETCHES ─────────────────────────────────────
// Odds API cost: the events list is free; an event-odds call costs one credit
// per market per region. The expensive mistake was re-downloading the SAME
// game's odds over and over — e.g. the slate scan fetched game totals/spread
// once per PICK (2 credits each), so 14 picks in one game paid 28 credits for
// one set of numbers. Everything below dedupes by game (and shares in-flight
// requests), with a TTL short enough that lines stay fresh.
const oddsEventsCache = {};   // sportKey -> { data, ts }
const eventOddsCache  = {};   // sportKey|eventId|markets -> { promise, ts }
const ODDS_EVENTS_TTL = 5 * 60 * 1000;
const GAME_CONTEXT_ODDS_TTL = 20 * 60 * 1000;
async function getOddsEvents(sportKey) {
  const c = oddsEventsCache[sportKey];
  if (c && Date.now() - c.ts < ODDS_EVENTS_TTL) return c.data;
  const res = await axios.get(`${ODDS_BASE}/sports/${sportKey}/events`, { params: { apiKey: process.env.ODDS_API_KEY }, timeout: 8000 });
  oddsEventsCache[sportKey] = { data: res.data || [], ts: Date.now() };
  return oddsEventsCache[sportKey].data;
}
function getEventOdds(sportKey, eventId, markets, ttlMs) {
  const key = `${sportKey}|${eventId}|${markets}`;
  const c = eventOddsCache[key];
  if (c && Date.now() - c.ts < ttlMs) return c.promise;
  const promise = axios.get(`${ODDS_BASE}/sports/${sportKey}/events/${eventId}/odds`, {
    params: { apiKey: process.env.ODDS_API_KEY, regions: 'us', markets, oddsFormat: 'american' }, timeout: 8000,
  }).then(r => r.data.bookmakers || []);
  eventOddsCache[key] = { promise, ts: Date.now() };
  promise.catch(() => { delete eventOddsCache[key]; }); // never cache a failure
  return promise;
}
// Finds the one game between two teams by last word ("Sparks", "76ers").
// Words under 3 letters never match ("la" is inside "atlanta dream").
function findEventForTeams(events, teamA, teamB) {
  const last = (t) => (t || '').toLowerCase().trim().split(' ').pop();
  const has = (ev, t) => { const w = last(t); return w.length >= 3 && ((ev.home_team || '').toLowerCase().endsWith(w) || (ev.away_team || '').toLowerCase().endsWith(w)); };
  return (events || []).find(ev => has(ev, teamA) && (!teamB || has(ev, teamB))) || null;
}

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
// Reverse of ESPN_TEAM_MAP (abbr -> canonical full name) — derived, not
// hand-duplicated, by keeping the longest alias mapped to each
// abbreviation (the full team name is always the longest key), then
// title-cased since ESPN_TEAM_MAP's keys are all lowercase (verified
// against all 30 teams — this naive title-case produces the correct
// display name for every one of them, including "76ers").
const ESPN_ABBR_TO_FULLNAME = {};
for (const [name, abbr] of Object.entries(ESPN_TEAM_MAP)) {
  if (!ESPN_ABBR_TO_FULLNAME[abbr] || name.length > ESPN_ABBR_TO_FULLNAME[abbr].length) {
    ESPN_ABBR_TO_FULLNAME[abbr] = name.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1));
  }
}
function resolveNBAFullName(teamName) {
  return ESPN_ABBR_TO_FULLNAME[resolveESPNTeam(teamName || '')] || teamName;
}

// ── NBA PLAYER INDEX — name -> {id, team, position} built from all 30
// rosters via ESPN. fetchPlayerStats' nba_api bridge path doesn't return a
// team name at all, and previously relied solely on a BallDontLie lookup
// to fill it in — a single point of failure with no fallback, and BDL has
// been persistently rate-limited this session, silently leaving
// player.team as the literal string "Unknown" (which in turn defeats the
// same-team input-validation guard, since there's nothing real to compare
// against). ESPN rosters need no API key and have been reliable all
// session, so this gives fetchPlayerStats a real fallback instead of one
// fragile dependency. Parallelized (unlike the WNBA version's sequential
// loop) since 30 teams sequentially would be noticeably slower than
// WNBA's 15. ──────────────────────────────────────────────────────
let nbaPlayerIndex     = {};
let lastNbaIndexBuild  = 0;
const NBA_INDEX_TTL    = 3 * 60 * 60 * 1000; // 3h

async function buildNBAPlayerIndex() {
  const now = Date.now();
  if (Object.keys(nbaPlayerIndex).length && (now - lastNbaIndexBuild) < NBA_INDEX_TTL) {
    return nbaPlayerIndex;
  }
  const abbrs = [...new Set(Object.values(ESPN_TEAM_MAP))];
  const index = {};
  await Promise.all(abbrs.map(async (abbr) => {
    try {
      const res = await axios.get(`${ESPN_BASE}/teams/${abbr}/roster`, { timeout: 8000 });
      const raw = res.data?.athletes || [];
      const isGrouped = raw.length > 0 && Array.isArray(raw[0]?.items);
      const playerList = isGrouped ? raw.flatMap(g => g.items || []) : raw.filter(p => p.fullName);
      for (const p of playerList) {
        if (!p.fullName || !p.id) continue;
        index[p.fullName.toLowerCase()] = {
          id: p.id, name: p.fullName, teamAbbr: abbr,
          team: ESPN_ABBR_TO_FULLNAME[abbr] || abbr,
          position: p.position?.abbreviation || 'N/A',
        };
      }
    } catch (_) { /* skip this team, index still usable with the rest */ }
  }));
  if (Object.keys(index).length) {
    nbaPlayerIndex    = index;
    lastNbaIndexBuild = now;
    console.log(`[ESPN] NBA player index built: ${Object.keys(index).length} players across ${abbrs.length} teams`);
  }
  return nbaPlayerIndex;
}

async function resolveNBAPlayer(playerName) {
  await buildNBAPlayerIndex();
  const lower = playerName.toLowerCase().trim();
  if (nbaPlayerIndex[lower]) return nbaPlayerIndex[lower];
  // Every query token must appear as a whole token in the candidate's
  // name — not a bare substring, which could match an unrelated player
  // sharing a name fragment instead of an honest "not found".
  const queryTokens = new Set(lower.split(' ').filter(Boolean));
  const match = Object.values(nbaPlayerIndex).find(p => {
    const nameTokens = new Set(p.name.toLowerCase().split(' '));
    return [...queryTokens].every(t => nameTokens.has(t));
  });
  return match || null;
}

// Full-name match for sportsbook outcome descriptions — last-name-only
// matching produces real collisions on current rosters (e.g. OKC carries
// both Jalen Williams and Jaylin Williams; a last-name search for either
// one pulls both players' odds into the same result).
function matchesOutcomeName(description, playerName) {
  const descLower = (description || '').toLowerCase();
  const nameLower = playerName.toLowerCase();
  if (!descLower || !nameLower) return false;
  if (descLower === nameLower) return true;
  const parts = nameLower.split(' ').filter(Boolean);
  const first = parts[0], last = parts[parts.length - 1];
  return descLower.includes(first) && descLower.includes(last);
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

// Headshot id for a pick, from the stats files. Exact full-name match only —
// fuzzyMatchPlayer falls back to last-name-only, which would put the wrong
// person's face next to a pick; a miss just shows initials instead.
const playerIdCache = {};
function lookupPlayerId(league, name) {
  const key = league + '|' + name;
  if (key in playerIdCache) return playerIdCache[key];
  let id = null;
  try {
    const st = league === 'wnba' ? loadWNBAStats() : loadNBAStats();
    const lower = String(name || '').toLowerCase();
    const row = (st?.playerAdvanced || []).find(p => (p.PLAYER_NAME || '').toLowerCase() === lower);
    id = row?.PLAYER_ID ?? null;
  } catch (_) {}
  playerIdCache[key] = id;
  return id;
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
    teamDefPutbacks:    load('playtype_putbacks_team_def.json'),
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

// ═══════════════════════════════════════════════════════════════════
// POSITION-CATEGORY DEFENSE — "how many points/rebounds/assists/threes
// does this team allow to Guards/Wings/Bigs" — NOT a stat stats.nba.com's
// API exposes directly (its position-defense endpoint only covers FG%,
// see getTeamPositionDefense above). Built instead from real box scores:
// for a team's recent completed games, pull the opponent's box score,
// tag every opposing player who appeared by their position that game,
// and sum what each position group actually did against this defense.
// Works for both leagues (ESPN's boxscore format is shared), unlike the
// FG%-only version above which is NBA-tracking-only.
// ═══════════════════════════════════════════════════════════════════
const NBA_TEAM_NAMES = [
  'Atlanta Hawks','Boston Celtics','Brooklyn Nets','Charlotte Hornets','Chicago Bulls',
  'Cleveland Cavaliers','Dallas Mavericks','Denver Nuggets','Detroit Pistons','Golden State Warriors',
  'Houston Rockets','Indiana Pacers','LA Clippers','Los Angeles Lakers','Memphis Grizzlies',
  'Miami Heat','Milwaukee Bucks','Minnesota Timberwolves','New Orleans Pelicans','New York Knicks',
  'Oklahoma City Thunder','Orlando Magic','Philadelphia 76ers','Phoenix Suns','Portland Trail Blazers',
  'Sacramento Kings','San Antonio Spurs','Toronto Raptors','Utah Jazz','Washington Wizards',
];
function positionGroupOf(abbr) {
  for (const [label, list] of Object.entries(POSITION_GROUPS)) if (list.includes(abbr)) return label;
  return null;
}

const posCategoryCache = {}; // `${league}:${abbr}` -> { data, ts }
const POS_CATEGORY_TTL = 12 * 60 * 60 * 1000; // 12h — box scores for finished games never change

async function computeTeamPositionCategoryDefense(league, teamName, numGames = 10) {
  const abbr = league === 'wnba' ? resolveWNBATeam(teamName) : resolveESPNTeam(teamName);
  if (!abbr) return null;
  const cacheKey = `${league}:${abbr}:${numGames}`;
  const cached = posCategoryCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < POS_CATEGORY_TTL) return cached.data;

  const { finals } = await fetchTeamSeasonFinals(league, teamName);
  const recent = finals.slice(-numGames);
  if (!recent.length) return null;

  const base = league === 'wnba' ? ESPN_BASE_WNBA : ESPN_BASE;
  const totals = { Guards: { pts:0, reb:0, ast:0, fg3m:0 }, Wings: { pts:0, reb:0, ast:0, fg3m:0 }, Bigs: { pts:0, reb:0, ast:0, fg3m:0 } };
  let gamesUsed = 0;

  const boxscores = await Promise.allSettled(recent.map(e =>
    axios.get(`${base}/summary`, { params: { event: e.id }, timeout: 8000 })
  ));

  for (const result of boxscores) {
    if (result.status !== 'fulfilled') continue;
    const players = result.value.data?.boxscore?.players || [];
    // The OPPONENT's block — whichever team in this boxscore is NOT us —
    // is what this defense actually allowed that game.
    const oppBlock = players.find(p => (p.team?.abbreviation || '').toLowerCase() !== abbr);
    const stats = oppBlock?.statistics?.[0];
    const athletes = stats?.athletes;
    if (!athletes) continue;
    const labels = stats.labels || [];
    const idx = { pts: labels.indexOf('PTS'), reb: labels.indexOf('REB'), ast: labels.indexOf('AST'), fg3: labels.indexOf('3PT') };
    if (idx.pts < 0) continue; // unexpected boxscore shape — skip rather than credit garbage numbers

    let gameHadData = false;
    for (const a of athletes) {
      const posAbbr = a.athlete?.position?.abbreviation;
      const group = positionGroupOf(posAbbr);
      if (!group || !a.stats) continue;
      const pts = parseFloat(a.stats[idx.pts]) || 0;
      const reb = idx.reb >= 0 ? parseFloat(a.stats[idx.reb]) || 0 : 0;
      const ast = idx.ast >= 0 ? parseFloat(a.stats[idx.ast]) || 0 : 0;
      const fg3m = idx.fg3 >= 0 ? parseInt((a.stats[idx.fg3] || '0-0').split('-')[0], 10) || 0 : 0;
      totals[group].pts += pts; totals[group].reb += reb; totals[group].ast += ast; totals[group].fg3m += fg3m;
      gameHadData = true;
    }
    if (gameHadData) gamesUsed++;
  }
  if (!gamesUsed) return null;

  const data = {
    gamesAnalyzed: gamesUsed,
    byPosition: Object.fromEntries(Object.entries(totals).map(([group, t]) => [group, {
      pts:  parseFloat((t.pts  / gamesUsed).toFixed(1)),
      reb:  parseFloat((t.reb  / gamesUsed).toFixed(1)),
      ast:  parseFloat((t.ast  / gamesUsed).toFixed(1)),
      fg3m: parseFloat((t.fg3m / gamesUsed).toFixed(1)),
    }])),
  };
  posCategoryCache[cacheKey] = { data, ts: Date.now() };
  return data;
}

// League-wide pass so a single team's numbers can be shown with a real
// rank (#4/15, etc.), not just in isolation. Expensive on a cold cache
// (up to ~30 teams × several box-score fetches each) — cached a full day
// so this heavy pass only actually runs once per league per day; any
// team already warmed by an individual matchup lookup that same day is
// reused instead of re-fetched via the per-team cache above.
const leaguePosCategoryCache = {}; // league -> { data, dateKey }
async function computeLeaguePositionCategoryRanks(league) {
  const today = getToday();
  const cached = leaguePosCategoryCache[league];
  if (cached && cached.dateKey === today) return cached.data;

  const teamNames = league === 'wnba' ? Object.values(WNBA_ABBR_TO_NAME) : NBA_TEAM_NAMES;
  // Fewer games for the full-league sweep than a single-matchup lookup —
  // keeps a cold-cache pass from taking minutes; still ~2 weeks of games.
  const perTeam = await Promise.all(teamNames.map(name => computeTeamPositionCategoryDefense(league, name, 6).catch(() => null)));

  const byTeam = {};
  teamNames.forEach((name, i) => { if (perTeam[i]) byTeam[name] = perTeam[i]; });

  const ranks = {}; // team -> { Guards: {pts: {value, rank, of}, ...}, ... }
  const groups = ['Guards', 'Wings', 'Bigs'], cats = ['pts', 'reb', 'ast', 'fg3m'];
  const teamsWithData = Object.keys(byTeam);
  for (const group of groups) {
    for (const cat of cats) {
      // Fewer allowed = better defense = rank #1, same convention as the
      // rest of the app's "#1 = best defense" stat-table labeling.
      const sorted = [...teamsWithData].sort((a, b) => byTeam[a].byPosition[group][cat] - byTeam[b].byPosition[group][cat]);
      sorted.forEach((name, i) => {
        ranks[name] = ranks[name] || {};
        ranks[name][group] = ranks[name][group] || {};
        ranks[name][group][cat] = { value: byTeam[name].byPosition[group][cat], rank: i + 1, of: sorted.length };
      });
    }
  }

  const data = { league, teams: ranks, generatedAt: new Date().toISOString() };
  leaguePosCategoryCache[league] = { data, dateKey: today };
  return data;
}

app.get('/api/position-category-defense', async (req, res) => {
  const league = req.query.league === 'wnba' ? 'wnba' : 'nba';
  const team = req.query.team;
  if (!team) return res.status(400).json({ error: 'team required' });
  try {
    const [own, leagueRanks] = await Promise.all([
      computeTeamPositionCategoryDefense(league, team, 10),
      computeLeaguePositionCategoryRanks(league),
    ]);
    if (!own) return res.json({ available: false });
    const rankInfo = leagueRanks.teams[team] || null;
    res.json({ available: true, team, gamesAnalyzed: own.gamesAnalyzed, byPosition: own.byPosition, ranks: rankInfo, leagueSize: Object.keys(leagueRanks.teams).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// Standalone (not a closure) so getTeamGameMargins below can reuse the
// exact same real score/opponent extraction instead of duplicating it.
function mapTeamScheduleGame(e, abbr) {
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
}

async function fetchTeamRecentGames(league, teamName, oppName) {
  const { abbr, finals } = await fetchTeamSeasonFinals(league, teamName);
  if (!abbr) return { last5: [], h2h: [] };

  const mapGame = (e) => mapTeamScheduleGame(e, abbr);
  const last5 = finals.slice(-5).map(mapGame);
  let h2h = [];
  if (oppName) {
    const oppAbbr = league === 'wnba' ? resolveWNBATeam(oppName) : resolveESPNTeam(oppName);
    h2h = finals.filter(e => e.competitions[0].competitors.some(x => (x.team.abbreviation || '').toLowerCase() === oppAbbr))
                .map(mapGame);
  }
  return { last5, h2h };
}

// Real per-game margins for a team's finished games — lets a player's
// game log be tagged with confirmed blowouts (see tagBlowoutGames) instead
// of only inferring "unusual" from the stat line itself, which can miss a
// run of real blowouts (the reference point itself gets skewed) or
// misfire on a player whose minutes are just naturally volatile.
async function getTeamGameMargins(league, teamName) {
  const { abbr, finals } = await fetchTeamSeasonFinals(league, teamName);
  if (!abbr) return [];
  return finals.map(e => mapTeamScheduleGame(e, abbr));
}

const BLOWOUT_MARGIN = 20; // standard blowout threshold

// nba_api's MATCHUP field (stored directly as the `opponent` field on NBA
// game logs via the bridge — see last5Games/last10Games/gameLog20 above)
// is "TEAM vs. OPP" / "TEAM @ OPP" in nba_api's own tricodes, e.g. "PHX
// vs. PHI" — NOT a full team name, and NOT the same abbreviation scheme as
// ESPN_TEAM_MAP above (nba_api uses GSW/NOP/NYK/SAS/UTA/WAS where ESPN
// uses gs/no/ny/sa/utah/wsh). Confirmed live: without resolving this,
// tagBlowoutGames' substring match against ESPN's full display names
// never matched a single NBA game, silently no-op'ing blowout detection
// for the whole league. WNBA's opponent field is already a full ESPN
// display name and doesn't need this.
const NBA_API_ABBR_TO_NAME = {
  atl:'Atlanta Hawks', bos:'Boston Celtics', bkn:'Brooklyn Nets', cha:'Charlotte Hornets',
  chi:'Chicago Bulls', cle:'Cleveland Cavaliers', dal:'Dallas Mavericks', den:'Denver Nuggets',
  det:'Detroit Pistons', gsw:'Golden State Warriors', hou:'Houston Rockets', ind:'Indiana Pacers',
  lac:'LA Clippers', lal:'Los Angeles Lakers', mem:'Memphis Grizzlies', mia:'Miami Heat',
  mil:'Milwaukee Bucks', min:'Minnesota Timberwolves', nop:'New Orleans Pelicans', nyk:'New York Knicks',
  okc:'Oklahoma City Thunder', orl:'Orlando Magic', phi:'Philadelphia 76ers', phx:'Phoenix Suns',
  por:'Portland Trail Blazers', sac:'Sacramento Kings', sas:'San Antonio Spurs', tor:'Toronto Raptors',
  uta:'Utah Jazz', was:'Washington Wizards',
};

// Tags each of a player's recent games with `_blowout`/`_margin` when it
// can be confidently matched to a real final score. Matches by opponent
// name (reliable, present on both sides) with nearest-date only as a
// tiebreaker for a team met more than once in the window — deliberately
// NOT matching on date strings directly: confirmed live that the team
// schedule's dates are UTC event timestamps while a player's game-log
// dates are plain local game-days, and naive truncation can land a late
// game on the wrong calendar day.
function tagBlowoutGames(playerGames, teamMargins) {
  if (!teamMargins?.length || !playerGames?.length) return playerGames;
  return playerGames.map(g => {
    const oppRaw = (g.opponent || '').trim();
    if (!oppRaw) return g;
    // nba_api MATCHUP format — resolve the trailing tricode to a full team
    // name before matching. Anything else (full display names, as ESPN
    // sources already provide) falls through to the plain substring match.
    const abbrMatch = oppRaw.match(/(?:vs\.?|@)\s*([A-Za-z]{2,4})$/i);
    const resolvedName = abbrMatch ? NBA_API_ABBR_TO_NAME[abbrMatch[1].toLowerCase()] : null;
    const oppLower = (resolvedName || oppRaw).toLowerCase();
    const candidates = teamMargins.filter(t => {
      const tOpp = (t.opponent || '').toLowerCase();
      return tOpp && (tOpp.includes(oppLower) || oppLower.includes(tOpp));
    });
    if (!candidates.length) return g;
    let match = candidates[0];
    if (candidates.length > 1 && g.date) {
      const target = new Date(g.date + 'T12:00:00Z').getTime();
      let bestDiff = Infinity;
      for (const c of candidates) {
        const diff = Math.abs(new Date(c.date).getTime() - target);
        if (diff < bestDiff) { bestDiff = diff; match = c; }
      }
    }
    const margin = Math.abs(match.ownScore - match.oppScore);
    return margin >= BLOWOUT_MARGIN ? { ...g, _blowout: true, _margin: margin } : g;
  });
}

// Shallow-copies playerStats with last5Games/last10Games blowout-tagged —
// NOT a mutation, since fetchPlayerStats/fetchWNBAPlayerStats results are
// cached and shared across requests; mutating in place would leak one
// request's tagging into every other request that hits the same cache
// entry. Only these two arrays need tagging: they're what
// projectMinutes/calcUsageInflation/winsorizeGames actually read.
function withBlowoutTags(playerStats, teamMargins) {
  if (!playerStats || !teamMargins?.length) return playerStats;
  return {
    ...playerStats,
    last5Games: tagBlowoutGames(playerStats.last5Games, teamMargins),
    last10Games: tagBlowoutGames(playerStats.last10Games, teamMargins),
  };
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
// ESPN's scoreboard rejects multi-day ranges ("dates=A-B" answers 400), so the
// look-ahead asks for one day at a time. Cached briefly: a matchup view asks
// for up to 15 days and several people can open the same game.
const espnScoreboardCache = {};
async function getEspnScoreboard(base, ymd) {
  const key = base + '|' + ymd;
  const hit = espnScoreboardCache[key];
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.data;
  const res = await axios.get(`${base}/scoreboard`, { params: { dates: ymd }, timeout: 8000 });
  const events = res.data?.events || [];
  espnScoreboardCache[key] = { data: events, ts: Date.now() };
  return events;
}

async function fetchGameOdds(league, team1Name, team2Name) {
  const abbr1 = league === 'wnba' ? resolveWNBATeam(team1Name) : resolveESPNTeam(team1Name);
  const abbr2 = league === 'wnba' ? resolveWNBATeam(team2Name) : resolveESPNTeam(team2Name);
  if (!abbr1 || !abbr2) return { available: false };

  const base = league === 'wnba' ? ESPN_BASE_WNBA : ESPN_BASE;
  const days = [];
  for (let i = 0; i <= 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    days.push(toLocalDateStr(d).replace(/-/g, ''));
  }

  try {
    const perDay = await Promise.all(days.map(d => getEspnScoreboard(base, d).catch(() => [])));
    const matches = perDay.flat().filter(e => {
      const abbrs = (e.competitions?.[0]?.competitors || []).map(c => (c.team?.abbreviation || '').toLowerCase());
      return abbrs.includes(abbr1) && abbrs.includes(abbr2);
    });
    if (!matches.length) return { available: false };

    // Earliest meeting that has a line; a finished game carries none.
    const match = matches.find(e => e.competitions?.[0]?.odds?.[0]) || matches[0];
    const comp = match.competitions[0];
    const odds = comp.odds?.[0];
    if (!odds) return { available: false, gameDate: match.date };

    const home = comp.competitors.find(c => c.homeAway === 'home');
    const away = comp.competitors.find(c => c.homeAway === 'away');
    const at = (obj, side, when) => obj?.[side]?.[when] ?? null;
    const ou = (when, side) => odds.total?.[side]?.[when]?.odds ?? null;
    return {
      available: true,
      gameDate: match.date,
      provider: odds.provider?.displayName || null,
      home: { name: home?.team?.displayName, abbr: home?.team?.abbreviation },
      away: { name: away?.team?.displayName, abbr: away?.team?.abbreviation },
      spread: {
        home: at(odds.pointSpread, 'home', 'close')?.line ?? null,
        away: at(odds.pointSpread, 'away', 'close')?.line ?? null,
        homeOdds: at(odds.pointSpread, 'home', 'close')?.odds ?? null,
        awayOdds: at(odds.pointSpread, 'away', 'close')?.odds ?? null,
      },
      moneyline: {
        home: at(odds.moneyline, 'home', 'close')?.odds ?? null,
        away: at(odds.moneyline, 'away', 'close')?.odds ?? null,
      },
      total: odds.overUnder ?? null,
      totalOdds: { over: ou('close', 'over'), under: ou('close', 'under') },
      // Opening numbers, so the page can say whether the line has moved.
      open: {
        spreadHome: at(odds.pointSpread, 'home', 'open')?.line ?? null,
        moneylineHome: at(odds.moneyline, 'home', 'open')?.odds ?? null,
        moneylineAway: at(odds.moneyline, 'away', 'open')?.odds ?? null,
        total: (odds.total?.over?.open?.line || '').replace(/^[ou]/i, '') || null,
      },
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

    // Team/position: ESPN first, BDL only fills in id/height. ESPN's live
    // roster index is checked against BDL FIRST here on purpose — BDL was
    // originally the sole source for this, but two separate real problems
    // were confirmed live: (1) BDL has been persistently rate-limited this
    // session, and (2) even when it responds, its own underlying team data
    // can be stale/wrong — confirmed directly, BDL's database currently
    // returns "LeBron James -> Philadelphia 76ers", which is simply
    // incorrect. A silently wrong team is worse than an honest "Unknown":
    // it defeats the same-team input-validation guard downstream (nothing
    // real to compare the typed opponent against) without even the
    // visible symptom that would prompt someone to notice. ESPN needs no
    // key and has been reliable all session, so it's authoritative for
    // team/position now; BDL is kept only for id/height, which ESPN's
    // roster payload doesn't carry.
    try {
      const espnMatch = await resolveNBAPlayer(playerName);
      if (espnMatch) {
        result.player.id       = espnMatch.id;
        result.player.team     = espnMatch.team;
        result.player.position = espnMatch.position !== 'N/A' ? espnMatch.position : result.player.position;
      }
    } catch (_) { /* ESPN index unavailable — BDL below still gets a shot */ }

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
      // returns zero results, but "LeBron" alone finds him).
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
        })), corrected);
        // Only trust an actual name match, not "whichever came back
        // first" — the last-name-only search above can return many
        // unrelated players sharing that surname.
        if (p) {
          result.player.id = p.id;
          // team/position already came from ESPN above where available;
          // only use BDL's if ESPN's index missed this player entirely.
          if (result.player.team === 'Unknown')     result.player.team     = p.team?.full_name || 'Unknown';
          if (result.player.position === 'Unknown') result.player.position = p.position || 'Unknown';
          // BDL's current API returns a single combined "height" string
          // (e.g. "6-9"), not separate height_feet/height_inches fields —
          // the old code was written against a schema BDL no longer uses.
          result.player.height = p.height ? p.height.replace('-', "' ") + '"' : '?';
        }
      }
    } catch (_) { /* BDL supplement optional */ }

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
  if (security.badString(playerName) || security.badString(opponent) || security.badString(season)) return { error: 'Invalid name' };
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

async function fetchPropLines(playerName, propType, opts = {}) {
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
    const events = await getOddsEvents('basketball_nba');

    const lines = {};

    // When the opponent is known, fetch ONLY that game (1 credit). The old
    // behavior — odds for the first 5 listed games — cost 5 credits per
    // analysis and mostly downloaded other teams' players. Falls back to it
    // only when the game can't be identified.
    const target = opts.opponent ? findEventForTeams(events, opts.opponent, opts.playerTeam) : null;
    const eventSlice = target ? [target] : events.slice(0, 5);
    await Promise.allSettled(eventSlice.map(async event => {
      try {
        const bookmakers = await getEventOdds('basketball_nba', event.id, market, PROP_LINES_TTL);
        for (const bm of bookmakers) {
          for (const mkt of (bm.markets || [])) {
            for (const o of (mkt.outcomes || [])) {
              if (matchesOutcomeName(o.description, playerName)) {
                if (!lines[bm.title]) lines[bm.title] = {};
                lines[bm.title][o.name] = { point: o.point, price: o.price };
              }
            }
          }
        }
      } catch (_) {}
    }));

    const result = { lines, market, ...consensusFromLines(lines) };
    propLinesCache[cacheKey] = { data: result, ts: Date.now() };
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

// Shared by the NBA and WNBA versions of fetchPropLines — softest (lowest)
// Over line/book for display, PLUS the median line across every book
// (consensus, closer to "what the real market thinks" than any one book)
// and the softest book's actual prices, so real EV/Kelly can be computed
// against them instead of just the point spread from the projection.
function consensusFromLines(lines) {
  let softestLine = null, softestBook = null;
  for (const [book, data] of Object.entries(lines)) {
    const ol = data['Over']?.point;
    if (ol != null && (softestLine == null || ol < softestLine)) { softestLine = ol; softestBook = book; }
  }
  const overPoints = Object.values(lines).map(d => d['Over']?.point).filter(p => p != null).sort((a, b) => a - b);
  let consensusLine = null;
  if (overPoints.length) {
    const mid = Math.floor(overPoints.length / 2);
    consensusLine = parseFloat((overPoints.length % 2 ? overPoints[mid] : (overPoints[mid - 1] + overPoints[mid]) / 2).toFixed(1));
  }
  const softest = (softestBook && lines[softestBook]) || {};
  return {
    softestLine, softestBook, consensusLine, bookCount: overPoints.length,
    overPrice: softest['Over']?.price ?? null, underPrice: softest['Under']?.price ?? null,
  };
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

// Caps each game's value to within a band around the player's own recent
// median before it gets averaged in. Real case this fixes: a normally
// ~8min/game bench player gets 25 garbage-time minutes in one blowout —
// averaged raw, that one game swings both the minutes baseline and the
// short-term trend signal hard, projecting a role change that isn't real.
// Capped relative to the player's OWN median (not a league-wide number)
// so it works the same way for a deep bench piece and a 35min starter —
// still counts as "elevated," just can't single-handedly dominate a
// small sample. Symmetric, so it equally guards against the inverse (a
// normal starter pulled early in a blowout dragging the average down).
function winsorizeGames(games, key) {
  if ((games || []).length < 3) return (games || []).map(g => parseFloat(g[key]) || 0); // too few games to tell an outlier from real signal
  const rows = games.map(g => ({ v: parseFloat(g[key]) || 0, blowout: !!g._blowout }));
  // Median computed from confirmed-non-blowout games when there are
  // enough of them, so a run of real blowouts doesn't drag the reference
  // point itself off — falls back to using everyone if too few clean
  // games remain to get a meaningful median from.
  const cleanVals = rows.filter(r => !r.blowout).map(r => r.v);
  const medianSource = cleanVals.length >= 3 ? cleanVals : rows.map(r => r.v);
  const sorted = [...medianSource].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const cushion = Math.max(median * 0.5, 3); // floor so a low-minutes player isn't frozen at their median
  const lo = Math.max(0, median - cushion), hi = median + cushion;
  // A CONFIRMED blowout (real final margin, not just a value that looks
  // unusual) gets clipped straight to the median instead of the softer
  // cushion — we know for certain that game's context was atypical,
  // not guessing from the stat line alone.
  return rows.map(r => r.blowout ? median : Math.max(lo, Math.min(hi, r.v)));
}

// Props where pace has minimal effect — skip adjustment
const PACE_NEUTRAL = ['3pm', 'steals', 'blocks'];
// Shared by calcPaceAdj (general path) and the opportunity/efficiency
// decomposition (buildProjection's canDecomposePoints branch), which used
// to duplicate this exact formula inline — any future tuning here now
// reaches both instead of silently desyncing them.
function getPaceMultiplier(oppPace, playerTeamPace, propType, league = 'nba') {
  if (PACE_NEUTRAL.includes(propType)) return 1;
  const leagueAvgPace = getLeagueBaselines(league).pace;
  // Use blended pace (avg of both teams) vs league average
  const opp = parseFloat(oppPace) || leagueAvgPace;
  const own = parseFloat(playerTeamPace) || leagueAvgPace;
  const blended = (opp + own) / 2;
  // Linear multiplier capped at ±8% — more accurate than sqrt dampening
  const raw = (blended - leagueAvgPace) / leagueAvgPace;
  return 1 + Math.max(-0.08, Math.min(0.08, raw));
}
function calcPaceAdj(proj, oppPace, playerTeamPace, propType, league = 'nba') {
  if (!proj) return proj;
  return proj * getPaceMultiplier(oppPace, playerTeamPace, propType, league);
}

function calcDvPCoeff(oppDefRating, playerPosition, playerPlaytypes, oppDefPlaytypes, propType, league = 'nba') {
  // Base: team-level defensive rating (always available)
  let base = 1.0;
  if (oppDefRating) {
    const leagueAvg = getLeagueBaselines(league).defRating;
    // DEF_RATING is points allowed per 100 possessions — lower is a better
    // defense (see the "lower=better defense" rank convention elsewhere in
    // this file). A tougher-than-average defense (oppDefRating < leagueAvg)
    // must produce raw < 1 so base < 1, i.e. push the projection DOWN — the
    // previous leagueAvg/oppDefRating version had this backwards.
    const raw = parseFloat(oppDefRating) / leagueAvg;
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

// ── HOW MUCH OF A TEAMMATE'S ABSENCE IS ALREADY IN THE BASELINE ─────
// The teammate-out boost used to depend only on who is injured RIGHT NOW. But
// a player's baseline (recent games blended with the season) already reflects
// every game that teammate missed: live case — Breanna Stewart got a +21%
// usage boost for Satou Sabally being out, yet Sabally last played June 24,
// so all 10 of Stewart's recent games were already played without her (and the
// other "out" teammate never played this season). That credited the same
// absence twice and pushed a 22.5-pt scorer to a 31.1 projection against a
// 22.5 market line. The boost now only counts the part of the absence the
// baseline has NOT absorbed, measured from the teammate's real game log and
// weighted exactly like the baseline itself (recent window n/(n+8), season
// for the rest — see shrink()).
const injuryAbsenceCache = {}; // lowercase name -> { lastPlayed, gamesThisSeason, ts }
const INJURY_ABSENCE_TTL = 6 * 3600 * 1000;
async function enrichInjuryAbsence(playerRoster, league) {
  const injured = (playerRoster?.injured || [])
    .filter(p => ['out', 'doubtful', 'questionable'].includes((p.status || '').toLowerCase()))
    .slice(0, 4);
  await Promise.all(injured.map(async (p) => {
    const key = (p.name || '').toLowerCase();
    const c = injuryAbsenceCache[key];
    if (!key || (c && Date.now() - c.ts < INJURY_ABSENCE_TTL)) return;
    try {
      const stats = league === 'wnba' ? await fetchWNBAPlayerStats(p.name) : await fetchPlayerStats(p.name);
      if (stats && !stats.error) {
        const played = (stats.gameLog20 || []).filter(g => (parseFloat(g.min) || 0) > 0).map(gameDateISO).filter(Boolean).sort();
        injuryAbsenceCache[key] = { lastPlayed: played.length ? played[played.length - 1] : null, gamesThisSeason: stats.seasonGames || 0, ts: Date.now() };
      } else if (/no game log/i.test(stats?.error || '')) {
        injuryAbsenceCache[key] = { lastPlayed: null, gamesThisSeason: 0, ts: Date.now() }; // never played this season
      } // any other failure stays unknown (half weight) and is retried next time
    } catch (_) { /* unknown */ }
  }));
}
// 1 = the whole absence is new to the baseline (full boost), 0 = the baseline
// already contains it entirely (no boost), 0.5 = unknown.
function baselineAbsenceWeight(name, playerStats) {
  const a = injuryAbsenceCache[(name || '').toLowerCase()];
  if (!a) return 0.5;
  const recent = (playerStats?.last10Games || []).map(gameDateISO).filter(Boolean);
  const n = recent.length;
  const missedRecent = n ? recent.filter(d => !a.lastPlayed || d > a.lastPlayed).length / n : 0;
  const seasonGames = playerStats?.seasonGames || 0;
  const missedSeason = seasonGames ? Math.max(0, Math.min(1, 1 - (a.gamesThisSeason || 0) / seasonGames)) : 0;
  const wRecent = n / (n + 8);
  return Math.max(0, Math.min(1, 1 - (wRecent * missedRecent + (1 - wRecent) * missedSeason)));
}

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
        const absenceWeight = baselineAbsenceWeight(p.name, playerStats);
        const effectiveUSG = (usg ? usg * statusWeight : 0.08 * statusWeight) * absenceWeight; // 8% default if unknown
        freedUSG += effectiveUSG;
        injuredWithUSG.push({ ...p, usg, effectiveUSG, absenceWeight });
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
            newToBaseline: Math.round(p.absenceWeight * 100) + '%',
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
          boost *= rotationConf * baselineAbsenceWeight(p.name, playerStats);
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
      // Winsorized so one outlier game (blowout garbage time, or a starter
      // pulled early) can't masquerade as a real usage trend on its own —
      // same fix as the minutes projection, same underlying blind spot.
      const winsorized = winsorizeGames(playerStats.last10Games, statKey);
      const l10avg = winsorized.reduce((s,v) => s+v, 0) / winsorized.length;
      const l3avg  = winsorized.slice(0,3).reduce((s,v) => s+v, 0) / Math.min(3, winsorized.length);
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
function projectMinutes(playerStats, ctx, propType) {
  const details = [];
  const last10 = playerStats.last10Games || [];
  const last3  = last10.slice(0, 3);
  // Winsorized against the player's own L10 median before averaging — one
  // blowout game (garbage-time run for a normally low-minutes player, or
  // an early pull for a normal starter) used to be able to swing both the
  // baseline and the trend signal below on its own; capping its influence
  // relative to this player's own typical minutes fixes that without
  // needing to know the actual final score margin.
  const winsorizedMin = winsorizeGames(last10, 'min');
  const recentMin = winsorizedMin.length
    ? winsorizedMin.reduce((s, v) => s + v, 0) / winsorizedMin.length
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
    const l3Min = winsorizedMin.slice(0, 3).reduce((s, v) => s + v, 0) / Math.min(3, winsorizedMin.length);
    const trendPct = Math.max(-0.12, Math.min(0.12, (l3Min - projMin) / projMin * 0.5));
    const before = projMin;
    projMin *= (1 + trendPct);
    if (Math.abs(projMin - before) > 0.05) details.push({ label: 'recent rotation trend', minutes: parseFloat((projMin - before).toFixed(1)) });
  }

  // Teammate-out role bump — reuses the same USG_PCT-based redistribution
  // signal as usage inflation (a teammate out means more usage AND more
  // time on court), but scaled down: minutes respond less elastically than
  // usage rate to an absence (a bench player's minutes cap still exists).
  // Uses the ACTUAL propType being projected — this used to be hardcoded
  // to 'points' regardless of what was actually being projected, which
  // broke the "minutesMult × rateMult ≈ original usageMult" no-double-
  // count assumption documented below for every non-points prop (e.g. a
  // rebounds projection would blend a points-calibrated minutes bump with
  // a rebounds-calibrated rate multiplier — two different signals treated
  // as if they were split halves of the same one).
  const usageMult = calcUsageInflation(ctx.playerRoster, playerStats, propType || 'points', ctx.nbaPlayerStats || []);
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
  const zLine = (parseFloat(postedLine) - projection) / stdDev;
  // A count stat (points, blocks, steals, etc.) can't go below 0, but the
  // raw normal approximation assigns real probability mass there anyway —
  // most noticeable for low-projection props (e.g. a 0.8 projection with
  // a proportionally wide floor'd stdDev can put ~5% of the fitted curve
  // below zero). Truncate at 0 and renormalize over the valid [0, ∞)
  // domain instead of silently leaving that impossible mass in the split.
  const zZero = (0 - projection) / stdDev;
  const massBelowZero = normalCdf(zZero);
  const validMass = 1 - massBelowZero;
  const under = validMass > 0.0001
    ? Math.max(0, Math.min(1, (normalCdf(zLine) - massBelowZero) / validMass))
    : (zLine <= zZero ? 0 : 1); // degenerate: projection deeply negative relative to stdDev
  const over = 1 - under;
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
    const events = await getOddsEvents('basketball_nba');

    const teamLower = playerTeam.toLowerCase().split(' ').pop();
    const oppLower  = opponent.toLowerCase().split(' ').pop();

    const event = events.find(e =>
      (e.home_team?.toLowerCase().includes(teamLower) || e.away_team?.toLowerCase().includes(teamLower)) &&
      (e.home_team?.toLowerCase().includes(oppLower)  || e.away_team?.toLowerCase().includes(oppLower))
    );

    if (event) {
      const bookmakers = await getEventOdds('basketball_nba', event.id, 'totals,spreads', GAME_CONTEXT_ODDS_TTL);

      for (const bm of bookmakers.slice(0, 3)) {
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
// shape into a flat, newest-first array of game objects. Regular season +
// postseason — ESPN labels playoffs "Postseason" (confirmed directly
// against the live API), and the old regex here only matched "Regular
// Season", so it silently threw away every playoff/Finals game. That meant
// once the postseason started, a player's minutes/stat baseline stayed
// frozen on stale regular-season box scores — no tighter-rotation signal,
// no playoff-intensity data, ever. Preseason/All-Star are still excluded.
function flattenWNBAGamelog(raw) {
  if (!raw?.seasonTypes?.length) return [];
  const meta = raw.events || {};
  const games = [];
  for (const st of raw.seasonTypes) {
    if (!/regular season|postseason/i.test(st.displayName || '')) continue; // skip preseason/all-star
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
async function fetchWNBAPropLines(playerName, propType, opts = {}) {
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
    const events = await getOddsEvents('basketball_wnba');
    const lines = {};
    const target = opts.opponent ? findEventForTeams(events, opts.opponent, opts.playerTeam) : null;
    const eventSlice = target ? [target] : events.slice(0, 5);
    await Promise.allSettled(eventSlice.map(async event => {
      try {
        const bookmakers = await getEventOdds('basketball_wnba', event.id, market, PROP_LINES_TTL);
        for (const bm of bookmakers) {
          for (const mkt of (bm.markets || [])) {
            for (const o of (mkt.outcomes || [])) {
              if (matchesOutcomeName(o.description, playerName)) {
                if (!lines[bm.title]) lines[bm.title] = {};
                lines[bm.title][o.name] = { point: o.point, price: o.price };
              }
            }
          }
        }
      } catch (_) {}
    }));
    const result = { lines, market, ...consensusFromLines(lines) };
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
    const events = await getOddsEvents('basketball_wnba');
    const teamLower = playerTeam.toLowerCase().split(' ').pop();
    const oppLower  = opponent.toLowerCase().split(' ').pop();
    const event = events.find(e =>
      (e.home_team?.toLowerCase().includes(teamLower) || e.away_team?.toLowerCase().includes(teamLower)) &&
      (e.home_team?.toLowerCase().includes(oppLower)  || e.away_team?.toLowerCase().includes(oppLower))
    );
    if (event) {
      const bookmakers = await getEventOdds('basketball_wnba', event.id, 'totals,spreads', GAME_CONTEXT_ODDS_TTL);
      for (const bm of bookmakers.slice(0, 3)) {
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

// ── CONFIDENCE / RELIABILITY (separate from probability) ──────────
// How far to trust THIS projection — not how likely the pick is to win.
// The previous version was a checklist of yes/no data-availability flags,
// so any two players with the same data coverage scored identically (four
// different players on one live slate all showed exactly 87%), and it said
// nothing about how erratic the player actually is. This version is built
// from continuous inputs, so it differentiates real players:
//   consistency (30) — game-to-game spread of this stat relative to its mean
//   minutes     (15) — spread of minutes played, plus how far the minutes
//                      projection moved off its baseline (role/rest changes)
//   depth       (15) — how much season + recent sample backs the baseline
//   coverage    (20) — which data feeds were actually available (H2H and
//                      playtypes scale with sample instead of on/off)
//   situation   (20) — model-internal swing from the adjustments, blowout
//                      risk (spread), teammate-out usage shift, back-to-back,
//                      hot/cold streak vs. baseline, recent-vs-H2H disagreement
// Every component is a smooth function of its input (no hard thresholds),
// which is what keeps two players from landing on the same number.
// Bump when calcConfidence's scale changes. Stamped on every tracker entry so
// the accuracy-by-tier stats only ever compare picks scored on the same scale.
const CONFIDENCE_FORMULA_VERSION = 2;
function calcConfidence(i) {
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
  const inv = (x, scale) => 1 / (1 + (Math.max(x, 0) / scale) ** 2);

  // consistency — coefficient of variation of the stat itself
  let consistency = inv(0.8, 0.45); // too few games to measure: scored as poor, not neutral
  if (i.gameVals.length >= 3) {
    const m = mean(i.gameVals);
    if (m > 0) consistency = inv(sd(i.gameVals) / m, 0.45);
  }

  // minutes reliability
  const mins = (i.recentGames || []).map(g => parseFloat(g.min)).filter(v => v > 0);
  let minutes = 0.35;
  if (mins.length >= 3) {
    minutes = inv(sd(mins) / mean(mins), 0.15);
    const base = i.minutesProj.baselineMinutes;
    if (base > 0) minutes *= Math.exp(-3 * Math.abs(i.minutesProj.projectedMinutes - base) / base);
  }

  // sample depth
  const seasonGames = i.playerStats.seasonGames || 0;
  const recentN = (i.recentGames || []).length;
  const depth = 0.6 * (1 - Math.exp(-seasonGames / 20)) + 0.4 * (1 - Math.exp(-recentN / 6));

  // data coverage — playtypes only exist for the NBA, so they're excluded from
  // the WNBA denominator rather than counted as missing
  const h2hN = i.h2h?.gamesVsOpp || 0;
  const ptCount = Object.keys(i.ctx.playerPlaytypes || {}).length;
  const cov = [
    { w: 8,  got: i.ctx.oppAdvanced ? 1 : 0 },
    { w: 3,  got: i.ctx.playerTeamAdvanced ? 1 : 0 },
    { w: 10, got: 1 - Math.exp(-h2hN / 2.5) },
    { w: 4,  got: i.ctx.playerRoster ? 1 : 0 },
    { w: 5,  got: i.gc?.total ? 1 : 0 },
    { w: 5,  got: i.gc?.spread != null ? 1 : 0 },
    { w: 3,  got: i.canDecomposePoints ? 1 : 0 },
    ...(i.league === 'wnba' ? [] : [{ w: 5, got: Math.min(1, ptCount / 6) }]),
  ];
  const coverage = cov.reduce((s, x) => s + x.w * x.got, 0) / cov.reduce((s, x) => s + x.w, 0);

  // situational stability — average of whichever sub-signals apply
  const sit = [];
  if (i.totalSwing > 0) sit.push(Math.exp(-2 * Math.abs(Math.log(i.totalSwing))));
  sit.push(i.gc?.spread != null ? inv(Math.max(0, Math.abs(i.gc.spread) - 4), 10) : 0.65);
  sit.push(Math.exp(-4 * Math.abs((i.usageMult || 1) - 1)));
  sit.push(i.gc?.isBackToBack ? 0.7 : 1);
  sit.push(i.seasonVal > 0 ? Math.exp(-3 * Math.abs(i.l10FromLog - i.seasonVal) / i.seasonVal) : 0.7);
  if (i.h2hVal != null && i.l10FromLog > 0) sit.push(Math.exp(-2 * Math.abs(i.h2hVal - i.l10FromLog) / i.l10FromLog));
  const situation = mean(sit);

  const score = (30 * consistency + 15 * minutes + 15 * depth + 20 * coverage + 20 * situation) / 100;
  // Real players cluster in a narrow band of raw scores (~0.53-0.82), so a
  // straight linear map squeezes them into ~20 points and ties pile up. A
  // logistic spreads that band over roughly 40-90 without any hard clamp
  // (a clamp would itself create ties at the ends), and stays bounded
  // inside the 25-97 range the rest of the app assumes.
  const spread = 1 / (1 + Math.exp(-11 * (score - 0.66)));
  const r2 = (x) => parseFloat(x.toFixed(2));
  return {
    score: parseFloat((25 + 72 * spread).toFixed(1)),
    components: { consistency: r2(consistency), minutes: r2(minutes), depth: r2(depth), coverage: r2(coverage), situation: r2(situation) },
  };
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
  const minutesProj = projectMinutes(playerStats, ctx, propType);
  const recentMinAvg = minutesProj.recentMinutes || parseFloat(avgs.min) || 0;
  const minutesRatio = recentMinAvg > 0 ? minutesProj.projectedMinutes / recentMinAvg : 1.0;

  const playerPos = playerStats?.player?.position;
  const usageMult = calcUsageInflation(ctx.playerRoster, playerStats, propType, ctx.nbaPlayerStats || []);
  // Usage signal is split across two channels so it isn't counted twice:
  // 35% already landed on minutes (projectMinutes' "role bump"), the
  // remaining 65% applies here to the per-minute production rate.
  const rateUsageMult = 1 + 0.65 * (usageMult - 1.0);

  const oppAdj = calcOpponentAdjustment(propType, ctx.oppFourFact, league);
  const playerTeamPace = ctx.playerTeamAdvanced?.PACE;
  const paceRatio = getPaceMultiplier(ctx.oppAdvanced?.PACE, playerTeamPace, propType, league);

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

  // ── HOME/AWAY SPLIT — applies to all paths ─────────────────────
  // `home` was already tagged on every game in the log (used for display
  // in tooltips/last5 tables) but never turned into a real signal —
  // confirmed nothing in this function referenced it before this. Only
  // applied when the upcoming game's home/away status is actually known
  // and there's a real sample in both splits; shrunk toward 1.0 (no
  // adjustment) so a handful of games can't swing this like a real
  // season-long split would, and capped tighter than the primary drivers
  // since this is a secondary signal, not a headline one.
  const isHomeGame = ctx.gameContext?.isHome;
  if (isHomeGame != null) {
    const splitLog = playerStats.gameLog20 || recentGames || [];
    const homeVals = splitLog.filter(g => g.home === true).map(getGameVal);
    const awayVals = splitLog.filter(g => g.home === false).map(getGameVal);
    if (homeVals.length >= 3 && awayVals.length >= 3) {
      const homeAvg = homeVals.reduce((a,b)=>a+b,0) / homeVals.length;
      const awayAvg = awayVals.reduce((a,b)=>a+b,0) / awayVals.length;
      const overallAvg = (homeAvg + awayAvg) / 2;
      if (overallAvg > 0) {
        const splitAvg = isHomeGame ? homeAvg : awayAvg;
        const sampleN = isHomeGame ? homeVals.length : awayVals.length;
        const shrunkRatio = shrink(splitAvg / overallAvg, 1.0, sampleN, 8);
        const homeAwayMult = Math.max(0.9, Math.min(1.1, shrunkRatio));
        const before = proj;
        proj *= homeAwayMult;
        if (Math.abs(proj - before) > 0.05) drivers.push({ label: `${isHomeGame ? 'home' : 'road'} split (${sampleN}-game sample)`, value: parseFloat((proj - before).toFixed(1)) });
      }
    }
  }

  // ── OVERALL SANITY CAP ──────────────────────────────────────────
  // Pace (±8%), the opponent-matchup adjustment, usage (up to ~±19.5%
  // via rateUsageMult), form (±4%), game context (±15%), and home/away
  // (±10%) are each individually capped, but they all multiply together
  // with no ceiling on the combined result — worst case that chain
  // compounds to roughly a ±90% swing, far beyond what any single cap
  // implies on its own. This is a deliberately wide backstop against that
  // pathological all-signals-aligned case, not a retuning of any
  // individual signal — it should rarely bind on real data.
  const preAdjustmentProj = baseProj * minutesRatio;
  let totalSwing = 1;
  if (preAdjustmentProj > 0) {
    totalSwing = proj / preAdjustmentProj;
    const cappedSwing = Math.max(0.65, Math.min(1.54, totalSwing));
    if (cappedSwing !== totalSwing) {
      const before = proj;
      proj = preAdjustmentProj * cappedSwing;
      drivers.push({ label: 'combined-adjustment sanity cap', value: parseFloat((proj - before).toFixed(1)) });
    }
  }

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

  const confidence = calcConfidence({
    playerStats, recentGames, gameVals, minutesProj, usageMult, totalSwing, gc, h2h,
    h2hVal, l10FromLog, seasonVal, ctx, league, canDecomposePoints,
  });

  const dvpCoeff = calcDvPCoeff(ctx.oppAdvanced?.DEF_RATING, playerPos, ctx.playerPlaytypes, ctx.oppDefPlaytypes, propType, league);

  return {
    projection:        parseFloat(proj.toFixed(1)),
    medianProjection:  parseFloat(proj.toFixed(1)), // normal approx — see stdDev note above
    lowerBound:        parseFloat(Math.max(0, proj - zRange*stdDev).toFixed(1)),
    upperBound:        parseFloat((proj + zRange*stdDev).toFixed(1)),
    zRange,
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
    confidence:        confidence.score,
    confidenceBreakdown: confidence.components,
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

// ── MARKET-LINE BLEND ────────────────────────────────────────────
// buildProjection() above is built entirely from box scores and opponent
// stats — it never sees a price. Sportsbook consensus lines price in real
// signal this model has no source for (late-breaking lineup news, referee
// assignments, sharp money), so leaning the projection toward consensus —
// more when the model's own confidence is lower, less when it's high —
// should outperform ignoring the market outright.
//
// Deliberately kept OUTSIDE buildProjection (and therefore outside its
// cache): odds move continuously, far more often than the injury/game-
// context signature the projection cache keys on, so baking this in would
// let a cached projection go stale against a moving line with nothing to
// invalidate it. Recomputed fresh every request instead — same pattern as
// liveMarket below.
function blendWithMarket(mathProjection, consensusLine, bookCount) {
  if (!mathProjection || consensusLine == null || !bookCount || bookCount < 2) return mathProjection;
  const proj = mathProjection.projection;
  if (!proj) return mathProjection;

  // Confidence 25→97 (buildProjection's own scale) maps to market weight
  // 0.40→0.12: a shakier projection leans harder on the market; a
  // well-supported one barely moves for it.
  const conf = mathProjection.confidence ?? 60;
  const confT = Math.max(0, Math.min(1, (conf - 25) / (97 - 25)));
  const marketWeight = 0.40 - 0.28 * confT;

  const rawGap = consensusLine - proj;
  // Same spirit as buildProjection's combined-adjustment sanity cap — one
  // disagreeing market shouldn't be able to drag the number more than 20%
  // off what the model itself computed.
  const cappedGap = Math.max(-0.20 * proj, Math.min(0.20 * proj, rawGap));
  const blended = proj + marketWeight * cappedGap;
  if (Math.abs(blended - proj) < 0.05) return mathProjection;

  const shift = parseFloat((blended - proj).toFixed(1));
  const zRange = mathProjection.zRange || 1.28;
  return {
    ...mathProjection,
    projection:        parseFloat(blended.toFixed(1)),
    medianProjection:  parseFloat(blended.toFixed(1)),
    lowerBound:        parseFloat(Math.max(0, blended - zRange * mathProjection.stdDev).toFixed(1)),
    upperBound:        parseFloat((blended + zRange * mathProjection.stdDev).toFixed(1)),
    preMarketProjection: proj,
    marketBlend: { consensusLine, bookCount, weight: parseFloat(marketWeight.toFixed(2)), shift },
    drivers: [...mathProjection.drivers, { label: `market consensus blend (${bookCount} books)`, value: shift }],
  };
}

function calcEdgeScore(mathProj, postedLine) {
  // null (no line to compare against) is distinct from a real 0.0 edge
  // (the model landed exactly on a valid posted line) — both used to
  // collapse to the same 0, making a missing/invalid line indistinguishable
  // downstream from a genuinely dead-even projection. Safe to change: every
  // caller either does math (null coerces to 0, same as before) or an
  // explicit `> 0`/`Math.abs()` check (null behaves identically to 0 there
  // too) — nothing currently branches on "edge === null" vs "=== 0".
  if (!mathProj || !postedLine) return null;
  const line = parseFloat(postedLine);
  if (!line || line <= 0) return null;
  // Absolute unit difference: proj - line
  // e.g. proj=22.5, line=24.5 → diff=-2.0 → edge=-2.0
  // Scale for display: cap at ±10
  const diff = mathProj - line;
  return Math.max(-10, Math.min(10, parseFloat(diff.toFixed(1))));
}

// ════════════════════════════════════════════════════════════════
// REAL EXPECTED VALUE — from the posted PRICE (American odds), not just
// the point spread between projection and line. "Edge" above only measures
// how far the projection sits from the line, in raw stat units; it says
// nothing about whether the number actually being offered (-110? +140?
// -250?) makes betting it worthwhile. This is the same real-money-vs-model
// comparison a sportsbook's own EV tools make, done against the model's
// own probability estimate (calcOverUnderProbability) instead of someone
// else's projection.
// ════════════════════════════════════════════════════════════════
function americanToImplied(price) {
  if (price == null) return null;
  const p = parseFloat(price);
  if (!isFinite(p) || p === 0) return null;
  return p > 0 ? 100 / (p + 100) : -p / (-p + 100);
}
function americanToDecimal(price) {
  if (price == null) return null;
  const p = parseFloat(price);
  if (!isFinite(p) || p === 0) return null;
  return p > 0 ? 1 + p / 100 : 1 + 100 / -p;
}
// A two-way (Over/Under) market's own implied probabilities always sum to
// more than 1 — the extra is the book's built-in margin ("vig"). Dividing
// each side by that sum removes it, leaving a fair estimate of what the
// market actually thinks the true probability is. Falls back to the raw
// (vig-included) implied probability for just the one side when the other
// side's price isn't available — worse, but still usable.
function devigTwoWay(overPrice, underPrice) {
  const po = americanToImplied(overPrice), pu = americanToImplied(underPrice);
  if (po != null && pu != null && (po + pu) > 0) {
    return { over: po / (po + pu), under: pu / (po + pu) };
  }
  return { over: po, under: pu };
}
// Expected value per $1 staked, from the model's own win probability
// against the price actually being offered. Positive = the model thinks
// this is a better bet than the price implies.
function calcExpectedValue(modelProb, price) {
  const dec = americanToDecimal(price);
  if (modelProb == null || dec == null) return null;
  return parseFloat((modelProb * (dec - 1) - (1 - modelProb)).toFixed(4));
}
// Fractional-Kelly stake suggestion, as a fraction of bankroll. Uses
// quarter-Kelly (a standard discount for real bankrolls, since full Kelly
// assumes the win probability is known exactly — it isn't; this model's
// own confidence score says as much) and caps at 5% of bankroll on any
// single pick regardless of how large the calculated edge looks. Both
// numbers are reasonable, commonly-used defaults, not backtested against
// this app's own results — treat them as a starting point to revisit once
// enough graded picks exist to check against (see /api/clv's
// byConfidenceTier).
function calcKellyStake(modelProb, price, kellyMultiplier = 0.25, maxFraction = 0.05) {
  const dec = americanToDecimal(price);
  if (modelProb == null || dec == null) return 0;
  const b = dec - 1;
  if (b <= 0) return 0;
  const fullKelly = (modelProb * b - (1 - modelProb)) / b;
  if (fullKelly <= 0) return 0;
  return parseFloat(Math.min(fullKelly * kellyMultiplier, maxFraction).toFixed(4));
}
// One call, everything a UI needs: fair market probability (de-vigged),
// the model's edge over that fair price, real EV, and a stake suggestion —
// for whichever side (over/under) the model's projection actually favors.
function calcRealEdge(direction, overProb, underProb, overPrice, underPrice) {
  const isOver = direction === 'OVER' || direction === 'LEAN_OVER';
  const modelProb = isOver ? overProb : underProb;
  const price = isOver ? overPrice : underPrice;
  if (modelProb == null || price == null) return null;
  const fairProb = devigTwoWay(overPrice, underPrice)[isOver ? 'over' : 'under'];
  // modelProb stays the raw number (it's what gets logged and scored). When the
  // calibrator is on, EV, edge and stake use the corrected chance instead.
  const calOn = !!(calibrationModel && calibrationModel.active);
  const usedProb = calOn ? calibrate(modelProb) : modelProb;
  return {
    price,
    modelProb: parseFloat((modelProb * 100).toFixed(1)),
    calibrated: calOn,
    calibratedProb: calOn ? parseFloat((usedProb * 100).toFixed(1)) : null,
    fairMarketProb: fairProb != null ? parseFloat((fairProb * 100).toFixed(1)) : null,
    probEdge: fairProb != null ? parseFloat(((usedProb - fairProb) * 100).toFixed(1)) : null,
    expectedValue: calcExpectedValue(usedProb, price),
    kellyStake: calcKellyStake(usedProb, price),
  };
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

const BRIDGE_MAX_QUEUE = 30;
let bridgePending = 0;
function enqueueBridge(taskFn) {
  // Beyond this many waiting jobs a visitor would just be stuck behind minutes of queue; refuse instead.
  if (bridgePending >= BRIDGE_MAX_QUEUE) return Promise.resolve({ error: 'Busy: too many lookups waiting. Try again in a minute.' });
  bridgePending++;
  const scheduled = bridgeChain.then(async () => {
    const wait = BRIDGE_MIN_GAP_MS - (Date.now() - lastBridgeCallTs);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try {
      return await taskFn();
    } finally {
      lastBridgeCallTs = Date.now();
      bridgePending--;
    }
  });
  // Keep the queue alive regardless of whether this task succeeds or fails
  bridgeChain = scheduled.then(() => {}, () => {});
  return scheduled;
}

async function fetchViaBridge(playerName, season = '2025-26') {
  if (security.badString(playerName) || security.badString(season)) return { error: 'Invalid name' };
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
  if (security.badString(name) || security.badString(season)) return { error: 'Invalid name' };
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
app.get('/api/nba-bridge', requireAdmin, async (req, res) => {
  const { player, season } = req.query;
  if (!player) return res.status(400).json({ error: 'player required' });

  console.log(`[Bridge] Fetching: ${player}`);
  const data = await fetchViaBridge(player, season || '2025-26');
  res.json(data);
});

// POST /api/nba-bridge/batch — fetch multiple players at once
app.post('/api/nba-bridge/batch', requireAdmin, async (req, res) => {
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

// What the "DATA FEED STATUS" badge actually reads — real backend health,
// not a hardcoded green pill. No network calls of its own; reflects
// config presence (free) plus whatever the last real odds-API request
// this server made actually returned (also free — no probe call).
app.get('/api/data-status', (req, res) => {
  const oddsConfigured = !!(process.env.ODDS_API_KEY && !process.env.ODDS_API_KEY.includes('XXXXX'));
  const fresh = freshness.describe({ oddsConfigured, odds: oddsApiHealth, inSeason: datachecks.inSeason,
    statMtimes: { nba: mtimeOf(STAT_FILE.nba), wnba: mtimeOf(STAT_FILE.wnba) } });
  // Visitors only need to know whether the odds feed is up. Credit counts, usage and error text
  // are for the admin.
  if (!isAdmin(req)) {
    return res.json({
      odds: { configured: oddsConfigured, exhausted: !!oddsApiHealth.exhausted }, fresh,
      balldontlie: { configured: !!process.env.BALLDONTLIE_KEY },
      anthropic: { configured: !!(process.env.ANTHROPIC_KEY && !process.env.ANTHROPIC_KEY.includes('your_')) },
    });
  }
  res.json({
    odds: { configured: oddsConfigured, ...oddsApiHealth, usage: oddsUsage }, fresh,
    balldontlie: { configured: !!process.env.BALLDONTLIE_KEY },
    anthropic: { configured: !!(process.env.ANTHROPIC_KEY && !process.env.ANTHROPIC_KEY.includes('your_')) },
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
      // Your own film reads for each team, if any — folded into the AI
      // matchup breakdown alongside the stats.
      scoutNotes: { team1: getScoutNotes(league, { team: team1 }), team2: getScoutNotes(league, { team: team2 }) },
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
    fetchWNBAPropLines(player, propType || 'points', { opponent, playerTeam: playerStatsPre?.player?.team }),
    fetchWNBASchedule(),
  ]);

  const playerTeamName = playerStats?.player?.team || '';

  const [playerRoster, h2hStats, gameContext, teamMargins] = await Promise.all([
    playerTeamName ? fetchWNBARoster(playerTeamName).then(async r => { await enrichInjuryAbsence(r, 'wnba'); return r; }) : Promise.resolve(null),
    fetchWNBAH2HStats(player, opponent),
    fetchWNBAGameContext(playerTeamName || player, opponent),
    playerTeamName ? getTeamGameMargins('wnba', playerTeamName) : Promise.resolve([]),
  ]);

  // Resolve the typed opponent to its canonical full name before matching
  // — a raw substring match against the typed query is exploitable by
  // short/ambiguous input: confirmed live that "atlanta dream".includes
  // ("la") is true, so typing "LA" (meaning Los Angeles Sparks) could
  // silently match an Atlanta Dream game instead.
  const resolvedOpponent = WNBA_ABBR_TO_NAME[resolveWNBATeam(opponent)] || opponent;
  const todayGame = todaysGames.find(g =>
    g.home.toLowerCase().includes(resolvedOpponent.toLowerCase()) ||
    g.away.toLowerCase().includes(resolvedOpponent.toLowerCase()) ||
    g.home.toLowerCase().includes(playerTeamName.toLowerCase()) ||
    g.away.toLowerCase().includes(playerTeamName.toLowerCase())
  ) || null;
  // Real home/away status for the upcoming game — feeds buildProjection's
  // home/away split adjustment.
  if (todayGame && gameContext) {
    gameContext.isHome = todayGame.home.toLowerCase().includes(playerTeamName.toLowerCase());
  }

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
    mathProjection = buildProjection(withBlowoutTags(playerStats, teamMargins), {
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
  if (mathProjection && propLines && !propLines.error) {
    mathProjection = blendWithMarket(mathProjection, propLines.consensusLine, propLines.bookCount);
  }

  // Real edge/EV against the LIVE market line (propLines.softestLine),
  // independent of whatever the user has typed into the line field —
  // computed fresh every request, never attached to mathProjection itself
  // (which is cached across requests; the market line isn't).
  let liveMarket = null;
  if (mathProjection && propLines && !propLines.error && propLines.softestLine != null) {
    const liveEdge = calcEdgeScore(mathProjection.projection, propLines.softestLine);
    const liveProb = calcOverUnderProbability(mathProjection.projection, mathProjection.stdDev, propLines.softestLine);
    liveMarket = {
      line: propLines.softestLine, consensusLine: propLines.consensusLine, bookCount: propLines.bookCount,
      edge: liveEdge, ...liveProb,
      realEdge: liveEdge != null && liveProb ? calcRealEdge(liveEdge > 0 ? 'OVER' : 'UNDER', liveProb.overProbability, liveProb.underProbability, propLines.overPrice, propLines.underPrice) : null,
    };
  }

  res.json({
    fetchedAt: new Date().toISOString(),
    date: getToday(),
    league: 'wnba',
    dataAvailable: wnbaStats?.dataAvailable || {},
    mathProjection, liveMarket,
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
    scoutNotes: getScoutNotes('wnba', { team: opponent }), // your own offense/defense film reads on this opponent, if any
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
  // WAVE 1 — H2H bridge fires immediately (slowest); player stats are
  // fetched alone first so the same-team check below can run before the
  // paid Odds API call (fetchPropLines) fires — previously that ran in
  // the same Promise.all as this check, burning quota on every "you
  // entered your own team as opponent" error. Matches the WNBA endpoint's
  // existing ordering.
  // ═══════════════════════════════════════════════════════════════
  // Start H2H bridge immediately — it takes longest (nba_api multi-season)
  const h2hBridgePromise = fetchH2HViaBridge(player, opponent);

  const playerStats = await fetchPlayerStats(player);
  const playerTeamName = playerStats?.player?.team || '';

  if (sameTeam(playerTeamName, opponent)) {
    return res.status(400).json({
      error: `${player} plays for ${playerTeamName} — that's the same team you entered as the opponent. Enter who ${playerTeamName} is actually facing.`
    });
  }

  const [oppRoster, lineups, propLines] = await Promise.all([
    fetchESPNRoster(opponent),
    fetchLineups(),
    fetchPropLines(player, propType || 'points', { opponent, playerTeam: playerTeamName }),
  ]);

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
    playerTeamName ? fetchESPNRoster(playerTeamName).then(async r => { await enrichInjuryAbsence(r, 'nba'); return r; }) : Promise.resolve(null),
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

  // Today's confirmed game — resolve the typed opponent to its canonical
  // full name first (same short-input collision risk as the WNBA side,
  // e.g. a bare "LA" or other short alias matching the wrong team).
  const resolvedOpponentNBA = resolveNBAFullName(opponent);
  const todayGame = todaysGames.find(g =>
    g.home_team.full_name.toLowerCase().includes(resolvedOpponentNBA.toLowerCase()) ||
    g.visitor_team.full_name.toLowerCase().includes(resolvedOpponentNBA.toLowerCase()) ||
    g.home_team.full_name.toLowerCase().includes(playerTeamName.toLowerCase()) ||
    g.visitor_team.full_name.toLowerCase().includes(playerTeamName.toLowerCase())
  ) || null;
  // Real home/away status for the upcoming game — feeds buildProjection's
  // home/away split adjustment. Merged in here rather than threaded
  // through fetchGameContext since todayGame wasn't resolved yet at that
  // call site.
  if (todayGame && gameContext) {
    gameContext.isHome = todayGame.home_team.full_name.toLowerCase().includes(playerTeamName.toLowerCase());
  }
  const teamMargins = playerTeamName ? await getTeamGameMargins('nba', playerTeamName) : [];

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

  // Opponent team defense by playtype (how well they defend each play
  // type), paired with where they rank league-wide defending it specifically
  // — 1st = toughest to score on, same convention the shot-chart zone ranks
  // use — computed from the same 30-team file already being read, no extra
  // fetch. A handful of play types (PR Ball-Handler, PR Roll Man, Cut,
  // Putbacks) don't have a defensive file at all right now: nba.com's own
  // Synergy defensive endpoint times out/errors on those specific
  // play-type+defensive combinations (confirmed live, not a bug on this
  // end) — those simply won't appear here or in the UI rather than showing
  // a fabricated number.
  const oppDefPlaytypes = {};
  const teamDefKeys = [
    ['iso','teamDefIso'],['transition','teamDefTransition'],
    ['prBall','teamDefPRBall'],['prRoll','teamDefPRRoll'],
    ['postUp','teamDefPostUp'],['spotUp','teamDefSpotUp'],
    ['cut','teamDefCut'],['handoff','teamDefHandoff'],
    ['offScreen','teamDefOffScreen'],['putbacks','teamDefPutbacks'],
  ];
  for (const [key, src] of teamDefKeys) {
    const arr = nbaStats?.[src];
    const match = arr?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase()));
    if (!match) continue;
    const ranked = arr.filter(t => t.PPP != null).sort((a, b) => a.PPP - b.PPP);
    const rank = match.PPP != null ? ranked.findIndex(t => t.TEAM_ID === match.TEAM_ID) + 1 : null;
    oppDefPlaytypes[key] = { ...match, rank: rank || null, rankOf: ranked.length || null };
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
    mathProjection = buildProjection(withBlowoutTags(playerStats, teamMargins), {
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
  if (mathProjection && propLines && !propLines.error) {
    mathProjection = blendWithMarket(mathProjection, propLines.consensusLine, propLines.bookCount);
  }

  // Real edge/EV against the LIVE market line (propLines.softestLine),
  // independent of whatever the user has typed into the line field —
  // computed fresh every request, never attached to mathProjection itself
  // (which is cached across requests; the market line isn't).
  let liveMarket = null;
  if (mathProjection && propLines && !propLines.error && propLines.softestLine != null) {
    const liveEdge = calcEdgeScore(mathProjection.projection, propLines.softestLine);
    const liveProb = calcOverUnderProbability(mathProjection.projection, mathProjection.stdDev, propLines.softestLine);
    liveMarket = {
      line: propLines.softestLine, consensusLine: propLines.consensusLine, bookCount: propLines.bookCount,
      edge: liveEdge, ...liveProb,
      realEdge: liveEdge != null && liveProb ? calcRealEdge(liveEdge > 0 ? 'OVER' : 'UNDER', liveProb.overProbability, liveProb.underProbability, propLines.overPrice, propLines.underPrice) : null,
    };
  }

  res.json({
    fetchedAt:          new Date().toISOString(),
    date:               getToday(),
    dataAvailable:      nbaStats?.dataAvailable || {},
    mathProjection,     // Independent mathematical projection
    liveMarket,         // Real edge/EV/Kelly against the live market line
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
    scoutNotes: getScoutNotes('nba', { team: opponent }), // your own offense/defense film reads on this opponent, if any
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
  // "Tonight's slate" means games that tip off later TODAY. The Odds API
  // lists every upcoming game (the NBA list started two weeks out), and the
  // scan used to take the first 6 regardless — paying 3 credits per game to
  // build "tonight's picks" out of opening-week games, which then also
  // couldn't be graded on the day they were logged. Already-started games
  // are skipped too (their lines are live, not pre-game).
  const now = Date.now(), today = getToday();
  const events = (await getOddsEvents(sportKey))
    .filter(ev => { const t = new Date(ev.commence_time); return t.getTime() > now && toLocalDateStr(t) === today; })
    .slice(0, MAX_SLATE_EVENTS);

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
      // `${player}|${propType}` → { bookTitle: {Over:{point,price}, Under:{point,price}} }
      // — every book kept (not just the first-seen one) so a consensus line
      // and the actual price can both be computed below, the same real data
      // fetchPropLines already collects for the single-player analyzer.
      const seen = {};
      for (const bm of (oddsRes.data.bookmakers || [])) {
        for (const mkt of (bm.markets || [])) {
          const propType = Object.entries(SLATE_PROP_MARKETS).find(([, v]) => v === mkt.key)?.[0];
          if (!propType) continue;
          for (const o of (mkt.outcomes || [])) {
            if (!o.description || (o.name !== 'Over' && o.name !== 'Under')) continue;
            const key = `${o.description}|${propType}`;
            if (!seen[key]) seen[key] = {};
            if (!seen[key][bm.title]) seen[key][bm.title] = {};
            seen[key][bm.title][o.name] = { point: o.point, price: o.price };
          }
        }
      }
      for (const [key, books] of Object.entries(seen)) {
        const [player, propType] = key.split('|');
        const overPoints = Object.values(books).map(b => b.Over?.point).filter(p => p != null).sort((a, b) => a - b);
        if (!overPoints.length) continue;
        // Softest (lowest) Over line — the best real number available for
        // an Over bet, same convention fetchPropLines already uses.
        let softestBook = null, softestLine = null;
        for (const [book, d] of Object.entries(books)) {
          if (d.Over?.point != null && (softestLine == null || d.Over.point < softestLine)) { softestLine = d.Over.point; softestBook = book; }
        }
        const mid = Math.floor(overPoints.length / 2);
        const consensusLine = overPoints.length % 2 ? overPoints[mid] : (overPoints[mid - 1] + overPoints[mid]) / 2;
        const softest = books[softestBook] || {};
        candidates.push({
          player, propType, line: softestLine, book: softestBook,
          consensusLine: parseFloat(consensusLine.toFixed(1)), bookCount: overPoints.length,
          overPrice: softest.Over?.price ?? null, underPrice: softest.Under?.price ?? null,
          homeTeam: event.home_team, awayTeam: event.away_team,
        });
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
  const [playerRoster, gameContext, teamMargins] = await Promise.all([
    fetchESPNRoster(playerTeam).then(async r => { await enrichInjuryAbsence(r, 'nba'); return r; }),
    fetchGameContext(playerTeam, opponent, null),
    getTeamGameMargins('nba', playerTeam),
  ]);
  // Already have both team names on the candidate — no extra lookup needed.
  if (gameContext) gameContext.isHome = (cand.homeTeam || '').toLowerCase().includes(playerTeam.toLowerCase());

  // H2H is intentionally still skipped here (unlike the WNBA slate scan,
  // which now includes it — that one's nearly free, just filtering an
  // already-fetched gamelog). NBA H2H goes through the nba_api Python
  // bridge, which would mean up to MAX_SLATE_CANDIDATES more serialized
  // bridge calls on top of the one fetchPlayerStats already makes per
  // candidate — real risk of the once-daily scan taking many minutes.
  // So an NBA slate-scan projection can still differ slightly from the
  // full single-player analysis (which does include H2H); WNBA's cannot.
  const rawProjection = buildProjection(withBlowoutTags(playerStats, teamMargins), {
    oppAdvanced, oppShooting, oppPaintDef, oppFourFact,
    playerRoster, playerTeamAdvanced,
    playerPlaytypes: {}, oppDefPlaytypes: {}, // skipped in the slate scan for speed — see note above
    dataAvailable: nbaStats?.dataAvailable || {},
    h2hStats: null, gameContext,
    nbaPlayerStats: nbaStats?.playerAdvanced || nbaStats?.playerStats || [],
  }, cand.propType);
  if (!rawProjection) return null;
  // Same market blend as the single-player analyzer (blendWithMarket) —
  // applied here too so a Top Plays pick and the auto-logged/CLV-graded
  // version of that same pick are always the same number as what the
  // analyzer would show for it, instead of two silently different
  // definitions of "the projection" living side by side in the app.
  const projection = blendWithMarket(rawProjection, cand.consensusLine, cand.bookCount);

  const edge = calcEdgeScore(projection.projection, cand.line);
  const prob = calcOverUnderProbability(projection.projection, projection.stdDev, cand.line);
  return {
    league: 'nba', player: playerStats.player.name, team: playerTeam, opponent,
    propType: cand.propType, line: cand.line, book: cand.book,
    // Consensus (median across every book posting a line) — the projection
    // above is already blended toward it (blendWithMarket), so marketEdge
    // below shows how much edge survives after that blend, not the raw
    // model-vs-market gap.
    consensusLine: cand.consensusLine ?? null, bookCount: cand.bookCount ?? null,
    marketEdge: cand.consensusLine != null ? calcEdgeScore(projection.projection, cand.consensusLine) : null,
    projection: projection.projection, confidence: projection.confidence,
    edge, ...prob,
    realEdge: calcRealEdge(edge > 0 ? 'OVER' : 'UNDER', prob?.overProbability, prob?.underProbability, cand.overPrice, cand.underPrice),   // prob is null when there is no posted line
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
  const [playerRoster, h2hStats, gameContext, teamMargins] = await Promise.all([
    fetchWNBARoster(playerTeam).then(async r => { await enrichInjuryAbsence(r, 'wnba'); return r; }),
    fetchWNBAH2HStats(cand.player, opponent),
    fetchWNBAGameContext(playerTeam, opponent),
    getTeamGameMargins('wnba', playerTeam),
  ]);
  if (gameContext) gameContext.isHome = (cand.homeTeam || '').toLowerCase().includes(playerTeam.toLowerCase());
  const wnbaStats = loadWNBAStats();
  const findTeam = (arr) => arr?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())) || null;
  const oppAdvanced = findTeam(wnbaStats?.teamAdvanced);
  const playerTeamAdvanced = wnbaStats?.teamAdvanced?.find(t => t.TEAM_NAME?.toLowerCase().includes(playerTeam.toLowerCase())) || null;

  const rawProjection = buildProjection(withBlowoutTags(playerStats, teamMargins), {
    oppAdvanced, oppShooting: findTeam(wnbaStats?.teamOppShooting), oppPaintDef: null,
    oppFourFact: findTeam(wnbaStats?.teamFourFactors),
    playerRoster, playerTeamAdvanced,
    playerPlaytypes: {}, oppDefPlaytypes: {},
    dataAvailable: wnbaStats?.dataAvailable || {}, h2hStats, gameContext,
    nbaPlayerStats: wnbaStats?.playerAdvanced || [], league: 'wnba',
  }, cand.propType);
  if (!rawProjection) return null;
  const projection = blendWithMarket(rawProjection, cand.consensusLine, cand.bookCount);

  const edge = calcEdgeScore(projection.projection, cand.line);
  const prob = calcOverUnderProbability(projection.projection, projection.stdDev, cand.line);
  return {
    league: 'wnba', player: playerStats.player.name, team: playerTeam, opponent,
    propType: cand.propType, line: cand.line, book: cand.book,
    consensusLine: cand.consensusLine ?? null, bookCount: cand.bookCount ?? null,
    marketEdge: cand.consensusLine != null ? calcEdgeScore(projection.projection, cand.consensusLine) : null,
    projection: projection.projection, confidence: projection.confidence,
    edge, ...prob,
    realEdge: calcRealEdge(edge > 0 ? 'OVER' : 'UNDER', prob?.overProbability, prob?.underProbability, cand.overPrice, cand.underPrice),   // prob is null when there is no posted line
  };
}

// Shared by /api/top-plays and /api/team-picks — both are just different
// ways of slicing the same slate-wide candidate scan. Memoized per day so
// the two endpoints see the exact same scan instead of each independently
// re-hitting the odds API — otherwise they can disagree if evaluate() (or
// the odds API itself) flakes differently between two separate live calls,
// and each visit doubles real odds-API quota usage for no reason.
// Persisted to disk, not just memory — this scan is what actually spends
// odds-API quota (one events call + up to 5 per-event calls, per league).
// It was already day-locked, but only in memory: every server restart
// silently threw away a scan that was still valid for the rest of that
// day and paid for it again from zero. Confirmed live this session — that
// exact pattern burned a fresh 500-request key down to 0 from nothing but
// repeated restarts, not real traffic.
const SLATE_CACHE_FILE = 'slate_scan_cache.json';
function loadSlateScanCacheFromDisk() {
  try {
    if (!fs.existsSync(SLATE_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(SLATE_CACHE_FILE, 'utf8'));
  } catch (_) { return {}; }
}
function saveSlateScanCacheToDisk(cache) {
  try { fs.writeFileSync(SLATE_CACHE_FILE, JSON.stringify(cache)); } catch (_) {}
}
const slateScanCache = loadSlateScanCacheFromDisk(); // league -> { data: {candidates, results}, dateKey, v }
// Bump whenever projection/confidence math changes: the scan is cached on
// disk for the whole day (to protect the Odds API quota), so without a
// version stamp a logic change would keep serving numbers from the OLD
// formula until midnight.
const SLATE_LOGIC_VERSION = 2; // 2 = continuous confidence score (calcConfidence)
// An empty scan (0 candidates) is ambiguous — could mean a real quota/key
// failure, or just no props posted yet — so it's NOT trusted for the rest
// of the day like a real successful scan is. Real bug this fixed: a key
// that was exhausted earlier today and has since been replaced/reset
// stayed stuck showing the fallback until midnight, because the disk
// cache had already locked in "0 candidates" for today and had no way to
// know the underlying problem was fixed. A successful (non-empty) scan
// is still trusted for the full day, since it's expensive to produce and
// clearly means everything's working.
const EMPTY_SCAN_RETRY_MS = 20 * 60 * 1000;
// A cold cache used to start one full scan PER CALLER: the Today page asks for top picks, team
// picks and the prop board at once, and each would spend its own Odds credits on the same scan.
// Callers that arrive while a scan is running now share its result.
const slateScanInflight = {};
async function collectSlateResults(league) {
  const today = getToday();
  const cached = slateScanCache[league];
  if (cached && cached.dateKey === today && cached.v === SLATE_LOGIC_VERSION) {
    const isEmpty = !cached.data?.candidates?.length;
    if (!isEmpty || (Date.now() - (cached.ts || 0)) < EMPTY_SCAN_RETRY_MS) return cached.data;
  }
  // The nightly scan already skips itself when the Odds credits cannot cover it. A visitor opening the page must not be able to start
  // one and burn the last credits either (a scan that runs out half way is wasted). Nothing is cached, so it tries again once
  // credits are back. ODDS_ALLOW_LOW_CREDITS=1 overrides this.
  const budget = currentCreditBudget();
  if (budget.known && !budget.canScan && process.env.ODDS_ALLOW_LOW_CREDITS !== '1') return { candidates: [], results: [], skipped: 'low Odds credits' };
  if (!slateScanInflight[league]) {
    slateScanInflight[league] = scanSlate(league, today).finally(() => { delete slateScanInflight[league]; });
  }
  return slateScanInflight[league];
}

async function scanSlate(league, today) {
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
  slateScanCache[league] = { data, dateKey: today, ts: Date.now(), v: SLATE_LOGIC_VERSION };
  saveSlateScanCacheToDisk(slateScanCache);
  // Preseason picks cannot be graded (the stats feed has no preseason games), so they would only sit in the track record as noise.
  if (datachecks.inSeason(league, new Date())) autoLogSlatePicks(league, results);
  return data;
}

// ── AUTO-LOG — every real pick from the daily slate scan gets saved to
// the CLV tracker automatically (source:'auto'), independent of anyone
// using the Prop List. Without this, "does confidence actually predict
// hit rate" can never be answered — there just wasn't enough graded data,
// since only whatever a user happened to click "+ ADD TO LIST" on got
// tracked. Same "real edge only" cutoff as top-plays/team-picks (edge >=
// 1.0) — this logs exactly what the app actually recommends, not every
// candidate it merely looked at. Runs once per fresh (non-cached) scan;
// deduped against what's already logged today so a cache-miss retry
// can't double-log the same pick.
function autoLogSlatePicks(league, results) {
  const withEdge = (results || []).filter(r => Math.abs(r.edge) >= 1.0);
  if (!withEdge.length) return;
  const today = getToday();
  const entries = loadCLV();
  const already = new Set(entries
    .filter(e => e.source === 'auto' && e.date === today && e.league === league)
    .map(e => `${e.player}|${e.propType}|${e.line}`));
  let added = 0;
  for (const r of withEdge) {
    const key = `${r.player}|${r.propType}|${r.line}`;
    if (already.has(key)) continue;
    already.add(key);
    entries.unshift({
      id: nextId(), date: today, savedAt: new Date().toISOString(), league,
      player: r.player, opp: r.opponent, propType: r.propType, line: r.line,
      projection: r.projection, verdict: r.edge > 0 ? 'OVER' : 'UNDER',
      edge: r.edge, confidence: r.confidence,
      closingLine: null, result: null, actualStat: null, clv: null, notes: '',
      source: 'auto', confVersion: CONFIDENCE_FORMULA_VERSION,
      book: r.book ?? null, openConsensus: r.consensusLine ?? null,
      // What calibration and the backtest score later: the model's RAW chance for
      // the logged side, the price it was compared to, and the EV that implied.
      modelProb: r.realEdge?.modelProb ?? null, price: r.realEdge?.price ?? null, ev: r.realEdge?.expectedValue ?? null,
    });
    added++;
  }
  if (added) { saveCLV(entries); console.log(`[AutoLog] ${league}: logged ${added} picks for ${today}`); }
}

// ── AUTO-GRADE — fills in result/actualStat for every auto-logged pick
// whose game has already happened but hasn't been graded yet. Reuses the
// exact win/loss/push logic the manual Prop List auto-grade uses
// (checkOneProp in index.html), so a pick graded automatically and one
// graded by opening the Prop List always agree.
async function autoGradePendingPicks() {
  const today = getToday();
  const pending = loadCLV().filter(e => e.source === 'auto' && e.result == null && (!e.gradeNote || e.gradeNoteV !== GRADE_LOGIC_VERSION) && gradeDateOf(e) < today);
  if (!pending.length) return 'nothing waiting to grade';
  let graded = 0, unmatched = 0;
  const threeDaysAgo = toLocalDateStr(new Date(Date.now() - 3 * 86400000));
  // The network calls below take a while. The results are collected and applied to a fresh read at the
  // end: saving the list we started with would erase any pick saved or deleted in the meantime.
  const patches = new Map();
  for (const e of pending) {
    try {
      const stats = e.league === 'wnba' ? await fetchWNBAPlayerStats(e.player) : await fetchPlayerStats(e.player);
      if (!stats || stats.error) {
        // The player's stats could not be loaded. Retry for three days, then set it aside like an unmatched game, so it stops
        // counting as "waiting" forever.
        if (gradeDateOf(e) <= threeDaysAgo) { patches.set(e.id, { gradeNote: 'player stats could not be loaded after 3 days', gradeNoteV: GRADE_LOGIC_VERSION }); unmatched++; }
        continue;
      }
      const game = findGameForPick(stats, e);
      if (!game) {
        // Still no game in the log three days on (offseason stats feed, preseason game, player moved):
        // stop retrying and stop counting it as "waiting".
        if (gradeDateOf(e) <= threeDaysAgo) { patches.set(e.id, { gradeNote: 'no matching game in the stats log after 3 days', gradeNoteV: GRADE_LOGIC_VERSION }); unmatched++; }
        continue;
      }
      const actual = gradeStatValue(game, e.propType);
      const isOver  = e.verdict === 'OVER'  || e.verdict === 'LEAN_OVER';
      const isUnder = e.verdict === 'UNDER' || e.verdict === 'LEAN_UNDER';
      const result = actual === e.line ? 'PUSH' : isOver ? (actual > e.line ? 'WIN' : 'LOSS') : isUnder ? (actual < e.line ? 'WIN' : 'LOSS') : 'NO_BET';
      patches.set(e.id, { actualStat: actual, result });
      graded++;
    } catch (_) { /* leave ungraded — retried on tomorrow's run */ }
  }
  if (patches.size) {
    const fresh = loadCLV();
    for (const e of fresh) {
      const p = patches.get(e.id);
      if (p && e.result == null) Object.assign(e, p);   // skip anything that was graded by someone else meanwhile
    }
    saveCLV(fresh);
    console.log(`[AutoGrade] Graded ${graded} pending picks, gave up on ${unmatched}`);
  }
  return `graded ${graded} of ${pending.length} waiting${unmatched ? `, ${unmatched} had no matching game` : ''}`;
}

async function computeTopPlays(league) {
  const { candidates, results } = await collectSlateResults(league);

  // Only surface real edges — matches the app's existing "never bet on a
  // PASS-tier signal" rule (see calcEdgeScore/verdict thresholds elsewhere).
  const withEdge = results.filter(r => Math.abs(r.edge) >= 1.0);
  withEdge.sort((a, b) => (b.confidence - a.confidence) || (Math.abs(b.edge) - Math.abs(a.edge)));
  // One pick per player (their most confident prop) — the Top 3 was showing the same player twice.
  const seenPlayers = new Set();
  const onePerPlayer = withEdge.filter(r => !seenPlayers.has(r.player) && seenPlayers.add(r.player));

  return {
    league, generatedAt: new Date().toISOString(),
    scanned: candidates.length, evaluated: results.length,
    topPlays: onePerPlayer.slice(0, 3).map(r => ({
      player: r.player, playerId: lookupPlayerId(league, r.player), team: r.team, opponent: r.opponent,
      propType: r.propType, line: r.line, book: r.book,
      direction: r.edge > 0 ? 'OVER' : 'UNDER',
      projection: r.projection, edge: r.edge, confidence: r.confidence,
      overProbability: r.overProbability ?? null, underProbability: r.underProbability ?? null,
      consensusLine: r.consensusLine ?? null, bookCount: r.bookCount ?? null, marketEdge: r.marketEdge ?? null,
      realEdge: r.realEdge ?? null,
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
        team: r.team, player: r.player, playerId: lookupPlayerId(league, r.player), opponent: r.opponent,
        propType: r.propType, line: r.line, book: r.book,
        direction: r.edge > 0 ? 'OVER' : 'UNDER',
        projection: r.projection, edge: r.edge, confidence: r.confidence,
        overProbability: r.overProbability ?? null, underProbability: r.underProbability ?? null,
        consensusLine: r.consensusLine ?? null, bookCount: r.bookCount ?? null, marketEdge: r.marketEdge ?? null,
        realEdge: r.realEdge ?? null,
      })),
    })),
  };
}

// ── FALLBACK: TOP PROJECTED PERFORMERS (needs no odds API at all) ─────
// "Confident picks" needs a real posted line to evaluate against — with
// the odds API down there's no line, but the math model can still
// project real production for tonight's actual players and games.
// Reuses the same evaluateNBACandidate/evaluateWNBACandidate used by the
// real path — both already degrade a missing line to edge=0 and no
// probability rather than erroring, so passing line:null is safe. Only
// projection + confidence get surfaced here — no fabricated edge, no
// OVER/UNDER call, since there's no real line to be over/under against.
const fallbackProjectedCache = {}; // league -> { data, dateKey }
async function computeFallbackProjected(league) {
  const today = getToday();
  const cached = fallbackProjectedCache[league];
  if (cached && cached.dateKey === today) return cached.data;

  let gameList;
  if (league === 'wnba') {
    gameList = (await fetchWNBASchedule()).map(g => ({ home: g.home, away: g.away }));
  } else {
    if (!todaysGames.length) await fetchTodaysGames();
    gameList = todaysGames.map(g => ({ home: g.home_team.full_name, away: g.visitor_team.full_name }));
  }

  const evaluate = league === 'wnba' ? evaluateWNBACandidate : evaluateNBACandidate;
  if (!gameList.length) console.error(`[Fallback] ${league}: no games on today's schedule`);
  const byGame = [];
  for (const g of gameList) {
    const byTeam = {};
    for (const team of [g.home, g.away]) {
      try {
        const top = await getTopUsagePlayers(league, team, 2);
        if (!top.length) console.error(`[Fallback] ${league} ${team}: no players found in the stat files`);
        for (const p of top) {
          try {
            const r = await evaluate({ player: p.name, propType: 'points', line: null, book: null, homeTeam: g.home, awayTeam: g.away });
            if (!r || !r.projection) { console.error(`[Fallback] ${league} ${p.name}: no projection returned`); continue; }
            const existing = byTeam[r.team];
            if (!existing || (r.confidence || 0) > (existing.confidence || 0)) byTeam[r.team] = r;
          } catch (err) { console.error(`[Fallback] ${league} ${p.name}: ${err.message}`); /* one player shouldn't sink the rest */ }
        }
      } catch (err) { console.error(`[Fallback] ${league} ${team}: ${err.message}`); /* one team shouldn't sink the rest */ }
    }
    if (Object.keys(byTeam).length) byGame.push({ home: g.home, away: g.away, byTeam });
  }

  const allPicks = byGame.flatMap(g => Object.values(g.byTeam));
  allPicks.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  const data = {
    league, generatedAt: new Date().toISOString(), fallback: true,
    top3: allPicks.slice(0, 3).map(r => ({ player: r.player, playerId: lookupPlayerId(league, r.player), team: r.team, opponent: r.opponent, propType: r.propType, projection: r.projection, confidence: r.confidence })),
    games: byGame.map(g => ({
      home: g.home, away: g.away,
      picks: Object.values(g.byTeam).map(r => ({ team: r.team, player: r.player, playerId: lookupPlayerId(league, r.player), opponent: r.opponent, propType: r.propType, projection: r.projection, confidence: r.confidence })),
    })),
  };
  fallbackProjectedCache[league] = { data, dateKey: today };
  return data;
}

// A cached FALLBACK result gets the same short-retry treatment as an
// empty slate scan (see EMPTY_SCAN_RETRY_MS above) — real bug this fixed:
// once odds failed once in a day, a mid-day key fix/quota reset stayed
// invisible until midnight, because this layer also day-locked the
// fallback result with no way to notice the underlying problem was gone.
// A real successful result is still trusted for the full day.
function isCacheStillFresh(cached, today) {
  if (!cached || cached.dateKey !== today) return false;
  if (!cached.data?.fallback) return true;
  return (Date.now() - (cached.ts || 0)) < EMPTY_SCAN_RETRY_MS;
}

app.get('/api/top-plays', async (req, res) => {
  const league  = (req.query.league || 'nba').toLowerCase() === 'wnba' ? 'wnba' : 'nba';
  const today   = getToday();
  const cached  = topPlaysCache[league];
  if (isCacheStillFresh(cached, today)) {
    return res.json({ ...cached.data, cached: true });
  }
  const hasOddsKey = !!(process.env.ODDS_API_KEY && !process.env.ODDS_API_KEY.includes('your_'));
  let data = null, scanFailed = false;
  if (hasOddsKey) {
    try {
      data = await computeTopPlays(league);
      if (data.scanned === 0) scanFailed = true; // key present but nothing came back — quota exhaustion, most likely
    } catch (err) {
      console.error(`[TopPlays] ${league} scan failed:`, err.message);
      scanFailed = true;
    }
  }
  if (!hasOddsKey || scanFailed) {
    try {
      const fb = await computeFallbackProjected(league);
      const fallbackData = { league, generatedAt: fb.generatedAt, scanned: 0, evaluated: fb.top3.length, topPlays: [], fallback: true, fallbackPlays: fb.top3 };
      topPlaysCache[league] = { data: fallbackData, dateKey: today, ts: Date.now() };
      return res.json({ ...fallbackData, cached: false });
    } catch (err) {
      return res.status(500).json({ error: (hasOddsKey ? '' : 'No odds key configured. ') + 'Fallback projection also failed: ' + err.message });
    }
  }
  topPlaysCache[league] = { data, dateKey: today };
  res.json({ ...data, cached: false });
});

// Every scanned prop for the Today page's prop board: the same day-locked slate scan the top picks
// and team picks read (so it costs nothing extra), with the real-edge rule left to the page's filters.
app.get('/api/prop-board', async (req, res) => {
  const league = (req.query.league || 'nba').toLowerCase() === 'wnba' ? 'wnba' : 'nba';
  try {
    const { candidates, results } = await collectSlateResults(league);
    const all = (results || []).filter(r => r.realEdge || r.line != null).map(r => ({
        player: r.player, playerId: lookupPlayerId(league, r.player), team: r.team, opponent: r.opponent,
        homeTeam: r.homeTeam, awayTeam: r.awayTeam,
        propType: r.propType, line: r.line, book: r.book,
        direction: r.edge > 0 ? 'OVER' : r.edge < 0 ? 'UNDER' : 'PASS',
        projection: r.projection, edge: r.edge, confidence: r.confidence,
        overProbability: r.overProbability ?? null, underProbability: r.underProbability ?? null,
        consensusLine: r.consensusLine ?? null, bookCount: r.bookCount ?? null, realEdge: r.realEdge ?? null,
      }));
    // Free accounts and guests see the top of the board; Pro sees every prop.
    const limited = paywallOn() && !isProReq(req);
    res.json({ league, date: getToday(), scanned: (candidates || []).length, props: limited ? billingLib.freeBoard(all) : all, ...(limited ? { limited: true, total: all.length } : {}) });
  } catch (err) {
    res.json({ league, date: getToday(), scanned: 0, props: [], error: err.message });
  }
});

const teamPicksCache = {}; // league -> { data, dateKey, ts } — same freshness rule as topPlaysCache
app.get('/api/team-picks', async (req, res) => {
  const league = (req.query.league || 'nba').toLowerCase() === 'wnba' ? 'wnba' : 'nba';
  const today  = getToday();
  const cached = teamPicksCache[league];
  if (isCacheStillFresh(cached, today)) {
    return res.json({ ...cached.data, cached: true });
  }
  const hasOddsKey = !!(process.env.ODDS_API_KEY && !process.env.ODDS_API_KEY.includes('your_'));
  let data = null, scanFailed = false;
  if (hasOddsKey) {
    try {
      data = await computeTeamPicks(league);
      if (!data.games.length) scanFailed = true;
    } catch (err) {
      console.error(`[TeamPicks] ${league} scan failed:`, err.message);
      scanFailed = true;
    }
  }
  if (!hasOddsKey || scanFailed) {
    try {
      const fb = await computeFallbackProjected(league);
      const fallbackData = { league, generatedAt: fb.generatedAt, fallback: true, games: fb.games };
      teamPicksCache[league] = { data: fallbackData, dateKey: today, ts: Date.now() };
      return res.json({ ...fallbackData, cached: false });
    } catch (err) {
      return res.status(500).json({ error: (hasOddsKey ? '' : 'No odds key configured. ') + 'Fallback projection also failed: ' + err.message });
    }
  }
  teamPicksCache[league] = { data, dateKey: today };
  res.json({ ...data, cached: false });
});

// ─────────────────────────────────────────────────────
// CLAUDE PROXY
// ─────────────────────────────────────────────────────
// /api/analyze forwards whatever prompt it is sent to the paid Anthropic key, so anyone who can reach
// it can use that key. The app's own prompts are well under 30,000 characters; a daily ceiling
// (ANALYZE_DAILY_CAP, default 400) bounds the worst case. The admin is not capped.
// Only a local stand-in may replace the Anthropic address (used by the tests); the real key never goes anywhere else.
const ANTHROPIC_BASE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(process.env.ANTHROPIC_BASE_URL || '') ? process.env.ANTHROPIC_BASE_URL : 'https://api.anthropic.com';
let analyzeDay = '', analyzeCount = 0;
// `kind` says what the prompt is for. 'team' is the free written breakdown on Daily Matchups: its prompt must
// be the app's own template, so it cannot be used as a free general-purpose AI. 'prop' is the prop analyzer,
// which needs a ticket from /api/analysis/start while the paywall is on.
const TEAM_PROMPT_START = 'You are WIN AI. Write a short scouting read of';
app.post('/api/analyze', analyzeRateLimiter, (req, res, next) => {
  const kind = req.body?.kind === 'team' ? 'team' : 'prop';
  req.analyzeKind = kind;
  return kind === 'prop' ? analysisGate('ai')(req, res, next) : next();
}, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required' });
  if (prompt.length > 30000) return res.status(413).json({ error: 'Prompt too long.' });
  if (req.analyzeKind === 'team' && (!prompt.startsWith(TEAM_PROMPT_START) || prompt.length > 12000)) return res.status(400).json({ error: 'Not a team breakdown request.' });
  // Pro accounts have their own daily limit, so they do not count toward the shared ceiling.
  if (!isAdmin(req) && !(paywallOn() && isProReq(req))) {
    const today = getToday();
    if (analyzeDay !== today) { analyzeDay = today; analyzeCount = 0; }
    if (++analyzeCount > envNum(process.env.ANALYZE_DAILY_CAP, 400)) return res.status(429).json({ error: 'Daily AI analysis limit reached. It resets at midnight.' });
  }
  if (!process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_KEY.includes('your_')) {
    return res.status(500).json({ error: 'Anthropic API key not configured in .env' });
  }
  try {
    const claudeRes = await axios.post(
      `${ANTHROPIC_BASE}/v1/messages`,
      {
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      },
      { headers: { 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 60000 }
    );
    // The analysis counts toward the daily limit only now, once it has actually worked.
    if (req.analysisTicket) store.finishTicket(req.analysisTicket);
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
app.get('/api/debug-matchup', requireAdmin, async (req, res) => {
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
// Shared by the manual "clear all" route and the midnight cron — previously
// each only reset 5 of ~15 in-memory caches (projections/playerStats/
// bridge/rosters/nbaStats), so prop lines, shot charts, WNBA gamelogs,
// team schedules, position-defense, and the slate-scan/top-plays/team-
// picks/fallback caches could all still serve stale data after either a
// manual clear or the daily reset.
function clearAllCaches() {
  projectionCache  = {};
  playerStatsCache = {};
  lastPlayerStatsFetch = {};
  Object.keys(nbaApiBridgeCache).forEach(k => delete nbaApiBridgeCache[k]);
  rosterCache      = {};
  lastRosterFetch  = {};
  nbaStatsCache    = null;
  lastStatsDiskRead = 0;
  lineupCache      = null;
  wnbaStatsCache      = null;
  wnbaRosterCache     = {};
  lastWnbaRosterFetch = {};
  wnbaPlayerIndex     = {};
  wnbaTodaysGames  = [];
  lastWnbaSchedule = 0;
  playersListCache = {};
  Object.keys(posCategoryCache).forEach(k => delete posCategoryCache[k]);
  Object.keys(leaguePosCategoryCache).forEach(k => delete leaguePosCategoryCache[k]);
  Object.keys(teamScheduleCache).forEach(k => delete teamScheduleCache[k]);
  Object.keys(propLinesCache).forEach(k => delete propLinesCache[k]);
  Object.keys(oddsEventsCache).forEach(k => delete oddsEventsCache[k]);
  Object.keys(playerIdCache).forEach(k => delete playerIdCache[k]);
  Object.keys(injuryAbsenceCache).forEach(k => delete injuryAbsenceCache[k]);
  Object.keys(eventOddsCache).forEach(k => delete eventOddsCache[k]);
  Object.keys(wnbaGamelogCache).forEach(k => delete wnbaGamelogCache[k]);
  Object.keys(shotChartCache).forEach(k => delete shotChartCache[k]);
  Object.keys(topPlaysCache).forEach(k => delete topPlaysCache[k]);
  Object.keys(fallbackProjectedCache).forEach(k => delete fallbackProjectedCache[k]);
  Object.keys(teamPicksCache).forEach(k => delete teamPicksCache[k]);
  Object.keys(slateScanCache).forEach(k => delete slateScanCache[k]);
  saveSlateScanCacheToDisk(slateScanCache);
}

// Wiping the slate scan cache makes the next visitor trigger a paid re-scan, so this is admin only.
app.post('/api/cache-clear', requireAdmin, (req, res) => {
  const { target } = req.body || {};

  if (!target || target === 'all') {
    clearAllCaches();
    console.log('[Cache] ALL caches cleared by user request');
    return res.json({ ok: true, cleared: ['projections','playerStats','h2hBridge','rosters','nbaStats','propLines','shotCharts','wnbaGamelogs','teamSchedules','posDefense','slateScan','topPlays','teamPicks','fallbackProjected'] });
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

// ── ROSTER REFRESH ────────────────────────────────────────────────
// Force-clear all cached rosters so next request gets fresh data
app.post('/api/roster-refresh', requireAdmin, (req, res) => {
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
  // The page only reads the BallDontLie result. Which keys exist, which files are present and
  // cache sizes are for the admin.
  if (!isAdmin(req)) return res.json({ time: results.time, balldontlie: results.balldontlie });
  results.env = {
    balldontlie: !!process.env.BALLDONTLIE_KEY,
    anthropic: !!(process.env.ANTHROPIC_KEY && !process.env.ANTHROPIC_KEY.includes('your_')),
    oddsApi: !!process.env.ODDS_API_KEY,
    rapidApi: !!process.env.RAPIDAPI_KEY,
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


// The caches below are keyed by whatever player name a visitor types, and are only emptied at midnight. Cap them so a bot asking
// for endless made-up names cannot slowly use up the server's memory: past the limit the oldest entries are dropped.
const CACHE_CAP = 1500;
function capCache(c) { const k = Object.keys(c); if (k.length > CACHE_CAP) for (const key of k.slice(0, k.length - CACHE_CAP)) delete c[key]; }
setInterval(() => { for (const c of [projectionCache, playerStatsCache, lastPlayerStatsFetch, nbaApiBridgeCache, shotChartCache]) capCache(c); }, 5 * 60 * 1000).unref();

// ─────────────────────────────────────────────────────
// SCHEDULED JOBS
// ─────────────────────────────────────────────────────
cron.schedule('0 9 * * *', fetchTodaysGames);

// Auto-refresh nba.com stat files every morning at 7am
// This keeps playtypes, tracking, shot dashboard etc current
cron.schedule('0 7 * * *', () => {
  console.log('[CRON] Auto-running fetch_stats.py to refresh nba.com data...');
  const py = spawn('python3', ['fetch_stats.py'], { cwd: __dirname });
  py.stdout.on('data', d => console.log('[fetch_stats]', d.toString().trim()));
  py.stderr.on('data', d => console.error('[fetch_stats ERR]', d.toString().trim()));
  py.on('close', code => {
    jobRuns['stats-nba'] = { lastRun: new Date().toISOString(), ok: code === 0, error: code === 0 ? undefined : `exit code ${code}` };
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
    jobRuns['stats-wnba'] = { lastRun: new Date().toISOString(), ok: code === 0, error: code === 0 ? undefined : `exit code ${code}` };
    console.log(`[CRON] fetch_wnba_stats.py finished (exit ${code})`);
    wnbaStatsCache = null;
    lastWnbaStatsDiskRead = 0;
  });
});
cron.schedule('0 0 * * *', () => {                                                      // midnight reset
  clearAllCaches();
  console.log('[CRON] All caches cleared');
});
cron.schedule('0 12,17 * * *', () => { lastLineupFetch = null; fetchLineups(); });     // lineup refresh at noon + 5pm
cron.schedule('0 8,12,16 * * *', () => { rosterCache = {}; lastRosterFetch = {}; });         // roster refresh every morning
// Proactively runs (and thereby auto-logs) each day's slate scan even if
// nobody opens the app — accuracy tracking shouldn't depend on a visit.
// A full scan costs ~50-130 Odds API credits. If the budget can't cover one, skip it
// (and say so on the admin page) instead of starting a scan that dies half way.
cron.schedule('0 10 * * *', async () => {
  const b = currentCreditBudget();
  if (b.known && !b.canScan) {
    jobRuns['slate-scan'] = { lastRun: new Date().toISOString(), ok: true, detail: `skipped: ${b.remaining} credits left, a scan needs about ${b.scanCost}` };
    alerts.notify({ key: 'scan-skipped', level: 'warn', kind: 'budget', message: `Today's slate scan was skipped: ${b.remaining} Odds credits left, a scan needs about ${b.scanCost}.` }).catch(() => {});
    return;
  }
  await Promise.allSettled(['nba', 'wnba'].map(lg => trackJob('slate-scan-' + lg, () => collectSlateResults(lg).then(() => 'scanned'))()
    .catch(err => console.error(`[AutoLog] ${lg} scan failed:`, err.message))));
});
// Closing-line capture — cheap tick (the events list is free); only spends
// odds requests within CLOSING_WINDOW_MIN of a tip-off with pending picks.
const trackedClosing = trackJob('closing-lines', captureClosingLines);
cron.schedule('*/5 * * * *', () => trackedClosing().catch(err => console.error('[Closing] failed:', err.message)));
setTimeout(() => trackedClosing().catch(err => console.error('[Closing] failed:', err.message)), 20000);
// Well after any real-world game could still be in progress — grades
// everything auto-logged for days that have already fully passed.
// The daily pipeline: grade finished games, refit the calibrator on the graded history,
// then score everything for the backtest report.
cron.schedule('0 6 * * *', () => runDailyPipeline().catch(err => console.error('[Pipeline] failed:', err.message)));
cron.schedule('0 3 * * *', () => trackJob('backup', async () => `wrote ${path.basename(store.backup(path.join(__dirname, 'backups')) || 'nothing (no file database)')}`)().catch(err => console.error('[Backup] failed:', err.message)));
cron.schedule('5 3 * * *', () => trackJob('offsite-backup', async () => { const r = await uploadOffsite(); return `uploaded ${r.key} (${Math.round(r.bytes / 1024)} KB)`; })().catch(err => { console.error('[Offsite] failed:', err.message); }));
// The credit count only used to update when a real odds request happened, so after adding credits the app kept believing it
// was out until something spent one. The /sports call is free (it costs 0 credits and still returns the balance), so asking
// it hourly keeps the count true, and lifts the "paused" state as soon as credits exist again.
async function refreshOddsCredits() {
  if (!oddsKeyConfigured()) return 'no odds key set';
  const r = await axios.get(`${ODDS_BASE}/sports`, { params: { apiKey: process.env.ODDS_API_KEY }, timeout: 12000 });   // the response interceptor records x-requests-remaining
  return `${r.headers['x-requests-remaining'] ?? '?'} credits left`;
}
cron.schedule('7 * * * *', () => trackJob('odds-credits', refreshOddsCredits)().catch(err => console.error('[Odds] credit check failed:', err.message)));
setTimeout(() => trackJob('odds-credits', refreshOddsCredits)().catch(err => console.error('[Odds] credit check failed:', err.message)), 6000);
cron.schedule('*/15 * * * *', () => runHealthCheck().catch(err => console.error('[Health] failed:', err.message)));
setTimeout(() => initAdminJobs().catch(err => console.error('[Init] failed:', err.message)), 4000);

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
// ACCOUNTS — email and password, plus Google (lib/auth.js). Visitors browse as guests; an account is only
// needed to save props, and every saved prop belongs to the account that saved it. Picks the system
// logs itself (source 'auto') have no owner: everyone can read them, only the admin can change them.
// ═══════════════════════════════════════════════════════════════════
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const USER_MAX_PROPS = envNum(process.env.USER_MAX_PROPS, 300);
const isLoopback = ip => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(String(ip || ''));
const mailer = createMailer({
  apiKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM,
  // Resend explains a refusal in its reply (an unverified domain, a test sender used for someone else, a bad key).
  // That reason is logged and shown to the admin, so a failed email is never a mystery.
  post: async (url, body, cfg) => {
    try { const r = await axios.post(url, body, { timeout: 10000, ...cfg }); store.setMeta('mail:last_error', ''); return r; }
    catch (err) {
      const why = `${err.response?.status || ''} ${err.response?.data?.message || err.response?.data?.error || err.message}`.trim().slice(0, 300);
      store.setMeta('mail:last_error', JSON.stringify({ at: new Date().toISOString(), why }));
      throw new Error(`Resend refused it: ${why}`);
    }
  },
  log: m => console.log(m), devLinks: process.env.AUTH_DEV_LINKS === '1' && process.env.NODE_ENV !== 'production',
});
// EMAIL_CONFIRMATION=off: people sign up and are in straight away, and no confirmation email is sent or asked for. Turn it back
// on (remove the line) once emails can be delivered to anyone, which needs a verified sending domain at Resend.
const CONFIRM_REQUIRED = String(process.env.EMAIL_CONFIRMATION || 'on').toLowerCase() !== 'off';
const auth = createAuth({
  confirmEmails: CONFIRM_REQUIRED,
  store, send: m => mailer.send(m), adminEmail: process.env.ADMIN_EMAIL, devLinks: mailer.devLinks, log: m => console.log(m),
  extraBlocked: String(process.env.BLOCKED_EMAIL_DOMAINS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean),
});
// Google sign-in needs only the public client id (Google Cloud Console > Credentials > OAuth client ID, Web).
const GOOGLE_CLIENT_ID = /^[\w.-]+\.apps\.googleusercontent\.com$/.test(process.env.GOOGLE_CLIENT_ID || '') ? process.env.GOOGLE_CLIENT_ID : '';
// Only a local stand-in may replace Google's key address (used by the tests).
const GOOGLE_JWKS_URL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(process.env.GOOGLE_JWKS_URL || '') ? process.env.GOOGLE_JWKS_URL : 'https://www.googleapis.com/oauth2/v3/certs';
// The redirect flow also needs the client SECRET (kept on the server only) to trade Google's one-time code for the signed note.
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
// Only a local stand-in may replace Google's token address (used by the tests).
const GOOGLE_TOKEN_URL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(process.env.GOOGLE_TOKEN_URL || '') ? process.env.GOOGLE_TOKEN_URL : 'https://oauth2.googleapis.com/token';
const googleVerifier = GOOGLE_CLIENT_ID ? createGoogleVerifier({
  clientId: GOOGLE_CLIENT_ID,
  fetchJwks: async () => {
    const r = await axios.get(GOOGLE_JWKS_URL, { timeout: 8000 });
    return { keys: r.data.keys || [], maxAgeSec: Number(/max-age=(\d+)/.exec(r.headers['cache-control'] || '')?.[1]) || 3600 };
  },
}) : null;
function authStatus() {
  if (!store.supportsAccounts) return { enabled: false, methods: { password: false, google: false, mail: false }, mailReady: false, detail: 'Accounts need the SQLite database. This server is on the JSON fallback (use Node 22.13 or newer).' };
  const mail = mailer.configured ? !!PUBLIC_URL : mailer.devLinks;
  const googleOn = !!(googleVerifier && GOOGLE_CLIENT_SECRET);
  const methods = { password: true, google: googleOn, mail, confirm: CONFIRM_REQUIRED };
  const mailDetail = mailer.configured
    ? (PUBLIC_URL ? 'Confirmation and reset emails are set up.' : 'Set PUBLIC_URL to your site address (for example https://yourapp.up.railway.app) so the links in emails point to the right place. Until then confirmation and reset emails are NOT sent.')
    : mailer.devLinks ? 'Development mode: confirmation and reset links are printed in the server log, not emailed. Never use AUTH_DEV_LINKS on a public site.'
    : 'Email is not set up (add RESEND_API_KEY, MAIL_FROM and PUBLIC_URL). People can sign up, but nobody can confirm an address or reset a password.';
  const googleDetail = googleOn ? ', and so is Google' : googleVerifier ? '. Google sign-in is NOT on: GOOGLE_CLIENT_SECRET is missing' : '';
  let lastMailError = null;
  try { const e = JSON.parse(store.getMeta('mail:last_error') || 'null'); if (e && Date.now() - new Date(e.at).getTime() < 24 * 3600e3) lastMailError = e.why; } catch (_) {}
  const confirmDetail = CONFIRM_REQUIRED ? '' : ' Email confirmation is OFF (EMAIL_CONFIRMATION=off): people sign up and are in straight away. Password reset emails still need working email.';
  return { enabled: true, methods, confirmRequired: CONFIRM_REQUIRED, mailReady: mail && !lastMailError, lastMailError, detail: `Email and password sign-in is on${googleDetail}.${confirmDetail} ${lastMailError ? `The last email could not be sent: ${lastMailError}` : mailDetail}` };
}
// The address in a sign-in email must never come from the request, or a forged Host header could point a
// victim's link at another site. In development (links printed, not emailed) only loopback requests may use it.
function authBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  return mailer.devLinks && isLoopback(req.ip) ? `${req.protocol}://${req.get('host')}` : null;
}
const isSecureReq = req => !!req.secure || PUBLIC_URL.startsWith('https://');
const authBlocks = [];   // when a sign-in limit blocked someone, for the admin Users tab
const noteBlock = () => { authBlocks.push(Date.now()); if (authBlocks.length > 2000) authBlocks.splice(0, 1000); };
const authLoginLimiter = security.createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30, onBlock: noteBlock, message: 'Too many sign-in attempts. Try again in a few minutes.' });
const authSignupLimiter = security.createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, onBlock: noteBlock, message: 'Too many accounts created from this connection. Try again later.' });
const authForgotLimiter = security.createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, onBlock: noteBlock, message: 'Too many reset requests. Try again in a few minutes.' });
const authVerifyLimiter = security.createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30, onBlock: noteBlock, message: 'Too many attempts. Try again in a few minutes.' });

app.use(['/api/auth', '/api/account', '/api/clv', '/api/billing', '/api/analysis'], (req, res, next) => (req.method === 'GET' || req.method === 'HEAD') ? next() : security.sameOrigin(req, res, next));
function requireUser(req, res, next) {
  if (!authStatus().enabled) return res.status(503).json({ error: 'Sign-in is not set up on this server yet.', code: 'auth_disabled' });
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.', code: 'auth_required' });
  next();
}

app.get('/api/auth/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const on = paywallOn(), info = req.user ? planFor(req) : null;
  res.json({
    enabled: authStatus().enabled, methods: { password: authStatus().methods.password, mail: authStatus().mailReady, confirm: CONFIRM_REQUIRED, google: authStatus().methods.google },
    user: req.user ? { email: req.user.email, name: req.user.name || null, emailVerified: !!req.user.email_verified_at } : null, maxProps: USER_MAX_PROPS,
    ...(req.user ? { rg: rgView(req.user) } : {}),
    paywall: on,
    ...(on && req.user ? {
      plan: info.plan,
      billing: { status: info.status, renewsAt: info.renewsAt, cancelAtPeriodEnd: info.cancelAtPeriodEnd, comped: info.comped, canManage: info.hasCustomer },
      quota: { used: store.analysesDone(req.user.id, getToday()), limit: info.plan === 'pro' ? PRO_DAILY_ANALYSES : FREE_DAILY_ANALYSES },
    } : {}),
  });
});
const mailBase = req => (authStatus().methods.mail ? authBaseUrl(req) : null);
const authFail = (res, r) => res.status(r.status).json({ error: r.error, ...(r.field ? { field: r.field } : {}), ...(r.code ? { code: r.code } : {}), ...(r.locked ? { locked: true } : {}), ...(r.problems ? { problems: r.problems } : {}), ...(r.retryAfterSec ? { retryAfterSec: r.retryAfterSec } : {}) });
const startSession = (req, res, r, extra = {}) => {
  res.set('Set-Cookie', sessionCookie(r.sessionToken, { secure: isSecureReq(req) }));
  res.json({ ok: true, email: r.user.email, name: r.user.name || null, emailVerified: !!r.user.email_verified_at, created: r.created, claimed: r.claimed, ...extra });
};
const devOnly = (req, r) => (r.devLink && isLoopback(req.ip) ? { devLink: r.devLink } : {});
// Sign up: the account is made and the person is signed in. The confirmation email goes out only now, after sign-up.
app.post('/api/auth/signup', authSignupLimiter, async (req, res) => {
  const b = req.body || {};
  const r = await auth.signUp({ name: b.name, email: b.email, password: b.password, ageConfirmed: b.ageConfirmed === true, baseUrl: mailBase(req), ip: req.ip });
  if (r.error) return authFail(res, r);
  startSession(req, res, r, { emailSent: r.emailSent, ...devOnly(req, r) });
});
app.post('/api/auth/login', authLoginLimiter, async (req, res) => {
  const r = await auth.signIn({ email: req.body?.email, password: req.body?.password, ip: req.ip });
  if (r.error) return authFail(res, r);
  startSession(req, res, r);
});
// Always answers the same, whether or not the address has an account.
app.post('/api/auth/forgot', authForgotLimiter, async (req, res) => {
  const r = await auth.requestReset({ email: req.body?.email, baseUrl: mailBase(req), ip: req.ip });
  if (r.error) return authFail(res, r);
  res.json({ ok: true, ...devOnly(req, r) });
});
app.post('/api/auth/reset', authVerifyLimiter, async (req, res) => {
  const r = await auth.resetPassword({ token: req.body?.token, password: req.body?.password, ip: req.ip });
  if (r.error) return authFail(res, r);
  startSession(req, res, r);
});
app.post('/api/auth/confirm', authVerifyLimiter, (req, res) => {
  const r = auth.confirmEmail({ token: req.body?.token });
  if (r.error) return authFail(res, r);
  res.json({ ok: true, email: r.email, signedIn: !!req.user && req.user.email === r.email });
});
const resendLimiter = security.createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Try again in a few minutes.' });
app.post('/api/auth/resend-confirmation', requireUser, resendLimiter, async (req, res) => {
  const r = await auth.resendConfirmation(req.user, { baseUrl: mailBase(req), ip: req.ip });
  if (r.error) return authFail(res, r);
  res.json({ ok: true, alreadyConfirmed: !!r.alreadyConfirmed, ...devOnly(req, r) });
});
// The links in the emails open this page. It asks for one tap before it does anything, so mail scanners that
// pre-open links cannot use up a one-time link before the person ever sees it.
app.get(['/auth/confirm', '/auth/reset'], (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'auth-link.html')); });
// ── Sign in with Google: the full-page flow ──
// 1. The button sends the person to /auth/google/start, which sends them on to Google's own sign-in page.
// 2. They sign in there. Google sends them back to /auth/google/callback with a one-time code.
// 3. The server trades the code (plus its secret) for a signed note, checks it, makes or finds the account, signs the
//    person in and sends them to the app. Their Google password never touches this site.
// The `state` ties the return trip to the browser that started it, and the code is bound to a PKCE secret and a nonce, so a
// code someone else obtained cannot be replayed here.
const googleStates = new Map();                       // hash(state) -> { nonce, verifier, ageConfirmed, at }
const GSTATE_COOKIE = 'winai_gstate', GSTATE_TTL_MS = 10 * 60 * 1000;
const googleReturnBase = req => PUBLIC_URL || (isLoopback(req.ip) ? `${req.protocol}://${req.get('host')}` : null);
const b64url = buf => Buffer.from(buf).toString('base64url');
const backToApp = (res, qs) => { res.set('Cache-Control', 'no-store'); res.redirect(302, '/?' + new URLSearchParams(qs).toString()); };
const gStateCookie = (value, req, maxAge) => `${GSTATE_COOKIE}=${value}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecureReq(req) ? '; Secure' : ''}`;
// Too many starts from one connection: come back to the app with a note, not a page of raw JSON.
const googleStartLimit = security.createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30, onBlock: noteBlock });
const googleStartLimiter = (req, res, next) => googleStartLimit(req, { set() {}, status: () => ({ json: () => backToApp(res, { signin_error: 'busy' }) }) }, next);
app.get('/auth/google/start', googleStartLimiter, (req, res) => {
  const base = authStatus().methods.google ? googleReturnBase(req) : null;
  if (!base) return backToApp(res, { signin_error: 'google_off' });
  for (const [k, v] of googleStates) if (Date.now() - v.at > GSTATE_TTL_MS) googleStates.delete(k);
  if (googleStates.size > 5000) return backToApp(res, { signin_error: 'failed' });
  const state = newToken(), nonce = newToken(), verifier = b64url(crypto.randomBytes(48));
  googleStates.set(sha(state), { nonce, verifier, ageConfirmed: req.query.age === '1', at: Date.now() });
  const url = new URL(process.env.GOOGLE_AUTH_URL && /^http:\/\/(localhost|127\.0\.0\.1)/.test(process.env.GOOGLE_AUTH_URL) ? process.env.GOOGLE_AUTH_URL : 'https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: `${base}/auth/google/callback`, response_type: 'code', scope: 'openid email profile',
    state, nonce, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', prompt: 'select_account',
  }).toString();
  res.set({ 'Set-Cookie': gStateCookie(state, req, GSTATE_TTL_MS / 1000), 'Cache-Control': 'no-store' });
  res.redirect(302, url.toString());
});
app.get('/auth/google/callback', async (req, res) => {      // needs the matching cookie and state, so it is bounded by the start limit
  const cookies = parseCookiesHeader(req.headers.cookie), state = String(req.query.state || '');
  res.append('Set-Cookie', gStateCookie('', req, 0));                                                // the state is single use either way
  const rec = state && cookies[GSTATE_COOKIE] === state ? googleStates.get(sha(state)) : null;
  if (rec) googleStates.delete(sha(state));
  if (!rec || Date.now() - rec.at > GSTATE_TTL_MS) return backToApp(res, { signin_error: 'failed' });
  if (req.query.error) return backToApp(res, { signin_error: req.query.error === 'access_denied' ? 'cancelled' : 'failed' });
  const base = googleReturnBase(req);
  if (!base || !googleVerifier || typeof req.query.code !== 'string' || req.query.code.length > 2048) return backToApp(res, { signin_error: 'failed' });
  try {
    const t = await axios.post(GOOGLE_TOKEN_URL, new URLSearchParams({ code: req.query.code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: `${base}/auth/google/callback`, grant_type: 'authorization_code', code_verifier: rec.verifier }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
    const g = await googleVerifier.verify(t.data?.id_token);
    if (g.nonce !== rec.nonce) throw new Error('nonce does not match');
    const r = auth.signInVerified({ email: g.email, name: g.name, ageConfirmed: rec.ageConfirmed });
    if (r.error) return backToApp(res, { signin_error: r.code === 'age_required' ? 'age_required' : r.status === 403 ? 'disabled' : 'failed' });
    res.append('Set-Cookie', sessionCookie(r.sessionToken, { secure: isSecureReq(req) }));
    backToApp(res, { welcome: r.created ? 'new' : 'back' });
  } catch (err) { console.error('[Auth] Google sign-in failed:', err.response?.data?.error || err.message); backToApp(res, { signin_error: 'failed' }); }
});
app.post('/api/auth/logout', (req, res) => {
  auth.logout(req.headers.cookie);
  res.set('Set-Cookie', clearCookie({ secure: isSecureReq(req) }));
  res.json({ ok: true });
});
// Everything the account holds, as a file.
// Change the password while signed in: needs the current one, signs out every other device, keeps this one signed in.
app.post('/api/account/password', requireUser, authLoginLimiter, async (req, res) => {
  const b = req.body || {};
  const r = await auth.changePassword({ user: req.user, current: b.current, password: b.password, ip: req.ip });
  if (r.error) return authFail(res, r);
  startSession(req, res, r, { changed: true });
});
app.post('/api/account/sign-out-others', requireUser, writeLimiter, (req, res) => {
  const r = auth.signOutOthers(req.user);
  if (r.error) return authFail(res, r);
  startSession(req, res, r, { signedOutOthers: true });
});
app.get('/api/account/export', requireUser, (req, res) => {
  res.set({ 'Content-Disposition': 'attachment; filename="winai-my-data.json"', 'Cache-Control': 'no-store' });
  res.json({ email: req.user.email, name: req.user.name || null, emailConfirmed: !!req.user.email_verified_at, createdAt: req.user.created_at, exportedAt: new Date().toISOString(), props: store.picksForUser(req.user.id) });
});
// Deletes the account and every prop it saved. There is no undo and nothing is kept.
app.post('/api/account/delete', requireUser, async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirm the deletion first.' });
  // A live subscription is cancelled first, so deleting an account never leaves someone being charged.
  const b = store.getBilling(req.user.id);
  if (b?.subscription_id && ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(b.status)) {
    if (!stripe) return res.status(409).json({ error: 'Cancel your subscription first (Manage subscription), then delete your account.' });
    try { await stripe.cancelSubscription(b.subscription_id); }
    catch (err) {
      if (!/ 404/.test(err.message)) { console.error('[Billing] cancel on delete failed:', err.message); return res.status(502).json({ error: 'We could not cancel your subscription, so nothing was deleted. Cancel it from Manage subscription, then try again.' }); }
    }
  }
  const r = store.deleteUser(req.user.id);
  res.set('Set-Cookie', clearCookie({ secure: isSecureReq(req) }));
  res.json({ ok: true, propsDeleted: r.props });
});
const userPicks = id => (store.supportsAccounts ? store.picksForUser(id) : []);
const systemPicks = () => (store.supportsAccounts ? store.systemPicks() : loadCLV().filter(e => e.source === 'auto'));

// ═══════════════════════════════════════════════════════════════════
// BILLING — Pro subscriptions through Stripe (lib/billing.js). Stripe's own pages take the card; this server
// only learns the result from a signed webhook. PAYWALL=on turns the limits on, and only once Stripe is fully
// set up, so a half-finished setup can never lock anyone out. With it off, everyone has everything.
// ═══════════════════════════════════════════════════════════════════
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE = process.env.STRIPE_PRICE_ID || '';
const STRIPE_PRICE_YEARLY = process.env.STRIPE_PRICE_ID_YEARLY || '';
// Only a local stand-in may replace Stripe's address (used by the tests).
const STRIPE_BASE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(process.env.STRIPE_API_BASE || '') ? process.env.STRIPE_API_BASE : 'https://api.stripe.com';
const FREE_DAILY_ANALYSES = envNum(process.env.FREE_DAILY_ANALYSES, 1);
const PRO_DAILY_ANALYSES = envNum(process.env.PRO_DAILY_ANALYSES, 100);
const stripeHttp = async (method, url, form, headers) => {
  const r = await axios({ method, url, data: form || undefined, headers: { ...headers, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, timeout: 15000, validateStatus: () => true });
  if (r.status >= 400) throw new Error(`Stripe ${r.status}: ${r.data?.error?.message || 'request failed'}`);
  return r.data;
};
const stripe = STRIPE_KEY ? billingLib.createStripeClient({ secretKey: STRIPE_KEY, base: STRIPE_BASE, http: stripeHttp }) : null;
function billingStatus() {
  const missing = [];
  if (!STRIPE_KEY) missing.push('STRIPE_SECRET_KEY');
  if (!STRIPE_WEBHOOK_SECRET) missing.push('STRIPE_WEBHOOK_SECRET');
  if (!STRIPE_PRICE) missing.push('STRIPE_PRICE_ID');
  const requested = process.env.PAYWALL === 'on';
  return { requested, configured: !missing.length, missing, on: requested && !missing.length && authStatus().enabled && (authStatus().methods.mail || !CONFIRM_REQUIRED),
    mode: STRIPE_KEY ? (/^(sk|rk)_test_/.test(STRIPE_KEY) ? 'test' : 'live') : null, lastWebhookAt: store.getMeta('stripe:last_event_at') };
}
const paywallOn = () => billingStatus().on;
const planFor = req => {
  const info = billingLib.planInfo(req.user, req.user ? store.getBilling(req.user.id) : null);
  if (req.user && auth.isAdminEmail(req.user.email)) { info.plan = 'pro'; info.owner = true; }   // the owner always has everything
  return info;
};
const isProReq = req => isAdmin(req) || (!!req.user && planFor(req).plan === 'pro');
const FEATURE_NAME = { prop_list: 'The Prop List', analyzer: 'The prop analyzer', prop_board: 'The full Prop Board' };
function requirePro(feature) {
  return (req, res, next) => {
    if (!paywallOn() || isProReq(req)) return next();
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.', code: 'auth_required' });
    return res.status(402).json({ error: `${FEATURE_NAME[feature] || 'This'} is a Pro feature.`, code: 'pro_required', feature });
  };
}
const returnBase = req => PUBLIC_URL || (isLoopback(req.ip) ? `${req.protocol}://${req.get('host')}` : null);
const safeStripeUrl = u => { try { const x = new URL(u); return (x.protocol === 'https:' && /(^|\.)stripe\.com$/.test(x.hostname)) || (STRIPE_BASE !== 'https://api.stripe.com' && /^(localhost|127\.0\.0\.1)$/.test(x.hostname)); } catch (_) { return false; } };

// ── analysis tickets: one per analysis, so the daily limit counts analyses and not requests ──
const TICKET_TTL_MS = 5 * 60 * 1000, TICKET_CTX_MAX = 4, TICKET_AI_MAX = 2;
const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const analysisStartLimiter = security.createRateLimiter({ windowMs: 60 * 1000, max: 20, message: 'Too many analyses started. Wait a moment.' });
app.post('/api/analysis/start', analysisStartLimiter, (req, res) => {
  const planGate = paywallOn() && !isAdmin(req);
  const eff = req.user ? rg.effective(rgRow(req.user)) : null;
  const rgOn = !!eff && (eff.dailyLimit != null || eff.restricted || !!eff.pending);
  if (!planGate && !rgOn) return res.json({ ticket: null, unlimited: true });
  if (!req.user) return res.status(401).json({ error: 'Sign in to run an analysis.', code: 'auth_required' });
  if (eff.restricted) return res.status(403).json(rgBreakBody(eff));
  const pro = isProReq(req), planLimit = planGate ? (pro ? PRO_DAILY_ANALYSES : FREE_DAILY_ANALYSES) : Infinity, day = getToday();
  const limit = Math.min(planLimit, eff.dailyLimit ?? Infinity);
  const used = store.analysesDone(req.user.id, day);
  if (used >= limit) {
    if (eff.dailyLimit != null && eff.dailyLimit <= planLimit) return res.status(403).json({ error: `You have reached the daily limit you set (${eff.dailyLimit}). It resets at midnight.`, code: 'rg_limit', quota: { used, limit } });
    return res.status(402).json(pro
      ? { error: `You have used today's ${limit} analyses. The limit resets at midnight.`, code: 'daily_limit', feature: 'analyzer', quota: { used, limit } }
      : { error: "You've used today's free analysis. Pro removes the daily limit.", code: 'pro_required', feature: 'analyzer', quota: { used, limit } });
  }
  // A person who keeps starting analyses without finishing one is stopped, so the data routes cannot be farmed.
  if (store.ticketsStarted(req.user.id, day) >= Math.min(limit, 100) * (pro ? 2 : 5) + 3) return res.status(429).json({ error: 'Too many analyses started today.', code: 'daily_limit', quota: { used, limit } });
  const ticket = newToken();
  store.startTicket({ hash: sha(ticket), userId: req.user.id, day, expiresAt: new Date(Date.now() + TICKET_TTL_MS).toISOString() });
  res.json({ ticket, quota: { used, limit: Number.isFinite(limit) ? limit : null } });
});
// Checks the ticket on a data route ('ctx') or the AI route ('ai'). Needed while the paywall is on, and for anyone
// who has set a limit or a break on themselves, whether or not the paywall is on.
function analysisGate(use) {
  return (req, res, next) => {
    const eff = req.user ? rg.effective(rgRow(req.user)) : null;
    if (eff?.restricted) return res.status(403).json(rgBreakBody(eff));
    const rgOn = !!eff && (eff.dailyLimit != null || !!eff.pending);
    if (!(paywallOn() && !isAdmin(req)) && !rgOn) return next();
    if (!req.user) return res.status(401).json({ error: 'Sign in to run an analysis.', code: 'auth_required' });
    const t = String(req.get('x-analysis-ticket') || '');
    const row = TICKET_SHAPE.test(t) ? store.getTicket(sha(t)) : null;
    if (!row || row.user_id !== req.user.id) return res.status(403).json({ error: 'Start the analysis again.', code: 'ticket_required' });
    if (!store.useTicket(row.hash, use, use === 'ctx' ? TICKET_CTX_MAX : TICKET_AI_MAX)) return res.status(403).json({ error: 'Start the analysis again.', code: 'ticket_required' });
    if (use === 'ai') req.analysisTicket = row.hash;
    next();
  };
}

// ── responsible gambling: limits and breaks people set on themselves. Free for everyone, never paid. ──
// An active break or exclusion also follows the email, so deleting the account and signing up again does not end it.
function rgRow(user) {
  let row = store.getRg(user.id);
  const hold = store.holdFor(user.email);
  if (hold && !(row?.restricted_until && row.restricted_until >= hold.until)) row = store.saveRg(user.id, { restricted_until: hold.until, restriction_kind: hold.kind || 'exclusion', restricted_at: new Date().toISOString() });
  return row;
}
function rgBreakBody(eff) {
  const until = new Date(eff.until).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return { error: eff.kind === 'exclusion' ? `You chose to step away until ${until}. The analyzer and Prop List are paused.` : `You are on a break until ${until}. The analyzer and Prop List are paused.`, code: 'rg_break', kind: eff.kind, until: eff.until };
}
function rgView(user) {
  const row = rgRow(user), e = rg.effective(row);
  return { dailyLimit: e.dailyLimit, pending: e.pending, restricted: e.restricted, kind: e.kind, until: e.until, reminderMinutes: row?.reminder_minutes || 0, usedToday: store.analysesDone(user.id, getToday()) };
}
function rgBlock(req, res, next) {
  const eff = req.user ? rg.effective(rgRow(req.user)) : null;
  return eff?.restricted ? res.status(403).json(rgBreakBody(eff)) : next();
}
app.get('/api/account/rg', requireUser, (req, res) => { res.set('Cache-Control', 'no-store'); res.json(rgView(req.user)); });
app.post('/api/account/rg/limit', requireUser, writeLimiter, (req, res) => {
  const raw = req.body?.limit;
  const r = rg.planLimitChange(rgRow(req.user), raw === null ? null : (typeof raw === 'number' ? raw : NaN));
  if (r.error) return res.status(400).json({ error: r.error });
  if (Object.keys(r.patch).length) store.saveRg(req.user.id, r.patch);
  res.json({ ...rgView(req.user), appliesAt: r.appliesAt });
});
app.post('/api/account/rg/break', requireUser, writeLimiter, (req, res) => {
  const kind = req.body?.kind === 'exclusion' ? 'exclusion' : req.body?.kind === 'break' ? 'break' : null;
  const r = kind ? rg.planRestriction(rgRow(req.user), kind, Number(req.body?.amount)) : { error: 'Choose a break or self-exclusion.' };
  if (r.error) return res.status(400).json({ error: r.error });
  store.saveRg(req.user.id, r.patch);
  store.addEvent('rg', 'info', `${kind} set (user ${req.user.id})`);
  res.json(rgView(req.user));
});
app.post('/api/account/rg/reminder', requireUser, writeLimiter, (req, res) => {
  const m = req.body?.minutes;
  if (![0, 15, 30, 60].includes(m)) return res.status(400).json({ error: 'Choose off, 15, 30 or 60 minutes.' });
  store.saveRg(req.user.id, { reminder_minutes: m });
  res.json(rgView(req.user));
});

// ── price shown on the upgrade sheet (cached; the price itself lives in Stripe) ──
let priceCache = { at: 0, price: null };
async function currentPrice() {
  if (!stripe || !STRIPE_PRICE) return null;
  if (Date.now() - priceCache.at < 3600e3) return priceCache.price;
  try { priceCache = { at: Date.now(), price: await stripe.getPrice(STRIPE_PRICE) }; } catch (err) { console.error('[Billing] price lookup failed:', err.message); priceCache = { at: Date.now() - 3300e3, price: priceCache.price }; }
  return priceCache.price;
}
app.get('/api/billing/plans', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const on = paywallOn();
  const price = on ? await currentPrice() : null;
  res.json({ paywall: on, price: price ? { label: billingLib.priceLabel(price), interval: price.recurring?.interval || null } : null, freeDailyAnalyses: FREE_DAILY_ANALYSES, proDailyAnalyses: PRO_DAILY_ANALYSES, maxProps: USER_MAX_PROPS });
});
const checkoutLimiter = security.createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Try again in a few minutes.' });
app.post('/api/billing/checkout', requireUser, checkoutLimiter, async (req, res) => {
  if (!paywallOn() || !stripe) return res.status(503).json({ error: 'Payments are not turned on yet.' });
  const base = returnBase(req);
  if (!base) return res.status(503).json({ error: 'The site address is not set up for payments yet.' });
  const info = planFor(req);
  if (CONFIRM_REQUIRED && !req.user.email_verified_at && !info.owner) return res.status(403).json({ error: 'Confirm your email first. We sent a link when you signed up.', code: 'email_unverified' });
  try {
    let customer = store.getBilling(req.user.id)?.customer_id;
    if (info.plan === 'pro' && !info.comped && !info.owner && customer) {          // already subscribed: send them to manage it
      const p = await stripe.createPortalSession({ customer, returnUrl: `${base}/` });
      return res.json({ url: p.url, already: true });
    }
    if (!customer) { const c = await stripe.createCustomer({ email: req.user.email, userId: req.user.id }); customer = c.id; store.setCustomer(req.user.id, customer); }
    const priceId = req.body?.interval === 'year' && STRIPE_PRICE_YEARLY ? STRIPE_PRICE_YEARLY : STRIPE_PRICE;
    const session = await stripe.createCheckoutSession({ customer, priceId, userId: req.user.id, successUrl: `${base}/?upgraded=1`, cancelUrl: `${base}/?checkout=canceled`, automaticTax: process.env.STRIPE_AUTOMATIC_TAX === '1' });
    if (!safeStripeUrl(session.url)) throw new Error('Stripe returned an unexpected address');
    res.json({ url: session.url });
  } catch (err) { console.error('[Billing] checkout failed:', err.message); res.status(502).json({ error: 'Could not start checkout. Try again in a moment.' }); }
});
app.post('/api/billing/portal', requireUser, checkoutLimiter, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not turned on yet.' });
  const customer = store.getBilling(req.user.id)?.customer_id, base = returnBase(req);
  if (!customer) return res.status(400).json({ error: 'There is no subscription to manage.' });
  if (!base) return res.status(503).json({ error: 'The site address is not set up for payments yet.' });
  try {
    const p = await stripe.createPortalSession({ customer, returnUrl: `${base}/` });
    if (!safeStripeUrl(p.url)) throw new Error('Stripe returned an unexpected address');
    res.json({ url: p.url });
  } catch (err) { console.error('[Billing] portal failed:', err.message); res.status(502).json({ error: 'Could not open the billing page. Try again in a moment.' }); }
});
// Stripe calls this when a subscription changes. Nothing is trusted unless the signature checks out.
app.post('/api/stripe/webhook', (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhook is not configured.' });
  let event;
  try { event = billingLib.verifyWebhook(req.rawBody, req.get('stripe-signature'), STRIPE_WEBHOOK_SECRET); }
  catch (err) { return res.status(400).json({ error: 'Invalid signature.' }); }
  if (!event.id || !event.type) return res.status(400).json({ error: 'Malformed event.' });
  if (!store.recordStripeEvent(event.id, event.type)) return res.json({ received: true, duplicate: true });
  try {
    const r = billingLib.handleEvent({ store, event, log: m => console.log(m) });
    if (r.handled && r.status) store.addEvent('billing', 'info', `Account #${r.userId}: subscription ${r.status}${r.applied === false ? ' (older event, ignored)' : ''}.`);
    store.setMeta('stripe:last_event_at', new Date().toISOString());
    res.json({ received: true });
  } catch (err) {
    store.forgetStripeEvent(event.id);            // let Stripe retry it
    console.error('[Billing] webhook handler failed:', err.message);
    res.status(500).json({ error: 'Could not process the event.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// CLV TRACKING — Closing Line Value
// Stores analyses and closing lines for long-term edge measurement
// ═══════════════════════════════════════════════════════════════════
// Same load/save interface as before; the storage underneath is SQLite (lib/db.js).
function loadCLV() { return store.loadPicks(); }
function saveCLV(data) { return store.savePicks(data); }

// Direction-adjusted closing-line value (positive = the market moved toward
// our side). Auto picks are logged at the SOFTEST book's line, so comparing
// that to a closing consensus would hand every OVER positive CLV and every
// UNDER negative CLV by construction. Their CLV is therefore measured as
// market movement: closing consensus vs. the consensus at logging time.
// What the softest-book shopping itself was worth is kept separately as
// lineShopGain. Manual entries keep the original line-vs-close definition.
function applyCLV(e) {
  if (e.closingLine == null) return;
  const sign = (e.verdict === 'OVER' || e.verdict === 'LEAN_OVER') ? 1
             : (e.verdict === 'UNDER' || e.verdict === 'LEAN_UNDER') ? -1 : 0;
  if (!sign) return;
  const base = e.source === 'auto' ? e.openConsensus : e.line;
  if (base != null) e.clv = parseFloat((sign * (e.closingLine - base)).toFixed(1));
  if (e.source === 'auto' && e.line != null) e.lineShopGain = parseFloat((sign * (e.closingLine - e.line)).toFixed(1));
}

// ── AUTOMATIC CLOSING-LINE CAPTURE ──────────────────────────────────
// Closing lines used to be typed in by hand, so auto-logged picks never had
// one and CLV (the only fast signal of whether the model beats the market)
// could not be measured. A 5-minute tick finds each pending pick's game via
// the (free) events list and, once tip-off is within CLOSING_WINDOW_MIN,
// makes ONE odds call per game for just the markets that have pending picks
// (~1 request per market). Never captured after tip-off: live lines are a
// different thing, and those picks are marked 'missed' instead of faked.
const CLOSING_WINDOW_MIN = 12;
const PROP_MARKET_BY_TYPE = {
  points: 'player_points', rebounds: 'player_rebounds', assists: 'player_assists', '3pm': 'player_threes',
  pra: 'player_points_rebounds_assists', steals: 'player_steals', blocks: 'player_blocks',
};
const closingNextCheck = {}; // league -> epoch ms; skips pointless polling until near tip-off
let closingRunning = false;

function entryEvent(entry, events) {
  const opp = (entry.opp || '').toLowerCase().trim();
  if (!opp) return null;
  const saved = new Date(entry.savedAt || 0).getTime();
  const last = opp.split(' ').pop();
  const hits = (events || []).filter(ev => {
    const h = (ev.home_team || '').toLowerCase(), a = (ev.away_team || '').toLowerCase();
    // short strings match exactly only — "la" is a substring of "atlanta dream"
    if (h === opp || a === opp) return true;
    if (opp.length >= 5 && (h.includes(opp) || a.includes(opp))) return true;
    return last.length >= 4 && (h.endsWith(last) || a.endsWith(last));
  }).filter(ev => new Date(ev.commence_time).getTime() > saved - 3 * 3600 * 1000)
    .sort((x, y) => new Date(x.commence_time) - new Date(y.commence_time));
  return hits[0] || null; // earliest game involving that opponent after the pick was logged
}

async function captureClosingLines() {
  if (closingRunning) return;
  if (!process.env.ODDS_API_KEY || process.env.ODDS_API_KEY.includes('your_')) return;
  closingRunning = true;
  try {
    const now = Date.now();
    const pending = loadCLV().filter(e => e.closingLine == null && !e.result && !e.closingCapture &&
      (e.league === 'nba' || e.league === 'wnba') && now - new Date(e.savedAt || 0).getTime() < 36 * 3600 * 1000);
    if (!pending.length) return;

    const patches = new Map(); // id -> fields to merge (re-applied to a FRESH read below, so a pick saved while we were on the network isn't overwritten)
    const addPatch = (id, fields) => patches.set(id, { ...(patches.get(id) || {}), ...fields });
    for (const league of ['nba', 'wnba']) {
      const mine = pending.filter(e => e.league === league);
      if (!mine.length || now < (closingNextCheck[league] || 0)) continue;
      const sportKey = league === 'wnba' ? 'basketball_wnba' : 'basketball_nba';
      const evRes = await axios.get(`${ODDS_BASE}/sports/${sportKey}/events`, { params: { apiKey: process.env.ODDS_API_KEY }, timeout: 10000 });

      const byEvent = new Map();
      for (const e of mine) {
        const ev = entryEvent(e, evRes.data || []);
        if (!ev) continue; // game not listed (yet) — stays pending, ages out after 36h
        if (!byEvent.has(ev.id)) byEvent.set(ev.id, { ev, list: [] });
        byEvent.get(ev.id).list.push(e);
        if (e.gameStart !== ev.commence_time) patches.set(e.id, { gameStart: ev.commence_time }); // only when new/changed — avoids rewriting the file every tick
      }

      let earliestTip = Infinity;
      for (const { ev, list } of byEvent.values()) {
        const mins = (new Date(ev.commence_time).getTime() - now) / 60000;
        if (mins > CLOSING_WINDOW_MIN) { earliestTip = Math.min(earliestTip, mins); continue; }
        if (mins <= 0) { list.forEach(e => addPatch(e.id, { closingCapture: 'missed' })); continue; }

        const markets = [...new Set(list.map(e => PROP_MARKET_BY_TYPE[e.propType]).filter(Boolean))];
        if (!markets.length) { list.forEach(e => addPatch(e.id, { closingCapture: 'unsupported' })); continue; }
        const oddsRes = await axios.get(`${ODDS_BASE}/sports/${sportKey}/events/${ev.id}/odds`, {
          params: { apiKey: process.env.ODDS_API_KEY, regions: 'us', markets: markets.join(','), oddsFormat: 'american' }, timeout: 10000,
        });
        for (const e of list) {
          const market = PROP_MARKET_BY_TYPE[e.propType];
          const lines = {};
          for (const bm of (oddsRes.data.bookmakers || [])) {
            for (const mkt of (bm.markets || [])) {
              if (mkt.key !== market) continue;
              for (const o of (mkt.outcomes || [])) {
                if (matchesOutcomeName(o.description, e.player) && (o.name === 'Over' || o.name === 'Under')) {
                  if (!lines[bm.title]) lines[bm.title] = {};
                  lines[bm.title][o.name] = { point: o.point, price: o.price };
                }
              }
            }
          }
          const c = consensusFromLines(lines);
          addPatch(e.id, c.consensusLine != null
            ? { closingLine: c.consensusLine, closingBookCount: c.bookCount, closingCapturedAt: new Date().toISOString(), closingCapture: 'auto' }
            : { closingCapture: 'unavailable' }); // player no longer posted at close
        }
        console.log(`[Closing] ${league}: ${ev.away_team} @ ${ev.home_team} — captured ${list.length} pick(s), ${Math.round(mins)} min to tip`);
      }
      const waitMin = earliestTip === Infinity ? 30 : Math.min(30, Math.max(1, earliestTip - CLOSING_WINDOW_MIN - 5));
      closingNextCheck[league] = Date.now() + waitMin * 60000;
      console.log(`[Closing] ${league}: ${mine.length} pending, ${earliestTip === Infinity ? 'no upcoming game matched' : Math.round(earliestTip) + ' min to first tip'} — next check in ${Math.round(waitMin)} min`);
    }

    if (patches.size) {
      const fresh = loadCLV();
      for (const e of fresh) {
        const patch = patches.get(e.id);
        if (!patch || e.closingLine != null || e.result) continue;
        Object.assign(e, patch);
        applyCLV(e);
      }
      saveCLV(fresh);
    }
  } finally { closingRunning = false; }
}

// Save a prop to the signed-in user's own list
const CLV_MAX_ENTRIES = 200000;
app.post('/api/clv/save', requireUser, rgBlock, requirePro('prop_list'), writeLimiter, (req, res) => {
  const { value, error } = security.cleanEntryInput(req.body);
  if (error) return res.status(400).json({ error });
  const { player, opp, propType, line, projection, verdict, edge, confidence, gameDate, league } = value;

  if (store.countPicks() >= CLV_MAX_ENTRIES) return res.status(507).json({ error: 'The saved-props store is full.' });
  if (store.countUserPicks(req.user.id) >= USER_MAX_PROPS) return res.status(409).json({ error: `Your Prop List is full (${USER_MAX_PROPS}). Remove some props to add more.`, code: 'list_full' });
  const entry = {
    id:          nextId(),
    userId:      req.user.id,
    date:        gameDate || getToday(),
    savedAt:     new Date().toISOString(),
    league,
    player, opp, propType, line,
    projection,
    verdict,
    edge,
    confidence,
    confVersion: CONFIDENCE_FORMULA_VERSION,
    // These get filled in after the game
    closingLine: null,
    result:      null,   // 'WIN' | 'LOSS' | 'PUSH' | 'NO_BET'
    actualStat:  null,
    clv:         null,   // closingLine - openLine (positive = beat closing)
    notes:       ''
  };
  store.writePick(entry);
  res.json({ ok: true, id: entry.id, entry });
});

// Update with closing line and result after game. A user can only change props they saved. Picks the
// system logged itself (source:'auto') are graded by the server; only the admin may edit those, because
// the backtest and calibration are built from them. Someone else's prop answers "not found", the same as
// a prop that does not exist.
app.post('/api/clv/update', writeLimiter, (req, res) => {
  const id = parseInt(req.body?.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id required' });
  const { value, error } = security.cleanUpdateInput(req.body);
  if (error) return res.status(400).json({ error });

  const entry = store.supportsAccounts ? store.getPick(id) : null;
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (entry.source === 'auto') {
    if (!isAdmin(req)) return res.status(403).json({ error: 'System-logged picks are graded automatically.' });
  } else {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.', code: 'auth_required' });
    if (entry.userId !== req.user.id) return res.status(404).json({ error: 'Entry not found' });
  }

  if (value.closingLine !== undefined) entry.closingLine = value.closingLine;
  // result uses "key present" rather than truthiness: the UI toggles a result off by sending null
  if (value.result !== undefined) entry.result = value.result;
  if (value.actualStat !== undefined) entry.actualStat = value.actualStat;
  if (value.notes !== undefined) entry.notes = value.notes;

  applyCLV(entry);

  store.writePick(entry);
  res.json({ ok: true, entry });
});

// Get all CLV entries with summary stats
// Same bands the frontend's confTier() uses for the colored confidence
// number — kept in sync so "70% confidence" means the same tier everywhere.
function clvConfTier(c) { return c >= 75 ? 'strong' : c >= 55 ? 'lean' : 'thin'; }

// `summary` is the system's own record (the picks it logged and graded itself), the same for everyone.
// `entries` is only the signed-in user's own saved props.
app.get('/api/clv', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const entries = systemPicks();
  const withResult = entries.filter(e => e.result && e.result !== 'NO_BET');
  const wins   = withResult.filter(e => e.result === 'WIN').length;
  const losses = withResult.filter(e => e.result === 'LOSS').length;
  const pushes = withResult.filter(e => e.result === 'PUSH').length;
  const clvEntries = entries.filter(e => e.clv !== null);
  const avgCLV = clvEntries.length
    ? parseFloat((clvEntries.reduce((s, e) => s + e.clv, 0) / clvEntries.length).toFixed(2))
    : null;

  // The actual point of auto-logging: does a higher confidence score really
  // mean a higher real hit rate? Graded-with-a-confidence-number picks only
  // — a pick with no confidence recorded can't be tiered.
  // Only entries scored on the current confidence scale are tiered —
  // older entries used a different formula (a yes/no data checklist), so
  // mixing them would make "75%+ = strong" mean two different things.
  const tierable = withResult.filter(e => e.confVersion === CONFIDENCE_FORMULA_VERSION);
  const confidenceTierExcluded = withResult.filter(e => e.confidence != null && e.confVersion !== CONFIDENCE_FORMULA_VERSION).length;
  const byConfidenceTier = {};
  for (const tier of ['strong', 'lean', 'thin']) {
    const g = tierable.filter(e => e.confidence != null && clvConfTier(e.confidence) === tier);
    const w = g.filter(e => e.result === 'WIN').length;
    byConfidenceTier[tier] = { graded: g.length, wins: w, winRate: g.length ? parseFloat((w / g.length * 100).toFixed(1)) : null };
  }

  res.json({
    entries: req.user ? userPicks(req.user.id) : [],
    signedIn: !!req.user,
    summary: {
      total: entries.length,
      graded: withResult.length,
      wins, losses, pushes,
      winRate: withResult.length ? parseFloat((wins / withResult.length * 100).toFixed(1)) : null,
      avgCLV,
      positiveCLV: clvEntries.filter(e => e.clv > 0).length,
      negativeCLV: clvEntries.filter(e => e.clv < 0).length,
      byConfidenceTier,
      confidenceTierExcluded,
      // Market movement after each auto pick was flagged (see applyCLV):
      // the fast read on whether the model is ahead of the market, long
      // before enough picks are graded for win rate to mean anything.
      autoCLV: (() => {
        const c = entries.filter(e => e.source === 'auto' && e.clv != null);
        return {
          captured: c.length,
          beat: c.filter(e => e.clv > 0).length,
          flat: c.filter(e => e.clv === 0).length,
          worse: c.filter(e => e.clv < 0).length,
          avg: c.length ? parseFloat((c.reduce((t, e) => t + e.clv, 0) / c.length).toFixed(2)) : null,
          missed: entries.filter(e => e.source === 'auto' && e.closingCapture === 'missed').length,
        };
      })(),
    }
  });
});

// Delete a prop. Only its owner can (the admin can remove system-logged picks).
app.delete('/api/clv/:id', writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const target = Number.isFinite(id) && store.supportsAccounts ? store.getPick(id) : null;
  if (!target) return res.status(404).json({ error: 'Entry not found' });
  if (target.source === 'auto') {
    if (!isAdmin(req)) return res.status(403).json({ error: 'System-logged picks cannot be deleted.' });
  } else {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.', code: 'auth_required' });
    if (target.userId !== req.user.id) return res.status(404).json({ error: 'Entry not found' });
  }
  store.deletePick(id);
  res.json({ ok: true });
});

// Current market line for a player prop — used both to snapshot a closing
// line and to detect line movement on already-saved props. Thin wrapper
// around the same fetchPropLines/fetchWNBAPropLines used by the analyzer,
// so it inherits the same odds-API source (and the same "unavailable if
// quota's exhausted" behavior — reported honestly via `available: false`
// rather than a fake number).
app.get('/api/current-line', async (req, res) => {
  const league    = (req.query.league || 'nba').toLowerCase() === 'wnba' ? 'wnba' : 'nba';
  const player    = req.query.player;
  const propType  = req.query.propType || 'points';
  if (!player) return res.status(400).json({ error: 'player required' });
  const data = league === 'wnba'
    ? await fetchWNBAPropLines(player, propType)
    : await fetchPropLines(player, propType);
  if (data.error) return res.json({ available: false, error: data.error });
  res.json({ available: data.softestLine != null, line: data.softestLine ?? null, book: data.softestBook ?? null });
});

// Auto-grade a saved prop from the player's real game log — no manual
// stat entry required once the game is final. Reuses gameLog20 (already
// fetched for the game-log chart) rather than a separate box-score call.
const GRADE_COMBO_KEYS = { pra: ['pts','reb','ast'], pr: ['pts','reb'], pa: ['pts','ast'], ra: ['reb','ast'] };
const GRADE_STAT_KEY   = { points: 'pts', rebounds: 'reb', assists: 'ast', '3pm': 'fg3m', steals: 'stl', blocks: 'blk' };
// nba_api game logs carry dates like "Apr 30, 2026" while ESPN (WNBA) uses
// ISO "2026-10-04". Both graders compared the first 10 characters to a
// YYYY-MM-DD string, which can never match the NBA format — so NBA picks
// were never gradable, automatically or via CHECK RESULTS. Normalizes both.
function gameDateISO(g) {
  const raw = (g && g.date) || '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const t = new Date(raw);
  return isNaN(t) ? '' : toLocalDateStr(t);
}
function findGameOnDate(stats, dateISO) {
  return (stats.gameLog20 || []).find(g => gameDateISO(g) === dateISO);
}
// A pick is graded against the day its GAME is played, which is not
// always the day it was logged (a scan can list games days away) — the
// closing-line capture records the real start time as gameStart.
function gradeDateOf(e) { return e.gameStart ? toLocalDateStr(new Date(e.gameStart)) : e.date; }
// ESPN's WNBA game log stamps games with their UTC start (a 9:37 PM ET tip-off is dated the
// NEXT day), while nba_api dates are local. Looking only for the local date left every late
// WNBA game ungraded. Try the league's own convention first, then the other.
//
// A pick logged days before its game (the scan lists upcoming games) has no gameStart yet.
// Then the date can't be trusted, so fall back to the first game against that opponent in the
// five days after the pick was logged, the same rule the closing-line capture uses.
function findGameForPick(stats, e) {
  const local = gradeDateOf(e);
  const utc = e.gameStart ? new Date(e.gameStart).toISOString().slice(0, 10) : local;
  const order = e.league === 'wnba' ? [utc, local] : [local, utc];
  for (const d of new Set(order)) { const g = findGameOnDate(stats, d); if (g) return g; }
  const opp = (e.opp || '').toLowerCase().trim();
  if (e.gameStart || !opp || !e.savedAt) return null;
  const from = new Date(e.savedAt).toISOString().slice(0, 10);
  const to = new Date(new Date(e.savedAt).getTime() + 5 * 86400000).toISOString().slice(0, 10);
  const last = opp.split(' ').pop();
  return (stats.gameLog20 || [])
    .filter(g => { const d = gameDateISO(g), o = (g.opponent || '').toLowerCase(); return d >= from && d <= to && (o === opp || (last.length >= 4 && o.endsWith(last))); })
    .sort((a, b) => gameDateISO(a).localeCompare(gameDateISO(b)))[0] || null;
}
const GRADE_LOGIC_VERSION = 2;   // bump when grading learns to match more games; picks set aside before get retried once
function gradeStatValue(g, propType) {
  const combo = GRADE_COMBO_KEYS[propType];
  if (combo) return combo.reduce((s, k) => s + (parseFloat(g[k]) || 0), 0);
  return parseFloat(g[GRADE_STAT_KEY[propType] || 'pts']) || 0;
}
app.get('/api/grade-prop', async (req, res) => {
  const league   = (req.query.league || 'nba').toLowerCase() === 'wnba' ? 'wnba' : 'nba';
  const player   = req.query.player;
  const propType = req.query.propType || 'points';
  const date     = req.query.date; // YYYY-MM-DD — the game date this prop was for
  if (!player || !date) return res.status(400).json({ error: 'player and date required' });

  const stats = league === 'wnba' ? await fetchWNBAPlayerStats(player) : await fetchPlayerStats(player);
  if (!stats || stats.error) return res.json({ graded: false, reason: stats?.error || 'stats unavailable' });

  const game = findGameOnDate(stats, date);
  if (!game) {
    const reason = date < getToday() ? 'no matching game found in recent log' : 'game not final yet';
    return res.json({ graded: false, reason });
  }
  res.json({ graded: true, actualStat: gradeStatValue(game, propType), opponent: game.opponent || null, date: game.date });
});

// ═══════════════════════════════════════════════════════════════════
// SCOUTING NOTES — private, hand-entered film reads, one running list of
// OFFENSE notes and one of DEFENSE notes per team (no per-player scoping)
// that get woven into the AI breakdown for every future analysis
// involving that team. Writing is gated behind ADMIN_TOKEN — this is
// intentionally NOT a feature any site visitor can use, only whoever
// holds the token (you + cofounder).
// Reading happens server-side only, folded into /api/prop-context,
// /api/wnba/prop-context, and /api/team-compare — never a public,
// unauthenticated read endpoint either, since these are your own
// proprietary scouting reads.
// ═══════════════════════════════════════════════════════════════════
const NOTES_FILE = 'scouting_notes.json';

function loadNotes() {
  try {
    if (!fs.existsSync(NOTES_FILE)) return [];
    return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
  } catch (_) { return []; }
}
function saveNotes(data) {
  try { fs.writeFileSync(NOTES_FILE, JSON.stringify(data, null, 2)); return true; }
  catch (_) { return false; }
}

// Fails closed: if ADMIN_TOKEN was never configured, nobody can write —
// not "anyone can write" (the opposite of a missing-config default would
// silently expose this to every visitor).
const adminFails = security.createFailLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
// ── Admin: the token, plus (when ADMIN_TOTP_SECRET is set) a 6-digit code from an authenticator app ──
// With the code switched on, the token alone opens nothing: signing in also needs a current code, which starts a short
// session (an HttpOnly cookie). A stolen token is useless without the phone; a stolen cookie is useless without the token.
const adminTokenConfigured = () => !!(process.env.ADMIN_TOKEN && !process.env.ADMIN_TOKEN.includes('XXXXX'));
const tokenMatches = req => {
  if (!adminTokenConfigured()) return false;
  const a = Buffer.from(String(req.headers['x-admin-token'] || '')), b = Buffer.from(process.env.ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const ADMIN_TOTP = (() => { const raw = String(process.env.ADMIN_TOTP_SECRET || '').trim(); if (!raw) return null; try { totp.base32Decode(raw); return raw; } catch (_) { console.error('[Admin] ADMIN_TOTP_SECRET is not valid base32, so the second factor is NOT active. Fix it or remove it.'); return null; } })();
const ADMIN_COOKIE = 'winai_admin', ADMIN_SESSION_MS = 8 * 3600 * 1000;
const adminSessions = new Map();            // sha256(cookie value) -> expiry. Kept in memory: a restart signs the admin out.
const adminCodeFails = security.createFailLimiter({ max: 8, windowMs: 15 * 60 * 1000 });     // one shared count: an attacker with the token still cannot guess codes
function adminSessionOk(req) {
  const t = parseCookiesHeader(req.headers.cookie)[ADMIN_COOKIE];
  if (typeof t !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(t)) return false;
  const exp = adminSessions.get(sha(t));
  if (!exp) return false;
  if (exp < Date.now()) { adminSessions.delete(sha(t)); return false; }
  return true;
}
const adminSecondFactorOk = req => !ADMIN_TOTP || adminSessionOk(req);
// True only for a request that has everything the admin needs. No side effects (used to decide how much a
// public route may reveal), so it never counts toward the brute-force lockout.
function isAdmin(req) { return tokenMatches(req) && adminSecondFactorOk(req); }
function requireAdmin(req, res, next) {
  if (!adminTokenConfigured()) return res.status(503).json({ error: 'ADMIN_TOKEN not configured on the server — set it in .env' });
  // Ten wrong guesses lock that address out for 15 minutes.
  if (adminFails.blocked(req.ip)) return res.status(429).json({ error: 'Too many wrong tokens. Try again in 15 minutes.' });
  // Constant-time compare (see tokenMatches): a plain !== leaks how many leading bytes matched via response timing.
  if (!tokenMatches(req)) { adminFails.fail(req.ip); return res.status(401).json({ error: 'Invalid admin token' }); }
  adminFails.ok(req.ip);
  if (!adminSecondFactorOk(req)) return res.status(401).json({ error: 'Enter the 6-digit code from your authenticator app.', code: 'admin_2fa' });
  next();
}
// Trade the token and a current code for a session.
app.post('/api/admin/2fa', (req, res) => {
  if (!adminTokenConfigured()) return res.status(503).json({ error: 'ADMIN_TOKEN not configured on the server — set it in .env' });
  if (adminFails.blocked(req.ip)) return res.status(429).json({ error: 'Too many wrong tokens. Try again in 15 minutes.' });
  if (!tokenMatches(req)) { adminFails.fail(req.ip); return res.status(401).json({ error: 'Invalid admin token' }); }
  if (!ADMIN_TOTP) return res.json({ ok: true, required: false });
  if (adminCodeFails.blocked('all')) return res.status(429).json({ error: 'Too many wrong codes. Try again in 15 minutes.' });
  const after = Number(store.getMeta('admin:totp_step') ?? -1);
  const step = totp.verify(ADMIN_TOTP, req.body?.code, { afterStep: Number.isFinite(after) ? after : -1 });
  if (step == null) { adminCodeFails.fail('all'); store.addEvent('admin', 'warn', 'A wrong admin code was entered.'); return res.status(401).json({ error: 'That code is not right, or was already used. Wait for the next one.', code: 'admin_2fa' }); }
  adminCodeFails.ok('all'); store.setMeta('admin:totp_step', step);
  const value = newToken(); adminSessions.set(sha(value), Date.now() + ADMIN_SESSION_MS);
  if (adminSessions.size > 20) for (const [k, v] of adminSessions) if (v < Date.now()) adminSessions.delete(k);
  res.set('Set-Cookie', `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_MS / 1000}${isSecureReq(req) ? '; Secure' : ''}`);
  store.addEvent('admin', 'info', 'Admin signed in with a code.');
  res.json({ ok: true, required: true });
});
app.post('/api/admin/signout', (req, res) => {
  const t = parseCookiesHeader(req.headers.cookie)[ADMIN_COOKIE]; if (typeof t === 'string') adminSessions.delete(sha(t));
  res.set('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
});

// Used internally by the analysis endpoints — a note matches if its team
// (case-insensitive substring either direction) matches what's being
// analyzed. League-scoped so an NBA "Lakers" note never leaks into a
// WNBA analysis of a differently-named team. Team-only, no player
// scoping — notes are organized per-team, split into OFFENSE/DEFENSE.
function getScoutNotes(league, { team } = {}) {
  const notes = loadNotes().filter(n => n.league === league);
  const teamLower = (team || '').toLowerCase();
  if (!teamLower) return [];
  return notes.filter(n => {
    const noteTeam = (n.team || '').toLowerCase();
    return noteTeam && (teamLower.includes(noteTeam) || noteTeam.includes(teamLower));
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// List/manage all notes — admin only.
app.get('/api/admin/notes', requireAdmin, (req, res) => {
  res.json({ notes: loadNotes().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});

app.post('/api/admin/notes', requireAdmin, (req, res) => {
  const { league, team, category, text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  if (!team || !team.trim()) return res.status(400).json({ error: 'team required' });
  const note = {
    id: nextId(),
    league: league === 'wnba' ? 'wnba' : 'nba',
    team: team.trim(),
    category: category === 'defense' ? 'defense' : 'offense',
    text: text.trim(),
    createdAt: new Date().toISOString(),
  };
  const notes = loadNotes();
  notes.unshift(note);
  saveNotes(notes);
  res.json({ ok: true, note });
});

app.delete('/api/admin/notes/:id', requireAdmin, (req, res) => {
  const notes = loadNotes().filter(n => n.id !== parseInt(req.params.id));
  saveNotes(notes);
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════
// ADMIN: HEALTH, CREDIT BUDGET, BACKTEST, CALIBRATION
// Everything below is behind ADMIN_TOKEN. None of it is visible to visitors.
// ═════════════════════════════════════════════════════════════════
const oddsKeyConfigured = () => !!(process.env.ODDS_API_KEY && !process.env.ODDS_API_KEY.includes('XXXXX'));
function currentCreditBudget() {
  return creditBudget({
    remaining: oddsApiHealth.remaining, usage: oddsUsage,
    warnAt: envNum(process.env.ODDS_CREDIT_WARN, 100), critAt: envNum(process.env.ODDS_CREDIT_CRIT, 40), scanCost: envNum(process.env.ODDS_SCAN_COST, 60),
  });
}

function healthSnapshot() {
  const mtime = f => { try { return fs.statSync(path.join(__dirname, f)).mtimeMs; } catch (_) { return null; } };
  const picks = loadCLV();
  let tests = null;
  try { tests = JSON.parse(fs.readFileSync(path.join(__dirname, 'test_results.json'), 'utf8')); } catch (_) {}
  return {
    odds: { configured: oddsKeyConfigured(), ...oddsApiHealth, usage: oddsUsage },
    anthropicConfigured: !!(process.env.ANTHROPIC_KEY && !process.env.ANTHROPIC_KEY.includes('your_')),
    balldontlieConfigured: !!process.env.BALLDONTLIE_KEY,
    statFiles: { NBA: { mtime: mtime('player_stats.json') }, WNBA: { mtime: mtime('wnba_player_stats.json') } },
    jobs: jobRuns,
    storage: store.info(),
    grading: { waiting: picks.filter(e => e.source === 'auto' && !e.result && !e.gradeNote).length, unmatched: picks.filter(e => e.source === 'auto' && !e.result && e.gradeNote).length, graded: picks.filter(e => e.result === 'WIN' || e.result === 'LOSS' || e.result === 'PUSH').length },
    calibration: calibrationModel ? { active: calibrationModel.active, reason: calibrationModel.reason } : { active: false, reason: 'Not fitted yet.' },
    tests,
  };
}

// The Odds API's events list costs 0 credits but its response still reports how many credits
// are left, so this keeps the credit meter current without spending anything.
async function refreshOddsCredits() {
  if (!oddsKeyConfigured()) return 'no ODDS_API_KEY set';
  await axios.get(`${ODDS_BASE}/sports/basketball_wnba/events`, { params: { apiKey: process.env.ODDS_API_KEY }, timeout: 10000 });
  return oddsApiHealth.remaining != null ? `${oddsApiHealth.remaining} credits left` : 'no credit count returned';
}

// Alert only when a check gets worse, and note when it clears; never on every tick.
const activeIssues = new Map();
async function runHealthCheck() {
  const stale = !oddsApiHealth.checkedAt || Date.now() - new Date(oddsApiHealth.checkedAt).getTime() > 3 * 3600 * 1000;
  if (stale) { try { await trackJob('credits', refreshOddsCredits)(); } catch (_) { /* the health check below reports the odds feed state */ } }
  const h = evaluateHealth(healthSnapshot(), { budget: { warnAt: envNum(process.env.ODDS_CREDIT_WARN, 100), critAt: envNum(process.env.ODDS_CREDIT_CRIT, 40), scanCost: envNum(process.env.ODDS_SCAN_COST, 60) } });
  const rank = { ok: 0, warn: 1, critical: 2 };
  for (const c of h.checks) {
    const before = activeIssues.get(c.id) || 'ok';
    if (rank[c.level] > rank[before]) await alerts.notify({ key: 'health:' + c.id, level: c.level, kind: 'health', message: `${c.label}: ${c.detail}` });
    else if (c.level === 'ok' && before !== 'ok') { store.addEvent('health', 'info', `${c.label} is back to normal.`); alerts.resolve('health:' + c.id); }
    if (c.level === 'ok') activeIssues.delete(c.id); else activeIssues.set(c.id, c.level);
  }
  jobRuns.health = { lastRun: new Date().toISOString(), ok: true, detail: h.status };
  return h;
}

// Picks logged before the chance was being stored can be filled in from the saved slate scan
// (the same numbers the pick was logged with). Only matches by day, league, player, prop and line.
function backfillModelChances() {
  const picks = loadCLV();
  let filled = 0;
  for (const lg of ['nba', 'wnba']) {
    const c = slateScanCache[lg];
    if (!c?.data?.results?.length) continue;
    const byKey = new Map(c.data.results.map(r => [`${r.player}|${r.propType}|${r.line}`, r]));
    for (const e of picks) {
      if (e.league !== lg || e.date !== c.dateKey || e.modelProb != null) continue;
      const r = byKey.get(`${e.player}|${e.propType}|${e.line}`);
      if (!r?.realEdge) continue;
      e.modelProb = r.realEdge.modelProb; e.price = r.realEdge.price; e.ev = r.realEdge.expectedValue;
      filled++;
    }
  }
  if (filled) saveCLV(picks);
  return filled;
}

async function runBacktest() {
  const report = buildReport(loadCLV().filter(e => e.source === 'auto'), { confVersion: CONFIDENCE_FORMULA_VERSION });
  store.saveBacktest(report);
  return report;
}
async function refitCalibration() {
  const model = calibration.fit(loadCLV().filter(e => e.source === 'auto'));
  const was = !!(calibrationModel && calibrationModel.active);
  store.saveCalibration(model);
  calibrationModel = model;
  if (model.active !== was) store.addEvent('calibration', 'info', `Calibration turned ${model.active ? 'on' : 'off'}. ${model.reason}`);
  return model;
}
async function runDailyPipeline() {
  await trackJob('grade', autoGradePendingPicks)();
  await trackJob('backfill', async () => `filled ${backfillModelChances()} picks with their stored model chance`)();
  await trackJob('calibration', async () => (await refitCalibration()).reason)();
  await trackJob('backtest', async () => { const r = await runBacktest(); return `${r.totals.graded} graded picks scored`; })();
}
async function initAdminJobs() {
  backfillModelChances();
  if (!store.latestCalibration()) await refitCalibration();
  if (!store.latestBacktest()) await runBacktest();
  setTimeout(() => runHealthCheck().catch(() => {}), 25000);
}

app.get('/api/admin/health', requireAdmin, async (req, res) => {
  const h = evaluateHealth(healthSnapshot(), { budget: { warnAt: envNum(process.env.ODDS_CREDIT_WARN, 100), critAt: envNum(process.env.ODDS_CREDIT_CRIT, 40), scanCost: envNum(process.env.ODDS_SCAN_COST, 60) } });
  res.json({ generatedAt: new Date().toISOString(), ...h, jobs: jobRuns, alertWebhookConfigured: alerts.configured, events: store.recentEvents(25) });
});
app.get('/api/admin/events', requireAdmin, (req, res) => res.json({ events: store.recentEvents(Math.min(200, parseInt(req.query.limit, 10) || 50)) }));
app.get('/api/admin/backtest', requireAdmin, (req, res) => {
  const latest = store.latestBacktest();
  res.json({
    latest,
    history: store.backtestHistory(30).map(h => ({ ts: h.ts, graded: h.report.totals.graded, winRate: h.report.overall.winRate, brier: h.report.probability.brier })),
  });
});
app.post('/api/admin/backtest/run', requireAdmin, async (req, res) => res.json({ ts: new Date().toISOString(), report: await runBacktest() }));
app.get('/api/admin/calibration', requireAdmin, (req, res) => {
  const picks = loadCLV();
  res.json({
    model: calibrationModel,
    thresholds: { minGraded: calibration.MIN_GRADED, shrinkK: calibration.SHRINK_K, minCvGain: calibration.MIN_CV_GAIN },
    usableSamples: calibration.samplesFrom(picks).length,
    loggedWithChance: picks.filter(e => e.modelProb != null).length,
  });
});
app.post('/api/admin/calibration/refit', requireAdmin, async (req, res) => res.json({ model: await refitCalibration() }));
// Run a job now. The slate scan is left out on purpose: it spends Odds API credits.
const ADMIN_JOBS = {
  grade: () => trackJob('grade', autoGradePendingPicks)(),
  pipeline: () => runDailyPipeline(),
  backtest: () => trackJob('backtest', async () => { const r = await runBacktest(); return `${r.totals.graded} graded picks scored`; })(),
  calibration: () => trackJob('calibration', async () => (await refitCalibration()).reason)(),
  backup: () => trackJob('backup', async () => `wrote ${path.basename(store.backup(path.join(__dirname, 'backups')) || 'nothing (no file database)')}`)(),
  health: () => runHealthCheck(),
  'closing-lines': () => trackedClosing(),
  credits: () => trackJob('credits', refreshOddsCredits)(),
  datachecks: () => runDataChecks(),
};
app.post('/api/admin/jobs/:name/run', requireAdmin, async (req, res) => {
  const job = ADMIN_JOBS[req.params.name];
  if (!job) return res.status(404).json({ error: 'Unknown job', jobs: Object.keys(ADMIN_JOBS) });
  try { await job(); res.json({ ok: true, jobs: jobRuns }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
// ── Users (admin only: nothing here is public) ──
const planOf = u => {
  const info = billingLib.planInfo(u, store.getBilling(u.id));
  if (auth.isAdminEmail(u.email)) info.plan = 'pro';
  return { plan: info.plan, comped: !!u.comped, subStatus: info.status, renewsAt: info.renewsAt, cancelling: info.cancelAtPeriodEnd && info.plan === 'pro' };
};
const planTotals = users => {
  const t = { pro: 0, free: 0, comped: 0, cancelling: 0 };
  for (const u of users) { const p = planOf(u); t[p.plan]++; if (p.comped) t.comped++; if (p.cancelling) t.cancelling++; }
  return t;
};
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = store.supportsAccounts ? store.listUsers() : [];
  const t = Date.now(), week = t - 7 * 24 * 3600 * 1000, day = t - 24 * 3600 * 1000;
  res.json({
    auth: authStatus(),
    totals: {
      accounts: users.length,
      active: users.filter(u => !u.disabled).length,
      newThisWeek: users.filter(u => new Date(u.created_at).getTime() > week).length,
      propsSaved: users.reduce((n, u) => n + u.props, 0),
      unclaimedProps: store.supportsAccounts ? store.countUnclaimedPicks() : 0,
      signInsBlocked24h: authBlocks.filter(x => x > day).length,
    },
    users: users.map(u => ({ id: u.id, email: maskEmail(u.email), joined: u.created_at, lastSeen: u.last_seen, props: u.props, disabled: !!u.disabled, confirmed: !!u.email_verified_at, ...planOf(u) })),
    billing: { ...(({ requested, configured, missing, on, mode, lastWebhookAt }) => ({ requested, configured, missing, on, mode, lastWebhookAt }))(billingStatus()), plans: planTotals(users) },
  });
});
app.post('/api/admin/users/:id/:action(disable|enable|comp|uncomp)', requireAdmin, (req, res) => {
  const u = store.supportsAccounts ? store.userById(req.params.id) : null;
  if (!u) return res.status(404).json({ error: 'No such account' });
  const a = req.params.action;
  if (a === 'comp' || a === 'uncomp') store.setUserComped(u.id, a === 'comp');   // free Pro, for friends and testing; no payment involved
  else store.setUserDisabled(u.id, a === 'disable');
  store.addEvent('account', 'info', `Account #${u.id}: ${a} by admin.`);
  res.json({ ok: true });
});

// ── Data checks (admin only) ──
function mtimeOf(f) { try { return fs.statSync(path.join(__dirname, f)).mtimeMs; } catch (_) { return null; } }
const BACKUP_DIR = path.join(__dirname, 'backups');
const STAT_FILE = { nba: 'player_stats.json', wnba: 'wnba_player_stats.json' };
// The same Python scripts the 7 AM jobs run. One attempt, five minute limit.
function runStatsScript(league) {
  return new Promise((resolve, reject) => {
    const [cmd, script] = league === 'nba' ? ['python3', 'fetch_stats.py'] : ['python3', 'fetch_wnba_stats.py'];
    const py = spawn(cmd, [script], { cwd: __dirname });
    const timer = setTimeout(() => { py.kill(); reject(new Error('timed out after 5 minutes')); }, 5 * 60 * 1000);
    py.on('error', err => { clearTimeout(timer); reject(err); });
    py.on('close', code => {
      clearTimeout(timer);
      if (league === 'nba') { nbaStatsCache = null; lastStatsDiskRead = 0; } else { wnbaStatsCache = null; lastWnbaStatsDiskRead = 0; }
      code === 0 ? resolve() : reject(new Error(`exit code ${code}`));
    });
  });
}
// Offsite backups: an encrypted copy in an S3-compatible bucket. The address must be https (or this computer, for tests).
const offsite = (() => {
  const endpoint = String(process.env.BACKUP_S3_ENDPOINT || '').trim();
  const okUrl = /^https:\/\//.test(endpoint) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(endpoint);
  if (endpoint && !okUrl) console.warn('[Offsite] BACKUP_S3_ENDPOINT must start with https://, so offsite backups are off.');
  return offsiteLib.createOffsite({ endpoint: okUrl ? endpoint : '', bucket: process.env.BACKUP_S3_BUCKET, accessKeyId: process.env.BACKUP_S3_KEY_ID, secretAccessKey: process.env.BACKUP_S3_SECRET,
    region: process.env.BACKUP_S3_REGION || 'auto', prefix: process.env.BACKUP_S3_PREFIX || 'winai/', passphrase: process.env.BACKUP_PASSPHRASE });
})();
async function uploadOffsite() {
  const file = store.backup(BACKUP_DIR);
  if (!file) throw new Error('there is no file database to copy');
  const r = await offsite.upload(file);
  store.setMeta('offsite:last_upload', new Date().toISOString());
  return r;
}
const dataCheckCtx = {
  offsite, offsiteUpload: uploadOffsite, offsiteVerify: () => offsite.verifyLatest(),
  store, adminEmail: String(process.env.ADMIN_EMAIL || '').trim().toLowerCase() || null,
  today: getToday,
  daysAgo: n => { const d = new Date(); d.setDate(d.getDate() - n); return toLocalDateStr(d); },
  fileMtime: lg => mtimeOf(STAT_FILE[lg]),
  refreshStats: runStatsScript,
  statRows: lg => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, STAT_FILE[lg]), 'utf8')); } catch (_) { return null; } },
  slateCacheDates: () => Object.fromEntries(Object.entries(slateScanCache).map(([k, v]) => [k, v?.dateKey])),
  clearSlateCache: lg => { delete slateScanCache[lg]; saveSlateScanCacheToDisk(slateScanCache); },
  newestBackupMtime: () => {
    try { return Math.max(0, ...fs.readdirSync(BACKUP_DIR).filter(f => /^winai-\d{4}-\d{2}-\d{2}\.db$/.test(f)).map(f => fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs)) || null; } catch (_) { return null; }
  },
  runBackup: () => store.backup(BACKUP_DIR),
  picks: () => loadCLV(),
  runGrade: () => trackJob('grade', autoGradePendingPicks)(),
  creditBudget: currentCreditBudget,
  authStatus, billingStatus,
  adminTotpOn: !!ADMIN_TOTP, errorGroups: errorLog.groups, monitoring: () => ({ webhook: alerts.configured, heartbeat: heartbeatState() }),
};
let dataChecksRunning = null;
function runDataChecks() {
  if (dataChecksRunning) return dataChecksRunning;      // one run at a time
  let result = null;
  dataChecksRunning = trackJob('datachecks', async () => {
    result = await datachecks.runAll({ checks: datachecks.buildChecks(dataCheckCtx), store, alerts, log: m => console.log(m) });
    return `${result.counts.ok} healthy, ${result.counts.fixed} fixed, ${result.counts.bad} need you`;
  })().then(() => result).finally(() => { dataChecksRunning = null; });
  return dataChecksRunning;
}
app.get('/api/admin/checks', requireAdmin, (req, res) => {
  let last = null; try { last = JSON.parse(store.getMeta('datachecks:last') || 'null'); } catch (_) {}
  res.json({ last, running: !!dataChecksRunning, activity: store.recentEvents(200).filter(e => e.kind === 'datacheck').slice(0, 25) });
});
app.post('/api/admin/checks/run', requireAdmin, async (req, res) => {
  try { res.json({ last: await runDataChecks(), running: false }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
cron.schedule('10 3 * * *', () => runDataChecks().catch(err => console.error('[DataChecks] failed:', err.message)));
setTimeout(() => runDataChecks().catch(err => console.error('[DataChecks] failed:', err.message)), 45000);

app.post('/api/admin/alerts/test', requireAdmin, async (req, res) => {
  const out = await alerts.notify({ key: 'test:' + Date.now(), level: 'info', kind: 'test', message: 'Test alert from the admin page.' });
  res.json({ webhookConfigured: alerts.configured, ...out });
});

// ── Monitoring: uptime signal, browser errors, and what the admin page shows ──
// /api/ping is for an uptime watcher (UptimeRobot, Better Stack...). It touches the database, so "up" means really up.
app.get('/api/ping', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { store.getMeta('ping'); res.json({ ok: true, uptimeSec: Math.round(process.uptime()) }); }
  catch (err) { res.status(503).json({ ok: false }); }
});
// Browser errors: tiny, scrubbed, and rationed so nobody can fill the log or ping the owner's phone.
const clientErrLimiter = security.createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many reports.' });
let clientErrHour = { at: 0, n: 0 };
app.post('/api/client-error', clientErrLimiter, security.sameOrigin, (req, res) => {
  const b = req.body || {};
  const nowT = Date.now(); if (nowT - clientErrHour.at > 3600e3) clientErrHour = { at: nowT, n: 0 };
  if (typeof b.message === 'string' && b.message && ++clientErrHour.n <= 60) errorLog.record({ source: 'client', route: errorsLib.routeOf('', typeof b.page === 'string' ? b.page.slice(0, 80) : ''), message: `${b.message.slice(0, 160)}${typeof b.at === 'string' ? ' @ ' + b.at.slice(0, 60) : ''}` });
  res.status(204).end();
});
app.get('/api/admin/errors', requireAdmin, (req, res) => {
  res.json({ groups: errorLog.groups({ sinceMs: 7 * 24 * 3600e3 }), webhook: alerts.configured, heartbeat: heartbeatState() });
});
// Dead-man's switch: the app tells an outside service (Healthchecks.io, Better Stack heartbeats...) it is alive every five
// minutes. If the site goes down, the messages stop and that service is what alerts you. A down server cannot alert itself.
const HEARTBEAT_URL = /^https:\/\//.test(String(process.env.HEARTBEAT_URL || '').trim()) ? String(process.env.HEARTBEAT_URL).trim() : '';
const hb = { lastOk: null, lastError: null };
const heartbeatState = () => ({ configured: !!HEARTBEAT_URL, lastOk: hb.lastOk, lastError: hb.lastError });
async function sendHeartbeat() {
  if (!HEARTBEAT_URL) return;
  try { await axios.get(HEARTBEAT_URL, { timeout: 8000, maxRedirects: 0, validateStatus: s => s >= 200 && s < 300 }); hb.lastOk = new Date().toISOString(); hb.lastError = null; }
  catch (err) { hb.lastError = err.message; }
}
if (HEARTBEAT_URL) { cron.schedule('*/5 * * * *', sendHeartbeat); setTimeout(sendHeartbeat, 15000); }
else if (process.env.HEARTBEAT_URL) console.warn('[Monitoring] HEARTBEAT_URL must start with https://, so the heartbeat is off.');

// ═════════════════════════════════════════════════════════════════
// SAFETY NET
// One bad request or one failed background call must not take the whole server down. Errors are
// logged and answered with a plain JSON message (never a stack trace). If errors pile up (more than
// 20 in a minute) the process exits so the host restarts it clean instead of limping on.
// ═════════════════════════════════════════════════════════════════
let recentFaults = [];
function noteFault(kind, err, route = '') {
  const now = Date.now();
  recentFaults = recentFaults.filter(t => now - t < 60000);
  recentFaults.push(now);
  console.error(`[${kind}]`, err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err);
  try { errorLog.record({ source: kind === 'route' ? 'server' : 'process', route, message: `${kind === 'route' ? '' : kind + ': '}${err && err.message ? err.message : err}` }); } catch (_) {}
  if (recentFaults.length > 20) { console.error('[Fatal] too many faults in a minute, exiting for a clean restart'); process.exit(1); }
}
process.on('uncaughtException', err => noteFault('uncaughtException', err));
process.on('unhandledRejection', err => noteFault('unhandledRejection', err));
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  if (status >= 500) { res.locals.errorLogged = true; noteFault('route', err, errorsLib.routeOf(req.method, req.originalUrl)); }
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: status === 413 ? 'Request too large.' : status === 400 ? 'Bad request.' : 'Something went wrong on the server.' });
});
