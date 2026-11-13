// Which props are "the picks": the three best in each game, one per player, ranked by expected value at the best available price.
// There is no minimum. A game with lines always has picks, and a pick that does not clear the value bar is shown as the best available,
// not dressed up as a strong bet (the page marks the ones that do clear it). Pure functions.
const evOf = r => r && r.realEdge ? r.realEdge.expectedValue : undefined;
const isPickable = r => !!(r && r.direction && r.realEdge && Number.isFinite(evOf(r)));
const gameKey = r => `${r.awayTeam}@${r.homeTeam}`;
const rowKey = r => `${r.player}|${r.propType}|${r.homeTeam}|${r.awayTeam}`;

// Map of "away@home" -> that game's picks, best first.
function topPicksPerGame(results, n = 3) {
  const byGame = new Map();
  for (const r of results || []) {
    if (!isPickable(r)) continue;
    const k = gameKey(r);
    if (!byGame.has(k)) byGame.set(k, []);
    byGame.get(k).push(r);
  }
  const out = new Map();
  for (const [k, rows] of byGame) {
    rows.sort((a, b) => (evOf(b) - evOf(a)) || ((b.confidence || 0) - (a.confidence || 0)) || String(a.player).localeCompare(String(b.player)) || String(a.propType).localeCompare(String(b.propType)));
    const seen = new Set(), picks = [];
    for (const r of rows) { if (seen.has(r.player)) continue; seen.add(r.player); picks.push(r); if (picks.length >= n) break; }
    out.set(k, picks);
  }
  return out;
}
const flattenPicks = map => [...map.values()].flat();

// The headline Top 3 for a league: the most confident of the props it is given, one per player (the server gives it every priced prop on the slate, so
// expected value does not limit the pool). Ties go to the higher expected value,
// then to the name, so the same scan always gives the same three. (This is a different list from the three best per game, which are ranked by value.)
function mostConfident(results, n = 3) {
  const rows = (results || []).filter(isPickable).sort((a, b) =>
    ((b.confidence || 0) - (a.confidence || 0)) || (evOf(b) - evOf(a)) || String(a.player).localeCompare(String(b.player)) || String(a.propType).localeCompare(String(b.propType)));
  const seen = new Set(), out = [];
  for (const r of rows) { if (seen.has(r.player)) continue; seen.add(r.player); out.push(r); if (out.length >= n) break; }
  return out;
}
// Map of a prop's key -> its rank (1 = best) inside its game, for the props that are picks.
function pickRanks(results, n = 3) {
  const ranks = new Map();
  for (const picks of topPicksPerGame(results, n).values()) picks.forEach((r, i) => ranks.set(rowKey(r), i + 1));
  return ranks;
}

module.exports = { mostConfident, topPicksPerGame, flattenPicks, pickRanks, isPickable, gameKey, rowKey };
