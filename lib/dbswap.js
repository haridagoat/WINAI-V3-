// Replacing the live database with one uploaded from the owner's own computer (scripts/push-db.js).
// The upload is only saved next to the database as "<db>.incoming". The swap happens at the next start, BEFORE the database is opened,
// so nothing is ever replaced under a running connection: the old database is copied to backups/ (including anything still in its
// write-ahead log), the new one takes its place, and the old log files are removed so they cannot be applied to the wrong database.
// A file that is not a healthy database with every table the app needs is refused and set aside, and the old database stays.
const fs = require('fs');
const path = require('path');

const REQUIRED_TABLES = ['meta', 'users', 'sessions', 'picks', 'scan_props', 'events', 'calibration', 'backtests', 'subscriptions', 'stripe_events', 'analysis_tickets', 'login_tokens', 'rg_settings', 'rg_holds'];
const MAGIC = Buffer.from('SQLite format 3\0');

function openReadOnly(file) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

// { ok: true, tables, counts } or { ok: false, reason }.
function checkDatabase(file) {
  let db;
  try {
    const head = Buffer.alloc(16); const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
    if (!head.equals(MAGIC)) return { ok: false, reason: 'it is not an SQLite database file' };
    db = openReadOnly(file);
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const verdict = integrity && Object.values(integrity)[0];
    if (verdict !== 'ok') return { ok: false, reason: `the integrity check failed (${String(verdict).slice(0, 80)})` };
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    const missing = REQUIRED_TABLES.filter(t => !tables.includes(t));
    if (missing.length) return { ok: false, reason: `it is missing tables the app needs: ${missing.join(', ')}` };
    const counts = {};
    for (const t of ['users', 'picks', 'scan_props']) counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return { ok: true, tables, counts };
  } catch (err) {
    return { ok: false, reason: `it could not be read (${String(err.message).slice(0, 100)})` };
  } finally { try { db && db.close(); } catch (_) {} }
}

const sidecars = file => [file + '-wal', file + '-shm'];
const rm = f => { try { fs.unlinkSync(f); } catch (_) {} };

// Run once at start, before the database is opened. Returns null (nothing waiting) or a description of what happened.
function applyIncoming(dbPath, log = () => {}, now = () => new Date()) {
  const incoming = dbPath + '.incoming';
  if (!fs.existsSync(incoming)) return null;
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const check = checkDatabase(incoming);
  if (!check.ok) {
    const rejected = `${dbPath}.rejected-${stamp}`;
    try { fs.renameSync(incoming, rejected); } catch (_) { rm(incoming); }
    sidecars(incoming).forEach(rm);
    log(`[DbSwap] The uploaded database was refused (${check.reason}). The current database was not touched.`);
    return { applied: false, reason: check.reason };
  }
  let backup = null;
  if (fs.existsSync(dbPath)) {
    const dir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    backup = path.join(dir, `winai-before-swap-${stamp}.db`);
    // VACUUM INTO reads the old database together with its write-ahead log, so the copy is complete.
    const { DatabaseSync } = require('node:sqlite');
    const old = new DatabaseSync(dbPath);
    try { old.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`); } finally { old.close(); }
    if (!checkDatabase(backup).ok) throw new Error('The backup of the current database could not be verified, so nothing was replaced.');
  }
  sidecars(dbPath).forEach(rm);
  fs.renameSync(incoming, dbPath);
  sidecars(incoming).forEach(rm);
  log(`[DbSwap] Database replaced (${JSON.stringify(check.counts)}).${backup ? ' The previous one is saved as ' + backup : ''}`);
  return { applied: true, backup, counts: check.counts };
}

// Saves an upload (raw bytes, already unzipped) as "<db>.incoming" after checking it. Returns { ok, counts } or { ok: false, reason }.
function stageIncoming(dbPath, bytes) {
  const tmp = dbPath + '.incoming.tmp';
  fs.writeFileSync(tmp, bytes);
  const check = checkDatabase(tmp);
  if (!check.ok) { rm(tmp); return check; }
  fs.renameSync(tmp, dbPath + '.incoming');
  return check;
}

module.exports = { checkDatabase, applyIncoming, stageIncoming, REQUIRED_TABLES };
