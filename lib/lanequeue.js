// A small job queue with two lanes. A visitor waiting on a result goes in the "high" lane; background work
// (the slate scan, grading) goes in the "low" lane and only runs when nothing high is waiting. Up to `concurrency`
// jobs run at once, at most `lowConcurrency` of them low, and no job starts less than `minGapMs` after the one before it
// (nba.com rate-limits hard). The high lane refuses new work once `maxHigh` are waiting or running, so a flood of visitors
// cannot pile up minutes of queue; the low lane never refuses because its callers are already limited.
function createLaneQueue({ concurrency = 2, lowConcurrency = 1, minGapMs = 600, maxHigh = 30, now = Date.now } = {}) {
  const waiting = { high: [], low: [] };
  let running = 0, lowRunning = 0, highPending = 0, lastStart = -Infinity, timer = null;

  function pump() {
    if (timer) return;                                   // a gap timer is already counting down
    while (running < concurrency) {
      const lane = waiting.high.length ? 'high' : (waiting.low.length && lowRunning < lowConcurrency ? 'low' : null);
      if (!lane) return;
      const wait = minGapMs - (now() - lastStart);
      if (wait > 0) { timer = setTimeout(() => { timer = null; pump(); }, wait); timer.unref?.(); return; }
      const job = waiting[lane].shift();
      lastStart = now(); running++; if (lane === 'low') lowRunning++;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => {
        running--; if (lane === 'low') lowRunning--; if (lane === 'high') highPending--;
        pump();
      });
    }
  }

  function enqueue(fn, lane = 'high') {
    lane = lane === 'low' ? 'low' : 'high';
    if (lane === 'high' && highPending >= maxHigh) return Promise.resolve({ error: 'Busy: too many lookups waiting. Try again in a minute.' });
    return new Promise((resolve, reject) => {
      if (lane === 'high') highPending++;
      waiting[lane].push({ fn, resolve, reject });
      pump();
    });
  }
  return { enqueue, stats: () => ({ running, lowRunning, waitingHigh: waiting.high.length, waitingLow: waiting.low.length }) };
}

module.exports = { createLaneQueue };
