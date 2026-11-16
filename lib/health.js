// Turns a snapshot of the server's state into a list of checks (ok / warn / critical)
// and a credit budget for the Odds API. Pure: everything it needs comes in as an
// argument, which is what makes it testable.
const HOUR = 3600 * 1000;

function envNum(v, d) { const n = Number(v); return v != null && v !== '' && isFinite(n) ? n : d; }

// Credits left, how fast they're being used, and whether a full-slate scan can run.
function creditBudget({ remaining, usage, dailyAverage = null, now = Date.now(), warnAt = 100, critAt = 40, scanCost = 60 }) {
  if (remaining == null) return { known: false, level: 'unknown', message: 'The Odds API has not reported its remaining credits yet.' };
  const sinceMs = usage?.since ? now - new Date(usage.since).getTime() : 0;
  const used = usage?.credits ?? 0;
  // Best source: the saved day-by-day record (dailyAverage), which survives a restart and includes credits spent outside this server.
  // Without it, the meter since the last restart, trusted only once it covers 12+ hours.
  const perDay = dailyAverage != null && isFinite(dailyAverage) && dailyAverage > 0 ? dailyAverage
    : sinceMs >= 12 * HOUR && used > 0 ? used / (sinceMs / (24 * HOUR)) : null;
  const runwayDays = perDay ? remaining / perDay : null;
  const level = remaining < critAt ? 'critical' : remaining < warnAt ? 'warn' : 'ok';
  return {
    known: true, level, remaining, warnAt, critAt, scanCost,
    usedSinceRestart: used, perDay: perDay != null ? Math.round(perDay * 10) / 10 : null,
    runwayDays: runwayDays != null ? Math.round(runwayDays * 10) / 10 : null,
    canScan: remaining >= scanCost,
    message: level === 'ok' ? `${remaining} credits left.` : `${remaining} credits left${runwayDays != null ? `, about ${runwayDays.toFixed(1)} days at the current pace` : ''}. A full slate scan costs about ${scanCost}.`,
  };
}

function evaluateHealth(s, opts = {}) {
  const now = opts.now ?? Date.now();
  const checks = [];
  const add = (id, label, level, detail) => checks.push({ id, label, level, detail });

  // Odds feed + credits
  if (!s.odds?.configured) add('odds', 'Odds API', 'critical', 'No ODDS_API_KEY is set, so lines and prices are unavailable.');
  else if (s.odds.exhausted) add('odds', 'Odds API', 'critical', 'Out of credits. No new lines until they reset.');
  else if (s.odds.lastError) add('odds', 'Odds API', 'warn', `Last response was an error: ${s.odds.lastError}`);
  else add('odds', 'Odds API', 'ok', 'Responding.');
  const budget = creditBudget({ remaining: s.odds?.remaining, usage: s.odds?.usage, dailyAverage: s.odds?.dailyAverage, now, ...(opts.budget || {}) });
  if (budget.known) add('credits', 'Odds credits', budget.level, budget.message);

  add('ai', 'AI analysis (Anthropic)', s.anthropicConfigured ? 'ok' : 'critical', s.anthropicConfigured ? 'Key present.' : 'No ANTHROPIC_KEY is set.');
  add('stats', 'Player stats (BallDontLie)', s.balldontlieConfigured ? 'ok' : 'warn', s.balldontlieConfigured ? 'Key present.' : 'No BALLDONTLIE key set.');

  // Stat files should refresh every morning
  for (const [name, f] of Object.entries(s.statFiles || {})) {
    if (f.mtime == null) { add(`file_${name}`, `${name} stat files`, 'warn', 'Not found.'); continue; }
    const age = (now - f.mtime) / HOUR;
    const stale = age > 72;   // the 7 AM refresh only runs while the server is up; out of season this is expected
    const when = age < 1 ? 'under an hour ago' : age < 72 ? Math.round(age) + ' hours ago' : Math.round(age / 24) + ' days ago';
    add(`file_${name}`, `${name} stat files`, stale ? 'warn' : 'ok', `Updated ${when}.${stale ? ' Fine if the league is out of season; otherwise run the stats refresh.' : ''}`);
  }

  // Scheduled jobs
  for (const [name, j] of Object.entries(s.jobs || {})) {
    if (j.ok === false) add(`job_${name}`, `Job: ${name}`, 'warn', `Last run failed: ${j.error || 'unknown error'}`);
    else if (j.lastRun) { const t = `Last ran ${new Date(j.lastRun).toISOString().replace('T', ' ').slice(0, 16)} UTC${j.detail ? ': ' + j.detail : ''}`; add(`job_${name}`, `Job: ${name}`, 'ok', /[.!?]$/.test(t) ? t : t + '.'); }
    else add(`job_${name}`, `Job: ${name}`, 'ok', 'Has not run since the server started.');
  }

  // Storage
  if (s.storage) {
    add('storage', 'Storage', s.storage.backend === 'sqlite' ? 'ok' : 'warn',
      s.storage.backend === 'sqlite' ? `SQLite, ${s.storage.picks} picks${s.storage.sizeBytes != null ? ', ' + Math.round(s.storage.sizeBytes / 1024) + ' KB' : ''}.` : (s.storage.note || 'Using the JSON fallback.'));
  }

  // Grading is what calibration and the backtest run on
  if (s.grading) {
    const { waiting, graded, unmatched = 0 } = s.grading;
    add('grading', 'Pick grading', waiting > 40 && graded === 0 ? 'warn' : 'ok',
      (graded === 0 ? `${waiting} picks are waiting and none has been graded yet. Grading runs at 6:00 AM.` : `${graded} graded, ${waiting} waiting.`) + (unmatched ? ` ${unmatched} had no matching game in the stats log and were set aside.` : ''));
  }

  // Calibration
  if (s.calibration) add('calibration', 'Calibration', 'ok', s.calibration.reason || (s.calibration.active ? 'Active.' : 'Off.'));

  // Tests
  if (s.tests) {
    if (s.tests.failed > 0) add('tests', 'Automated tests', 'critical', `${s.tests.failed} of ${s.tests.passed + s.tests.failed} failed on the last run.`);
    else add('tests', 'Automated tests', now - new Date(s.tests.ts).getTime() > 14 * 24 * HOUR ? 'warn' : 'ok', `${s.tests.passed} passed, last run ${new Date(s.tests.ts).toISOString().slice(0, 10)}.`);
  } else add('tests', 'Automated tests', 'warn', 'No test run recorded yet. Run npm test.');

  const rank = { ok: 0, warn: 1, critical: 2 };
  const status = checks.reduce((m, c) => rank[c.level] > rank[m] ? c.level : m, 'ok');
  return { status, checks, budget };
}

module.exports = { evaluateHealth, creditBudget, envNum };
