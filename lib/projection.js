// The projection engine: minutes, then production per minute, then the adjustments (usage, opponent, pace, game context, position allowed), the learned
// bias correction and the blend with the books' line, plus the over/under probability, the confidence score and the edge score. Moved here from server.js
// unchanged, so the math can be tested by requiring it instead of cutting functions out of the server's source.
//
// create(deps) returns the functions. What it needs from the server (the things that read files and keep caches) is passed in:
//   getBiasTable()                the current learned bias table (changes when it is refit)
//   gameDateISO(game)             a game-log row's date as YYYY-MM-DD
//   getLeagueBaselines(league), getLeagueFourFactors(league)   league averages for the opponent adjustments
//   injuryAbsenceCache            { lowercase name: { lastPlayed, gamesThisSeason, ts } }, filled by the server's lookups (shared, not copied)
//   loadDvp(), loadNBAStats()     the position-allowed table and the NBA stat files
const modelParams = require('./params');
const biasLib = require('./bias');
const dvpLib = require('./dvp');
const market = require('./market');

function create({ getBiasTable, gameDateISO, getLeagueBaselines, getLeagueFourFactors, injuryAbsenceCache, loadDvp, loadNBAStats }) {
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

// How much of the team's regular production is missing because of injuries, measured the way the lab measured it: each absent regular's per-game
// stat, over the per-game stat of every regular on the roster (regular = 20+ minutes a game). A player listed 'questionable' counts half.
// Returns null when the season stat rows cannot support it (the caller then falls back to the usage-rate method).
function missingProductionShare(playerRoster, injuredPlayers, seasonRows, playerStats) {
  if (!seasonRows?.length || !playerRoster?.players?.length) return null;
  const rowOf = name => {
    const toks = new Set(String(name || '').toLowerCase().trim().split(/\s+/).filter(Boolean));
    return toks.size ? seasonRows.find(r => { const t = new Set(String(r.PLAYER_NAME || '').toLowerCase().split(/\s+/)); return [...toks].every(x => t.has(x)); }) : null;
  };
  const keys = { points: 'PTS', rebounds: 'REB', assists: 'AST', '3pm': 'FG3M', steals: 'STL', blocks: 'BLK' };
  const regulars = [];
  for (const p of playerRoster.players) {
    const r = rowOf(p.name), gp = parseFloat(r?.GP) || 0;
    if (r && gp >= 3 && (parseFloat(r.MIN) || 0) / gp >= 20) regulars.push({ name: p.name, row: r, gp });
  }
  for (const ip of injuredPlayers) {                                    // an injured regular may be listed apart from the healthy roster
    if (regulars.some(x => x.name === ip.name)) continue;
    const r = rowOf(ip.name), gp = parseFloat(r?.GP) || 0;
    if (r && gp >= 3 && (parseFloat(r.MIN) || 0) / gp >= 20) regulars.push({ name: ip.name, row: r, gp });
  }
  if (regulars.length < 5) return null;
  const perGame = (x, k) => (parseFloat(x.row[k]) || 0) / x.gp;
  const missing = [];
  for (const ip of injuredPlayers) {
    const reg = regulars.find(x => x.name === ip.name);
    if (!reg) continue;                                                // not a regular: the lab does not count them either
    const statusWeight = ['out', 'doubtful'].includes((ip.status || '').toLowerCase()) ? 1.0 : 0.5;
    missing.push({ reg, w: statusWeight * baselineAbsenceWeight(ip.name, playerStats), name: ip.name, status: ip.status });
  }
  const share = {};
  for (const k of Object.values(keys)) {
    const total = regulars.reduce((t, x) => t + perGame(x, k), 0);
    share[k] = total > 0 ? Math.min(0.6, missing.reduce((t, m) => t + m.w * perGame(m.reg, k), 0) / total) : 0;
  }
  return { share, missing, regularsCount: regulars.length };
}

function calcUsageInflation(playerRoster, playerStats, propType, nbaPlayerStats, league = 'nba') {
  let mult = 1.0;
  let teammatePart = 0;                                   // the share of the lift that comes from teammates being out (logged for the forward check)
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

      // NBA: the measured method. The lab found that others produce more by (slope x the share of the team's regular production that is out),
      // with a slope for each stat, so that share is worked out the same way here and the fitted slope applied.
      const prod = league === 'nba' ? missingProductionShare(playerRoster, injuredPlayers, loadNBAStats()?.playerStats, playerStats) : null;
      const sens = modelParams.get().usage.sens || {};
      if (prod && prod.missing.length) {
        const own = k => parseFloat(playerStats?.averages?.[k]) || 0;
        const parts = { points: ['PTS'], rebounds: ['REB'], assists: ['AST'], '3pm': ['FG3M'], steals: ['STL'], blocks: ['BLK'], pra: ['PTS', 'REB', 'AST'], pr: ['PTS', 'REB'], pa: ['PTS', 'AST'], ra: ['REB', 'AST'] }[propType] || ['PTS'];
        const nameOf = { PTS: 'points', REB: 'rebounds', AST: 'assists', FG3M: '3pm', STL: 'steals', BLK: 'blocks' }, avgKey = { PTS: 'pts', REB: 'reb', AST: 'ast', FG3M: 'fg3m', STL: 'stl', BLK: 'blk' };
        const weights = parts.map(k => Math.max(own(avgKey[k]), 0.01)), wSum = weights.reduce((a, b) => a + b, 0);
        const boost = parts.reduce((t, k, i) => t + (weights[i] / wSum) * (sens[nameOf[k]] ?? 0) * prod.share[k], 0);
        mult += boost;
        details.push({
          method: 'production share', missingShare: Object.fromEntries(parts.map(k => [nameOf[k], parseFloat((prod.share[k] * 100).toFixed(1)) + '%'])),
          scaledBoost: parseFloat((boost * 100).toFixed(1)) + '%',
          injuredPlayers: prod.missing.map(m => ({ name: m.name, status: m.status, newToBaseline: Math.round(baselineAbsenceWeight(m.name, playerStats) * 100) + '%' })),
        });
      } else if (prod) {
        details.push({ method: 'production share', note: 'no regular rotation player is out', scaledBoost: '0%' });
      } else if (healthyTotalUSG > 0 && playerUSG && freedUSG > 0) {
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
      teammatePart = mult - 1;
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
  calcUsageInflation._lastTeammate = teammatePart;
  return result;
}

// Returns full redistribution breakdown for UI display and Claude prompt
function calcInjuryBreakdown(playerRoster, playerStats, propType, nbaPlayerStats, league = 'nba') {
  const mult    = calcUsageInflation(playerRoster, playerStats, propType, nbaPlayerStats, league);
  const details = calcUsageInflation._lastDetails || [];
  return {
    mult,
    totalBoost:     parseFloat((mult - 1.0).toFixed(3)),
    teammateBoost:  parseFloat((calcUsageInflation._lastTeammate || 0).toFixed(4)),
    details,
    usgBased:       details.some(d => d.method === 'USG_PCT redistribution' || d.method === 'production share'),
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
  const usageMult = calcUsageInflation(ctx.playerRoster, playerStats, propType || 'points', ctx.nbaPlayerStats || [], ctx.league || 'nba');
  if (usageMult > 1.0 && projMin > 0) {
    // The share of the lift that arrives as extra minutes is the one measured on two seasons of games (about 0.6 for points), not a guess.
    const minutesBump = Math.min(0.20, (usageMult - 1.0) * modelParams.usageMinutesShare(propType || 'points'));
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
  if (ctx.gameContext?.isBackToBack && projMin > 0 && modelParams.get().rest.minutes !== 1) {
    const before = projMin;
    projMin *= modelParams.get().rest.minutes;
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

// Small-count props (3-pointers, steals, blocks, and low rebound or assist lines) land on whole numbers and cannot go below
// zero, so a bell curve misprices them, most of all around the line. They use a count distribution instead, with the same mean
// (the projection) and the same spread (stdDev) the bell curve would have used: Poisson when the spread matches the mean,
// negative binomial when it is wider, binomial when it is tighter (3-pointers usually are). Points and combos stay on the curve.
function usesCountModel(propType, projection) {
  const counts = ['3pm', 'steals', 'blocks'];
  return counts.includes(propType) || ((propType === 'rebounds' || propType === 'assists') && projection < 5);
}

function countPmf(mu, variance, kMax) {
  const pmf = new Array(kMax + 1).fill(0), ratio = variance / mu;
  if (ratio > 1.02) {
    const r = mu * mu / (variance - mu), p = r / (r + mu);
    pmf[0] = Math.pow(p, r);
    for (let k = 0; k < kMax; k++) pmf[k + 1] = pmf[k] * ((k + r) / (k + 1)) * (1 - p);
  } else if (ratio < 0.98) {
    const n = Math.min(200, Math.max(Math.ceil(mu) + 1, Math.round(mu * mu / (mu - variance)))), p = mu / n;
    pmf[0] = Math.pow(1 - p, n);
    for (let k = 0; k < kMax; k++) pmf[k + 1] = k >= n ? 0 : pmf[k] * ((n - k) / (k + 1)) * (p / (1 - p));
  } else {
    pmf[0] = Math.exp(-mu);
    for (let k = 0; k < kMax; k++) pmf[k + 1] = pmf[k] * mu / (k + 1);
  }
  return pmf;
}

// Over and under, with a whole-number line's push left out: a push refunds the bet, so over and under are measured against each other.
function countOverUnder(mu, stdDev, postedLine) {
  const line = parseFloat(postedLine), variance = Math.max(stdDev * stdDev, 1e-6);
  if (!(mu > 0) || !(line > 0)) return null;
  const kMax = Math.min(600, Math.max(40, Math.ceil(line + 2 * mu + 12 * Math.sqrt(Math.max(variance, mu)))));
  const pmf = countPmf(mu, variance, kMax);
  const cdf = k => { let t = 0; for (let i = 0; i <= Math.min(k, kMax); i++) t += pmf[i]; return t; };
  const whole = Number.isInteger(line);
  const push = whole ? pmf[line] || 0 : 0, over = 1 - cdf(whole ? line : Math.floor(line));
  const live = 1 - push;
  if (!(live > 1e-9)) return null;
  const o = Math.max(0, Math.min(1, over / live));
  return { overProbability: parseFloat(o.toFixed(3)), underProbability: parseFloat((1 - o).toFixed(3)), pushProbability: parseFloat(push.toFixed(3)) };
}

function calcOverUnderProbability(projection, stdDev, postedLine, propType) {
  if (!projection || !stdDev || stdDev <= 0 || !postedLine) return null;
  // Anything that is not a real finite number (a broken stat file, a feed returning text) gets "no answer", not an exception from deep inside the count model.
  if (!Number.isFinite(Number(projection)) || !Number.isFinite(Number(stdDev)) || !Number.isFinite(parseFloat(postedLine))) return null;
  if (usesCountModel(propType, projection)) { const c = countOverUnder(projection, stdDev, postedLine); if (c) return c; }
  // A count stat (points, blocks, steals, etc.) can't go below 0, but the raw normal approximation assigns real probability mass there
  // anyway: truncate at 0 and renormalize over the valid [0, infinity) domain instead of silently leaving that impossible mass in the split.
  const line = parseFloat(postedLine);
  const zZero = (0 - projection) / stdDev;
  const massBelowZero = normalCdf(zZero);
  const validMass = 1 - massBelowZero;
  const cdf = x => validMass > 0.0001
    ? Math.max(0, Math.min(1, (normalCdf((x - projection) / stdDev) - massBelowZero) / validMass))
    : (x <= 0 ? 0 : 1);                       // degenerate: projection deeply negative relative to stdDev
  // A whole-number line can land exactly on the number, which refunds the bet: that sliver is left out of both sides and reported as
  // the push chance. A half-number line cannot push.
  if (Number.isInteger(line) && line > 0) {
    const lo = cdf(line - 0.5), hi = cdf(line + 0.5), push = Math.max(0, hi - lo), live = 1 - push;
    if (live > 1e-9) {
      const o = Math.max(0, Math.min(1, (1 - hi) / live));
      return { overProbability: parseFloat(o.toFixed(3)), underProbability: parseFloat((1 - o).toFixed(3)), pushProbability: parseFloat(push.toFixed(3)) };
    }
  }
  const under = cdf(line);
  const over = 1 - under;
  return { overProbability: parseFloat(over.toFixed(3)), underProbability: parseFloat(under.toFixed(3)), pushProbability: 0 };
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
  let posAllowed = null;  // the position-allowed multiplier, set in the general path below and logged on scan rows

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
  // Decay weighting (switched on per stat by the lab only if it beats the fixed 10-game window by 1% or more; on the last refit it did not:
  // the best settings were within 0.6% of what is already here). Newest game first; weights halve every `halfLifeGames` games.
  const decayHalfLife = modelParams.get().decay.halfLifeGames[propType], decayLambda = modelParams.get().decay.lambda[propType] ?? 0.7;
  const decayLog = playerStats.gameLog20 || recentGames || [];
  let decayed = null;
  if (decayHalfLife > 0 && decayLog.length >= 8) {
    const g = Math.pow(0.5, 1 / decayHalfLife); let num = 0, den = 0;
    decayLog.forEach((gm, i) => { const w = Math.pow(g, i); num += w * getGameVal(gm); den += w; });
    decayed = num / den;
  }
  const shrunkBase = decayed != null
    ? (seasonVal != null ? decayLambda * decayed + (1 - decayLambda) * seasonVal : decayed)
    : shrink(l10FromLog, seasonVal, recentGamesCount, 8);
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
  const usageMult = calcUsageInflation(ctx.playerRoster, playerStats, propType, ctx.nbaPlayerStats || [], league);
  // Usage signal is split across two channels so it isn't counted twice:
  // 35% already landed on minutes (projectMinutes' "role bump"), the
  // remaining 65% applies here to the per-minute production rate.
  const rateUsageMult = 1 + (1 - modelParams.usageMinutesShare(propType)) * (usageMult - 1.0);   // whatever minutes did not carry (see projectMinutes)

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

    // What this defense gives up to the player's group (guards/forwards/centers) in this stat, beyond its overall points allowed (lib/dvp.js).
    const beforeDvp = proj;
    posAllowed = league === 'nba' ? dvpLib.positionAllowedMultiplier({ data: loadDvp(), team: ctx.oppAdvanced?.TEAM_NAME, position: playerPos, propType, params: modelParams.get().positionAllowed }) : null;
    if (posAllowed) proj *= posAllowed.mult;
    if (Math.abs(proj - beforeDvp) > 0.05) drivers.push({ label: 'opponent allowed to this position', value: parseFloat((proj - beforeDvp).toFixed(1)) });

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

  // ── HOME/AWAY SPLIT — removed ───────────────────────────────────
  // This used to scale the projection by the player's own home or road average from his last 20 games (shrunk toward 1.0, capped at +-10%).
  // The replay lab tested exactly that on about 13,000 player-games in each of two seasons: the adjustment predicted nothing (slope between
  // -0.2 and 0.2 for points, rebounds, assists and threes) and made the average miss slightly worse. A player's own home/road gap is noise.

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

  // ── LEARNED BIAS CORRECTION ─────────────────────────────────────
  // Graded results showed the model running about 10% high on points and assists. The nightly fit (fitBias) scales it back by what actually happened.
  const biasMult = biasLib.multFor(getBiasTable(), league, propType);
  if (biasMult !== 1) {
    const before = proj;
    proj *= biasMult;
    drivers.push({ label: 'learned bias correction', value: parseFloat((proj - before).toFixed(1)) });
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
    sampleStdDev = Math.sqrt(gameVals.reduce((s,v)=>s+Math.pow(v-mean,2),0) / Math.max(1, gameVals.length - 1));   // n-1: a small sample under-states its own spread
  }
  const MIN_CV = { points:0.28, pra:0.25, pr:0.28, pa:0.28, ra:0.32, rebounds:0.35, assists:0.35, '3pm':0.55, steals:0.6, blocks:0.6 };
  // The spread of real outcomes around a number was measured on graded picks (points land about 6.6 from the line, far wider than the old
  // 28% floor implied); where that is fitted it replaces the floor. Combos and count stats keep the floor until the lab fits them.
  const fittedSd = isCombo ? null : modelParams.spreadSd(propType, proj);
  const stdDev = Math.max(sampleStdDev || 0, fittedSd != null ? fittedSd : (MIN_CV[propType] || 0.35) * Math.max(proj, 0.1));
  const zRange = 1.28; // ~80% interval

  const confidence = calcConfidence({
    playerStats, recentGames, gameVals, minutesProj, usageMult, totalSwing, gc, h2h,
    h2hVal, l10FromLog, seasonVal, ctx, league, canDecomposePoints,
  });

  const dvpCoeff = calcDvPCoeff(ctx.oppAdvanced?.DEF_RATING, playerPos, ctx.playerPlaytypes, ctx.oppDefPlaytypes, propType, league);

  return {
    biasMult,
    positionMult:      posAllowed ? parseFloat(posAllowed.mult.toFixed(4)) : null,
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
    injuryBreakdown:   calcInjuryBreakdown(ctx.playerRoster, playerStats, propType, ctx.nbaPlayerStats || [], league),
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
function blendWithMarket(mathProjection, consensusLine, bookCount, propType) {
  if (!mathProjection || consensusLine == null || !bookCount || bookCount < 1) return mathProjection;
  const proj = mathProjection.projection;
  if (!proj) return mathProjection;

  // The projection shown stays the model's own number. Alongside it goes a market-blended estimate, because on 647 graded picks the posted
  // line missed the real stat by less than the model did (best mix about 15% model; points 10%, assists 25%). The blended estimate is what the
  // win chance and EV lean on; it is shown as a secondary figure. The share comes from model_params.json so the lab can refit it, and with fewer
  // books behind the line the model keeps a little more of the say.
  const wMean = modelParams.forProp(modelParams.get().market.weightModelMean, propType, 0.15);
  const bookFactor = bookCount >= 4 ? 1 : bookCount >= 2 ? 0.9 : 0.75;
  const wModel = wMean + (1 - wMean) * (1 - bookFactor);
  const marketWeight = 1 - wModel;
  const blended = proj + marketWeight * (consensusLine - proj);
  return {
    ...mathProjection,
    marketBlendProjection: parseFloat(blended.toFixed(1)),
    marketBlend: { consensusLine, bookCount, weight: parseFloat(marketWeight.toFixed(2)), shift: parseFloat((blended - proj).toFixed(1)) },
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

  return { shrink, winsorizeGames, PACE_NEUTRAL, getPaceMultiplier, calcPaceAdj, calcDvPCoeff, baselineAbsenceWeight, missingProductionShare, calcUsageInflation, calcInjuryBreakdown, projectMinutes, calcOpponentAdjustment, normalCdf, usesCountModel, countPmf, countOverUnder, calcOverUnderProbability, CONFIDENCE_FORMULA_VERSION, calcConfidence, buildProjection, blendWithMarket, calcEdgeScore };
}

module.exports = { create };
