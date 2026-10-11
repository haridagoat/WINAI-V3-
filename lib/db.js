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
  return [e.date ?? null, e.league ?? null, e.source ?? null, e.result ?? null, e.savedAt ?? null, Number.isFinite(Number(e.userId)) && e.userId != null ? Number(e.userId) : null];
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
    -- Accounts. Login links and sessions are stored hashed, so a copy of this file cannot be used to sign in.
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      last_seen TEXT, disabled INTEGER NOT NULL DEFAULT 0, age_confirmed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS login_tokens (
      hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      used_at TEXT, age_ok INTEGER NOT NULL DEFAULT 0, ip TEXT
    );
    CREATE INDEX IF NOT EXISTS login_tokens_email ON login_tokens(email, created_at);
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    -- Billing. The plan only ever comes from here, and this only changes from a verified Stripe webhook or an admin grant.
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER PRIMARY KEY, customer_id TEXT, subscription_id TEXT, status TEXT, price_id TEXT,
      current_period_end TEXT, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, event_created INTEGER NOT NULL DEFAULT 0, updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS subscriptions_customer ON subscriptions(customer_id);
    CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, type TEXT, received_at TEXT);
    -- One row per analysis a person starts. It counts toward the daily limit only once the analysis succeeds.
    CREATE TABLE IF NOT EXISTS analysis_tickets (
      hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, day TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      ctx_uses INTEGER NOT NULL DEFAULT 0, ai_uses INTEGER NOT NULL DEFAULT 0, done_at TEXT
    );
    CREATE INDEX IF NOT EXISTS tickets_user_day ON analysis_tickets(user_id, day);
  `);
  if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'comped')) db.exec('ALTER TABLE users ADD COLUMN comped INTEGER NOT NULL DEFAULT 0');
  // Owner of a saved prop. NULL = the system's own picks (source 'auto') or props saved before accounts existed.
  if (!db.prepare('PRAGMA table_info(picks)').all().some(c => c.name === 'user_id')) db.exec('ALTER TABLE picks ADD COLUMN user_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS picks_user ON picks(user_id)');

  const q = {
    all: db.prepare('SELECT data FROM picks ORDER BY id DESC'),
    ids: db.prepare('SELECT id, data FROM picks'),
    upsert: db.prepare(`INSERT INTO picks (id, data, date, league, source, result, saved_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, date = excluded.date, league = excluded.league, source = excluded.source, result = excluded.result, saved_at = excluded.saved_at, user_id = excluded.user_id`),
    pickOne: db.prepare('SELECT data FROM picks WHERE id = ?'),
    picksByUser: db.prepare('SELECT data FROM picks WHERE user_id = ? ORDER BY id DESC'),
    picksSystem: db.prepare("SELECT data FROM picks WHERE source = 'auto' ORDER BY id DESC"),
    countByUser: db.prepare('SELECT COUNT(*) AS n FROM picks WHERE user_id = ?'),
    countUnclaimed: db.prepare("SELECT COUNT(*) AS n FROM picks WHERE user_id IS NULL AND (source IS NULL OR source <> 'auto')"),
    claim: db.prepare("UPDATE picks SET user_id = ?, data = json_set(data, '$.userId', ?) WHERE user_id IS NULL AND (source IS NULL OR source <> 'auto')"),
    delByUser: db.prepare('DELETE FROM picks WHERE user_id = ?'),
    addUser: db.prepare('INSERT INTO users (email, created_at, age_confirmed_at) VALUES (?, ?, ?)'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    touchUser: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
    setDisabled: db.prepare('UPDATE users SET disabled = ? WHERE id = ?'),
    listUsers: db.prepare('SELECT u.id, u.email, u.created_at, u.last_seen, u.disabled, u.comped, (SELECT COUNT(*) FROM picks p WHERE p.user_id = u.id) AS props FROM users u ORDER BY u.id'),
    delUser: db.prepare('DELETE FROM users WHERE id = ?'),
    addToken: db.prepare('INSERT INTO login_tokens (hash, email, created_at, expires_at, age_ok, ip) VALUES (?, ?, ?, ?, ?, ?)'),
    useToken: db.prepare('UPDATE login_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?'),
    getToken: db.prepare('SELECT * FROM login_tokens WHERE hash = ?'),
    recentTokens: db.prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?'),
    delTokensForEmail: db.prepare('DELETE FROM login_tokens WHERE email = ?'),
    addSession: db.prepare('INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    sessionUser: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ? AND s.expires_at > ? AND u.disabled = 0'),
    delSession: db.prepare('DELETE FROM sessions WHERE hash = ?'),
    delSessionsForUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    pruneTokens: db.prepare('DELETE FROM login_tokens WHERE expires_at <= ?'),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    setComped: db.prepare('UPDATE users SET comped = ? WHERE id = ?'),
    billingGet: db.prepare('SELECT * FROM subscriptions WHERE user_id = ?'),
    billingByCustomer: db.prepare('SELECT user_id FROM subscriptions WHERE customer_id = ?'),
    billingAll: db.prepare('SELECT * FROM subscriptions'),
    billingSetCustomer: db.prepare('INSERT INTO subscriptions (user_id, customer_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET customer_id = excluded.customer_id, updated_at = excluded.updated_at'),
    billingApply: db.prepare(`INSERT INTO subscriptions (user_id, customer_id, subscription_id, status, price_id, current_period_end, cancel_at_period_end, event_created, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET customer_id = excluded.customer_id, subscription_id = excluded.subscription_id, status = excluded.status, price_id = excluded.price_id,
        current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end, event_created = excluded.event_created, updated_at = excluded.updated_at
      WHERE excluded.event_created >= subscriptions.event_created`),
    delBilling: db.prepare('DELETE FROM subscriptions WHERE user_id = ?'),
    addStripeEvent: db.prepare('INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)'),
    delStripeEvent: db.prepare('DELETE FROM stripe_events WHERE id = ?'),
    pruneStripeEvents: db.prepare('DELETE FROM stripe_events WHERE received_at < ?'),
    closeTickets: db.prepare('UPDATE analysis_tickets SET expires_at = ? WHERE user_id = ? AND done_at IS NULL AND expires_at > ?'),
    addTicket: db.prepare('INSERT INTO analysis_tickets (hash, user_id, day, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'),
    getTicket: db.prepare('SELECT * FROM analysis_tickets WHERE hash = ? AND done_at IS NULL AND expires_at > ?'),
    bumpCtx: db.prepare('UPDATE analysis_tickets SET ctx_uses = ctx_uses + 1 WHERE hash = ? AND done_at IS NULL AND expires_at > ? AND ctx_uses < ?'),
    bumpAi: db.prepare('UPDATE analysis_tickets SET ai_uses = ai_uses + 1 WHERE hash = ? AND done_at IS NULL AND expires_at > ? AND ai_uses < ?'),
    finishTicket: db.prepare('UPDATE analysis_tickets SET done_at = ? WHERE hash = ? AND done_at IS NULL'),
    startedCount: db.prepare('SELECT COUNT(*) AS n FROM analysis_tickets WHERE user_id = ? AND day = ?'),
    doneCount: db.prepare('SELECT COUNT(*) AS n FROM analysis_tickets WHERE user_id = ? AND day = ? AND done_at IS NOT NULL'),
    pruneTickets: db.prepare('DELETE FROM analysis_tickets WHERE day < ?'),
    delTicketsForUser: db.prepare('DELETE FROM analysis_tickets WHERE user_id = ?'),
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

    // One row at a time. The whole-list savePicks() above rewrites everything, which is fine for the
    // server's own jobs but would let two people's saves overwrite each other.
    getPick(id) { const r = q.pickOne.get(Number(id)); return r ? JSON.parse(r.data) : null; },
    writePick(e) { q.upsert.run(Number(e.id), JSON.stringify(e), ...pickColumns(e)); return e; },
    deletePick(id) { return q.del.run(Number(id)).changes; },
    picksForUser(userId) { return q.picksByUser.all(Number(userId)).map(r => JSON.parse(r.data)); },
    systemPicks() { return q.picksSystem.all().map(r => JSON.parse(r.data)); },
    countUserPicks(userId) { return q.countByUser.get(Number(userId)).n; },
    countUnclaimedPicks() { return q.countUnclaimed.get().n; },
    // Props saved before accounts existed have no owner. They go to the account that claims them.
    claimUnclaimedPicks(userId) { return Number(q.claim.run(Number(userId), Number(userId)).changes); },

    // ── accounts ──
    supportsAccounts: true,
    createUser(email, ageConfirmedAt = null, createdAt = iso()) { return Number(q.addUser.run(email, createdAt, ageConfirmedAt).lastInsertRowid); },
    userByEmail(email) { return q.userByEmail.get(email) || null; },
    userById(id) { return q.userById.get(Number(id)) || null; },
    touchUser(id, ts = iso()) { q.touchUser.run(ts, Number(id)); },
    listUsers() { return q.listUsers.all(); },
    countUsers() { return q.countUsers.get().n; },
    setUserDisabled(id, disabled) { q.setDisabled.run(disabled ? 1 : 0, Number(id)); if (disabled) q.delSessionsForUser.run(Number(id)); },
    // Removes the person and everything they saved. Nothing is kept.
    deleteUser(id) {
      return tx(() => {
        const u = q.userById.get(Number(id));
        if (!u) return { deleted: false, props: 0 };
        const props = q.countByUser.get(u.id).n;
        q.delByUser.run(u.id); q.delSessionsForUser.run(u.id); q.delTokensForEmail.run(u.email); q.delBilling.run(u.id); q.delTicketsForUser.run(u.id); q.delUser.run(u.id);
        return { deleted: true, props };
      });
    },
    addLoginToken({ hash, email, expiresAt, ageOk = false, ip = null, createdAt = iso() }) { q.addToken.run(hash, email, createdAt, expiresAt, ageOk ? 1 : 0, ip); },
    // Marks a login link used and returns it, or null if it is unknown, expired or already used.
    consumeLoginToken(hash, nowIso = iso()) {
      if (q.useToken.run(nowIso, hash, nowIso).changes !== 1) return null;
      return q.getToken.get(hash);
    },
    recentLoginTokens(email, sinceIso) { return q.recentTokens.get(email, sinceIso).n; },
    addSession({ hash, userId, expiresAt, createdAt = iso() }) { q.addSession.run(hash, Number(userId), createdAt, expiresAt); },
    sessionUser(hash, nowIso = iso()) { return q.sessionUser.get(hash, nowIso) || null; },
    deleteSession(hash) { q.delSession.run(hash); },
    pruneAuth(nowIso = iso()) { q.pruneSessions.run(nowIso); q.pruneTokens.run(nowIso); },
    // ── billing ──
    setUserComped(id, comped) { q.setComped.run(comped ? 1 : 0, Number(id)); },
    getBilling(userId) { return q.billingGet.get(Number(userId)) || null; },
    allBilling() { return q.billingAll.all(); },
    userIdByCustomer(customerId) { return q.billingByCustomer.get(String(customerId))?.user_id ?? null; },
    setCustomer(userId, customerId) { q.billingSetCustomer.run(Number(userId), String(customerId), iso()); },
    // Applies a subscription state. An event older than the one already stored is ignored, so a late retry
    // can never undo a newer cancellation. Returns true when it was applied.
    applySubscription(userId, s) {
      return q.billingApply.run(Number(userId), s.customerId ?? null, s.subscriptionId ?? null, s.status ?? null, s.priceId ?? null,
        s.currentPeriodEnd ?? null, s.cancelAtPeriodEnd ? 1 : 0, Number(s.eventCreated) || 0, iso()).changes === 1;
    },
    // First sight of an event id returns true; a replay returns false.
    recordStripeEvent(id, type) { q.pruneStripeEvents.run(new Date(Date.now() - 45 * 86400e3).toISOString()); return q.addStripeEvent.run(String(id), String(type), iso()).changes === 1; },
    forgetStripeEvent(id) { q.delStripeEvent.run(String(id)); },
    // ── analysis tickets ──
    // Starting a new analysis closes the person's earlier unfinished one, so only one can be in flight.
    startTicket({ hash, userId, day, expiresAt, now = iso() }) { q.closeTickets.run(now, Number(userId), now); q.addTicket.run(hash, Number(userId), day, now, expiresAt); q.pruneTickets.run(day); },
    getTicket(hash, now = iso()) { return q.getTicket.get(hash, now) || null; },
    useTicket(hash, field, max, now = iso()) { return (field === 'ctx' ? q.bumpCtx : q.bumpAi).run(hash, now, max).changes === 1; },
    finishTicket(hash, now = iso()) { return q.finishTicket.run(now, hash).changes === 1; },
    ticketsStarted(userId, day) { return q.startedCount.get(Number(userId), day).n; },
    analysesDone(userId, day) { return q.doneCount.get(Number(userId), day).n; },
    integrityCheck() { return db.prepare('PRAGMA quick_check').all().map(r => Object.values(r)[0]); },

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
    backend: 'json', file, imported: 0, supportsAccounts: false,
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
