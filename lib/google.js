// Sign in with Google. The browser gets a signed ID token from Google's own button; this file checks that the
// token really came from Google, was issued for THIS site (the client id), has not expired, and carries an email
// Google has verified. Nothing is trusted from the browser: the signature is checked against Google's published
// public keys. No Google secret is needed, only the public client id.
const crypto = require('crypto');

const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const b64 = s => Buffer.from(s, 'base64url');

// `fetchJwks()` returns { keys: [...], maxAgeSec } (Google's public keys and how long to keep them).
function createGoogleVerifier({ clientId, fetchJwks, now = () => Date.now() }) {
  let cache = { keys: null, exp: 0 }, lastForced = 0;
  async function getKeys(force) {
    if (!force && cache.keys && now() < cache.exp) return cache.keys;
    const { keys, maxAgeSec } = await fetchJwks();
    cache = { keys, exp: now() + Math.max(60, Math.min(maxAgeSec || 3600, 24 * 3600)) * 1000 };
    return keys;
  }
  return {
    async verify(idToken) {
      if (!clientId) throw new Error('Google sign-in is not configured');
      if (typeof idToken !== 'string' || idToken.length > 4096) throw new Error('malformed token');
      const parts = idToken.split('.');
      if (parts.length !== 3) throw new Error('malformed token');
      let header, payload;
      try { header = JSON.parse(b64(parts[0]).toString('utf8')); payload = JSON.parse(b64(parts[1]).toString('utf8')); } catch (_) { throw new Error('malformed token'); }
      if (header.alg !== 'RS256') throw new Error('unsupported algorithm');          // never accept "none" or a shared-secret algorithm
      let jwk = (await getKeys(false)).find(k => k.kid === header.kid);
      // An unknown key id may mean Google rotated keys. Refetch, but at most once a minute so a flood of bad
      // tokens cannot be used to hammer Google.
      if (!jwk && now() - lastForced > 60000) { lastForced = now(); jwk = (await getKeys(true)).find(k => k.kid === header.kid); }
      if (!jwk) throw new Error('unknown signing key');
      let ok = false;
      try { ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), b64(parts[2])); } catch (_) { ok = false; }
      if (!ok) throw new Error('signature does not match');
      const t = now() / 1000;
      if (!ISSUERS.has(payload.iss)) throw new Error('wrong issuer');
      if (payload.aud !== clientId) throw new Error('token was issued for a different site');
      if (typeof payload.exp !== 'number' || payload.exp <= t) throw new Error('token has expired');
      if (typeof payload.iat === 'number' && payload.iat > t + 300) throw new Error('token is from the future');
      if (typeof payload.email !== 'string' || !payload.email) throw new Error('no email in token');
      if (payload.email_verified !== true && payload.email_verified !== 'true') throw new Error('Google has not verified this email');
      return { email: payload.email.toLowerCase(), sub: String(payload.sub || ''), name: typeof payload.name === 'string' ? payload.name.slice(0, 80) : '' };
    },
  };
}
module.exports = { createGoogleVerifier };
