const test = require('node:test');
const assert = require('node:assert/strict');
const { createLaneQueue } = require('../lib/lanequeue');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const job = (log, name, ms = 20) => async () => { log.push('start ' + name); await sleep(ms); log.push('end ' + name); return name; };

test('a visitor jumps ahead of background work that is already waiting', async () => {
  const q = createLaneQueue({ concurrency: 1, lowConcurrency: 1, minGapMs: 0 });
  const log = [];
  const first = q.enqueue(job(log, 'scan-1'), 'low');          // starts at once
  const second = q.enqueue(job(log, 'scan-2'), 'low');
  const visitor = q.enqueue(job(log, 'visitor'), 'high');
  await Promise.all([first, second, visitor]);
  assert.deepEqual(log.filter(l => l.startsWith('start')), ['start scan-1', 'start visitor', 'start scan-2']);
});

test('background work never runs more than lowConcurrency at once, and leaves room for visitors', async () => {
  const q = createLaneQueue({ concurrency: 2, lowConcurrency: 1, minGapMs: 0 });
  let low = 0, maxLow = 0;
  const lowJob = async () => { low++; maxLow = Math.max(maxLow, low); await sleep(20); low--; };
  const lows = [1, 2, 3].map(() => q.enqueue(lowJob, 'low'));
  const log = [];
  const visitor = q.enqueue(job(log, 'visitor', 5), 'high');
  await Promise.all([...lows, visitor]);
  assert.equal(maxLow, 1);
  assert.ok(log.includes('end visitor'));
});

test('two visitor lookups run side by side', async () => {
  const q = createLaneQueue({ concurrency: 2, minGapMs: 0 });
  const t = Date.now();
  await Promise.all([q.enqueue(job([], 'a', 80)), q.enqueue(job([], 'b', 80))]);
  assert.ok(Date.now() - t < 140, 'they should overlap, not run one after the other');
});

test('jobs start at least minGapMs apart', async () => {
  const q = createLaneQueue({ concurrency: 3, minGapMs: 60 });
  const starts = [];
  await Promise.all([1, 2, 3].map(() => q.enqueue(async () => { starts.push(Date.now()); })));
  assert.ok(starts[1] - starts[0] >= 55 && starts[2] - starts[1] >= 55, JSON.stringify(starts));
});

test('the visitor lane refuses new work when too many are waiting; the background lane never does', async () => {
  const q = createLaneQueue({ concurrency: 1, minGapMs: 0, maxHigh: 2 });
  const slow = () => sleep(40);
  const a = q.enqueue(slow), b = q.enqueue(slow);
  const refused = await q.enqueue(slow);
  assert.match(refused.error, /Busy/);
  const lowOk = q.enqueue(async () => 'ran', 'low');
  await Promise.all([a, b]);
  assert.equal(await lowOk, 'ran');
});

test('a job that throws does not stop the queue', async () => {
  const q = createLaneQueue({ concurrency: 1, minGapMs: 0 });
  await assert.rejects(q.enqueue(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await q.enqueue(async () => 'next'), 'next');
});
