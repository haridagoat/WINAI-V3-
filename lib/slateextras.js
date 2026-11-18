// Everything the Today page adds around its games, answered in one request instead of one per game plus one per team (44 calls to open the page,
// 24 of them these): each game's spread, total and moneyline, and who is hurt on each team. The server reads the schedule itself and passes the games in
// as [away, home] pairs; the two fetchers are passed in too, so this can be tested without any network.
const MAX_GAMES = 20;   // a ceiling on one day's lookups, whatever the schedule says

async function buildSlateExtras({ games, fetchOdds, fetchRoster }) {
  const list = (games || []).slice(0, MAX_GAMES), teams = [...new Set(list.flat())], lines = {}, injuries = {};
  const odds = async ([away, home]) => { lines[`${away}|${home}`] = await Promise.resolve().then(() => fetchOdds(away, home)).catch(() => ({ available: false })); };
  const rosters = Promise.all(teams.map(async t => {
    try { const r = await fetchRoster(t); injuries[t] = r && Array.isArray(r.injured) ? r.injured : []; } catch (_) { injuries[t] = []; }
  }));
  // The first game goes first: it fills the schedule cache the odds lookups share, so the rest read it instead of every one fetching it at once.
  const oddsAll = (async () => { if (list.length) { await odds(list[0]); await Promise.all(list.slice(1).map(odds)); } })();
  await Promise.all([oddsAll, rosters]);
  return { lines, injuries };
}

module.exports = { buildSlateExtras, MAX_GAMES };
