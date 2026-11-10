// Closing lines: when the books cannot give one, the scan's last look before tip-off stands in, never the opening scan and never a look after tip-off.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('./helpers/extract');
const { createStore } = require('../lib/db');
const { buildGradingReport } = require('../lib/report');

const TIP = '2026-11-10T00:30:00.000Z';
const iso = m => new Date(Date.parse(TIP) + m * 60000).toISOString();
function setup(entries) {
  const store = createStore({ dbPath: ':memory:', log: () => {} });
  let saved = entries;
  const f = extract({ functions: ['scanClosingFor', 'backfillClosingFromScan'], globals: { store, loadCLV: () => saved, saveCLV: e => { saved = e; }, applyCLV: e => { e.clv = 0.5; }, Date } });
  return { f, store, get saved() { return saved; } };
}
const pick = (over = {}) => ({ id: 1, source: 'auto', date: '2026-11-09', league: 'nba', player: 'Anthony Black', propType: 'points', savedAt: iso(-600), gameStart: TIP, closingLine: null, closingCapture: 'missed', verdict: 'OVER', ...over });
const scanRow = (at, evalLine = 16.5) => [{ date: '2026-11-09', league: 'nba', player: 'Anthony Black', propType: 'points', data: { evalLine, books: [['A', 16.5], ['B', 16.5]], at } }];

test('a real re-look shortly before tip-off becomes the closing line, marked as coming from the scan', () => {
  const t = setup([pick()]); t.store.addScanProps(scanRow(iso(-40)));
  const c = t.f.scanClosingFor(t.saved[0]);
  assert.equal(c.closingLine, 16.5); assert.equal(c.closingCapture, 'scan'); assert.equal(c.closingBookCount, 2);
});

test('never the opening scan again, never a look after tip-off, never one that is hours old, never when there is no row', () => {
  const t = setup([pick()]);
  t.store.addScanProps(scanRow(iso(-590)));                                    // 10 minutes after the pick was logged: that is the opening look
  assert.equal(t.f.scanClosingFor(t.saved[0]), null);
  const t2 = setup([pick()]); t2.store.addScanProps(scanRow(iso(10)));          // after tip-off
  assert.equal(t2.f.scanClosingFor(t2.saved[0]), null);
  const t3 = setup([pick({ savedAt: iso(-900) })]); t3.store.addScanProps(scanRow(iso(-300)));   // 5 hours before tip
  assert.equal(t3.f.scanClosingFor(t3.saved[0]), null);
  assert.equal(setup([pick()]).f.scanClosingFor(pick()), null);
  assert.equal(setup([pick()]).f.scanClosingFor(pick({ gameStart: null })), null);
});

test('the backfill only touches picks marked missed, and counts what it filled', () => {
  const t = setup([pick({ id: 1 }), pick({ id: 2, closingCapture: 'auto', closingLine: 17 }), pick({ id: 3, closingCapture: 'unavailable' }), pick({ id: 4, player: 'Nobody' })]);
  t.store.addScanProps(scanRow(iso(-40)));
  assert.equal(t.f.backfillClosingFromScan(), 1);
  assert.equal(t.saved[0].closingLine, 16.5); assert.equal(t.saved[0].clv, 0.5);
  assert.equal(t.saved[1].closingLine, 17, 'a direct capture is never replaced'); assert.equal(t.saved[2].closingLine, null); assert.equal(t.saved[3].closingLine, null);
});

test('the report says how many picks have a closing line and where from', () => {
  const r = buildGradingReport({ date: '2026-11-09', picks: [], closing: { total: 100, auto: 30, scan: 10, missed: 50 } });
  assert.match(r.text, /CLOSING LINES: 40 of 100 picks have one \(40.0%\): 30 captured straight from the books, 10 from the scan's last look before tip-off, 50 missed/);
  assert.equal(r.data.closing.total, 100);
});
