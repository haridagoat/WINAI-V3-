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
// True when any of the given team abbreviations is in the finished set.
const anyFinal = (finals, abbrs) => (abbrs || []).some(a => a && finals.has(String(a).toLowerCase()));
module.exports = { finalTeams, anyFinal };
