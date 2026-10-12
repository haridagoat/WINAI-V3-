// Accounts: email and password, plus Google. Pure logic: the store, the mailer and the clock are passed in, so every
// rule here can be tested without a server.
//
// How it stays safe:
//  - Passwords are stored only as salted scrypt hashes (lib/passwords.js). Nobody can read one back.
//  - A wrong email and a wrong password get the same answer and take the same time, so the form cannot be used to
//    find out who has an account. Five wrong tries on one email pause it for 15 minutes.
//  - Nothing is emailed until someone signs up. Then one email confirms the address. A reset email goes out only when
//    someone asks. Both links are random, work once, expire, and are stored only as a hash.
//  - A session is a random token in an HttpOnly cookie; only its hash is stored.
//  - An address nobody has confirmed is not trusted: if its real owner shows up through Google or a reset link, the
//    password someone else may have set for it is thrown away.
const crypto = require('crypto');
const { hashPassword, verifyPassword, burnTime, passwordProblems } = require('./passwords');
const { firstName } = require('./emails');
const { createFailLimiter } = require('./security');

const CONFIRM_TTL_MS = 24 * 3600 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const EMAIL_COOLDOWN_MS = 5 * 60 * 1000;   // one confirmation or reset email per address every 5 minutes
const EMAILS_PER_DAY = 20;                  // and a daily ceiling, so nobody can use the form to flood an inbox
const TOUCH_EVERY_MS = 10 * 60 * 1000;
const COOKIE = 'winai_sid';

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

// Throwaway-mail providers. Extend with BLOCKED_EMAIL_DOMAINS (comma separated).
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'yopmail.com', 'trashmail.com', 'getnada.com', 'throwawaymail.com', 'dispostable.com', 'maildrop.cc', 'fakeinbox.com', 'mintemail.com']);

const EMAIL_SHAPE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return { error: 'Enter your email address.' };
  const email = raw.trim().toLowerCase();
  if (email.length < 5 || email.length > 254 || !EMAIL_SHAPE.test(email) || email.split('@').length !== 2) return { error: 'That does not look like an email address.' };
  return { email };
}

function blockedDomain(email, extra = []) {
  const d = email.split('@')[1];
  return DISPOSABLE.has(d) || extra.includes(d);
}

// For the admin list: enough to tell accounts apart without showing the whole address.
function maskEmail(e) {
  const [a, b] = String(e).split('@');
  return (a.length <= 2 ? a[0] + '*' : a[0] + '*'.repeat(Math.min(4, a.length - 2)) + a.slice(-1)) + '@' + b;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { /* ignore a malformed cookie */ } }
  }
  return out;
}

function sessionCookie(value, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`;
}
const clearCookie = ({ secure = false } = {}) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

const MISMATCH = { status: 401, error: "That email and password don't match." };

// `send({ to, purpose: 'confirm' | 'reset', link, name })` delivers an email (or throws).
function createAuth({ store, send, now = () => Date.now(), adminEmail = '', extraBlocked = [], devLinks = false, log = () => {}, maxFails = 5, lockMs = 15 * 60 * 1000, confirmEmails = true }) {
  const iso = t => new Date(t).toISOString();
  const admin = String(adminEmail || '').trim().toLowerCase();
  // Wrong tries are counted for an address from ONE connection (so a stranger's guesses pause only their own tries, never the
  // real owner's), and also for the address overall at a much higher number, which stops guessing spread across many connections.
  const failsPair = createFailLimiter({ max: maxFails, windowMs: lockMs, now });
  const failsAll = createFailLimiter({ max: maxFails * 5, windowMs: lockMs, now });
  const pairKey = (email, ip) => `${email}|${ip ?? ''}`;
  const isLocked = (email, ip) => failsPair.blocked(pairKey(email, ip)) || failsAll.blocked(email);
  const noteFail = (email, ip) => { failsPair.fail(pairKey(email, ip)); failsAll.fail(email); };
  const clearFails = (email, ip) => { failsPair.ok(pairKey(email, ip)); failsAll.ok(email); };
  const LOCKED = { status: 429, locked: true, error: 'Too many tries. This sign-in is paused for 15 minutes. You can wait, or reset your password now.' };

  // Starts a session for an account that has proved who it is.
  function finish(user, created) {
    if (user.disabled) return { status: 403, error: 'This account is turned off.' };
    // Props saved before accounts existed go to the admin's account, the first time it signs in.
    const claimed = admin && user.email === admin ? store.claimUnclaimedPicks(user.id) : 0;
    const sessionToken = newToken();
    store.addSession({ hash: sha(sessionToken), userId: user.id, createdAt: iso(now()), expiresAt: iso(now() + SESSION_TTL_MS) });
    store.touchUser(user.id, iso(now()));
    store.pruneAuth(iso(now()));
    return { status: 200, ok: true, sessionToken, user: store.userById(user.id), created, claimed };
  }
  // A one-time link for `purpose`. Only its hash is kept.
  function issueToken(email, purpose, ttlMs, ip = null) {
    const token = newToken();
    store.addLoginToken({ hash: sha(token), email, createdAt: iso(now()), expiresAt: iso(now() + ttlMs), purpose, ip });
    return token;
  }
  // Sends one of the account emails. Never throws: a failed send is logged and reported, and the caller carries on.
  async function mail(purpose, email, name, baseUrl, token) {
    const link = `${baseUrl}/auth/${purpose === 'confirm' ? 'confirm' : 'reset'}?t=${token}`;
    try { await send({ to: email, purpose, link, name }); return { sent: true, ...(devLinks ? { devLink: link } : {}) }; }
    catch (err) {
      store.deleteLoginToken(sha(token));            // an email that never left does not count against the limit
      log(`[Auth] could not send the ${purpose} email: ${err.message}`);
      return { sent: false };
    }
  }
  // null when another email may go out now; otherwise how long to wait, or that the daily ceiling is reached.
  function emailGate(email, purpose) {
    const last = store.lastLoginTokenAt(email, purpose);
    if (last) { const left = EMAIL_COOLDOWN_MS - (now() - new Date(last).getTime()); if (left > 0) return { retryAfterSec: Math.ceil(left / 1000) }; }
    if (store.recentLoginTokens(email, iso(now() - 24 * 3600 * 1000), purpose) >= EMAILS_PER_DAY) return { daily: true };
    return null;
  }
  const waitText = sec => (sec >= 90 ? `${Math.ceil(sec / 60)} minutes` : sec > 60 ? 'a minute or two' : 'a minute');
  const problemText = list => `Your password needs: ${list.join(', ')}.`;

  return {
    COOKIE,

    // Create an account and sign the person in. The confirmation email goes out only now, after sign-up.
    async signUp({ name, email: rawEmail, password, ageConfirmed = false, baseUrl = null, ip = null }) {
      const n = normalizeEmail(rawEmail);
      if (n.error) return { status: 400, field: 'email', error: n.error };
      const first = firstName(name);
      if (!first) return { status: 400, field: 'name', error: 'Enter your first name.' };
      if (blockedDomain(n.email, extraBlocked)) return { status: 400, field: 'email', error: 'Please use a regular email address. Throwaway providers are not supported.' };
      if (typeof password !== 'string') return { status: 400, field: 'password', error: 'Choose a password.' };
      const problems = passwordProblems(password, n.email, first);
      if (problems.length) return { status: 400, field: 'password', error: problemText(problems), problems };
      if (ageConfirmed !== true) return { status: 400, field: 'age', code: 'age_required', error: 'Please confirm you are 21 or older to create an account.' };
      if (store.userByEmail(n.email)) return { status: 409, field: 'email', code: 'email_taken', error: 'Email is already taken' };
      const hash = await hashPassword(password);
      let id;
      try { id = store.createUser(n.email, iso(now()), iso(now()), { name: first, passwordHash: hash }); }
      catch (err) {                                                    // two sign-ups for one address at the same moment
        if (/UNIQUE/i.test(err.message)) return { status: 409, field: 'email', code: 'email_taken', error: 'Email is already taken' };
        throw err;
      }
      const r = finish(store.userById(id), true);
      if (r.error) return r;
      const out = { ...r, emailSent: false };
      // With confirmation switched off (EMAIL_CONFIRMATION=off) nothing is emailed: the person is simply signed up and in.
      if (baseUrl && confirmEmails) { const m = await mail('confirm', n.email, first, baseUrl, issueToken(n.email, 'confirm', CONFIRM_TTL_MS, ip)); out.emailSent = m.sent; if (m.devLink) out.devLink = m.devLink; }
      return out;
    },

    async signIn({ email: rawEmail, password, ip = null }) {
      const n = normalizeEmail(rawEmail);
      if (n.error || typeof password !== 'string' || password.length > 256) { await burnTime(typeof password === 'string' ? password.slice(0, 256) : ''); return MISMATCH; }
      // Too many wrong tries on this address pauses it, whether or not it has an account, so the pause tells nothing.
      if (isLocked(n.email, ip)) return LOCKED;
      const row = store.userWithHashByEmail(n.email);
      if (!row || !row.password_hash) { await burnTime(password); noteFail(n.email, ip); return isLocked(n.email, ip) ? LOCKED : MISMATCH; }
      if (!(await verifyPassword(password, row.password_hash))) { noteFail(n.email, ip); return isLocked(n.email, ip) ? LOCKED : MISMATCH; }
      clearFails(n.email, ip);
      return finish(store.userById(row.id), false);                   // finish refuses a turned-off account
    },

    // Always answers the same, so it cannot be used to find out who has an account.
    async requestReset({ email: rawEmail, baseUrl = null, ip = null }) {
      const n = normalizeEmail(rawEmail);
      if (n.error) return { status: 400, error: n.error };
      const ok = { status: 200, ok: true };
      const user = store.userByEmail(n.email);
      if (!user || user.disabled || !baseUrl || emailGate(n.email, 'reset')) return ok;      // too soon after the last one: say nothing, send nothing
      const m = await mail('reset', n.email, user.name, baseUrl, issueToken(n.email, 'reset', RESET_TTL_MS, ip));
      return m.devLink ? { ...ok, devLink: m.devLink } : ok;
    },

    // Using the reset link: sets the new password, signs out every other device, and signs in this one.
    async resetPassword({ token, password, ip = null }) {
      if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return { status: 400, code: 'link_invalid', error: 'This reset link is not valid. Ask for a new one.' };
      if (typeof password !== 'string') return { status: 400, field: 'password', error: 'Choose a password.' };
      // The password is checked first, so a too-weak one does not use up the one-time link.
      const peek = store.peekLoginToken(sha(token), iso(now()), 'reset');
      if (!peek) return { status: 400, code: 'link_invalid', error: 'This link has expired or was already used. Ask for a new one.' };
      const user = store.userByEmail(peek.email);
      if (!user || user.disabled) return { status: 400, code: 'link_invalid', error: 'This reset link is not valid. Ask for a new one.' };
      const problems = passwordProblems(password, user.email, user.name);
      if (problems.length) return { status: 400, field: 'password', error: problemText(problems), problems };
      if (!store.consumeLoginToken(sha(token), iso(now()), 'reset')) return { status: 400, code: 'link_invalid', error: 'This link has expired or was already used. Ask for a new one.' };
      store.setPassword(user.id, await hashPassword(password));
      store.deleteSessionsForUser(user.id);                          // anyone who had this account is signed out
      store.markVerified(user.id, iso(now()));                       // the link went to this mailbox, so the address is proven
      store.deleteTokens(user.email, 'reset');
      clearFails(user.email, ip);
      return finish(user, false);
    },

    // Using the confirmation link. It does not sign anyone in; it only proves the address.
    confirmEmail({ token }) {
      if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return { status: 400, error: 'This confirmation link is not valid.' };
      const row = store.consumeLoginToken(sha(token), iso(now()), 'confirm');
      if (!row) return { status: 400, error: 'This link has expired or was already used. Sign in and we will send a new one.' };
      const user = store.userByEmail(row.email);
      if (!user) return { status: 400, error: 'This confirmation link is not valid.' };
      store.markVerified(user.id, iso(now()));
      return { status: 200, ok: true, email: user.email };
    },

    async resendConfirmation(user, { baseUrl = null, ip = null } = {}) {
      if (user.email_verified_at) return { status: 200, ok: true, alreadyConfirmed: true };
      if (!confirmEmails) return { status: 200, ok: true, confirmationOff: true };
      if (!baseUrl) return { status: 503, error: 'Email is not set up on this server yet.' };
      const gate = emailGate(user.email, 'confirm');
      if (gate?.retryAfterSec) return { status: 429, retryAfterSec: gate.retryAfterSec, error: `Please wait ${waitText(gate.retryAfterSec)} before asking for another email.` };
      if (gate?.daily) return { status: 429, error: 'That is the most confirmation emails for one day. Try again tomorrow.' };
      const m = await mail('confirm', user.email, user.name, baseUrl, issueToken(user.email, 'confirm', CONFIRM_TTL_MS, ip));
      if (!m.sent) return { status: 502, error: 'We could not send the email. Try again in a moment.' };
      return { status: 200, ok: true, ...(m.devLink ? { devLink: m.devLink } : {}) };
    },

    // Sign in with an email address a trusted provider (Google) has already verified. A new account needs the 21+
    // confirmation; a turned-off account stays out.
    signInVerified({ email: rawEmail, name, ageConfirmed = false }) {
      const n = normalizeEmail(rawEmail);
      if (n.error) return { status: 400, error: n.error };
      let user = store.userByEmail(n.email), created = false;
      if (user?.disabled) return { status: 403, error: 'This account is turned off.' };
      if (!user) {
        if (ageConfirmed !== true) return { status: 400, error: 'Please confirm you are 21 or older to create an account.', code: 'age_required' };
        if (blockedDomain(n.email, extraBlocked)) return { status: 400, error: 'Please use a regular email address.' };
        const id = store.createUser(n.email, iso(now()), iso(now()), { name: firstName(name) || null, verifiedAt: iso(now()) });
        user = store.userById(id); created = true;
      } else {
        // The address now proves itself. If it had been signed up with a password before anyone confirmed it, that
        // password may have been set by someone else, so it is discarded along with their sessions.
        if (!user.email_verified_at && user.has_password) { store.clearPassword(user.id); store.deleteSessionsForUser(user.id); }
        store.markVerified(user.id, iso(now()));
        if (!user.name && firstName(name)) store.setName(user.id, firstName(name));
      }
      return finish(store.userById(user.id), created);
    },

    // Signed in and changing the password. The current password must be right (a stolen session alone cannot do it), the new one
    // follows the usual rules, and every other device is signed out. This device gets a fresh session.
    async changePassword({ user, current, password, ip = null }) {
      if (!user) return { status: 401, code: 'auth_required', error: 'Sign in to continue.' };
      if (typeof current !== 'string' || !current) return { status: 400, field: 'current', error: 'Enter your current password.' };
      if (typeof password !== 'string' || !password) return { status: 400, field: 'password', error: 'Choose a new password.' };
      const row = store.userWithHashByEmail(user.email);
      if (!row?.password_hash) return { status: 400, code: 'no_password', error: 'This account signs in with Google. To add a password, use Forgot password on the sign-in screen.' };
      if (isLocked(user.email, ip)) return LOCKED;
      if (current.length > 256 || !(await verifyPassword(current, row.password_hash))) {
        noteFail(user.email, ip);
        return isLocked(user.email, ip) ? LOCKED : { status: 400, field: 'current', error: 'That is not your current password.' };
      }
      clearFails(user.email, ip);
      if (password === current) return { status: 400, field: 'password', error: 'Choose a password you have not used here before.' };
      const problems = passwordProblems(password, user.email, user.name);
      if (problems.length) return { status: 400, field: 'password', error: problemText(problems), problems };
      store.setPassword(user.id, await hashPassword(password));
      store.deleteSessionsForUser(user.id);
      return finish(store.userById(user.id), false);
    },
    // Signs out every other device. This one gets a fresh session so the person stays signed in here.
    signOutOthers(user) {
      if (!user) return { status: 401, code: 'auth_required', error: 'Sign in to continue.' };
      store.deleteSessionsForUser(user.id);
      return finish(store.userById(user.id), false);
    },

    // The signed-in user for a request, or null.
    userFromCookieHeader(header) {
      const t = parseCookies(header)[COOKIE];
      if (typeof t !== 'string' || !TOKEN_SHAPE.test(t)) return null;
      const u = store.sessionUser(sha(t), iso(now()));
      if (u && (!u.last_seen || now() - new Date(u.last_seen).getTime() > TOUCH_EVERY_MS)) store.touchUser(u.id, iso(now()));
      return u;
    },
    logout(header) {
      const t = parseCookies(header)[COOKIE];
      if (typeof t === 'string' && TOKEN_SHAPE.test(t)) store.deleteSession(sha(t));
    },
    isAdminEmail: email => !!admin && String(email).toLowerCase() === admin,
  };
}

module.exports = { createAuth, maskEmail, normalizeEmail, blockedDomain, parseCookies, sessionCookie, clearCookie, sha, newToken, COOKIE, CONFIRM_TTL_MS, RESET_TTL_MS, SESSION_TTL_MS, EMAIL_COOLDOWN_MS, EMAILS_PER_DAY };
