const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../lib/db');
const A = require('../lib/auth');

const HOUR = 3600 * 1000;
function setup(opts = {}) {
  const store = createStore({ dbPath: ':memory:' });
  let t = Date.parse('2026-10-10T12:00:00Z');
  const sent = [];
  const auth = A.createAuth({ store, now: () => t, send: async m => { if (opts.failSend) throw new Error('smtp down'); sent.push(m); }, adminEmail: opts.adminEmail, devLinks: !!opts.devLinks });
  return { store, auth, sent, advance: ms => { t += ms; }, tokenFrom: m => new URL(m.link).searchParams.get('t') };
}
const req = (auth, email, extra = {}) => auth.requestLink({ email, ageConfirmed: true, baseUrl: 'https://winai.test', ...extra });

// ── email rules ──
test('emails are trimmed, lowercased and checked', () => {
  assert.equal(A.normalizeEmail('  Maya@Example.COM ').email, 'maya@example.com');
  for (const bad of ['', 'no-at', 'a@b', 'a b@c.com', '<x>@y.com', 'a@@b.com', 'a@b.c', 'x'.repeat(250) + '@e.com', 42, null]) assert.ok(A.normalizeEmail(bad).error, String(bad));
});
test('throwaway providers and extra blocked domains are refused', async () => {
  const { auth, sent } = setup();
  assert.equal((await req(auth, 'x@mailinator.com')).status, 400);
  assert.equal(sent.length, 0);
  const s2 = setup(); const a2 = A.createAuth({ store: s2.store, send: async () => {}, extraBlocked: ['evil.test'] });
  assert.equal((await a2.requestLink({ email: 'a@evil.test', ageConfirmed: true, baseUrl: 'x' })).status, 400);
});

// ── requesting a link ──
test('a new address must confirm it is 21+, and nothing is created by asking', async () => {
  const { auth, store, sent } = setup();
  const r = await auth.requestLink({ email: 'new@example.com', ageConfirmed: false, baseUrl: 'https://winai.test' });
  assert.equal(r.status, 400); assert.match(r.error, /21/);
  assert.equal(sent.length, 0);
  assert.equal((await req(auth, 'new@example.com')).status, 200);
  assert.equal(store.countUsers(), 0);          // an account only exists once the link is used
});
test('the emailed link is built from the server address, never from the request', async () => {
  const { auth, sent } = setup();
  await req(auth, 'a@example.com', { baseUrl: 'https://winai.test' });
  assert.match(sent[0].link, /^https:\/\/winai\.test\/auth\/verify\?t=[A-Za-z0-9_-]{43}$/);
});
test('the dev link is only returned when dev links are on', async () => {
  assert.equal((await req(setup().auth, 'a@example.com')).devLink, undefined);
  assert.match((await req(setup({ devLinks: true }).auth, 'a@example.com')).devLink, /\/auth\/verify\?t=/);
});
test('at most 5 links per address per hour, then it frees up', async () => {
  const { auth, advance } = setup();
  for (let i = 0; i < 5; i++) assert.equal((await req(auth, 'a@example.com')).status, 200);
  assert.equal((await req(auth, 'a@example.com')).status, 429);
  assert.equal((await req(auth, 'b@example.com')).status, 200);   // other addresses are unaffected
  advance(HOUR + 1000);
  assert.equal((await req(auth, 'a@example.com')).status, 200);
});
test('a failed send is reported and does not claim success', async () => {
  const r = await req(setup({ failSend: true }).auth, 'a@example.com');
  assert.equal(r.status, 502);
});

// ── using a link ──
test('a link works once, creates the account, and starts a session', async () => {
  const { auth, store, sent, tokenFrom } = setup();
  await req(auth, 'Maya@Example.com');
  const token = tokenFrom(sent[0]);
  const v = auth.verifyLink(token);
  assert.equal(v.status, 200); assert.equal(v.created, true); assert.equal(v.user.email, 'maya@example.com');
  assert.equal(store.countUsers(), 1);
  assert.equal(auth.verifyLink(token).status, 400);                       // second use refused
  const u = auth.userFromCookieHeader(`x=1; ${A.COOKIE}=${v.sessionToken}`);
  assert.equal(u.email, 'maya@example.com');
});
test('links expire after 15 minutes', async () => {
  const { auth, sent, tokenFrom, advance } = setup();
  await req(auth, 'a@example.com');
  advance(16 * 60 * 1000);
  assert.match(auth.verifyLink(tokenFrom(sent[0])).error, /expired/);
});
test('malformed or unknown tokens are refused without touching the database', () => {
  const { auth } = setup();
  for (const t of [undefined, null, '', 'short', 'x'.repeat(43), 'a'.repeat(44), { $ne: 1 }, "' OR 1=1 --"]) assert.equal(auth.verifyLink(t).status, 400);
});
test('a returning user does not create a second account', async () => {
  const { auth, store, sent, tokenFrom } = setup();
  await req(auth, 'a@example.com'); auth.verifyLink(tokenFrom(sent[0]));
  await auth.requestLink({ email: 'a@example.com', ageConfirmed: false, baseUrl: 'https://winai.test' });   // no age box needed again
  assert.equal(auth.verifyLink(tokenFrom(sent[1])).created, false);
  assert.equal(store.countUsers(), 1);
});
test('a turned-off account gets no email and cannot sign in', async () => {
  const { auth, store, sent, tokenFrom } = setup();
  await req(auth, 'a@example.com'); const v = auth.verifyLink(tokenFrom(sent[0]));
  store.setUserDisabled(v.user.id, true);
  assert.equal(auth.userFromCookieHeader(`${A.COOKIE}=${v.sessionToken}`), null);   // existing session ends at once
  const r = await req(auth, 'a@example.com');
  assert.equal(r.status, 200); assert.equal(sent.length, 1);                        // told "ok", sent nothing
});
test('sessions expire after 30 days and logout ends one', async () => {
  const { auth, sent, tokenFrom, advance } = setup();
  await req(auth, 'a@example.com'); const v = auth.verifyLink(tokenFrom(sent[0]));
  const cookie = `${A.COOKIE}=${v.sessionToken}`;
  assert.ok(auth.userFromCookieHeader(cookie));
  auth.logout(cookie);
  assert.equal(auth.userFromCookieHeader(cookie), null);
  await req(auth, 'a@example.com'); const v2 = auth.verifyLink(tokenFrom(sent[1]));
  advance(31 * 24 * HOUR);
  assert.equal(auth.userFromCookieHeader(`${A.COOKIE}=${v2.sessionToken}`), null);
});
test('stored hashes are not the tokens', async () => {
  const { auth, store, sent, tokenFrom } = setup();
  await req(auth, 'a@example.com'); const token = tokenFrom(sent[0]);
  const when = '2026-10-10T12:01:00.000Z';
  assert.equal(store.consumeLoginToken(token, when), null);               // the raw token is not a key in the table
  assert.ok(store.consumeLoginToken(A.sha(token), when));                 // only its hash is
});

// ── ownership ──
test('every user sees only their own props; system picks have no owner', async () => {
  const { auth, store, sent, tokenFrom } = setup();
  await req(auth, 'a@example.com'); await req(auth, 'b@example.com');
  const a = auth.verifyLink(tokenFrom(sent[0])).user, b = auth.verifyLink(tokenFrom(sent[1])).user;
  store.writePick({ id: 1, player: 'A1', userId: a.id }); store.writePick({ id: 2, player: 'A2', userId: a.id });
  store.writePick({ id: 3, player: 'B1', userId: b.id }); store.writePick({ id: 4, player: 'SYS', source: 'auto' });
  assert.deepEqual(store.picksForUser(a.id).map(p => p.id), [2, 1]);
  assert.deepEqual(store.picksForUser(b.id).map(p => p.id), [3]);
  assert.deepEqual(store.systemPicks().map(p => p.id), [4]);
  assert.equal(store.countUserPicks(a.id), 2);
});
test('the whole-list save used by background jobs keeps owners intact', () => {
  const { store } = setup();
  store.writePick({ id: 1, player: 'A1', userId: 7, result: null });
  const all = store.loadPicks(); all[0].result = 'WIN';
  store.savePicks(all);
  assert.equal(store.picksForUser(7)[0].result, 'WIN');
});
test('older props with no owner go to the admin account the first time it signs in, once', async () => {
  const { auth, store, sent, tokenFrom } = setup({ adminEmail: 'Admin@Example.com' });
  store.writePick({ id: 1, player: 'old manual' }); store.writePick({ id: 2, player: 'sys', source: 'auto' });
  await req(auth, 'someone@example.com'); const other = auth.verifyLink(tokenFrom(sent[0]));
  assert.equal(other.claimed, 0);
  assert.equal(store.countUnclaimedPicks(), 1);
  await req(auth, 'admin@example.com'); const admin = auth.verifyLink(tokenFrom(sent[1]));
  assert.equal(admin.claimed, 1);
  assert.equal(store.getPick(1).userId, admin.user.id);
  assert.equal(store.getPick(2).userId, undefined);                        // system picks are never claimed
  assert.equal(store.countUnclaimedPicks(), 0);
});
test('deleting an account removes the person and every prop they saved, and nobody else\'s', async () => {
  const { auth, store, sent, tokenFrom } = setup();
  await req(auth, 'a@example.com'); await req(auth, 'b@example.com');
  const a = auth.verifyLink(tokenFrom(sent[0])), b = auth.verifyLink(tokenFrom(sent[1]));
  store.writePick({ id: 1, userId: a.user.id }); store.writePick({ id: 2, userId: b.user.id }); store.writePick({ id: 3, source: 'auto' });
  assert.deepEqual(store.deleteUser(a.user.id), { deleted: true, props: 1 });
  assert.equal(store.userByEmail('a@example.com'), null);
  assert.equal(auth.userFromCookieHeader(`${A.COOKIE}=${a.sessionToken}`), null);
  assert.deepEqual(store.loadPicks().map(p => p.id).sort(), [2, 3]);
  assert.deepEqual(store.deleteUser(a.user.id), { deleted: false, props: 0 });
});

// ── cookies ──
test('the session cookie is HttpOnly and SameSite, and Secure when asked', () => {
  const c = A.sessionCookie('abc', { secure: true });
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Lax/); assert.match(c, /Secure/); assert.match(c, /Max-Age=2592000/);
  assert.doesNotMatch(A.sessionCookie('abc'), /Secure/);
  assert.match(A.clearCookie(), /Max-Age=0/);
});
test('cookie parsing ignores junk and takes the first value of a repeated name', () => {
  assert.deepEqual(A.parseCookies('a=1; b=%E0%A4%A; c=3; a=2'), { a: '1', c: '3' });
  assert.deepEqual(A.parseCookies(undefined), {});
});
test('masked emails hide most of the address', () => {
  assert.equal(A.maskEmail('maya@example.com'), 'm**a@example.com');
  assert.equal(A.maskEmail('jo@example.com'), 'j*@example.com');
  assert.equal(A.maskEmail('a@example.com'), 'a*@example.com');
});
