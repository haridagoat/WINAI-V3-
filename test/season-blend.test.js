// Runs the Python tests for the NBA season blend (season_blend.py), so `npm test` covers it too.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('season blend (python): weights, totals scaling, rookies, files', () => {
  const r = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', 'tests_py', '-t', '.'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
});
