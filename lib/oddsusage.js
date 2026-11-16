// Where the Odds API credits go: day by day, and within a day by the job or page that made the call. Pure functions over one plain object
// ({ days: { 'YYYY-MM-DD': day } }) that the server keeps in the meta table, so the record survives a restart.
//
// Each answer from the Odds API says what that call cost and how many credits are left. Adding up the costs gives what THIS server spent.
// Comparing that with how far the "credits left" number actually fell gives what was spent somewhere else with the same key (another copy
// of the app, a script, the provider's website): that part shows up as `elsewhere`.

const KEEP_DAYS = 14;
const RESET_JUMP = 100;   // "credits left" going UP by more than this is the monthly refill, not answers arriving out of order

const isNum = v => typeof v === 'number' && isFinite(v);
const emptyDay = () => ({ credits: 0, calls: 0, byJob: {}, start: null, low: null, ownBase: 0, banked: 0 });

function elsewhereOf(d) {
  if (!d) return 0;
  const live = isNum(d.start) && isNum(d.low) ? Math.max(0, (d.start - d.low) - (d.credits - (d.ownBase || 0))) : 0;
  return (d.banked || 0) + live;
}

// One answer from the Odds API. `credits` is what the call cost (0 for the free ones), `remaining` what the API says is left after it,
// `carried` the last "credits left" known before this answer (used as the day's starting point, so credits that went while the server was
// off are noticed).
function record(log, { day, job, credits, remaining, carried }) {
  if (!log || typeof log !== 'object') log = {};
  if (!log.days || typeof log.days !== 'object') log.days = {};
  if (!day) return log;
  const cost = isNum(credits) && credits > 0 ? credits : 0;
  const d = log.days[day] || (log.days[day] = emptyDay());
  const name = String(job || 'untagged').slice(0, 80);
  const j = d.byJob[name] || (d.byJob[name] = { calls: 0, credits: 0 });
  j.calls++; j.credits += cost; d.calls++; d.credits += cost;

  if (isNum(remaining)) {
    if (!isNum(d.start)) { d.start = isNum(carried) && carried >= remaining + cost ? carried : remaining + cost; d.low = remaining; }
    else if (remaining > d.low + RESET_JUMP) {          // monthly refill: keep what was worked out so far, start measuring again from here
      d.banked = elsewhereOf({ ...d, credits: d.credits - cost });   // this call was paid for after the refill, so it is not part of the old stretch
      d.start = remaining + cost; d.low = remaining; d.ownBase = d.credits - cost;
    } else if (remaining < d.low) d.low = remaining;
  }
  const keys = Object.keys(log.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete log.days[k];
  return log;
}

// One day, ready to show: the jobs sorted by what they spent, and what went elsewhere.
function summary(log, day) {
  const d = log && log.days && log.days[day];
  if (!d) return { day, credits: 0, calls: 0, elsewhere: 0, total: 0, jobs: [] };
  const jobs = Object.entries(d.byJob || {}).map(([job, v]) => ({ job, calls: v.calls, credits: v.credits })).sort((a, b) => b.credits - a.credits || b.calls - a.calls);
  const elsewhere = elsewhereOf(d);
  return { day, credits: d.credits, calls: d.calls, elsewhere, total: d.credits + elsewhere, jobs };
}

// The most recent days first.
function recent(log, n = 7) {
  return Object.keys((log && log.days) || {}).sort().reverse().slice(0, n).map(day => summary(log, day));
}

// Average credits a day (this server plus elsewhere) over the complete days on record, leaving out `today` because it is not over.
function dailyAverage(log, today, n = 7) {
  const days = recent(log, n + 1).filter(s => s.day !== today).slice(0, n);
  return days.length ? days.reduce((s, x) => s + x.total, 0) / days.length : null;
}

module.exports = { record, summary, recent, dailyAverage, elsewhereOf, KEEP_DAYS };
