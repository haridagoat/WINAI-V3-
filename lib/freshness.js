// How fresh the data behind the app is, in words a person can use. Pure, so each wording and rule is tested.
//
// The odds feed is only checked when real requests happen, so "updated 3 days ago" can simply mean nobody has asked;
// that is shown as it is. A banner appears only when something is really wrong for what people are doing now:
// the odds feed is out of credits or not connected, or a league's stats are old while that league is in season.
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const STALE_STATS_MS = 48 * HOUR, STALE_ODDS_MS = 12 * HOUR;

function ago(ms) {
  if (ms < 90e3) return 'just now';
  if (ms < HOUR) return `${Math.round(ms / MIN)} min ago`;
  if (ms < 36 * HOUR) { const h = Math.round(ms / HOUR); return `${h} ${h === 1 ? 'hour' : 'hours'} ago`; }
  const d = Math.round(ms / DAY); return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}
const shortDate = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function describe({ now = Date.now(), oddsConfigured, odds = {}, statMtimes = {}, inSeason = () => true } = {}) {
  const out = { odds: null, stats: {}, banner: null, at: new Date(now).toISOString() };
  const banners = [];

  if (!oddsConfigured) {
    out.odds = { state: 'off', label: 'Live odds are not connected' };
    banners.push('Live odds are not connected, so prop lines and edges are unavailable.');
  } else if (odds.exhausted) {
    out.odds = { state: 'down', label: 'Live odds are paused' };
    banners.push('Live odds are paused right now. Prop lines and edges may be missing or out of date.');
  } else if (!odds.checkedAt) {
    out.odds = { state: 'idle', label: 'Odds not checked yet today' };
  } else {
    const age = now - new Date(odds.checkedAt).getTime();
    out.odds = { state: age > STALE_ODDS_MS ? 'old' : 'ok', label: `Odds updated ${ago(Math.max(0, age))}`, checkedAt: odds.checkedAt };
  }

  for (const lg of ['nba', 'wnba']) {
    const NAME = lg.toUpperCase(), m = statMtimes[lg], season = inSeason(lg, new Date(now));
    if (m == null) {
      out.stats[lg] = { state: season ? 'missing' : 'offseason', label: season ? `${NAME} stats not found` : `${NAME} off season` };
      if (season) banners.push(`${NAME} stats could not be found, so projections are unavailable.`);
      continue;
    }
    const age = Math.max(0, now - m);
    if (age <= STALE_STATS_MS) out.stats[lg] = { state: 'ok', label: `${NAME} stats updated ${ago(age)}`, updatedAt: new Date(m).toISOString() };
    else if (!season) out.stats[lg] = { state: 'offseason', label: `${NAME} stats from ${shortDate(m)} (off season)`, updatedAt: new Date(m).toISOString() };
    else {
      out.stats[lg] = { state: 'old', label: `${NAME} stats updated ${ago(age)}`, updatedAt: new Date(m).toISOString() };
      banners.push(`${NAME} stats are ${Math.round(age / DAY)} days old, so projections may miss recent games.`);
    }
  }
  if (banners.length) out.banner = { level: 'warn', text: banners.join(' ') };
  return out;
}

module.exports = { describe, ago, STALE_STATS_MS, STALE_ODDS_MS };
