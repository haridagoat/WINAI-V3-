const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../lib/db');
const A = require('../lib/auth');
const P = require('../lib/passwords');

const HOUR = 3600 * 1000, BASE = 'https://winai.test', PW = 'bluejay-sunrise-42';
function setup(opts = {}) {
  const store = createStore({ dbPath: ':memory:' });
  let t = Date.parse('2026-10-10T12:00:00Z');
  const sent = [];
  const auth = A.createAuth({ store, now: () => t, adminEmail: opts.adminEmail, devLinks: !!opts.devLinks, extraBlocked: opts.extraBlocked || [],
    send: async m => { if (opts.failSend) throw new Error('mail down'); sent.push(m); } });
  const tokenOf = m => new URL(m.link).searchParams.get('t');
  const cookie = r => `${A.COOKIE}=${r.sessionToken}`;
  const signUp = (over = {}) => auth.signUp({ name: 'Maya', email: 'maya@example.com', password: PW, ageConfirmed: true, baseUrl: BASE, ...over });
  return { store, auth, sent, tokenOf, cookie, signUp, advance: ms => { t += ms; } };
}

// ── email rules ──
test('emails are trimmed, lowercased and checked', () => {
  assert.equal(A.normalizeEmail('  Maya@Example.COM ').email, 'maya@example.com');
  for (const bad of ['', 'no-at', 'a@b', 'a b@c.com', '<x>@y.com', 'a@@b.com', 'a@b.c', 'x'.repeat(250) + '@e.com', 42, null]) assert.ok(A.normalizeEmail(bad).error, String(bad));
});

// ── sign up ──
test('sign up needs a first name, a real email, a good password and the 21+ box, and creates nothing otherwise', async () => {
  const w = setup();
  const cases = [[{ name: '  ' }, 'name'], [{ email: 'nope' }, 'email'], [{ email: 'x@mailinator.com' }, 'email'], [{ password: 'short' }, 'password'], [{ password: 'password123' }, 'password'],
    [{ password: 'maya-is-great-2026' }, 'password'], [{ password: undefined }, 'password'], [{ ageConfirmed: false }, 'age'], [{ ageConfirmed: 'yes' }, 'age']];
  for (const [over, field] of cases) { const r = await w.signUp(over); assert.equal(r.status, 400, JSON.stringify(over)); assert.equal(r.field, field, JSON.stringify(over)); }
  assert.equal(w.store.countUsers(), 0); assert.equal(w.sent.length, 0);
});
test('a good sign up creates the account, stores only a hash, and signs the person in', async () => {
  const w = setup();
  const r = await w.signUp();
  assert.equal(r.status, 200); assert.equal(r.created, true); assert.equal(r.user.name, 'Maya'); assert.equal(r.user.email_verified_at, null);
  assert.equal(w.auth.userFromCookieHeader(w.cookie(r)).email, 'maya@example.com');
  const row = w.store.userWithHashByEmail('maya@example.com');
  assert.match(row.password_hash, /^scrypt\$/); assert.ok(!row.password_hash.includes(PW));
  assert.equal(await P.verifyPassword(PW, row.password_hash), true);
});
test('the confirmation email goes out only after sign up, to that address, with the name', async () => {
  const w = setup();
  assert.equal(w.sent.length, 0);
  await w.signUp({ name: '  Maya  ', email: 'Maya@Example.com' });
  assert.equal(w.sent.length, 1);
  const m = w.sent[0];
  assert.equal(m.purpose, 'confirm'); assert.equal(m.to, 'maya@example.com'); assert.equal(m.name, 'Maya');
  assert.match(m.link, /^https:\/\/winai\.test\/auth\/confirm\?t=[A-Za-z0-9_-]{43}$/);
});
test('with no mail setup the account still works, and the missing email is reported', async () => {
  const w = setup();
  const noBase = await w.signUp({ baseUrl: null });
  assert.equal(noBase.status, 200); assert.equal(noBase.emailSent, false); assert.equal(w.sent.length, 0);
  const w2 = setup({ failSend: true });
  const failed = await w2.signUp();
  assert.equal(failed.status, 200); assert.equal(failed.emailSent, false); assert.equal(w2.store.countUsers(), 1);   // a mail outage never blocks sign-up
});
test('a taken email says so, case-insensitively, and does not touch the existing account', async () => {
  const w = setup();
  await w.signUp();
  const r = await w.signUp({ email: 'MAYA@example.com', name: 'Someone', password: 'a-different-password-9' });
  assert.equal(r.status, 409); assert.equal(r.code, 'email_taken'); assert.equal(r.error, 'Email is already taken'); assert.equal(r.field, 'email');
  assert.equal(w.store.countUsers(), 1);
  assert.equal((await w.auth.signIn({ email: 'maya@example.com', password: PW })).status, 200);                 // still the first person's password
  assert.equal((await w.auth.signIn({ email: 'maya@example.com', password: 'a-different-password-9' })).status, 401);
});
test('the dev link is only returned when dev links are on', async () => {
  assert.equal((await setup().signUp()).devLink, undefined);
  assert.match((await setup({ devLinks: true }).signUp()).devLink, /\/auth\/confirm\?t=/);
});

// ── sign in ──
test('the right password signs in; wrong email and wrong password get the same answer', async () => {
  const w = setup();
  await w.signUp();
  const ok = await w.auth.signIn({ email: ' MAYA@example.com ', password: PW });
  assert.equal(ok.status, 200); assert.equal(w.auth.userFromCookieHeader(w.cookie(ok)).email, 'maya@example.com');
  const wrongPw = await w.auth.signIn({ email: 'maya@example.com', password: 'nope-nope-nope-1' });
  const wrongEmail = await w.auth.signIn({ email: 'ghost@example.com', password: PW });
  assert.deepEqual(wrongPw, wrongEmail);
  assert.equal(wrongPw.status, 401); assert.equal(wrongPw.error, "That email and password don't match.");
});
test('odd input is refused the same way and never throws', async () => {
  const w = setup(); await w.signUp();
  for (const body of [{}, { email: 'maya@example.com' }, { email: { $ne: 1 }, password: PW }, { email: 'maya@example.com', password: { $ne: 1 } }, { email: 'maya@example.com', password: 'x'.repeat(5000) }, { email: '', password: '' }])
    assert.equal((await w.auth.signIn(body)).status, 401, JSON.stringify(body).slice(0, 60));
});
test('an account made with Google has no password, and a password sign in just fails the usual way', async () => {
  const w = setup(); w.auth.signInVerified({ email: 'gina@gmail.com', name: 'Gina', ageConfirmed: true });
  assert.deepEqual(await w.auth.signIn({ email: 'gina@gmail.com', password: PW }), { status: 401, error: "That email and password don't match." });
});
test('five wrong tries pause that address for 15 minutes, even for the right password, and then it frees up', async () => {
  const w = setup(); await w.signUp();
  for (let i = 0; i < 4; i++) assert.equal((await w.auth.signIn({ email: 'maya@example.com', password: 'wrong-wrong-' + i })).status, 401);
  const fifth = await w.auth.signIn({ email: 'maya@example.com', password: 'wrong-wrong-5' });
  assert.equal(fifth.status, 429); assert.equal(fifth.locked, true); assert.match(fifth.error, /15 minutes/);
  assert.equal((await w.auth.signIn({ email: 'maya@example.com', password: PW })).status, 429);          // locked out, even with the right one
  w.advance(16 * 60 * 1000);
  assert.equal((await w.auth.signIn({ email: 'maya@example.com', password: PW })).status, 200);
});
test('an address with no account is paused the same way, so the pause tells nothing', async () => {
  const w = setup();
  const results = []; for (let i = 0; i < 6; i++) results.push((await w.auth.signIn({ email: 'ghost@example.com', password: 'wrong-wrong-' + i })).status);
  assert.deepEqual(results, [401, 401, 401, 401, 429, 429]);
});
test('a good sign in clears the count of wrong tries', async () => {
  const w = setup(); await w.signUp();
  for (let i = 0; i < 3; i++) await w.auth.signIn({ email: 'maya@example.com', password: 'wrong-wrong-' + i });
  assert.equal((await w.auth.signIn({ email: 'maya@example.com', password: PW })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await w.auth.signIn({ email: 'maya@example.com', password: 'wrong-again-' + i })).status, 401);   // counting started over
});
test('a turned-off account cannot sign in, and is only told so after the right password', async () => {
  const w = setup(); const r = await w.signUp(); w.store.setUserDisabled(r.user.id, true);
  assert.equal((await w.auth.signIn({ email: 'maya@example.com', password: 'wrong-wrong-1' })).status, 401);
  const ok = await w.auth.signIn({ email: 'maya@example.com', password: PW });
  assert.equal(ok.status, 403); assert.equal(w.auth.userFromCookieHeader(`${A.COOKIE}=whatever`), null);
});
test('sessions last 30 days, and signing out ends one', async () => {
  const w = setup(); const r = await w.signUp();
  assert.ok(w.auth.userFromCookieHeader(w.cookie(r)));
  w.auth.logout(w.cookie(r));
  assert.equal(w.auth.userFromCookieHeader(w.cookie(r)), null);
  const r2 = await w.auth.signIn({ email: 'maya@example.com', password: PW });
  w.advance(31 * 24 * HOUR);
  assert.equal(w.auth.userFromCookieHeader(w.cookie(r2)), null);
});

// ── confirming the email ──
test('the confirmation link confirms the address once, and only that address', async () => {
  const w = setup(); await w.signUp();
  assert.equal(w.store.userByEmail('maya@example.com').email_verified_at, null);
  const t = w.tokenOf(w.sent[0]);
  const r = w.auth.confirmEmail({ token: t });
  assert.equal(r.status, 200); assert.ok(w.store.userByEmail('maya@example.com').email_verified_at);
  assert.equal(w.auth.confirmEmail({ token: t }).status, 400);                                    // single use
});
test('a confirmation link expires after 24 hours, and bad tokens are refused', async () => {
  const w = setup(); await w.signUp();
  const t = w.tokenOf(w.sent[0]);
  w.advance(25 * HOUR);
  assert.equal(w.auth.confirmEmail({ token: t }).status, 400);
  for (const bad of [undefined, null, '', 'short', 'x'.repeat(43), 'a'.repeat(44), { $ne: 1 }, "' OR 1=1 --"]) assert.equal(w.auth.confirmEmail({ token: bad }).status, 400);
});
test('a link for one purpose cannot be used for another', async () => {
  const w = setup(); await w.signUp();
  const confirmToken = w.tokenOf(w.sent[0]);
  assert.equal((await w.auth.resetPassword({ token: confirmToken, password: 'another-good-pass-7' })).status, 400);        // a confirmation link is not a reset link
  await w.auth.requestReset({ email: 'maya@example.com', baseUrl: BASE });
  const resetToken = w.tokenOf(w.sent[1]);
  assert.equal(w.auth.confirmEmail({ token: resetToken }).status, 400);                                                    // and a reset link does not confirm
  assert.equal(w.store.userByEmail('maya@example.com').email_verified_at, null);
});
test('the confirmation email can be sent again, a few times an hour', async () => {
  const w = setup(); const r = await w.signUp();
  const out = []; for (let i = 0; i < 4; i++) out.push((await w.auth.resendConfirmation(r.user, { baseUrl: BASE })).status);
  assert.deepEqual(out, [200, 200, 429, 429]);                                                    // the sign-up email counts as the first of three
  w.advance(HOUR + 1000);
  assert.equal((await w.auth.resendConfirmation(r.user, { baseUrl: BASE })).status, 200);
  assert.equal((await w.auth.resendConfirmation(r.user, { baseUrl: null })).status, 503);
  w.auth.confirmEmail({ token: w.tokenOf(w.sent.at(-1)) });
  assert.equal((await w.auth.resendConfirmation(w.store.userById(r.user.id), { baseUrl: BASE })).alreadyConfirmed, true);
});

// ── forgot and reset ──
test('asking for a reset answers the same for any address, and emails only a real account', async () => {
  const w = setup(); await w.signUp(); w.sent.length = 0;
  const real = await w.auth.requestReset({ email: 'maya@example.com', baseUrl: BASE });
  const ghost = await w.auth.requestReset({ email: 'ghost@example.com', baseUrl: BASE });
  assert.deepEqual(real, ghost);                                                                  // nothing tells them apart
  assert.equal(w.sent.length, 1); assert.equal(w.sent[0].purpose, 'reset'); assert.equal(w.sent[0].to, 'maya@example.com');
  assert.match(w.sent[0].link, /\/auth\/reset\?t=/);
  assert.equal((await w.auth.requestReset({ email: 'not an email' })).status, 400);
});
test('at most 3 reset emails an hour per address, silently', async () => {
  const w = setup(); await w.signUp(); w.sent.length = 0;
  const statuses = []; for (let i = 0; i < 5; i++) statuses.push((await w.auth.requestReset({ email: 'maya@example.com', baseUrl: BASE })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200]); assert.equal(w.sent.length, 3);
});
test('a turned-off account is sent no reset email', async () => {
  const w = setup(); const r = await w.signUp(); w.store.setUserDisabled(r.user.id, true); w.sent.length = 0;
  await w.auth.requestReset({ email: 'maya@example.com', baseUrl: BASE });
  assert.equal(w.sent.length, 0);
});
test('using a reset link sets the new password, signs everyone else out and signs this device in', async () => {
  const w = setup(); const first = await w.signUp(); w.sent.length = 0;
  await w.auth.requestReset({ email: 'maya@example.com', baseUrl: BASE });
  const res = await w.auth.resetPassword({ token: w.tokenOf(w.sent[0]), password: 'a-brand-new-pass-77' });
  assert.equal(res.status, 200);
  assert.equal(w.auth.userFromCookieHeader(w.cookie(first)), null);                               // the old session is gone
  assert.ok(w.auth.userFromCookieHeader(w.cookie(res)));                                          // this one works
  assert.equal((await w.auth.signIn({ email: 'maya@example.com', password: PW })).status, 401);   // the old password is dead
  assert.equal((await w.auth.signIn({ email: 'maya@example.com', password: 'a-brand-new-pass-77' })).status, 200);
  assert.ok(w.store.userByEmail('maya@example.com').email_verified_at);                           // the link went to that mailbox
});
test('a reset link works once and expires after 30 minutes', async () => {
  const w = setup(); await w.signUp(); w.sent.length = 0;
  await w.auth.requestReset({ email: 'maya@example.com', baseUrl: BASE });
  const t = w.tokenOf(w.sent[0]);
  assert.equal((await w.auth.resetPassword({ token: t, password: 'a-brand-new-pass-77' })).status, 200);
  assert.equal((await w.auth.resetPassword({ token: t, password: 'yet-another-pass-88' })).status, 400);
  await w.auth.requestReset({ email: 'maya@example.com', baseUrl: BASE });
  const t2 = w.tokenOf(w.sent.at(-1));
  w.advance(31 * 60 * 1000);
  assert.equal((await w.auth.resetPassword({ token: t2, password: 'yet-another-pass-88' })).status, 400);
});
test('a too-weak new password is refused without using up the link', async () => {
  const w = setup(); await w.signUp(); w.sent.length = 0;
  await w.auth.requestReset({ email: 'maya@example.com', baseUrl: BASE });
  const t = w.tokenOf(w.sent[0]);
  for (const weak of ['short', 'password123', 'maya-is-great-2026']) { const r = await w.auth.resetPassword({ token: t, password: weak }); assert.equal(r.status, 400); assert.equal(r.field, 'password'); }
  assert.equal((await w.auth.resetPassword({ token: t, password: 'a-brand-new-pass-77' })).status, 200);   // the same link still works
});
test('a reset also lifts a pause caused by wrong tries', async () => {
  const w = setup(); await w.signUp(); w.sent.length = 0;
  for (let i = 0; i < 5; i++) await w.auth.signIn({ email: 'maya@example.com', password: 'wrong-wrong-' + i });
  assert.equal((await w.auth.signIn({ email: 'maya@example.com', password: PW })).status, 429);
  await w.auth.requestReset({ email: 'maya@example.com', baseUrl: BASE });
  await w.auth.resetPassword({ token: w.tokenOf(w.sent[0]), password: 'a-brand-new-pass-77' });
  assert.equal((await w.auth.signIn({ email: 'maya@example.com', password: 'a-brand-new-pass-77' })).status, 200);
});

// ── someone signs up with another person's address ──
test('a password set by a stranger for an unconfirmed address is thrown away when the real owner signs in with Google', async () => {
  const w = setup();
  const attacker = await w.signUp({ name: 'Eve', email: 'victim@gmail.com', password: 'eve-knows-this-one-1' });      // never confirmed
  const real = w.auth.signInVerified({ email: 'victim@gmail.com', name: 'Vic', ageConfirmed: true });
  assert.equal(real.status, 200); assert.equal(real.created, false);
  assert.equal(w.auth.userFromCookieHeader(w.cookie(attacker)), null);                                                 // the stranger is signed out
  assert.equal((await w.auth.signIn({ email: 'victim@gmail.com', password: 'eve-knows-this-one-1' })).status, 401);      // and their password no longer works
  assert.ok(w.store.userByEmail('victim@gmail.com').email_verified_at);
});
test('a confirmed password account is left alone when the same person also uses Google', async () => {
  const w = setup(); await w.signUp({ email: 'maya@gmail.com' });
  w.auth.confirmEmail({ token: w.tokenOf(w.sent[0]) });
  w.auth.signInVerified({ email: 'maya@gmail.com', ageConfirmed: false });
  assert.equal((await w.auth.signIn({ email: 'maya@gmail.com', password: PW })).status, 200);                           // the password still works
});
test('the real owner resetting the password also removes the stranger', async () => {
  const w = setup();
  const attacker = await w.signUp({ name: 'Eve', email: 'victim@example.com', password: 'eve-knows-this-one-1' }); w.sent.length = 0;
  await w.auth.requestReset({ email: 'victim@example.com', baseUrl: BASE });          // the link goes to the real owner's mailbox
  await w.auth.resetPassword({ token: w.tokenOf(w.sent[0]), password: 'owners-own-password-5' });
  assert.equal(w.auth.userFromCookieHeader(w.cookie(attacker)), null);
  assert.equal((await w.auth.signIn({ email: 'victim@example.com', password: 'eve-knows-this-one-1' })).status, 401);
});

// ── Google ──
test('a new Google user must confirm 21+, then gets a confirmed account with their name', () => {
  const w = setup();
  const no = w.auth.signInVerified({ email: 'gina@gmail.com', name: 'Gina Lopez', ageConfirmed: false });
  assert.equal(no.status, 400); assert.equal(no.code, 'age_required'); assert.equal(w.store.countUsers(), 0);
  const yes = w.auth.signInVerified({ email: 'gina@gmail.com', name: 'Gina Lopez', ageConfirmed: true });
  assert.equal(yes.status, 200); assert.equal(yes.created, true); assert.equal(yes.user.name, 'Gina Lopez'); assert.ok(yes.user.email_verified_at);
});
test('Google and password sign in reach the same account for the same address', async () => {
  const w = setup();
  const a = w.auth.signInVerified({ email: 'maya@gmail.com', ageConfirmed: true });
  const b = w.auth.signInVerified({ email: 'MAYA@gmail.com', ageConfirmed: false });
  assert.equal(b.created, false); assert.equal(b.user.id, a.user.id);
  const taken = await w.signUp({ email: 'maya@gmail.com' });
  assert.equal(taken.code, 'email_taken');
});
test('a turned-off account cannot get in through Google', () => {
  const w = setup(); const a = w.auth.signInVerified({ email: 'maya@gmail.com', ageConfirmed: true }); w.store.setUserDisabled(a.user.id, true);
  assert.equal(w.auth.signInVerified({ email: 'maya@gmail.com' }).status, 403);
});

// ── ownership ──
test('every user sees only their own props; system picks have no owner', async () => {
  const w = setup();
  const a = (await w.signUp({ email: 'a@example.com' })).user, b = (await w.signUp({ email: 'b@example.com' })).user;
  w.store.writePick({ id: 1, player: 'A1', userId: a.id }); w.store.writePick({ id: 2, player: 'A2', userId: a.id });
  w.store.writePick({ id: 3, player: 'B1', userId: b.id }); w.store.writePick({ id: 4, player: 'SYS', source: 'auto' });
  assert.deepEqual(w.store.picksForUser(a.id).map(p => p.id), [2, 1]);
  assert.deepEqual(w.store.picksForUser(b.id).map(p => p.id), [3]);
  assert.deepEqual(w.store.systemPicks().map(p => p.id), [4]);
});
test('the whole-list save used by background jobs keeps owners intact', () => {
  const { store } = setup();
  store.writePick({ id: 1, player: 'A1', userId: 7, result: null });
  const all = store.loadPicks(); all[0].result = 'WIN';
  store.savePicks(all);
  assert.equal(store.picksForUser(7)[0].result, 'WIN');
});
test('older props with no owner go to the admin account the first time it signs in, once', async () => {
  const w = setup({ adminEmail: 'Admin@Example.com' });
  w.store.writePick({ id: 1, player: 'old manual' }); w.store.writePick({ id: 2, player: 'sys', source: 'auto' });
  const other = await w.signUp({ email: 'someone@example.com' });
  assert.equal(other.claimed, 0); assert.equal(w.store.countUnclaimedPicks(), 1);
  const admin = await w.signUp({ email: 'admin@example.com' });
  assert.equal(admin.claimed, 1); assert.equal(w.store.getPick(1).userId, admin.user.id);
  assert.equal(w.store.getPick(2).userId, undefined); assert.equal(w.store.countUnclaimedPicks(), 0);
});
test('deleting an account removes the person, their props and their links, and nobody else', async () => {
  const w = setup();
  const a = await w.signUp({ email: 'a@example.com' }), b = await w.signUp({ email: 'b@example.com' });
  w.store.writePick({ id: 1, userId: a.user.id }); w.store.writePick({ id: 2, userId: b.user.id }); w.store.writePick({ id: 3, source: 'auto' });
  assert.deepEqual(w.store.deleteUser(a.user.id), { deleted: true, props: 1 });
  assert.equal(w.store.userByEmail('a@example.com'), null);
  assert.equal(w.auth.userFromCookieHeader(w.cookie(a)), null);
  assert.equal((await w.auth.signIn({ email: 'a@example.com', password: PW })).status, 401);
  assert.deepEqual(w.store.loadPicks().map(p => p.id).sort(), [2, 3]);
  assert.equal((await w.signUp({ email: 'a@example.com' })).status, 200);                         // the address can be used again
});
test('the password hash never appears in the user records handed around', async () => {
  const w = setup(); const r = await w.signUp();
  for (const u of [r.user, w.store.userByEmail('maya@example.com'), w.store.userById(r.user.id), w.auth.userFromCookieHeader(w.cookie(r)), w.store.listUsers()[0]]) {
    assert.ok(!('password_hash' in u)); assert.ok(!JSON.stringify(u).includes('scrypt'));
  }
});

// ── cookies and masks ──
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
