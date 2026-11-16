const test = require('node:test');
const assert = require('node:assert/strict');
const { record, summary, recent, dailyAverage, KEEP_DAYS } = require('../lib/oddsusage');

const D = '2026-11-16';

test('credits are added up per job, and the jobs come back biggest spender first', () => {
  const log = {};
  record(log, { day: D, job: 'job: slate-scan-nba', credits: 3, remaining: 97 });
  record(log, { day: D, job: 'job: slate-scan-nba', credits: 3, remaining: 94 });
  record(log, { day: D, job: 'job: closing-lines', credits: 2, remaining: 92 });
  record(log, { day: D, job: 'visitor: GET /api/prop-context', credits: 1, remaining: 91 });
  const s = summary(log, D);
  assert.equal(s.credits, 9); assert.equal(s.calls, 4); assert.equal(s.elsewhere, 0); assert.equal(s.total, 9);
  assert.deepEqual(s.jobs.map(j => [j.job, j.calls, j.credits]), [['job: slate-scan-nba', 2, 6], ['job: closing-lines', 1, 2], ['visitor: GET /api/prop-context', 1, 1]]);
});

test('free calls are counted as calls and cost nothing', () => {
  const log = {};
  record(log, { day: D, job: 'job: odds-credits', credits: 0, remaining: 80 });
  record(log, { day: D, job: 'job: odds-credits', credits: NaN, remaining: 80 });
  const s = summary(log, D);
  assert.equal(s.credits, 0); assert.equal(s.calls, 2); assert.equal(s.elsewhere, 0);
});

test('credits that fell without this server spending them are reported as spent elsewhere', () => {
  const log = {};
  record(log, { day: D, job: 'a', credits: 3, remaining: 97 });           // 100 before
  record(log, { day: D, job: 'a', credits: 3, remaining: 74 });           // something else took 20 in between
  const s = summary(log, D);
  assert.equal(s.credits, 6); assert.equal(s.elsewhere, 20); assert.equal(s.total, 26);
});

test('credits that went while the server was off are noticed from the last number it had saved', () => {
  const log = {};
  record(log, { day: D, job: 'a', credits: 3, remaining: 50, carried: 98 });   // 98 when it stopped, 53 just before this call
  const s = summary(log, D);
  assert.equal(s.credits, 3); assert.equal(s.elsewhere, 45);
});

test('a saved number lower than what the API reports is not trusted as the starting point', () => {
  const log = {};
  record(log, { day: D, job: 'a', credits: 3, remaining: 400, carried: 20 });  // refilled while the server was off
  assert.equal(summary(log, D).elsewhere, 0);
});

test('answers arriving out of order do not invent spending', () => {
  const log = {};
  record(log, { day: D, job: 'a', credits: 3, remaining: 91 });   // sent third, answered first
  record(log, { day: D, job: 'a', credits: 3, remaining: 97 });
  record(log, { day: D, job: 'a', credits: 3, remaining: 94 });
  const s = summary(log, D);
  assert.equal(s.credits, 9); assert.equal(s.elsewhere, 0);
});

test('the monthly refill does not count as negative or phantom spending', () => {
  const log = {};
  record(log, { day: D, job: 'a', credits: 3, remaining: 17 });
  record(log, { day: D, job: 'a', credits: 3, remaining: 4 });    // 10 went elsewhere
  record(log, { day: D, job: 'a', credits: 3, remaining: 497 });  // refill to 500, then this call
  record(log, { day: D, job: 'a', credits: 3, remaining: 494 });
  const s = summary(log, D);
  assert.equal(s.credits, 12); assert.equal(s.elsewhere, 10);
});

test('only the last two weeks are kept', () => {
  const log = {};
  for (let i = 1; i <= KEEP_DAYS + 6; i++) record(log, { day: `2026-10-${String(i).padStart(2, '0')}`, job: 'a', credits: 1, remaining: 500 - i });
  assert.equal(Object.keys(log.days).length, KEEP_DAYS);
  assert.equal(recent(log, 3)[0].day, `2026-10-${KEEP_DAYS + 6}`);
});

test('the daily average leaves out today and counts spending elsewhere', () => {
  const log = {};
  record(log, { day: '2026-11-14', job: 'a', credits: 30, remaining: 170 });
  record(log, { day: '2026-11-15', job: 'a', credits: 10, remaining: 150, carried: 170 });   // 10 own + 10 elsewhere
  record(log, { day: D, job: 'a', credits: 99, remaining: 51 });
  assert.equal(dailyAverage(log, D), 25);
  assert.equal(dailyAverage({}, D), null);
});

test('a damaged or empty record is rebuilt instead of throwing', () => {
  assert.equal(summary(null, D).credits, 0);
  assert.equal(summary({ days: 7 }, D).credits, 0);
  const log = record({ days: 'broken' }, { day: D, job: 'a', credits: 2, remaining: 10 });
  assert.equal(summary(log, D).credits, 2);
  assert.deepEqual(recent(null), []);
});
