#!/usr/bin/env node
// Copies this computer's database to your live site, so the live site starts with the same graded history, learned corrections
// (projection bias, calibration), accounts and logs.
//
//   node scripts/push-db.js           shows exactly what would be sent, sends nothing
//   node scripts/push-db.js --yes     sends it
//
// What happens: a consistent copy of winai.db is made (the running app is not disturbed), things that must not travel are removed
// (login sessions, one-time sign-in tokens, running analysis tickets, alert and check bookkeeping), it is zipped and uploaded over
// HTTPS with your admin token. The live site checks it, keeps its OLD database in backups/ on the volume, swaps the new one in and
// restarts (about a minute). Accounts made on the live site that are not in this database are replaced by the ones that are.
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const { checkDatabase } = require('../lib/dbswap');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const go = args.includes('--yes');
const env = {};
try { for (const l of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); } } catch (_) {}
const token = process.env.ADMIN_TOKEN || env.ADMIN_TOKEN;
const site = (args.find(a => /^https?:\/\//.test(a)) || env.LIVE_SITE_URL || '').replace(/\/+$/, '');
const src = path.resolve(process.env.WINAI_DB || path.join(root, 'winai.db'));
const die = m => { console.error(m); process.exit(1); };

(async () => {
  if (!fs.existsSync(src)) die(`No database at ${src}.`);
  if (go && (!site || !token)) die('Need LIVE_SITE_URL and ADMIN_TOKEN in .env (or give the address as an argument).');
  const tmp = path.join(os.tmpdir(), `winai-push-${process.pid}.db`);
  try { fs.unlinkSync(tmp); } catch (_) {}
  try {
    // 1. a consistent copy (VACUUM INTO reads the write-ahead log too)
    const live = new DatabaseSync(src, { readOnly: true });
    try { live.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { live.close(); }
    // 2. remove what must not travel
    const db = new DatabaseSync(tmp);
    const removed = {};
    for (const t of ['sessions', 'login_tokens', 'analysis_tickets']) removed[t] = db.prepare(`DELETE FROM ${t}`).run().changes;
    removed['meta (alerts, checks, local status)'] = db.prepare("DELETE FROM meta WHERE key LIKE 'alert_sent:%' OR key LIKE 'datachecks:%' OR key IN ('grade-live:last', 'mail:last_error')").run().changes;
    // 3. a summary of what is being sent
    const bias = (() => { try { const b = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'bias:model'").get().value); return { fittedAt: b.fittedAt, entries: Object.keys(b.table || {}).length, points: b.table && (b.table['nba:points'] || {}).mult }; } catch (_) { return null; } })();
    const users = db.prepare('SELECT id, email FROM users ORDER BY id').all().map(u => `#${u.id} ${u.email.replace(/^(.).*(.@.*)$/, '$1***$2')}`);
    db.exec('VACUUM'); db.close();
    const check = checkDatabase(tmp);
    if (!check.ok) die(`The copy failed its own check: ${check.reason}`);
    console.log('What would be sent:');
    const r = new DatabaseSync(tmp, { readOnly: true });
    const rows = t => r.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    console.log(`  picks: ${rows('picks')}   logged props: ${rows('scan_props')}   calibration rows: ${rows('calibration')}   backtests: ${rows('backtests')}   events: ${rows('events')}`);
    console.log(`  accounts: ${users.join(', ') || 'none'}`);
    console.log(`  learned projection bias: ${bias ? `fitted ${bias.fittedAt}, ${bias.entries} entries, points x${bias.points}` : 'none found'}`);
    console.log(`  left out: ${Object.entries(removed).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    r.close();
    const zipped = zlib.gzipSync(fs.readFileSync(tmp), { level: 9 });
    console.log(`  size: ${(fs.statSync(tmp).size / 1048576).toFixed(1)} MB, ${(zipped.length / 1048576).toFixed(1)} MB zipped`);
    if (!go) { console.log('\nNothing was sent. To send it:  node scripts/push-db.js --yes'); return; }

    console.log(`\nSending to ${site} ...`);
    const res = await fetch(site + '/admin-upload/db', { method: 'POST', headers: { 'x-admin-token': token, 'x-confirm-replace': 'replace-live-database', 'content-type': 'application/octet-stream' }, body: zipped })
      .catch(e => die('Could not reach ' + site + ': ' + e.message));
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) die('The live site refused the admin token (or needs the 6-digit code).');
    if (res.status === 404) die('The live site does not have the database route yet. It is still deploying the latest code; try again in a few minutes.');
    if (!res.ok) die(`The live site did not accept it (${res.status}): ${j.error || 'unknown error'}`);
    console.log(`Accepted: ${JSON.stringify(j.counts)}. The site is restarting to swap it in...`);
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 4000));
      try { const p = await (await fetch(site + '/api/ping', { signal: AbortSignal.timeout(5000) })).json(); if (p.ok && p.uptimeSec < 120) { console.log(`The live site is back (up ${p.uptimeSec}s) with your database.`); return; } } catch (_) {}
    }
    console.log('The live site has not answered yet. Give it a few minutes; if it stays down, check Railway.');
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
})().catch(e => die('Failed: ' + e.message));
