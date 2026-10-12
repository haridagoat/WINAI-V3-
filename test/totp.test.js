const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/totp');

// RFC 6238 appendix B: the shared secret is the ASCII string 12345678901234567890 (SHA-1).
const RFC = Buffer.from('12345678901234567890');
test('matches the RFC 6238 test values', () => {
  for (const [sec, code8] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(T.codeAt(RFC, T.stepOf(sec * 1000), 8), code8, String(sec));
    assert.equal(T.codeAt(RFC, T.stepOf(sec * 1000), 6), code8.slice(2), `${sec} (6 digits)`);
  }
});
test('base32 round-trips and rejects junk', () => {
  assert.equal(T.base32Encode(RFC), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(T.base32Decode('gezd gnbv-gy3t qojq GEZDGNBVGY3TQOJQ=='), RFC);                    // case, spaces, dashes and padding are ignored
  assert.throws(() => T.base32Decode('not base32!'), /base32/); assert.throws(() => T.base32Decode(''), /base32/);
  const s = T.newSecret(); assert.match(s, /^[A-Z2-7]{32}$/); assert.notEqual(s, T.newSecret());
  assert.deepEqual(T.base32Decode(s).length, 20);
});
const SECRET = T.base32Encode(RFC), AT = 1111111109 * 1000;
test('the current code is accepted; so are the neighbours (clock drift); further away is not', () => {
  const step = T.stepOf(AT);
  assert.equal(T.verify(SECRET, T.codeAt(SECRET, step), { now: AT }), step);
  assert.equal(T.verify(SECRET, T.codeAt(SECRET, step - 1), { now: AT }), step - 1);
  assert.equal(T.verify(SECRET, T.codeAt(SECRET, step + 1), { now: AT }), step + 1);
  assert.equal(T.verify(SECRET, T.codeAt(SECRET, step - 2), { now: AT }), null);
  assert.equal(T.verify(SECRET, T.codeAt(SECRET, step + 2), { now: AT }), null);
});
test('a code cannot be used twice, and an older one cannot be used after a newer one', () => {
  const step = T.stepOf(AT), code = T.codeAt(SECRET, step);
  assert.equal(T.verify(SECRET, code, { now: AT, afterStep: step - 1 }), step);
  assert.equal(T.verify(SECRET, code, { now: AT, afterStep: step }), null);
  assert.equal(T.verify(SECRET, T.codeAt(SECRET, step - 1), { now: AT, afterStep: step }), null);
});
test('anything that is not six digits is refused without throwing', () => {
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, 123456, '12 34 5x', '١٢٣٤٥٦']) assert.equal(T.verify(SECRET, bad, { now: AT }), null, String(bad));
  const code = T.codeAt(SECRET, T.stepOf(AT)); assert.equal(T.verify(SECRET, code.slice(0, 3) + ' ' + code.slice(3), { now: AT }), T.stepOf(AT));   // spaces are fine
});
test('the setup link carries the secret and names the app', () => {
  const u = T.otpauthUri('ABCDEF234567', 'owner@example.com');
  assert.match(u, /^otpauth:\/\/totp\/WIN%20AI:owner%40example\.com\?secret=ABCDEF234567&issuer=WIN%20AI&algorithm=SHA1&digits=6&period=30$/);
});
