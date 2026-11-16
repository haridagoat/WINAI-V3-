const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/db');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'winai-'));
const pick = (id, o = {}) => ({ id, date: '2026-10-09', league: 'wnba', source: 'auto', player: 'P' + id, line: 10.5, result: null, savedAt: new Date(id).toISOString(), ...o });

test('picks round-trip, newest first', () => {
  const s = createStore({ dbPath: ':memory:' });
  s.savePicks([pick(3), pick(1), pick(2)]);
  assert.deepEqual(s.loadPicks().map(p => p.id), [3, 2, 1]);
  assert.equal(s.countPicks(), 3);
});

test('saving replaces the set: edits stick and removed picks are deleted', () => {
  const s = createStore({ dbPath: ':memory:' });
  s.savePicks([pick(1), pick(2)]);
  s.savePicks([pick(2, { result: 'WIN', actualStat: 12 })]);
  const all = s.loadPicks();
  assert.equal(all.length, 1);
  assert.equal(all[0].result, 'WIN');
  assert.equal(all[0].actualStat, 12);
});

test('large ids and nested fields survive untouched', () => {
  const s = createStore({ dbPath: ':memory:' });
  const e = pick(1791598969376, { notes: 'x', nested: { a: [1, 2, { b: null }] }, closingLine: 0 });
  s.savePicks([e]);
  assert.deepEqual(s.loadPicks()[0], e);
});

test('the old JSON file is imported once, kept, and a copy is made', () => {
  const dir = tmp(), json = path.join(dir, 'clv_tracker.json'), db = path.join(dir, 'winai.db');
  fs.writeFileSync(json, JSON.stringify([pick(5), pick(6)]));
  let s = createStore({ dbPath: db, jsonPath: json });
  assert.equal(s.imported, 2);
  assert.equal(s.countPicks(), 2);
  assert.ok(fs.existsSync(json), 'original file must stay');
  assert.ok(fs.existsSync(json + '.pre-sqlite.bak'), 'backup copy must be written');
  s.close();
  // a second start must not import again, even after the JSON changes
  fs.writeFileSync(json, JSON.stringify([pick(99)]));
  s = createStore({ dbPath: db, jsonPath: json });
  assert.equal(s.imported, 0);
  assert.equal(s.countPicks(), 2);
  s.close();
});

test('events, backtests and calibration models persist and come back newest first', () => {
  const dir = tmp(), db = path.join(dir, 'winai.db');
  let s = createStore({ dbPath: db });
  s.addEvent('job', 'warn', 'first'); s.addEvent('job', 'info', 'second');
  s.saveBacktest({ n: 1 }); s.saveBacktest({ n: 2 });
  s.saveCalibration({ active: false, n: 3 });
  s.close();
  s = createStore({ dbPath: db });
  assert.deepEqual(s.recentEvents(5).map(e => e.message), ['second', 'first']);
  assert.equal(s.latestBacktest().report.n, 2);
  assert.equal(s.backtestHistory(5).length, 2);
  assert.equal(s.latestCalibration().model.n, 3);
  s.close();
});

test('meta values read back as saved', () => {
  const s = createStore({ dbPath: ':memory:' });
  assert.equal(s.getMeta('x'), null);
  s.setMeta('x', 39); assert.equal(s.getMeta('x'), '39');
  s.setMeta('x', 40); assert.equal(s.getMeta('x'), '40');
});

test('backup writes a dated copy that opens, and prunes beyond the newest few', () => {
  const dir = tmp(), db = path.join(dir, 'winai.db'), bdir = path.join(dir, 'backups');
  const s = createStore({ dbPath: db });
  s.savePicks([pick(1)]);
  for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) fs.mkdirSync(bdir, { recursive: true }), fs.writeFileSync(path.join(bdir, `winai-${d}.db`), '');
  const out = s.backup(bdir, 2);
  assert.ok(fs.existsSync(out));
  assert.equal(fs.readdirSync(bdir).length, 2);   // today's plus the newest old one
  const copy = createStore({ dbPath: out });
  assert.equal(copy.countPicks(), 1);
  copy.close(); s.close();
});

test('info describes the storage honestly', () => {
  const s = createStore({ dbPath: ':memory:' });
  s.savePicks([pick(1)]);
  assert.deepEqual([s.info().backend, s.info().picks], ['sqlite', 1]);
});

// ── scan log ──
const test2 = require('node:test'), assert2 = require('node:assert/strict');
test2('the scan log keeps one row per prop per day, grades once, and counts what is waiting', () => {
  const { createStore } = require('../lib/db');
  const st = createStore({ dbPath: ':memory:', log: () => {} });
  const row = (player, extra = {}) => ({ date: '2026-11-02', league: 'nba', player, propType: 'points', data: { projection: 20, evalLine: 19.5, ...extra } });
  assert.equal(st.addScanProps([row('A'), row('B'), row('A')]), 2, 'the same prop twice in a day is stored once');
  assert.equal(st.addScanProps([row('A')]), 0);
  assert.deepEqual(st.scanCounts('nba'), { total: 2, graded: 0, waiting: 2, setAside: 0, first: '2026-11-02', last: '2026-11-02' });
  assert.equal(st.scanPropsPending('2026-11-02').length, 0, 'today is not gradable yet');
  const pending = st.scanPropsPending('2026-11-03'); assert.equal(pending.length, 2);
  assert.equal(st.saveScanGrade(pending[0].id, 24), true); assert.equal(st.saveScanGrade(pending[0].id, 30), false, 'a grade is never overwritten');
  assert.equal(st.setScanNote(pending[1].id, 'no matching game'), true);
  const c = st.scanCounts('nba'); assert.equal(c.graded, 1); assert.equal(c.waiting, 0); assert.equal(c.setAside, 1);
  assert.equal(st.gradedScanProps('nba')[0].actual, 24);
  assert.equal(st.updateScanProp(row('A', { projection: 22 })), false, 'a graded row is no longer changed');
  assert.equal(st.addScanProps([row('C')]), 1);
  assert.equal(st.updateScanProp(row('C', { projection: 25 })), true);
  const upd = st.scanPropsPending('2026-11-03').find(r => r.player === 'C'); assert.equal(upd.data.projection, 25); assert.equal(upd.data.first.projection, 20, 'the first look is kept');
  assert.equal(st.pruneScanProps('2026-12-01') >= 3, true);
  st.close();
});

test('a write that arrives while another process holds the database waits for it instead of failing with "database is locked"', async () => {
  const { spawn } = require('node:child_process');
  const dir = tmp(), file = path.join(dir, 'lock.db');
  const store = createStore({ dbPath: file });
  // A second process (a backup tool, or a second copy of the app) takes the write lock, keeps it for 400 ms, and lets go.
  const holder = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
    const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec('BEGIN IMMEDIATE'); console.log('locked'); setTimeout(() => { db.exec('COMMIT'); process.exit(0); }, 400);`]);
  await new Promise((resolve, reject) => { holder.stdout.on('data', d => /locked/.test(String(d)) && resolve()); holder.on('error', reject); setTimeout(() => reject(new Error('holder did not start')), 5000); });
  const started = Date.now();
  store.setMeta('k', 'v');                                 // without a busy timeout this throws at once
  const waited = Date.now() - started;
  assert.equal(store.getMeta('k'), 'v');
  assert.ok(waited >= 250 && waited < 4000, `it should have waited for the other process (waited ${waited} ms)`);
  store.close && store.close(); fs.rmSync(dir, { recursive: true, force: true });
});
