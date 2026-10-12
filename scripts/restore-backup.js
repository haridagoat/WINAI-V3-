#!/usr/bin/env node
// Brings an offsite backup back after a disaster. Run on your own computer (or a new server) with the same
// BACKUP_* settings the app used:
//
//   node scripts/restore-backup.js list
//   node scripts/restore-backup.js restore <output-file> [key]     (default: the newest copy)
//   node scripts/restore-backup.js decrypt <downloaded-file.enc> <output-file>
//
// It never touches a running database: it writes to the output file you name and refuses to overwrite one.
try { require('dotenv').config(); } catch (_) {}
const fs = require('fs');
const { createOffsite, decryptBackup, defaultOpen } = require('../lib/offsite');

const off = createOffsite({ endpoint: process.env.BACKUP_S3_ENDPOINT, bucket: process.env.BACKUP_S3_BUCKET, accessKeyId: process.env.BACKUP_S3_KEY_ID,
  secretAccessKey: process.env.BACKUP_S3_SECRET, region: process.env.BACKUP_S3_REGION || 'auto', prefix: process.env.BACKUP_S3_PREFIX || 'winai/', passphrase: process.env.BACKUP_PASSPHRASE });
const [cmd, a, b] = process.argv.slice(2);
const die = m => { console.error(m); process.exit(1); };
const write = (file, buf) => { if (fs.existsSync(file)) die(`${file} already exists. Choose a new file name so nothing is overwritten.`); fs.writeFileSync(file, buf, { flag: 'wx' }); };
(async () => {
  if (cmd === 'decrypt' && a && b) {
    const plain = decryptBackup(fs.readFileSync(a), process.env.BACKUP_PASSPHRASE); write(b, plain);
    console.log(`Wrote ${b} (${plain.length} bytes).`); return checkFile(b);
  }
  if (!off.configured) die('Set BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID, BACKUP_S3_SECRET and BACKUP_PASSPHRASE first (same values the app used).');
  if (cmd === 'list') { for (const o of await off.list()) console.log(`${o.key}  ${Math.round(o.size / 1024)} KB  ${o.modified || ''}`); return; }
  if (cmd === 'restore' && a) {
    const all = await off.list(); if (!all.length) die('There are no copies in the bucket.');
    const key = b || all[all.length - 1].key;
    const plain = decryptBackup(await off.download(key), process.env.BACKUP_PASSPHRASE); write(a, plain);
    console.log(`Restored ${key} to ${a} (${plain.length} bytes).`); return checkFile(a);
  }
  die('Usage:\n  node scripts/restore-backup.js list\n  node scripts/restore-backup.js restore <output-file> [key]\n  node scripts/restore-backup.js decrypt <file.enc> <output-file>');
})().catch(e => die(e.message));
function checkFile(f) {
  const r = defaultOpen(f);
  console.log(r.ok ? `Checked: it opens, it is healthy, and it holds ${r.users} accounts and ${r.picks} picks.\nTo use it: stop the app, replace winai.db with this file (delete winai.db-wal and winai.db-shm), start the app.` : `WARNING: this file did not pass the check: ${r.problem}`);
}
