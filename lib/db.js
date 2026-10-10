// Storage for tracked picks and the admin-side records (backtests, calibration, events).
//
// SQLite (node:sqlite, built into Node 22.5+) is the real store. It replaces
// clv_tracker.json, which two server copies could overwrite each other on and
// which a redeploy with a fresh disk would lose. If node:sqlite isn't available
// the store falls back to the original JSON file for picks (and keeps the other
// records in memory only), and reports that clearly through info().
//
// The picks interface is deliberately the same shape the server already used:
// loadPicks() returns the whole array (newest first), savePicks(array) writes it.
const fs = require('fs');
const path = require('path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { /* fallback below */ }

function pickColumns(e) {
  return [e.date ?? null, e.league ?? null, e.source ?? null, e.result ?? null, e.savedAt ?? null];
}

function createStore({ dbPath, jsonPath, log = () => {} } = {}) {
  const useSqlite = !!sqlite && dbPath !== ':json:';
  return useSqlite ? sqliteStore({ dbPath, jsonPath, log }) : jsonStore({ jsonPath, log });
}

// ───────────────────────── SQLite ─────────────────────────
function sqliteStore({ dbPath, jsonPath, log }) {
  const file = dbPath || path.join(__dirname, '..', 'winai.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS picks (
      id INTEGER PRIMARY KEY, data TEXT NOT NULL,
      date TEXT, league TEXT, source TEXT, result TEXT, saved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS picks_date ON picks(date);
    CREATE INDEX IF NOT EXISTS picks_result ON picks(result);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS backtests (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, report TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS calibration (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, model TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT, level TEXT, message TEXT);
  `);

  const q = {
    all: db.prepare('SELECT data FROM picks ORDER BY id DESC'),
    ids: db.prepare('SELECT id, data FROM picks'),
    upsert: db.prepare(`INSERT INTO picks (id, data, date, league, source, result, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, date = excluded.date, league = excluded.league, source = excluded.source, result = excluded.result, saved_at = excluded.saved_at`),
    del: db.prepare('DELETE FROM picks WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM picks'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    addEvent: db.prepare('INSERT INTO events (ts, kind, level, message) VALUES (?, ?, ?, ?)'),
    events: db.prepare('SELECT ts, kind, level, message FROM events ORDER BY id DESC LIMIT ?'),
    addBt: db.prepare('INSERT INTO backtests (ts, report) VALUES (?, ?)'),
    lastBt: db.prepare('SELECT ts, report FROM backtests ORDER BY id DESC LIMIT 1'),
    btHist: db.prepare('SELECT ts, report FROM backtests ORDER BY id DESC LIMIT ?'),
    pruneBt: db.prepare('DELETE FROM backtests WHERE id NOT IN (SELECT id FROM backtests ORDER BY id DESC LIMIT 60)'),
    addCal: db.prepare('INSERT INTO calibration (ts, model) VALUES (?, ?)'),
    lastCal: db.prepare('SELECT ts, model FROM calibration ORDER BY id DESC LIMIT 1'),
    pruneCal: db.prepare('DELETE FROM calibration WHERE id NOT IN (SELECT id FROM calibration ORDER BY id DESC LIMIT 60)'),
    pruneEv: db.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 2000)'),
  };

  function tx(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }

  // One-time import of the old JSON file. The original is left in place and a
  // copy is kept next to it, so nothing is lost if the import needs redoing.
  let imported = 0;
  if (jsonPath && !q.getMeta.get('json_migrated') && fs.existsSync(jsonPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (Array.isArray(old)) {
        const have = new Set(q.ids.all().map(r => r.id));
        tx(() => { for (const e of old) { const id = Number(e.id); if (Number.isFinite(id) && !have.has(id)) { q.upsert.run(id, JSON.stringify(e), ...pickColumns(e)); imported++; } } });
        const bak = jsonPath + '.pre-sqlite.bak';
        if (!fs.existsSync(bak)) fs.copyFileSync(jsonPath, bak);
        q.setMeta.run('json_migrated', new Date().toISOString());
        log(`[Store] Imported ${imported} picks from ${path.basename(jsonPath)} into SQLite (original kept, backup copy written)`);
      }
    } catch (err) { log(`[Store] JSON import failed, will retry next start: ${err.message}`); }
  }

  const iso = () => new Date().toISOString();
  return {
    backend: 'sqlite', file, imported,
    loadPicks() { return q.all.all().map(r => JSON.parse(r.data)); },
    savePicks(entries) {
      try {
        tx(() => {
          const existing = new Map(q.ids.all().map(r => [r.id, r.data]));
          const keep = new Set();
          for (const e of entries) {
            const id = Number(e.id);
            if (!Number.isFinite(id)) continue;
            keep.add(id);
            const s = JSON.stringify(e);
            if (existing.get(id) !== s) q.upsert.run(id, s, ...pickColumns(e));
          }
          for (const id of existing.keys()) if (!keep.has(id)) q.del.run(id);
        });
        return true;
      } catch (err) { log(`[Store] savePicks failed: ${err.message}`); return false; }
    },
    countPicks() { return q.count.get().n; },
    getMeta(k) { return q.getMeta.get(k)?.value ?? null; },
    setMeta(k, v) { q.setMeta.run(k, String(v)); },
    addEvent(kind, level, message) { q.addEvent.run(iso(), kind, level, String(message).slice(0, 500)); q.pruneEv.run(); },
    recentEvents(limit = 50) { return q.events.all(limit); },
    saveBacktest(report) { q.addBt.run(iso(), JSON.stringify(report)); q.pruneBt.run(); },
    latestBacktest() { const r = q.lastBt.get(); return r ? { ts: r.ts, report: JSON.parse(r.report) } : null; },
    backtestHistory(limit = 30) { return q.btHist.all(limit).map(r => ({ ts: r.ts, report: JSON.parse(r.report) })); },
    saveCalibration(model) { q.addCal.run(iso(), JSON.stringify(model)); q.pruneCal.run(); },
    latestCalibration() { const r = q.lastCal.get(); return r ? { ts: r.ts, model: JSON.parse(r.model) } : null; },
    // Dated copy of the database; keeps the newest `keep`. Skips if today's exists.
    backup(dir, keep = 7) {
      if (file === ':memory:') return null;
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, `winai-${iso().slice(0, 10)}.db`);
      if (!fs.existsSync(out)) db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
      const files = fs.readdirSync(dir).filter(f => /^winai-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
      return out;
    },
    info() {
      let sizeBytes = null; try { if (file !== ':memory:') sizeBytes = fs.statSync(file).size; } catch (_) {}
      return { backend: 'sqlite', path: file, sizeBytes, picks: q.count.get().n, migratedFromJson: q.getMeta.get('json_migrated')?.value ?? null, note: null };
    },
    close() { db.close(); },
  };
}

// ───────────────────────── JSON fallback ─────────────────────────
function jsonStore({ jsonPath, log }) {
  const file = jsonPath || path.join(__dirname, '..', 'clv_tracker.json');
  const mem = { events: [], backtests: [], calibration: [], meta: {} };
  log('[Store] node:sqlite is unavailable on this Node version: using the JSON file for picks; reports and events are kept in memory only. Use Node 22.13 or newer.');
  const iso = () => new Date().toISOString();
  return {
    backend: 'json', file, imported: 0,
    loadPicks() { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []; } catch (_) { return []; } },
    savePicks(entries) { try { fs.writeFileSync(file, JSON.stringify(entries, null, 2)); return true; } catch (_) { return false; } },
    countPicks() { return this.loadPicks().length; },
    getMeta(k) { return mem.meta[k] ?? null; }, setMeta(k, v) { mem.meta[k] = String(v); },
    addEvent(kind, level, message) { mem.events.unshift({ ts: iso(), kind, level, message: String(message).slice(0, 500) }); mem.events.length = Math.min(mem.events.length, 500); },
    recentEvents(limit = 50) { return mem.events.slice(0, limit); },
    saveBacktest(report) { mem.backtests.unshift({ ts: iso(), report }); mem.backtests.length = Math.min(mem.backtests.length, 60); },
    latestBacktest() { return mem.backtests[0] || null; },
    backtestHistory(limit = 30) { return mem.backtests.slice(0, limit); },
    saveCalibration(model) { mem.calibration.unshift({ ts: iso(), model }); mem.calibration.length = Math.min(mem.calibration.length, 60); },
    latestCalibration() { return mem.calibration[0] || null; },
    backup() { return null; },
    info() { return { backend: 'json', path: file, sizeBytes: null, picks: this.countPicks(), migratedFromJson: null, note: 'node:sqlite unavailable; reports and events are not persisted' }; },
    close() {},
  };
}

module.exports = { createStore };
