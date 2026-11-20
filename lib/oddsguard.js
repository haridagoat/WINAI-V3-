// A spending guard for the Odds API, for calls that a visitor's page view starts (tagged "page: ..." by the server).
// Scheduled jobs ("job: ...") are never blocked here: they have their own budget check before they start.
// A page view is refused when the credits left are at or below a reserve (kept for the morning scan), or when pages have already
// spent their share for the day. The scan a first visitor may start is still allowed: the daily share is sized above one full scan.
// Pure.
const isNum = v => typeof v === 'number' && isFinite(v);

function pageSpentToday(log, day) {
  const jobs = (log && log.days && log.days[day] && log.days[day].byJob) || {};
  let n = 0;
  for (const [name, v] of Object.entries(jobs)) if (String(name).startsWith('page:')) n += (v && v.credits) || 0;
  return n;
}

// { allow: true } or { allow: false, reason }.
function decide({ job, remaining, pageSpent, reserve = 30, pageCap = 200 }) {
  if (!String(job || '').startsWith('page:')) return { allow: true };
  if (isNum(remaining) && remaining <= reserve) return { allow: false, reason: `only ${remaining} Odds credits are left, kept for the scheduled scan (reserve ${reserve})` };
  if (isNum(pageSpent) && pageSpent >= pageCap) return { allow: false, reason: `page views have already used ${pageSpent} Odds credits today (daily limit ${pageCap})` };
  return { allow: true };
}

module.exports = { decide, pageSpentToday };
