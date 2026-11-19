// Which teams have a finished game on a day, read from ESPN's scoreboard events (free, no odds credits).
// Used to grade picks within minutes of the final buzzer instead of waiting for the nightly run. Pure.
const finalTeams = events => {
  const out = new Set();
  for (const e of events || []) {
    const comp = e && e.competitions && e.competitions[0];
    const st = (comp && comp.status && comp.status.type) || (e && e.status && e.status.type) || {};
    if (!(st.name === 'STATUS_FINAL' || st.completed === true)) continue;
    for (const c of (comp && comp.competitors) || []) {
      const a = c && c.team && c.team.abbreviation;
      if (a) out.add(String(a).toLowerCase());
    }
  }
  return out;
};
// Team abbreviation (lowercase) -> ESPN event id, for finished games only, so a finished game's box score can be read.
const finalEventIds = events => {
  const out = new Map();
  for (const e of events || []) {
    const comp = e && e.competitions && e.competitions[0];
    const st = (comp && comp.status && comp.status.type) || (e && e.status && e.status.type) || {};
    if (!e || e.id == null || !(st.name === 'STATUS_FINAL' || st.completed === true)) continue;
    for (const c of (comp && comp.competitors) || []) { const a = c && c.team && c.team.abbreviation; if (a) out.set(String(a).toLowerCase(), String(e.id)); }
  }
  return out;
};
// Names from two feeds rarely match letter for letter (accents, Jr., punctuation).
const normName = n => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ').replace(/\s+/g, ' ').trim();
// Did this player sit out? Reads ESPN's box score `players` list. true only when the box score lists the player as did-not-play;
// false when he has a line; null when he is not listed at all (unknown: left to the normal retry, never guessed).
function playerDidNotPlay(boxPlayers, name) {
  const want = normName(name);
  for (const team of boxPlayers || []) for (const grp of (team && team.statistics) || []) for (const a of (grp && grp.athletes) || []) {
    if (normName(a && a.athlete && a.athlete.displayName) === want) return a.didNotPlay === true;
  }
  return null;
}
// True when any of the given team abbreviations is in the finished set.
const anyFinal = (finals, abbrs) => (abbrs || []).some(a => a && finals.has(String(a).toLowerCase()));
module.exports = { finalTeams, anyFinal, finalEventIds, normName, playerDidNotPlay };
