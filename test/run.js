// npm test: runs every *.test.js, prints a summary, and writes test_results.json so the
// admin Health page can show when the tests last ran and whether they passed.
const fs = require('fs');
const path = require('path');
const { run } = require('node:test');
const { spec } = require('node:test/reporters');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).map(f => path.join(__dirname, f));
const started = Date.now();
let passed = 0, failed = 0;
const failures = [];

const stream = run({ files, concurrency: 1 });
stream.on('test:pass', e => { if (e.details?.type !== 'suite') passed++; });
stream.on('test:fail', e => { if (e.details?.type !== 'suite') { failed++; failures.push({ name: e.name, error: String(e.details?.error?.message || e.details?.error || '').slice(0, 300) }); } });
stream.on('close', () => {
  const out = { ts: new Date().toISOString(), passed, failed, durationMs: Date.now() - started, failures };
  try { fs.writeFileSync(path.join(__dirname, '..', 'test_results.json'), JSON.stringify(out, null, 2)); } catch (_) {}
  console.log(`\n${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed (${out.durationMs} ms)`);
  process.exit(failed ? 1 : 0);
});
stream.compose(spec).pipe(process.stdout);
