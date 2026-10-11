// Accounts: sign-in by emailed link, no passwords. Pure logic: the store, the mailer and the clock are
// passed in, so every rule here can be tested without a server.
//
// What is stored, and how it stays safe:
//  - A login link is a random token. Only its SHA-256 hash is kept, it works once, and it expires in 15 minutes.
//  - A session is another random token held in an HttpOnly cookie. Only its hash is kept in the database,
//    so a copy of the database cannot be used to sign in.
//  - An account is only created when a link is used, never on request, so typing someone else's email
//    creates nothing.
const crypto = require('crypto');

const LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const LINKS_PER_EMAIL_PER_HOUR = 5;
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

function createAuth({ store, send, now = () => Date.now(), adminEmail = '', extraBlocked = [], devLinks = false, log = () => {} }) {
  const iso = t => new Date(t).toISOString();
  const admin = String(adminEmail || '').trim().toLowerCase();

  return {
    COOKIE,
    // Step 1: someone types their email. Always answers the same way for a known or unknown address.
    async requestLink({ email: rawEmail, ageConfirmed = false, ip = null, baseUrl }) {
      const n = normalizeEmail(rawEmail);
      if (n.error) return { status: 400, error: n.error };
      const { email } = n;
      if (blockedDomain(email, extraBlocked)) return { status: 400, error: 'Please use a regular email address. Throwaway providers are not supported.' };
      if (store.recentLoginTokens(email, iso(now() - 3600 * 1000)) >= LINKS_PER_EMAIL_PER_HOUR) return { status: 429, error: 'Too many sign-in emails for this address. Try again in an hour.' };
      const existing = store.userByEmail(email);
      if (!existing && ageConfirmed !== true) return { status: 400, error: 'Please confirm you are 21 or older to create an account.' };
      if (existing && existing.disabled) return { status: 200, ok: true };   // say nothing, send nothing
      const token = newToken();
      store.addLoginToken({ hash: sha(token), email, createdAt: iso(now()), expiresAt: iso(now() + LINK_TTL_MS), ageOk: ageConfirmed === true || !!existing, ip });
      const link = `${baseUrl}/auth/verify?t=${token}`;
      try { await send({ to: email, link }); }
      catch (err) { log(`[Auth] could not send sign-in email: ${err.message}`); return { status: 502, error: 'We could not send the email. Try again in a moment.' }; }
      return { status: 200, ok: true, ...(devLinks ? { devLink: link } : {}) };
    },

    // Step 2: the link is used. Creates the account on first use and starts a session.
    verifyLink(token) {
      if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return { status: 400, error: 'This sign-in link is not valid.' };
      const row = store.consumeLoginToken(sha(token), iso(now()));
      if (!row) return { status: 400, error: 'This link has expired or was already used. Request a new one.' };
      let user = store.userByEmail(row.email), created = false;
      if (!user) {
        if (!row.age_ok) return { status: 400, error: 'Please confirm you are 21 or older to create an account.' };
        const id = store.createUser(row.email, iso(now()), iso(now()));
        user = store.userById(id); created = true;
      }
      if (user.disabled) return { status: 403, error: 'This account is turned off.' };
      // Props saved before accounts existed go to the admin's account, the first time it signs in.
      const claimed = admin && user.email === admin ? store.claimUnclaimedPicks(user.id) : 0;
      const sessionToken = newToken();
      store.addSession({ hash: sha(sessionToken), userId: user.id, createdAt: iso(now()), expiresAt: iso(now() + SESSION_TTL_MS) });
      store.touchUser(user.id, iso(now()));
      store.pruneAuth(iso(now()));
      return { status: 200, ok: true, sessionToken, user, created, claimed };
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

module.exports = { createAuth, maskEmail, normalizeEmail, blockedDomain, parseCookies, sessionCookie, clearCookie, sha, newToken, COOKIE, LINK_TTL_MS, SESSION_TTL_MS, LINKS_PER_EMAIL_PER_HOUR };
