// Nightly data checks. Each one looks at something that quietly goes wrong, fixes it when the fix is safe,
// and says what it did. A check that cannot fix its problem asks for you instead (an alert, never a guess).
//
// What it may fix by itself: a stale slate cache, a missing backup, a stat file the server can re-fetch,
// picks that are overdue for grading.
// What it only reports: impossible values in picks or stats, a damaged database, low Odds credits, sign-in
// that is not set up. It never edits a pick or a stat.
//
// Everything the checks touch arrives in `ctx`, so each rule is tested with fakes (test/datachecks.test.js).
const HOUR = 3600 * 1000, DAY = 24 * HOUR;

// Rough seasons, by month/day. Out of season a stale stat file is expected, not a fault.
const SEASONS = { nba: { from: [10, 15], to: [6, 30] }, wnba: { from: [5, 1], to: [10, 31] } };
function inSeason(league, date) {
  const s = SEASONS[league]; if (!s) return true;
  const md = (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  const a = s.from[0] * 100 + s.from[1], b = s.to[0] * 100 + s.to[1];
  return a <= b ? md >= a && md <= b : md >= a || md <= b;
}

const ago = ms => ms < HOUR ? 'under an hour ago' : ms < DAY ? `${Math.round(ms / HOUR)} hours ago` : `${Math.round(ms / DAY)} days ago`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function buildChecks(ctx) {
  const now = () => (ctx.now ? ctx.now() : Date.now());
  const ok = detail => ({ status: 'ok', detail });
  const fixed = detail => ({ status: 'fixed', detail });
  const bad = detail => ({ status: 'bad', detail });

  // A stat file the server can re-fetch itself (it runs the same Python script the 7 AM job runs).
  // One attempt per run, and never more than one every six hours, so a broken source is not hammered.
  const statFile = (league, label) => ({
    key: `stats-${league}`, name: `${label} stat files`,
    description: `Refreshed in the last 48 hours while the ${label} season is on`,
    async run() {
      const m = ctx.fileMtime(league);
      const age = m == null ? null : now() - m;
      const season = inSeason(league, new Date(now()));
      if (m != null && age <= 48 * HOUR) return ok(`Updated ${ago(age)}.`);
      if (!season) return ok(m == null ? 'Not found, but it is the off season.' : `Off season. Last updated ${ago(age)}.`);
      const key = `datachecks:refresh:${league}`, last = Number(ctx.store.getMeta(key) || 0);
      if (!ctx.refreshStats || now() - last < 6 * HOUR) return bad(`${m == null ? 'Not found' : `Last updated ${ago(age)}`}. ${ctx.refreshStats ? 'A refresh was already tried in the last 6 hours.' : 'This server cannot refresh it.'} Run the ${label} stats script on your own computer.`);
      ctx.store.setMeta(key, String(now()));
      let err = null;
      try { await ctx.refreshStats(league); } catch (e) { err = e.message; }
      const m2 = ctx.fileMtime(league);
      if (m2 != null && now() - m2 <= 48 * HOUR) return fixed(`Was ${m == null ? 'missing' : ago(age)}. Re-fetched it just now.`);
      return bad(`${m == null ? 'Not found' : `Last updated ${ago(age)}`}. The automatic refresh ${err ? `failed (${err})` : 'did not update the file'}. Run the ${label} stats script on your own computer.`);
    },
  });

  return [
    statFile('nba', 'NBA'),
    statFile('wnba', 'WNBA'),

    {
      key: 'slate-cache', name: 'Slate cache', description: 'The saved slate scan belongs to today',
      async run() {
        const today = ctx.today(), stale = [];
        for (const [lg, dateKey] of Object.entries(ctx.slateCacheDates())) if (dateKey && dateKey !== today) stale.push(lg.toUpperCase());
        if (!stale.length) return ok('Nothing left over from an earlier day.');
        for (const lg of stale) ctx.clearSlateCache(lg.toLowerCase());
        return fixed(`Found an old ${stale.join(' and ')} scan. Cleared it so the next scan starts clean.`);
      },
    },

    {
      key: 'backup', name: 'Database backup', description: 'A backup exists from the last 26 hours',
      async run() {
        if (ctx.store.backend !== 'sqlite') return ok('Not using the SQLite file, so there is nothing to back up.');
        const newest = ctx.newestBackupMtime();
        if (newest != null && now() - newest < 26 * HOUR) return ok(`Newest backup is ${ago(now() - newest)}.`);
        try { ctx.runBackup(); } catch (e) { return bad(`No recent backup, and writing one failed: ${e.message}`); }
        const after = ctx.newestBackupMtime();
        return after != null && now() - after < 26 * HOUR ? fixed(newest == null ? 'There was no backup. Wrote one just now.' : `Newest was ${ago(now() - newest)}. Wrote a fresh one.`) : bad('A backup was attempted but no file appeared.');
      },
    },

    {
      key: 'db-integrity', name: 'Database health', description: 'SQLite reports no damage',
      async run() {
        if (typeof ctx.store.integrityCheck !== 'function') return ok('Not applicable without the SQLite file.');
        const r = ctx.store.integrityCheck();
        return r.length === 1 && r[0] === 'ok' ? ok('Integrity check passed.') : bad(`SQLite reported: ${r.slice(0, 3).join('; ')}. Restore the newest backup.`);
      },
    },

    {
      key: 'picks-values', name: 'Pick values', description: 'No impossible lines, confidences or results in saved picks',
      async run() {
        const picks = ctx.picks(), seen = new Set(), problems = [];
        const RESULTS = new Set(['WIN', 'LOSS', 'PUSH', 'NO_BET']);
        for (const p of picks) {
          const why = [];
          if (seen.has(p.id)) why.push('duplicate id'); seen.add(p.id);
          if (p.line != null && (!isFinite(p.line) || p.line < 0 || p.line > 500)) why.push(`line ${p.line}`);
          if (p.confidence != null && (!isFinite(p.confidence) || p.confidence < 0 || p.confidence > 100)) why.push(`confidence ${p.confidence}`);
          if (p.result != null && !RESULTS.has(p.result)) why.push(`result ${p.result}`);
          if (p.actualStat != null && (!isFinite(p.actualStat) || p.actualStat < 0)) why.push(`actual stat ${p.actualStat}`);
          if (why.length) problems.push(`#${p.id} ${why.join(', ')}`);
        }
        return problems.length ? bad(`${plural(problems.length, 'pick')} look wrong: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}. Nothing was changed.`) : ok(`${picks.length.toLocaleString('en-US')} picks checked.`);
      },
    },

    {
      key: 'stat-values', name: 'Stat values', description: 'No negative or impossible numbers in the stat files (minutes per game, shots made vs attempted)',
      async run() {
        let rows = 0; const problems = [];
        for (const lg of ['nba', 'wnba']) {
          const data = ctx.statRows(lg);
          if (!Array.isArray(data)) continue;
          for (const r of data) {
            rows++;
            const n = k => (r[k] == null ? null : Number(r[k]));
            // The stat files hold season totals (minutes included), so minutes are judged per game played.
            const min = n('MIN'), gp = n('GP'), fgm = n('FGM'), fga = n('FGA');
            const neg = ['MIN', 'GP', 'PTS', 'REB', 'AST', 'FGM', 'FGA'].some(k => n(k) != null && n(k) < 0);
            const perGame = gp > 0 && min != null ? min / gp : null;
            if (neg || (perGame != null && perGame > 48.5) || (gp != null && gp > 90) || (fgm != null && fga != null && fgm > fga)) problems.push(`${lg.toUpperCase()} ${r.PLAYER_NAME || r.PLAYER_ID}`);
          }
        }
        return problems.length ? bad(`${plural(problems.length, 'player row')} look wrong: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}. Nothing was changed.`) : ok(`${rows.toLocaleString('en-US')} player rows checked.`);
      },
    },

    {
      key: 'grading', name: 'Pick grading', description: 'Picks from more than 3 days ago have a result or a reason',
      async run() {
        const cutoff = ctx.daysAgo(3);
        const stuck = () => ctx.picks().filter(e => e.source === 'auto' && !e.result && !e.gradeNote && e.date && e.date < cutoff).length;
        const n = stuck();
        if (!n) return ok('Nothing is overdue.');
        try { await ctx.runGrade(); } catch (e) { return bad(`${plural(n, 'pick')} overdue, and grading failed: ${e.message}`); }
        const left = stuck();
        return left === 0 ? fixed(`${plural(n, 'pick')} were overdue. Ran grading and cleared them.`) : bad(`${plural(left, 'pick')} are still overdue after a grading run. Look at the Health tab.`);
      },
    },

    {
      key: 'odds-credits', name: 'Odds credits', description: 'Enough credits left for one full scan',
      async run() {
        const b = ctx.creditBudget();
        if (!b.known) return ok('The Odds API has not reported its credits yet.');
        return b.canScan ? ok(`${b.remaining} credits left.`) : bad(`${b.remaining} left, and a full scan needs about ${b.scanCost}. The 10 AM scan will be skipped until you add credits.`);
      },
    },

    {
      key: 'accounts', name: 'Sign-in', description: 'Accounts work and can send confirmation and reset emails',
      async run() {
        const a = ctx.authStatus();
        if (!a.enabled) return bad(a.detail);
        // With confirmation switched off, missing email is a known, chosen gap (reset emails wait for a verified domain), not an alarm.
        return a.mailReady === false && a.confirmRequired !== false ? bad(a.detail) : ok(a.detail || 'Sign-in and email are set up.');
      },
    },

    {
      key: 'payments', name: 'Payments', description: 'The paywall and Stripe are set up together',
      async run() {
        const b = ctx.billingStatus();
        if (!b.requested) return ok(b.configured ? 'Stripe is set up but PAYWALL is not "on", so everyone still has full access.' : 'The paywall is off. Everyone has full access.');
        if (!b.configured) return bad(`PAYWALL is on but Stripe is not fully set up (missing ${b.missing.join(', ')}), so the limits are NOT being applied.`);
        if (!b.on) return bad('PAYWALL is on and Stripe is set up, but sign-in is not working, so the limits are NOT being applied.');
        return ok(`The paywall is on (Stripe ${b.mode} mode). ${b.lastWebhookAt ? 'Last webhook received ' + ago(now() - new Date(b.lastWebhookAt).getTime()) + '.' : 'No webhook received yet.'}`);
      },
    },

    {
      key: 'unclaimed', name: 'Old saved props', description: 'Props saved before accounts all belong to someone',
      async run() {
        const n = ctx.store.countUnclaimedPicks ? ctx.store.countUnclaimedPicks() : 0;
        if (!n) return ok('Every saved prop has an owner.');
        return ctx.adminEmail
          ? ok(`${plural(n, 'older prop')} will move to ${ctx.adminEmail} the first time that address signs in.`)
          : bad(`${plural(n, 'older prop')} have no owner and nobody can see them. Set ADMIN_EMAIL to your address and sign in once.`);
      },
    },
  ];
}

// Runs every check once (each one isolated, so a crash in one never stops the rest), records the result,
// logs what was fixed, and alerts only when something newly needs a person.
async function runAll({ checks, store, alerts, now = () => Date.now(), log = () => {} }) {
  const prev = (() => { try { return JSON.parse(store.getMeta('datachecks:last') || 'null'); } catch (_) { return null; } })();
  const prevBad = new Set((prev?.checks || []).filter(c => c.status === 'bad').map(c => c.key));
  const out = [];
  for (const c of checks) {
    const t0 = now();
    let r;
    try { r = await c.run(); } catch (e) { r = { status: 'bad', detail: `The check itself failed: ${e.message}` }; }
    out.push({ key: c.key, name: c.name, description: c.description, status: r.status, detail: r.detail, ms: now() - t0 });
  }
  const counts = { ok: 0, fixed: 0, bad: 0 };
  for (const c of out) counts[c.status]++;
  const result = { ranAt: new Date(now()).toISOString(), checks: out, counts };
  store.setMeta('datachecks:last', JSON.stringify(result));
  store.addEvent('datacheck', counts.bad ? 'warn' : 'info', `Ran ${out.length} data checks: ${counts.ok} healthy, ${counts.fixed} fixed themselves, ${counts.bad} need you.`);
  for (const c of out) {
    if (c.status === 'fixed') store.addEvent('datacheck', 'info', `Fixed ${c.name}: ${c.detail}`);
    if (c.status === 'bad' && !prevBad.has(c.key)) await alerts?.notify({ key: `datacheck:${c.key}`, level: 'warn', kind: 'datacheck', message: `${c.name}: ${c.detail}` });
    if (c.status !== 'bad' && prevBad.has(c.key)) { store.addEvent('datacheck', 'info', `${c.name} is back to normal.`); alerts?.resolve(`datacheck:${c.key}`); }
  }
  log(`[DataChecks] ${counts.ok} ok, ${counts.fixed} fixed, ${counts.bad} need attention`);
  return result;
}

module.exports = { buildChecks, runAll, inSeason, SEASONS };
