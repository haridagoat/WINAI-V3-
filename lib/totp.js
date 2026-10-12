// Time-based one-time passwords (RFC 6238), the 6-digit codes authenticator apps show. Used as the second factor
// for the admin page: knowing ADMIN_TOKEN is not enough on its own once ADMIN_TOTP_SECRET is set.
const crypto = require('crypto');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('not a valid base32 secret');
  let bits = ''; for (const ch of clean) bits += ALPHABET.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
const newSecret = () => base32Encode(crypto.randomBytes(20));        // 160 bits, what authenticator apps expect

function codeAt(secret, step, digits = 6) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(msg).digest(), o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
const stepOf = (ms, period = 30) => Math.floor(ms / 1000 / period);

// Returns the matched time step, or null. Accepts the previous, current and next step (clock drift). A step at or
// before `afterStep` is refused, so a code that was already used (or seen by someone over the shoulder) cannot be replayed.
function verify(secret, code, { now = Date.now(), afterStep = -1, window = 1 } = {}) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = stepOf(now); let hit = null;
  for (let s = cur - window; s <= cur + window; s++) {
    const ok = crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(c));
    if (ok && s > afterStep && (hit == null || s > hit)) hit = s;
  }
  return hit;
}
const otpauthUri = (secret, account = 'admin', issuer = 'WIN AI') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { base32Encode, base32Decode, newSecret, codeAt, stepOf, verify, otpauthUri };
