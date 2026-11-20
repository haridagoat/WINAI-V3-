#!/usr/bin/env node
// Sends the stat files this computer fetched to your live site.
//
// nba.com refuses most cloud hosts (Railway included), so the live site cannot fetch its own stats. This computer can.
//   1. Fetch fresh files here:      python3 fetch_stats.py        (and python3 fetch_wnba_stats.py in the WNBA season)
//   2. Send them to the live site:  node scripts/push-stats.js https://your-site.up.railway.app
// It reads ADMIN_TOKEN from this folder's .env and never prints it. The live site keeps the files on its volume, so a redeploy does not lose them.
// Add --dry to only list what would be sent.
const fs = require('fs'), path = require('path');
const { isStatsFileName } = require('../lib/statsupload');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const site = (args.find(a => /^https?:\/\//.test(a)) || '').replace(/\/+$/, '');

function readEnv() {
  const out = {};
  try { for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); } } catch (_) {}
  return out;
}
const env = readEnv();
const token = process.env.ADMIN_TOKEN || env.ADMIN_TOKEN;
const target = site || (env.LIVE_SITE_URL || '').replace(/\/+$/, '');

(async () => {
  if (!target && !dry) { console.error('Give the live address:  node scripts/push-stats.js https://your-site.up.railway.app'); process.exit(1); }
  if (!token && !dry) { console.error('ADMIN_TOKEN was not found in .env or the environment.'); process.exit(1); }

  const names = fs.readdirSync(root).filter(isStatsFileName).sort();
  if (!names.length) { console.error('No stat files here. Run  python3 fetch_stats.py  first.'); process.exit(1); }
  const files = names.map(n => ({ n, text: fs.readFileSync(path.join(root, n), 'utf8'), at: fs.statSync(path.join(root, n)).mtimeMs }));
  const ageH = f => (Date.now() - f.at) / 3600e3;
  const main = files.find(f => f.n === 'player_stats.json');
  console.log(`${files.length} stat files, ${(files.reduce((a, f) => a + f.text.length, 0) / 1048576).toFixed(1)} MB`);
  if (main) console.log(`player_stats.json is ${ageH(main).toFixed(1)} hours old${ageH(main) > 26 ? '  <- old; run  python3 fetch_stats.py  first' : ''}`);
  if (dry) { console.log('Dry run: nothing was sent.\n' + names.join('\n')); return; }

  // batches of about 15 MB, so no single request is huge
  const batches = []; let cur = [], size = 0;
  for (const f of files) { if (cur.length && size + f.text.length > 15 * 1048576) { batches.push(cur); cur = []; size = 0; } cur.push(f); size += f.text.length; }
  if (cur.length) batches.push(cur);

  let sent = 0;
  for (const [i, b] of batches.entries()) {
    const res = await fetch(target + '/admin-upload/stats', { method: 'POST', headers: { 'x-admin-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ files: Object.fromEntries(b.map(f => [f.n, f.text])) }) }).catch(err => { console.error('Could not reach ' + target + ': ' + err.message); process.exit(1); });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401 && j.code === 'admin_2fa') { console.error('The live admin page now needs a 6-digit code, which this script cannot enter. Tell Claude and it will add that.'); process.exit(1); }
    if (res.status === 401) { console.error('The live site refused the admin token. ADMIN_TOKEN in Railway must match the one in this folder\'s .env.'); process.exit(1); }
    if (res.status === 404) { console.error('The live site does not have the upload route yet. It is still deploying the latest code; try again in a few minutes.'); process.exit(1); }
    if (!res.ok) { console.error(`Upload ${i + 1}/${batches.length} failed (${res.status}): ${j.error || 'unknown error'}`); process.exit(1); }
    sent += j.saved || 0;
    console.log(`Sent ${i + 1}/${batches.length}: ${j.saved} files${j.kept ? ' (kept on the live volume)' : ' (NOT kept: the live site has no volume path set, so a redeploy will lose them)'}`);
  }
  console.log(`Done. ${sent} files are on ${target}.`);
})();
