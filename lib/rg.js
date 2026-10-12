// Responsible gambling: the limits and breaks a person can set on themselves. Pure rules, so every one is tested.
//
//  - A daily limit on analyses. LOWERING it takes effect at once. RAISING it (or removing it) only takes effect 24 hours later,
//    so a bad moment cannot undo a good decision.
//  - A break (24 hours, 7 days, 30 days) or a self-exclusion (6 months, 1 year). While one is active, the analyzer and saving
//    props are paused. It can be extended but never shortened or ended early, by the person or by the admin.
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const BREAKS = { 24: 24 * HOUR, 168: 7 * DAY, 720: 30 * DAY };            // hours -> ms
const EXCLUSIONS = { 180: 180 * DAY, 365: 365 * DAY };                     // days -> ms
const RAISE_DELAY_MS = 24 * HOUR;
const MAX_DAILY = 100;

const t = v => (v ? new Date(v).getTime() : null);

// The settings as they are right now: a delayed raise that has come due is applied, and a finished break is over.
function effective(row, now = Date.now()) {
  const r = row || {};
  let daily = r.daily_limit ?? null, pending = null;
  if (r.next_effective_at) {
    if (t(r.next_effective_at) <= now) daily = r.next_daily_limit ?? null;
    else pending = { limit: r.next_daily_limit ?? null, at: r.next_effective_at };
  }
  const until = t(r.restricted_until), restricted = until != null && until > now;
  return { dailyLimit: daily, pending, restricted, kind: restricted ? r.restriction_kind : null, until: restricted ? r.restricted_until : null };
}
// Does this person have any setting that must be enforced even when the paywall is off?
const hasSettings = (row, now = Date.now()) => { const e = effective(row, now); return e.dailyLimit != null || e.restricted || !!e.pending; };

// requested: a whole number 1..100, or null to remove the limit. Returns { error } or { patch, appliesAt }.
function planLimitChange(row, requested, now = Date.now()) {
  if (requested !== null && !(Number.isInteger(requested) && requested >= 1 && requested <= MAX_DAILY)) return { error: `Choose a whole number from 1 to ${MAX_DAILY}, or remove the limit.` };
  const cur = effective(row, now).dailyLimit;
  const isRaise = requested === null ? cur != null : cur != null && requested > cur;
  if (requested === cur && !effective(row, now).pending) return { patch: {}, appliesAt: null, unchanged: true };
  if (cur == null && requested !== null) return { patch: { daily_limit: requested, next_daily_limit: null, next_effective_at: null }, appliesAt: null };     // setting a first limit is always immediate
  if (isRaise) return { patch: { next_daily_limit: requested, next_effective_at: new Date(now + RAISE_DELAY_MS).toISOString() }, appliesAt: new Date(now + RAISE_DELAY_MS).toISOString() };
  return { patch: { daily_limit: requested, next_daily_limit: null, next_effective_at: null }, appliesAt: null };                                              // lowering cancels any waiting raise
}

// kind: 'break' (hours: 24|168|720) or 'exclusion' (days: 180|365). The end date can only move later.
function planRestriction(row, kind, amount, now = Date.now()) {
  const ms = kind === 'break' ? BREAKS[amount] : kind === 'exclusion' ? EXCLUSIONS[amount] : null;
  if (!ms) return { error: 'Choose one of the listed lengths.' };
  const cur = effective(row, now);
  const proposed = now + ms, existing = cur.restricted ? t(cur.until) : 0;
  const until = Math.max(proposed, existing);
  // a break never replaces an exclusion that is still running
  const keepKind = cur.restricted && cur.kind === 'exclusion' && kind === 'break' ? 'exclusion' : kind;
  return { patch: { restricted_until: new Date(until).toISOString(), restriction_kind: keepKind, restricted_at: cur.restricted ? undefined : new Date(now).toISOString() }, until: new Date(until).toISOString(), extended: until > proposed ? false : cur.restricted };
}

module.exports = { effective, hasSettings, planLimitChange, planRestriction, BREAKS, EXCLUSIONS, MAX_DAILY, RAISE_DELAY_MS };
