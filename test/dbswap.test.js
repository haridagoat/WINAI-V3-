// Replacing the live database with an uploaded one (lib/dbswap.js): only healthy, complete databases are accepted,
// the old one is always kept, and nothing is replaced under a running connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../lib/db');
const S = require('../lib/dbswap');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'winai-swap-'));
// A real database made by the app's own schema code, with a recognisable marker in meta.
function makeDb(file, marker) {
  const store = createStore({ dbPath: file, jsonPath: path.join(path.dirname(file), 'x.json'), log() {} });
  store.setMeta('marker', marker);
  return store;
}
const readMarker = file => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare("SELECT value FROM meta WHERE key = 'marker'").get()?.value; } finally { db.close(); } };

test('a healthy, complete database passes the check and reports what is in it', () => {
  const dir = tmp(), f = path.join(dir, 'a.db'); const st = makeDb(f, 'new'); st.close();
  const c = S.checkDatabase(f);
  assert.equal(c.ok, true); assert.ok(c.tables.includes('users') && c.tables.includes('scan_props')); assert.deepEqual(Object.keys(c.counts), ['users', 'picks', 'scan_props']);
});

test('garbage, an empty file, a database missing tables, and a damaged database are all refused', () => {
  const dir = tmp();
  const junk = path.join(dir, 'junk.db'); fs.writeFileSync(junk, 'this is not a database at all, just text');
  assert.match(S.checkDatabase(junk).reason, /not an SQLite/);
  const empty = path.join(dir, 'empty.db'); fs.writeFileSync(empty, '');
  assert.equal(S.checkDatabase(empty).ok, false);
  const partial = path.join(dir, 'partial.db'); const p = new DatabaseSync(partial); p.exec('CREATE TABLE meta (key TEXT, value TEXT)'); p.close();
  assert.match(S.checkDatabase(partial).reason, /missing tables/);
  const good = path.join(dir, 'good.db'); makeDb(good, 'x').close();
  const bytes = fs.readFileSync(good); const damaged = path.join(dir, 'damaged.db');
  fs.writeFileSync(damaged, Buffer.concat([bytes.subarray(0, 4096), Buffer.alloc(bytes.length - 4096, 7)]));   // header intact, the rest overwritten
  assert.equal(S.checkDatabase(damaged).ok, false, 'a file with a good header and a destroyed body is refused');
  assert.equal(S.checkDatabase(path.join(dir, 'missing.db')).ok, false);
});

test('staging saves a good upload next to the database and refuses a bad one without leaving anything behind', () => {
  const dir = tmp(), live = path.join(dir, 'winai.db'), srcFile = path.join(dir, 'src.db'); makeDb(srcFile, 'from-mac').close();
  const bad = S.stageIncoming(live, Buffer.from('nope'));
  assert.equal(bad.ok, false); assert.deepEqual(fs.readdirSync(dir).sort(), ['src.db', 'src.db-shm', 'src.db-wal', 'x.json'].filter(n => fs.existsSync(path.join(dir, n))).sort(), 'no .incoming or .tmp left behind');
  const ok = S.stageIncoming(live, fs.readFileSync(srcFile));
  assert.equal(ok.ok, true); assert.ok(fs.existsSync(live + '.incoming')); assert.ok(!fs.existsSync(live + '.incoming.tmp'));
});

test('at start nothing happens when nothing was uploaded', () => {
  const dir = tmp(), live = path.join(dir, 'winai.db'); makeDb(live, 'keep').close();
  assert.equal(S.applyIncoming(live), null); assert.equal(readMarker(live), 'keep');
});

test('the swap: the new database takes over, and the old one is kept whole, including what was only in its write-ahead log', () => {
  const dir = tmp(), live = path.join(dir, 'winai.db'), srcFile = path.join(dir, 'src.db');
  const old = makeDb(live, 'old');                                   // left open: its newest rows are still in the -wal file
  old.setMeta('only-in-wal', 'recent');
  makeDb(srcFile, 'from-mac').close();
  S.stageIncoming(live, fs.readFileSync(srcFile));
  const logs = []; const r = S.applyIncoming(live, m => logs.push(m), () => new Date('2026-11-20T03:00:00Z'));
  assert.equal(r.applied, true);
  assert.ok(!fs.existsSync(live + '.incoming'), 'the staged file is gone');
  assert.ok(!fs.existsSync(live + '-wal') && !fs.existsSync(live + '-shm'), 'the old write-ahead log cannot be applied to the new database (checked before anything opens the new file, which would recreate them)');
  assert.equal(readMarker(live), 'from-mac', 'the live file is now the uploaded database');
  assert.match(path.basename(r.backup), /^winai-before-swap-2026-11-20T03-00-00-000Z\.db$/);
  assert.equal(readMarker(r.backup), 'old', 'the old database is kept');
  const b = new DatabaseSync(r.backup, { readOnly: true });
  assert.equal(b.prepare("SELECT value FROM meta WHERE key = 'only-in-wal'").get()?.value, 'recent', 'even rows that had not been written into the main file yet'); b.close();
  assert.ok(logs.some(l => /replaced/.test(l)));
  try { old.close(); } catch (_) {}
});

test('a bad file that is already staged at start is set aside and the current database is left untouched', () => {
  const dir = tmp(), live = path.join(dir, 'winai.db'); makeDb(live, 'keep').close();
  fs.writeFileSync(live + '.incoming', 'corrupt'); const logs = [];
  const r = S.applyIncoming(live, m => logs.push(m), () => new Date('2026-11-20T03:00:00Z'));
  assert.equal(r.applied, false); assert.equal(readMarker(live), 'keep');
  assert.ok(!fs.existsSync(live + '.incoming')); assert.ok(fs.readdirSync(dir).some(n => n.startsWith('winai.db.rejected-')), 'kept aside for a look');
  assert.ok(logs.some(l => /refused/.test(l)));
});

test('on a brand new host with no database yet, the uploaded one simply becomes the database', () => {
  const dir = tmp(), live = path.join(dir, 'winai.db'), srcFile = path.join(dir, 'src.db'); makeDb(srcFile, 'first').close();
  S.stageIncoming(live, fs.readFileSync(srcFile));
  const r = S.applyIncoming(live); assert.equal(r.applied, true); assert.equal(r.backup, null); assert.equal(readMarker(live), 'first');
});
