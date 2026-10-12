const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/passwords');

test('a password is stored as a salted scrypt hash, never as itself', async () => {
  const h = await P.hashPassword('bluejay-sunrise-42');
  assert.match(h, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!h.includes('bluejay'));
});
test('the right password verifies and a wrong one does not', async () => {
  const h = await P.hashPassword('bluejay-sunrise-42');
  assert.equal(await P.verifyPassword('bluejay-sunrise-42', h), true);
  for (const bad of ['bluejay-sunrise-43', 'Bluejay-sunrise-42', '', ' bluejay-sunrise-42', 'bluejay-sunrise-42 ']) assert.equal(await P.verifyPassword(bad, h), false, JSON.stringify(bad));
});
test('two people with the same password get different hashes', async () => {
  const [a, b] = await Promise.all([P.hashPassword('same-password-here'), P.hashPassword('same-password-here')]);
  assert.notEqual(a, b);
  assert.equal(await P.verifyPassword('same-password-here', a), true); assert.equal(await P.verifyPassword('same-password-here', b), true);
});
test('a damaged or foreign stored value never verifies and never throws', async () => {
  for (const bad of [undefined, null, '', 'plaintext', 'scrypt$x', 'bcrypt$12$abc$def', 'scrypt$32768$8$1$AAAA$']) assert.equal(await P.verifyPassword('anything', bad), false, String(bad));
});
test('accented and composed characters hash the same way however they were typed', async () => {
  const h = await P.hashPassword('café-password-1');                 // e with an accent, one character
  assert.equal(await P.verifyPassword('café-password-1', h), true);  // e then a combining accent
});
test('burnTime takes real time, so an unknown email cannot be told apart by speed', async () => {
  const t = Date.now(); await P.burnTime('x'); await P.burnTime('y');
  assert.ok(Date.now() - t >= 20);
});
test('the rules: length, common passwords, and your own email or name', () => {
  const ok = (pw, e = 'maya@gmail.com', n = 'Maya') => P.passwordProblems(pw, e, n);
  assert.deepEqual(ok('bluejay-sunrise-42'), []);
  assert.ok(ok('short1').some(x => /10 characters/.test(x)));
  assert.ok(ok('x'.repeat(129)).some(x => /128/.test(x)));
  for (const pw of ['password123', 'Password123', '1234567890', 'qwertyuiop', 'aaaaaaaaaaaa', 'iloveyou123', 'letmein123']) assert.ok(ok(pw).some(x => /common/.test(x)), pw);
  assert.ok(ok('maya-is-great-2026').some(x => /email name/.test(x)));
  assert.ok(ok('MAYA-sunrise-77', 'x@y.com', 'Maya').some(x => /your name/.test(x)));
  assert.deepEqual(ok('pass phrase with spaces ok'), []);
  assert.deepEqual(ok('ab@xy.com'.padEnd(12, 'z'), 'ab@xy.com', ''), ['not contain your email name'].filter(() => false));   // short local parts are not checked
  assert.ok(ok(undefined).length > 0);
});
