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

// Which of a game's props to keep when the books posted more than `n`. Taking the first `n` in the order the odds feed sends them
// filled the list with one stat (points, assists) and one team, so rebounds and the other side almost never made it. Instead each stat gets an
// equal share and, within a stat, the two teams alternate, with the bigger lines first (a bigger line means a bigger role). A stat that has
// fewer props than its share hands the spare slots to the others. `teamOf(player)` may return nothing: then only the stats are balanced.
const KEEP_ORDER = ['points', 'rebounds', 'assists'];
function balanceCandidates(cands, n, teamOf) {
  const list = cands || [];
  if (!(n > 0) || list.length <= n) return list.slice();
  const byLine = (a, b) => (b.line - a.line) || ((b.bookCount || 0) - (a.bookCount || 0)) || String(a.player).localeCompare(String(b.player));
  const types = [...KEEP_ORDER.filter(t => list.some(c => c.propType === t)), ...[...new Set(list.map(c => c.propType))].filter(t => !KEEP_ORDER.includes(t))];
  const queues = types.map(t => {
    const rows = list.filter(c => c.propType === t).sort(byLine);
    const buckets = new Map();
    for (const c of rows) { const k = (teamOf && teamOf(c.player)) || '?'; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(c); }
    const lists = [...buckets.values()], out = [];
    for (let i = 0; out.length < rows.length; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
    return out;
  });
  const kept = [];
  for (let i = 0; kept.length < n; i++) {
    let any = false;
    for (const q of queues) if (i < q.length && kept.length < n) { kept.push(q[i]); any = true; }
    if (!any) break;
  }
  return kept;
}

module.exports = { eventsDueForFill, eventInfoFrom, balanceCandidates };
