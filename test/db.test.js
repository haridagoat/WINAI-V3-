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
