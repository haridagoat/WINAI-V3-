const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/rg');
const H = 3600e3, NOW = Date.parse('2026-10-12T12:00:00Z'), iso = ms => new Date(ms).toISOString();

test('with nothing set there are no limits and no break', () => {
  const e = R.effective(null, NOW);
  assert.deepEqual(e, { dailyLimit: null, pending: null, restricted: false, kind: null, until: null });
  assert.equal(R.hasSettings(null, NOW), false);
});
test('a first limit applies at once; any number outside 1 to 100 is refused', () => {
  const r = R.planLimitChange(null, 5, NOW);
  assert.deepEqual(r.patch, { daily_limit: 5, next_daily_limit: null, next_effective_at: null }); assert.equal(r.appliesAt, null);
  for (const bad of [0, -3, 101, 2.5, '5', NaN, undefined]) assert.ok(R.planLimitChange(null, bad, NOW).error, String(bad));
});
test('lowering a limit applies at once, and cancels a raise that was waiting', () => {
  const row = { daily_limit: 10, next_daily_limit: 50, next_effective_at: iso(NOW + 5 * H) };
  const r = R.planLimitChange(row, 4, NOW);
  assert.deepEqual(r.patch, { daily_limit: 4, next_daily_limit: null, next_effective_at: null });
});
test('raising or removing a limit only takes effect 24 hours later', () => {
  const row = { daily_limit: 5 };
  const up = R.planLimitChange(row, 20, NOW);
  assert.equal(up.patch.next_daily_limit, 20); assert.equal(up.appliesAt, iso(NOW + 24 * H)); assert.equal(up.patch.daily_limit, undefined);
  assert.equal(R.effective({ ...row, ...up.patch }, NOW + 23 * H).dailyLimit, 5);                      // still 5 a minute before
  assert.equal(R.effective({ ...row, ...up.patch }, NOW + 24 * H + 1).dailyLimit, 20);                 // 20 after
  const rem = R.planLimitChange(row, null, NOW);
  assert.equal(rem.patch.next_daily_limit, null); assert.ok(rem.appliesAt);
  assert.equal(R.effective({ ...row, ...rem.patch }, NOW + H).dailyLimit, 5);
  assert.equal(R.effective({ ...row, ...rem.patch }, NOW + 25 * H).dailyLimit, null);
});
test('a pending raise is visible so the person can see it coming', () => {
  const e = R.effective({ daily_limit: 5, next_daily_limit: 20, next_effective_at: iso(NOW + 3 * H) }, NOW);
  assert.deepEqual(e.pending, { limit: 20, at: iso(NOW + 3 * H) }); assert.equal(e.dailyLimit, 5); assert.equal(R.hasSettings({ daily_limit: null, next_effective_at: iso(NOW + H), next_daily_limit: 3 }, NOW), true);
});
test('a break runs for its length, then it is over', () => {
  const r = R.planRestriction(null, 'break', 24, NOW);
  assert.equal(r.until, iso(NOW + 24 * H));
  const row = { restricted_until: r.until, restriction_kind: 'break' };
  assert.equal(R.effective(row, NOW + 23 * H).restricted, true);
  assert.equal(R.effective(row, NOW + 24 * H + 1).restricted, false);
  assert.equal(R.hasSettings(row, NOW + 25 * H), false);
});
test('only the listed lengths are allowed', () => {
  for (const [k, a] of [['break', 5], ['break', 1], ['exclusion', 30], ['exclusion', 24], ['nope', 24], ['break', undefined]]) assert.ok(R.planRestriction(null, k, a, NOW).error, `${k} ${a}`);
  assert.equal(R.planRestriction(null, 'exclusion', 180, NOW).until, iso(NOW + 180 * 24 * H));
});
test('a break can be made longer but never shorter, and cannot replace an exclusion', () => {
  const week = R.planRestriction(null, 'break', 168, NOW);
  const row = { restricted_until: week.until, restriction_kind: 'break' };
  const shorter = R.planRestriction(row, 'break', 24, NOW + H);
  assert.equal(shorter.until, week.until);                                                             // the 24 hour break does not shorten the week
  const longer = R.planRestriction(row, 'break', 720, NOW + H);
  assert.equal(longer.until, iso(NOW + H + 720 * H));
  const ex = R.planRestriction(null, 'exclusion', 365, NOW);
  const exRow = { restricted_until: ex.until, restriction_kind: 'exclusion' };
  const br = R.planRestriction(exRow, 'break', 24, NOW + H);
  assert.equal(br.until, ex.until); assert.equal(br.patch.restriction_kind, 'exclusion');              // still an exclusion
});
