// "Best bets": a few picks a day chosen by fixed rules, graded on their own, so we find out over time whether they win more than the rest.
//
// The rules use only what is known when the pick is made (its confidence score and its expected value at the price taken), never a result.
// They were chosen on 2026-11-05 after looking at the earlier picks, so the record before that date is a reference only (the rules were
// picked with those results in view); the record from that date on is the real test. Changing a rule starts a new version and a new test.
const RULES = { version: 1, lockedOn: '2026-11-05', minConfidence: 65, minEv: 0, maxPerDay: 6 };

const fin = v => typeof v === 'number' && isFinite(v);
const qualifies = (p, rules = RULES) => !!p && fin(p.confidence) && fin(p.ev) && p.confidence >= rules.minConfidence && p.ev >= rules.minEv;

// The day's best bets from its picks: those that pass, best expected value first (then confidence), at most maxPerDay.
function selectForDay(picks, rules = RULES) {
  return (picks || []).map((p, i) => ({ p, i })).filter(({ p }) => qualifies(p, rules))
    .sort((a, b) => (b.p.ev - a.p.ev) || (b.p.confidence - a.p.confidence) || (a.i - b.i))
    .slice(0, rules.maxPerDay).map(({ p }) => p);
}

// Ids of the best bets among every logged pick (each needs { id, day, confidence, ev }), day by day.
function bestBetIds(picks, rules = RULES) {
  const byDay = new Map();
  for (const p of picks || []) { if (!p || p.id == null || !p.day) continue; if (!byDay.has(p.day)) byDay.set(p.day, []); byDay.get(p.day).push(p); }
  const ids = new Set();
  for (const day of byDay.values()) for (const p of selectForDay(day, rules)) ids.add(p.id);
  return ids;
}

// Marks `bestBet` on a list of live picks ({ confidence, realEdge: { expectedValue } }), as a preview of what today's tracker will count.
function markLive(picks, rules = RULES) {
  const view = (picks || []).map(p => ({ p, confidence: p && p.confidence, ev: p && p.realEdge ? p.realEdge.expectedValue : undefined }));
  const chosen = new Set(selectForDay(view, rules).map(v => v.p));
  for (const v of view) if (v.p) v.p.bestBet = chosen.has(v.p);
  return picks;
}

const describe = (rules = RULES) => `confidence ${rules.minConfidence}+, expected value ${rules.minEv * 100}%+, the best ${rules.maxPerDay} a day`;

module.exports = { RULES, qualifies, selectForDay, bestBetIds, markLive, describe };
