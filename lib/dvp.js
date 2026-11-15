// What a defense gives up to guards, forwards and centers, turned into a small adjustment to a projection. Pure functions; the data comes from
// dvp_positions.json (written by fetch_dvp.py) and the strength of the adjustment from model_params.json (positionAllowed, fitted by `npm run lab`).
//
// The lab found that, beyond a defense's overall points allowed (which the model already uses), how much it gives up to a player's group of
// a given stat predicts rebounds, assists, threes, steals and blocks, but not points. The feature is the group's figure for the stat, as a ratio
// to the league's, minus the defense's overall points-allowed ratio; each figure is pulled toward the league average while the defense has played few games.

const GROUPS = ['G', 'F', 'C'];
const PROP_STATS = { points: ['pts'], rebounds: ['reb'], assists: ['ast'], '3pm': ['fg3m'], steals: ['stl'], blocks: ['blk'], pra: ['pts', 'reb', 'ast'], pr: ['pts', 'reb'], pa: ['pts', 'ast'], ra: ['reb', 'ast'] };
const SENS_KEY = { pts: 'points', reb: 'rebounds', ast: 'assists', fg3m: '3pm', stl: 'steals', blk: 'blocks' };

// "PG", "SG", "G", "G-F" -> guards; "SF", "PF", "F", "F-C" -> forwards; "C", "C-F" -> centers. The first letter is the main position.
function groupOf(position) {
  const p = String(position || '').trim().toUpperCase();
  if (!p) return null;
  if (p === 'PG' || p === 'SG') return 'G';
  if (p === 'SF' || p === 'PF') return 'F';
  const c = p[0];
  return c === 'G' || c === 'F' || c === 'C' ? c : null;
}

// "LA Clippers" and "Los Angeles Clippers" are the same team: match on the last word of the name.
const nick = name => String(name || '').trim().toLowerCase().split(/\s+/).pop();
function findTeam(teams, name) {
  if (!teams || !name) return null;
  if (teams[name]) return teams[name];
  const n = nick(name);
  const hit = Object.keys(teams).find(k => nick(k) === n);
  return hit ? teams[hit] : null;
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// -> { mult, detail } or null when there is nothing trustworthy to say (no data, unknown team or position, a prop type the lab found no signal for).
// `params` is the positionAllowed block: { sens: {rebounds: .., ...}, shrinkGames, cap }.
function positionAllowedMultiplier({ data, team, position, propType, params, maxAgeDays = 4, now = Date.now() }) {
  const sens = params && params.sens;
  const stats = PROP_STATS[propType];
  const group = groupOf(position);
  if (!data || !data.windows || !sens || !stats || !group) return null;
  const fetched = Date.parse(data.fetchedAt);
  if (!isFinite(fetched) || now - fetched > maxAgeDays * 86400000) return null;
  if (!stats.some(s => (sens[SENS_KEY[s]] || 0) > 0)) return null;
  const teams = data.windows.season, mine = findTeam(teams, team);
  if (!mine || !(mine.gp > 0)) return null;

  const k = Number.isFinite(params.shrinkGames) ? params.shrinkGames : 10, cap = Number.isFinite(params.cap) ? params.cap : 0.06;
  const all = Object.values(teams).filter(t => t && t.gp > 0);
  if (all.length < 20) return null;
  const shrunk = (stat, g) => {
    const lg = mean(all.map(t => t[g][stat]));
    return lg > 0 ? { value: (mine.gp * mine[g][stat] + k * lg) / (mine.gp + k), league: lg } : null;
  };
  // the defense's overall points allowed, as a ratio to the league
  let ptsMine = 0, ptsLeague = 0;
  for (const g of GROUPS) { const s = shrunk('pts', g); if (!s) return null; ptsMine += s.value; ptsLeague += s.league; }
  const overall = ptsMine / ptsLeague;

  let adj = 0, weight = 0;
  const parts = [];
  for (const stat of stats) {
    const s = shrunk(stat, group);
    if (!s) return null;
    const x = s.value / s.league - overall, b = sens[SENS_KEY[stat]] || 0;
    adj += s.league * b * x; weight += s.league;                  // components of a combo count in proportion to how much of the total they are
    parts.push({ stat, ratio: parseFloat((s.value / s.league).toFixed(3)), vsOverall: parseFloat(x.toFixed(3)) });
  }
  adj /= weight;
  const mult = 1 + clamp(adj, -cap, cap);
  return { mult, detail: { group, games: mine.gp, overallPointsRatio: parseFloat(overall.toFixed(3)), parts } };
}

// What one defense gives up per game to guards, forwards and centers, with each figure ranked among all the teams (1 = gives up the fewest, the
// same way the rest of the team stats are ranked). `yourGroup` is the player's own group, for highlighting. Null when there is no usable data.
const TABLE_STATS = ['pts', 'reb', 'ast', 'fg3m', 'stl', 'blk'];
const GROUP_LABEL = { G: 'Guards', F: 'Forwards', C: 'Centers' };
function positionTable({ data, team, position, windowKey = 'season', maxAgeDays = 4, now = Date.now() }) {
  if (!data || !data.windows || !data.windows[windowKey]) return null;
  const fetched = Date.parse(data.fetchedAt);
  if (!isFinite(fetched) || now - fetched > maxAgeDays * 86400000) return null;
  const teams = data.windows[windowKey], mine = findTeam(teams, team);
  const all = Object.values(teams).filter(t => t && t.gp > 0);
  if (!mine || !(mine.gp > 0) || all.length < 20) return null;
  const rows = GROUPS.map(g => {
    const stats = {};
    for (const st of TABLE_STATS) {
      const value = mine[g][st], vals = all.map(t => t[g][st]);
      if (!isFinite(value)) return null;
      stats[st] = { value: parseFloat(value.toFixed(1)), rank: 1 + vals.filter(v => v < value).length, leagueAvg: parseFloat(mean(vals).toFixed(1)) };
    }
    return { group: g, label: GROUP_LABEL[g], stats };
  });
  if (rows.some(r => !r)) return null;
  return { games: mine.gp, of: all.length, fetchedAt: data.fetchedAt, season: data.season || null, window: windowKey, yourGroup: groupOf(position), rows };
}

// The same figures in the shape the Matchup tab draws: per game allowed to Guards / Forwards / Centers with each one's rank (1 = allows the fewest) among all teams,
// every number from one table and one sample, so a rank always belongs to the value next to it, and the three groups add up to the team's total.
function defenseView({ data, team, windowKey = 'season', maxAgeDays = 10, now = Date.now() }) {
  const t = positionTable({ data, team, windowKey, maxAgeDays, now });
  if (!t) return null;
  const byPosition = {}, ranks = {};
  for (const r of t.rows) {
    byPosition[r.label] = {}; ranks[r.label] = {};
    for (const [st, c] of Object.entries(r.stats)) { byPosition[r.label][st] = c.value; ranks[r.label][st] = { value: c.value, rank: c.rank, of: t.of, leagueAvg: c.leagueAvg }; }
  }
  return { available: true, team, gamesAnalyzed: t.games, window: t.window, source: 'FantasyPros', season: t.season, fetchedAt: t.fetchedAt, leagueSize: t.of, byPosition, ranks };
}

module.exports = { groupOf, findTeam, positionAllowedMultiplier, positionTable, defenseView, PROP_STATS };
