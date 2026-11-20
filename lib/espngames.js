// A player's game log from ESPN, shaped exactly like predict_tonight.py (nba.com) returns it.
// nba.com refuses requests from cloud hosts such as Railway, so the live server cannot use that script. ESPN answers from anywhere, so the
// same numbers are read from there and handed to the model in the same form: { player, id, season, source, gamesFound, currentSeasonGames,
// priorSeasonGamesInWindow, l5, l10, season_avg, games } and, for head-to-head, { gamesVsOpp, avgs, trend, recentGames }.
// ESPN has no offensive/defensive rebound split and no plus-minus, so those fields are left out rather than invented.
// Pure: no network here. The server fetches the JSON and passes it in.

// ESPN writes some team abbreviations differently from nba.com. Shown in the matchup text ("NYK @ MIN").
const NBA_ABBR = { NY: 'NYK', GS: 'GSW', SA: 'SAS', NO: 'NOP', UTAH: 'UTA', WSH: 'WAS' };
const nbaAbbr = a => { const u = String(a || '').toUpperCase(); return NBA_ABBR[u] || u; };

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const pair = s => { const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(s == null ? '' : s)); return m ? [+m[1], +m[2]] : [0, 0]; };
// Python's round(x, 1) and round(x), which the nba.com script uses: exact ties go to the even digit (2.25 -> 2.2, 4.5 -> 4), JavaScript's go up.
const roundHalfEven = v => { const f = Math.floor(v); const d = v - f; if (d === 0.5) return f % 2 === 0 ? f : f + 1; return Math.round(v); };
const r1 = x => {
  if (Number.isInteger(x * 4) && !Number.isInteger(x * 2)) { const n = Math.floor(Math.abs(x) * 10); return (x < 0 ? -1 : 1) * (n % 2 === 0 ? n : n + 1) / 10; }
  return Number(x.toFixed(1));
};
const pct = (m, a) => (a > 0 ? r1((m / a) * 100) : 0);

const dateLabel = iso => {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', year: 'numeric' });   // "Nov 07, 2026", as nba.com writes it
};

// One ESPN game-log response -> { regular: [...], post: [...] }, each newest first, in the nba.com game shape.
// Preseason, play-in and all-star rows are left out, and so are games the player did not play (0 minutes), as nba.com's log does.
function parseGameLog(json, { teamAbbr = '' } = {}) {
  const out = { regular: [], post: [] };
  if (!json || !Array.isArray(json.names) || !json.events) return out;
  const idx = {}; json.names.forEach((n, i) => { idx[n] = i; });
  const get = (stats, name) => (idx[name] == null ? undefined : stats[idx[name]]);
  for (const st of json.seasonTypes || []) {
    const label = String(st.displayName || '');
    // ESPN names play-in games "Play In Regular Season"; nba.com keeps them out of both the regular season and the playoffs.
    const bucket = /play[- ]?in|preseason|all[- ]star/i.test(label) ? null : /postseason/i.test(label) ? out.post : /regular season/i.test(label) ? out.regular : null;
    if (!bucket) continue;
    for (const cat of st.categories || []) {
      for (const ev of cat.events || []) {
        const meta = json.events[ev.eventId], stats = ev.stats;
        if (!meta || !Array.isArray(stats)) continue;
        const min = num(get(stats, 'minutes'));
        if (!(min > 0)) continue;
        const [fgm, fga] = pair(get(stats, 'fieldGoalsMade-fieldGoalsAttempted'));
        const [fg3m, fg3a] = pair(get(stats, 'threePointFieldGoalsMade-threePointFieldGoalsAttempted'));
        const [ftm, fta] = pair(get(stats, 'freeThrowsMade-freeThrowsAttempted'));
        const away = meta.atVs === '@';
        const opp = meta.opponent || {};
        const g = {
          date: dateLabel(meta.gameDate),
          matchup: `${String(teamAbbr || '').toUpperCase()} ${away ? '@' : 'vs.'} ${nbaAbbr(opp.abbreviation)}`.trim(),
          home: !away,
          wl: String(meta.gameResult || ''),
          min: String(Math.round(min)),
          pts: Math.round(num(get(stats, 'points'))), reb: Math.round(num(get(stats, 'totalRebounds'))), ast: Math.round(num(get(stats, 'assists'))),
          fgm, fga, fg_pct: pct(fgm, fga), fg3m, fg3a, fg3_pct: pct(fg3m, fg3a), ftm, fta,
          stl: Math.round(num(get(stats, 'steals'))), blk: Math.round(num(get(stats, 'blocks'))), tov: Math.round(num(get(stats, 'turnovers'))),
        };
        Object.defineProperty(g, '_t', { value: Date.parse(meta.gameDate) || 0, enumerable: false });
        Object.defineProperty(g, '_opp', { value: { name: String(opp.displayName || ''), abbr: nbaAbbr(opp.abbreviation) }, enumerable: false });
        bucket.push(g);
      }
    }
  }
  out.regular.sort((a, b) => b._t - a._t); out.post.sort((a, b) => b._t - a._t);
  return out;
}

// Same arithmetic as predict_tonight.py's calc_avgs (only the columns ESPN has).
function calcAvgs(games) {
  if (!games || !games.length) return {};
  const n = games.length, keys = ['pts', 'reb', 'ast', 'fgm', 'fga', 'fg3m', 'fg3a', 'ftm', 'fta', 'stl', 'blk', 'tov'];
  const avgs = {};
  for (const k of keys) avgs[k] = r1(games.reduce((s, g) => s + (g[k] || 0), 0) / n);
  if (avgs.fga > 0) avgs.fg_pct = r1((avgs.fgm / avgs.fga) * 100);
  if (avgs.fg3a > 0) avgs.fg3_pct = r1((avgs.fg3m / avgs.fg3a) * 100);
  if (avgs.fta > 0) avgs.ft_pct = r1((avgs.ftm / avgs.fta) * 100);
  const mins = games.map(g => num(g.min)).filter(m => m > 0);
  if (mins.length) avgs.min = r1(mins.reduce((s, m) => s + m, 0) / mins.length);
  return avgs;
}

// Share of the season average that comes from last season, given this season's games (season_blend.prior_weight in Python).
function priorWeight(games) {
  if (games == null || games <= 0) return 1;
  const floor = games <= 20 ? 0.15 : Math.max(0.05, 0.15 - (0.15 - 0.05) * (games - 20) / 40);
  const boost = games < 10 ? 0.5 * (1 - games / 10) : 0;
  return Math.min(0.6, Math.max(floor, boost));
}
function blendAvgs(cur, prior, w0) {
  if (!prior || !Object.keys(prior).length) return cur;
  if (!cur || !Object.keys(cur).length || w0 >= 1) return prior;
  const out = { ...cur };
  for (const [k, v] of Object.entries(cur)) { const pv = prior[k]; if (typeof v === 'number' && typeof pv === 'number') out[k] = r1((1 - w0) * v + w0 * pv); }
  return out;
}

// predict_tonight.py's regular mode. `current` is { regular, post } for this season, `prior` the same for last season (or null).
function buildLog({ name, id, season, current, prior }) {
  const currentGames = [...current.post, ...current.regular];             // playoffs come after the regular season, newest first
  const n = currentGames.length;
  const w0 = priorWeight(n);
  const priorGames = n < 40 && prior ? prior.regular.map(g => Object.assign(Object.create(Object.getPrototypeOf(g)), g, { priorSeason: true })) : [];
  if (!n && !priorGames.length) return { error: `No game log for ${name}` };
  const all = [...currentGames, ...priorGames.slice(0, Math.max(0, 20 - n))];
  const effective = n + roundHalfEven(Math.min(priorGames.length, 30) * w0);
  const seasonAvg = blendAvgs(calcAvgs(currentGames), calcAvgs(priorGames), priorGames.length ? w0 : 0);
  return {
    player: name, id, season, source: 'ESPN game log',
    gamesFound: effective, currentSeasonGames: n, priorSeasonGamesInWindow: all.filter(g => g.priorSeason).length,
    l5: calcAvgs(all.slice(0, 5)), l10: calcAvgs(all.slice(0, 10)), season_avg: seasonAvg, games: all.slice(0, 20),
  };
}

// Does a game's opponent match what was asked for ("Boston Celtics", "Celtics" or "BOS")?
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function matchesOpponent(game, opponent) {
  const o = norm(opponent), n = norm(game._opp && game._opp.name), abbr = String(game._opp && game._opp.abbr || '').toLowerCase();
  if (!o || !n) return false;
  if (o === n || o === abbr) return true;
  const nick = n.split(' ').pop(), onick = o.split(' ').pop();
  return nick === onick && nick.length >= 3;
}

// predict_tonight.py's head-to-head mode. `seasons` is [{ regular }, ...] newest season first; stops once 6 games are found.
function buildH2H({ name, id, opponent, seasons }) {
  const found = [], seen = new Set();
  for (const s of seasons) {
    for (const g of s.regular || []) { if (!seen.has(g.date + g.matchup) && matchesOpponent(g, opponent)) { seen.add(g.date + g.matchup); found.push(g); } }
    if (found.length >= 6) break;
  }
  if (!found.length) return { player: name, id, opponent, h2h: null, error: `No H2H games found vs ${opponent}` };
  const mid = Math.max(1, Math.floor(found.length / 2));
  const recent = found.slice(0, mid).reduce((a, g) => a + g.pts, 0) / mid;
  const older = found.slice(mid).reduce((a, g) => a + g.pts, 0) / Math.max(found.length - mid, 1);
  const trend = recent > older + 2 ? 'IMPROVING' : recent < older - 2 ? 'DECLINING' : 'STABLE';
  return { player: name, id, opponent, h2h: { gamesVsOpp: found.length, source: 'ESPN game log', avgs: calcAvgs(found), trend, recentGames: found } };
}

module.exports = { parseGameLog, calcAvgs, priorWeight, blendAvgs, buildLog, matchesOpponent, buildH2H, nbaAbbr };
