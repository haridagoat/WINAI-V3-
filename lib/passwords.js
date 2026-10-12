// Passwords: how they are stored and which ones are allowed.
//
// A password is never stored. What is stored is a salted scrypt hash: a one-way scramble that takes about
// 60 ms to compute on purpose, so guessing at scale is slow. Each password gets its own random salt, so two
// people with the same password have different hashes. Nobody, including the admin, can read a password back.
const crypto = require('crypto');

const N = 1 << 15, R = 8, P = 1, KEYLEN = 64, MAXMEM = 128 * 1024 * 1024;
const MIN_LENGTH = 10, MAX_LENGTH = 128;       // the cap keeps one request from costing the server too much to hash

const scrypt = (pw, salt, n, r, p, len) => new Promise((res, rej) => crypto.scrypt(pw.normalize('NFKC'), salt, len, { N: n, r, p, maxmem: MAXMEM }, (e, k) => (e ? rej(e) : res(k))));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [alg, n, r, p, salt, key] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const got = await scrypt(String(pw), Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p), expected.length);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
// Used when an email has no account, so a wrong email takes as long to refuse as a wrong password does.
let dummy = null;
const dummyHash = () => (dummy ||= hashPassword('not-a-real-account-password'));
async function burnTime(pw) { await verifyPassword(pw, await dummyHash()); }

// Passwords people actually use. Not exhaustive: it stops the obvious ones and anything built from them.
const COMMON = new Set(['password', 'passw0rd', 'password1', 'password12', 'password123', 'password1234', 'p@ssword123', 'qwertyuiop', 'qwerty123', 'qwerty1234', 'qwertyuiop1', '1qaz2wsx3e', 'zxcvbnm123',
  '1234567890', '12345678910', '123456789012', '0123456789', '1111111111', '0000000000', '1234512345', '9876543210', 'abcdefghij', 'abcd123456', 'abc1234567', 'iloveyou123', 'iloveyou12', 'letmein123', 'letmein1234',
  'welcome123', 'welcome1234', 'admin12345', 'administrator', 'changeme123', 'trustno1234', 'sunshine123', 'princess123', 'football123', 'baseball123', 'basketball', 'basketball1', 'basketball23', 'lebronjames', 'stephcurry30',
  'monkey12345', 'dragon12345', 'master12345', 'superman123', 'batman12345', 'starwars123', 'whatever123', 'freedom123', 'shadow12345', 'michael1234', 'jordan23jordan', 'winai123456', 'winaiwinai', 'winai12345', 'bettingtime']);
function passwordProblems(pw, email = '', name = '') {
  const p = String(pw ?? '');
  const lower = p.toLowerCase(), local = String(email).split('@')[0].toLowerCase();
  const out = [];
  if (p.length < MIN_LENGTH) out.push(`at least ${MIN_LENGTH} characters`);
  if (p.length > MAX_LENGTH) out.push(`no more than ${MAX_LENGTH} characters`);
  if (p.length && (COMMON.has(lower) || /^(.)\1+$/.test(p) || /^(0123456789|1234567890|abcdefghij)/.test(lower) && p.length <= 12)) out.push('not a commonly used password');
  if (local.length >= 3 && lower.includes(local)) out.push('not contain your email name');
  const first = String(name).trim().toLowerCase();
  if (first.length >= 4 && lower.includes(first)) out.push('not contain your name');
  return out;
}

module.exports = { hashPassword, verifyPassword, burnTime, passwordProblems, MIN_LENGTH, MAX_LENGTH };
