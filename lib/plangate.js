// What a free account sees, and what it is never sent. A blur drawn by the page can be removed in the browser's inspector in seconds, so the locked
// parts are withheld on the server: a locked pick arrives as { locked: true, rank } and nothing else, and the page draws dummy text behind its blur.
// Every function here returns a new object and leaves its input alone (the cached and locked lists are shared by every visitor).
const lockedSlot = rank => ({ locked: true, rank });

// The headline Top picks: the first one is real, the rest are slots. The day's Top 10 is withheld entirely; `locked` says how much is held back.
function lockedTopPlays(data, { shown = 1 } = {}) {
  if (!data || typeof data !== 'object') return data;
  const slotted = list => (Array.isArray(list) ? list.map((p, i) => (i < shown ? p : lockedSlot(i + 1))) : undefined);
  const out = { ...data, topPlays: slotted(data.topPlays) || [], topTen: [] };
  if (Array.isArray(data.fallbackPlays)) out.fallbackPlays = slotted(data.fallbackPlays);
  const total = Math.max(Array.isArray(data.topTen) ? data.topTen.length : 0, Array.isArray(data.topPlays) ? data.topPlays.length : 0, Array.isArray(data.fallbackPlays) ? data.fallbackPlays.length : 0);
  out.locked = { shown: Math.min(shown, total), hidden: Math.max(0, total - shown) };
  return out;
}

// Each game's picks: the teams stay (the schedule is public), every pick becomes a slot. Only home, away and the slot count survive.
function lockedTeamPicks(data) {
  if (!data || typeof data !== 'object') return data;
  const games = (Array.isArray(data.games) ? data.games : []).map(g => ({ home: g && g.home, away: g && g.away, picks: ((g && g.picks) || []).map((_, i) => lockedSlot(i + 1)) }));
  return { ...data, games, locked: true };
}

// The prop board: no rows at all, only how many there are.
function lockedBoard(all, extra = {}) {
  return { props: [], locked: true, total: Array.isArray(all) ? all.length : 0, ...extra };
}

module.exports = { lockedTopPlays, lockedTeamPicks, lockedBoard, lockedSlot };
