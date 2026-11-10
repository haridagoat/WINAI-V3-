// Which games on today's slate should be asked the books for player props again.
// Books post props at different times, so a game with none at scan time is retried as its tip-off gets close:
// not before it is within `windowMs`, not more often than `gapMs`, and never more than `tries` times.
// A game that already has props, or that has started, is left alone.
function eventsDueForFill(events, info, haveGame, now, { gapMs, windowMs, tries }) {
  return (events || []).filter(ev => {
    const start = new Date(ev.commence_time).getTime();
    if (!(start > now)) return false;
    const i = (info || {})[ev.id];
    if (i && i.count > 0) return false;
    // a scan saved before games were tracked one by one: a game that already has props in it is not asked again
    if (!i && haveGame && haveGame.has(`${ev.away_team}@${ev.home_team}`)) return false;
    if (i && (i.attempts >= tries || now - i.lastTry < gapMs)) return false;
    return start - now <= windowMs;
  });
}

// What each game returned, kept with the scan. `report` rows are { id, home, away, commence, count, ok }.
function eventInfoFrom(report, prev = {}, now = Date.now()) {
  const info = { ...prev };
  for (const r of report) {
    const old = info[r.id];
    info[r.id] = { home: r.home, away: r.away, commence: r.commence, count: (old?.count || 0) + r.count, attempts: (old?.attempts || 0) + 1, lastTry: now, ok: r.ok };
  }
  return info;
}

module.exports = { eventsDueForFill, eventInfoFrom };
