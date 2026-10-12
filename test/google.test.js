const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createGoogleVerifier } = require('../lib/google');
const { createStore } = require('../lib/db');
const { createAuth } = require('../lib/auth');

const CLIENT = '1234-abc.apps.googleusercontent.com';
const NOW = Date.parse('2026-10-11T12:00:00Z');
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (k, kid) => ({ ...k.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });

function mint(payload, { key = privateKey, kid = 'k1', alg = 'RS256', sig } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' }), body = b64({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '42', email: 'Maya@Gmail.com', email_verified: true, name: 'Maya', iat: NOW / 1000 - 10, exp: NOW / 1000 + 3000, ...payload });
  const signature = sig ?? crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${signature}`;
}
function verifier(over = {}) {
  let fetches = 0;
  const v = createGoogleVerifier({ clientId: CLIENT, now: () => NOW, fetchJwks: async () => { fetches++; return { keys: [jwk({ publicKey }, 'k1')], maxAgeSec: 3600 }; }, ...over });
  return { v, fetches: () => fetches };
}
const rejects = (p, re) => assert.rejects(p, re);

test('a genuine token is accepted and the email is lowercased', async () => {
  const g = await verifier().v.verify(mint({}));
  assert.equal(g.email, 'maya@gmail.com'); assert.equal(g.sub, '42');
});
test('a token signed by anyone but Google is refused', async () => {
  await rejects(verifier().v.verify(mint({}, { key: other.privateKey })), /signature/);              // forged with a different key
  await rejects(verifier().v.verify(mint({}, { sig: 'AAAA' })), /signature/);
});
test('a token altered after signing is refused', async () => {
  const t = mint({}).split('.'); t[1] = b64({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '42', email: 'victim@gmail.com', email_verified: true, exp: NOW / 1000 + 3000 });
  await rejects(verifier().v.verify(t.join('.')), /signature/);
});
test('the "none" and shared-secret algorithm tricks are refused', async () => {
  const body = b64({ iss: 'accounts.google.com', aud: CLIENT, email: 'a@b.com', email_verified: true, exp: NOW / 1000 + 100 });
  await rejects(verifier().v.verify(`${b64({ alg: 'none', typ: 'JWT' })}.${body}.`), /algorithm|malformed/);
  await rejects(verifier().v.verify(mint({}, { alg: 'HS256' })), /algorithm/);
});
test('a token made for a different site, wrong issuer, expired, or from the future is refused', async () => {
  const { v } = verifier();
  await rejects(v.verify(mint({ aud: 'someone-else.apps.googleusercontent.com' })), /different site/);
  await rejects(v.verify(mint({ iss: 'https://evil.example' })), /issuer/);
  await rejects(v.verify(mint({ exp: NOW / 1000 - 1 })), /expired/);
  await rejects(v.verify(mint({ iat: NOW / 1000 + 3600 })), /future/);
  assert.ok(await v.verify(mint({ iss: 'accounts.google.com' })));                                 // Google's two valid spellings
});
test('an email Google has not verified, or a token with no email, is refused', async () => {
  const { v } = verifier();
  await rejects(v.verify(mint({ email_verified: false })), /verified/);
  await rejects(v.verify(mint({ email: undefined })), /email/);
  assert.ok(await v.verify(mint({ email_verified: 'true' })));
});
test('garbage input is refused cleanly', async () => {
  const { v } = verifier();
  for (const bad of [undefined, null, '', 'a.b', 'a.b.c.d', 'x'.repeat(5000), 42, {}, '!!!.???.***']) await rejects(v.verify(bad), /malformed|algorithm/);
  await rejects(createGoogleVerifier({ clientId: '', fetchJwks: async () => ({ keys: [] }) }).verify(mint({})), /not configured/);
});
test('keys are cached, and an unknown key id triggers one refresh at most per minute', async () => {
  const k = verifier();
  await k.v.verify(mint({})); await k.v.verify(mint({}));
  assert.equal(k.fetches(), 1);                                                                    // cached
  await rejects(k.v.verify(mint({}, { kid: 'rotated' })), /unknown signing key/);
  assert.equal(k.fetches(), 2);                                                                    // refreshed once to look for the new key
  await rejects(k.v.verify(mint({}, { kid: 'rotated2' })), /unknown signing key/);
  assert.equal(k.fetches(), 2);                                                                    // not again within a minute: bad tokens cannot hammer Google
});

// ── what happens after a verified token ──
function world(opts = {}) {
  const store = createStore({ dbPath: ':memory:' });
  return { store, auth: createAuth({ store, send: async () => {}, now: () => NOW, adminEmail: opts.admin }) };
}
test('a new Google user must confirm 21+, then gets an account and a session', () => {
  const { auth, store } = world();
  const no = auth.signInVerified({ email: 'maya@gmail.com', ageConfirmed: false });
  assert.equal(no.status, 400); assert.equal(no.code, 'age_required'); assert.equal(store.countUsers(), 0);
  const yes = auth.signInVerified({ email: 'maya@gmail.com', ageConfirmed: true });
  assert.equal(yes.status, 200); assert.equal(yes.created, true);
  assert.equal(auth.userFromCookieHeader(`winai_sid=${yes.sessionToken}`).email, 'maya@gmail.com');
});
test('Google and email sign-in reach the same account for the same address', () => {
  const { auth, store } = world();
  const a = auth.signInVerified({ email: 'maya@gmail.com', ageConfirmed: true });
  const b = auth.signInVerified({ email: 'MAYA@gmail.com', ageConfirmed: false });                 // returning: no age box needed
  assert.equal(b.created, false); assert.equal(b.user.id, a.user.id); assert.equal(store.countUsers(), 1);
});
test('a turned-off account cannot get in through Google', () => {
  const { auth, store } = world();
  const a = auth.signInVerified({ email: 'maya@gmail.com', ageConfirmed: true }); store.setUserDisabled(a.user.id, true);
  assert.equal(auth.signInVerified({ email: 'maya@gmail.com' }).status, 403);
});
test('the admin account claims the older props through Google too', () => {
  const { auth, store } = world({ admin: 'admin@gmail.com' });
  store.writePick({ id: 1, player: 'old' });
  assert.equal(auth.signInVerified({ email: 'admin@gmail.com', ageConfirmed: true }).claimed, 1);
});

test('the verifier hands back the nonce so the redirect flow can tie the note to the sign-in that asked for it', async () => {
  const g = await verifier().v.verify(mint({ nonce: 'abc123' }));
  assert.equal(g.nonce, 'abc123');
  assert.equal((await verifier().v.verify(mint({}))).nonce, null);
});
