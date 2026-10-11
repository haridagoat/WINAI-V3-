// Input checks, rate limits and headers. Pure helpers so they can be tested without a server.

// Control characters (null bytes especially) never belong in a name. One in a player name
// reached a Python launch call and crashed the whole server.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function badString(s, max = 200) {
  if (typeof s !== 'string') return null;
  if (CONTROL.test(s)) return 'contains control characters';
  if (s.length > max) return `longer than ${max} characters`;
  return null;
}

// First problem found in a query object (or null). Arrays and nested values are checked too.
function queryProblem(query, max = 200) {
  for (const [k, v] of Object.entries(query || {})) {
    const vals = Array.isArray(v) ? v : [v];
    for (const x of vals) {
      if (x && typeof x === 'object') return `${k} must be plain text`;
      const p = badString(x, max);
      if (p) return `${k} ${p}`;
    }
  }
  return null;
}

// Control characters anywhere in a JSON body (strings only, any depth, bounded depth).
function bodyProblem(value, depth = 0) {
  if (depth > 6) return 'too deeply nested';
  if (typeof value === 'string') return CONTROL.test(value) ? 'contains control characters' : null;
  if (Array.isArray(value)) { for (const x of value.slice(0, 200)) { const p = bodyProblem(x, depth + 1); if (p) return p; } return null; }
  if (value && typeof value === 'object') { for (const x of Object.values(value)) { const p = bodyProblem(x, depth + 1); if (p) return p; } }
  return null;
}

const PROP_TYPE = /^[a-z0-9+_]{1,12}$/i;
const VERDICT = /^[A-Z_]{2,14}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RESULTS = new Set(['WIN', 'LOSS', 'PUSH', 'NO_BET']);
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

// A saved prop, from anyone. Only fields the app uses survive, with types and sizes enforced, so
// nothing a stranger posts can carry markup or bloat the shared store.
function cleanEntryInput(b) {
  if (!b || typeof b !== 'object') return { error: 'body required' };
  for (const [k, max] of [['player', 80], ['opp', 80]]) {
    if (b[k] != null && (typeof b[k] !== 'string' || badString(b[k], max) || /[<>]/.test(b[k]))) return { error: `${k} is not valid` };
  }
  if (typeof b.player !== 'string' || !b.player.trim()) return { error: 'player and line required' };
  const line = num(b.line);
  if (line == null || line < 0 || line > 500) return { error: 'player and line required' };
  if (b.propType != null && !PROP_TYPE.test(String(b.propType))) return { error: 'propType is not valid' };
  if (b.verdict != null && !VERDICT.test(String(b.verdict))) return { error: 'verdict is not valid' };
  if (b.gameDate != null && !DATE.test(String(b.gameDate))) return { error: 'gameDate is not valid' };
  const edge = num(b.edge), conf = num(b.confidence), proj = num(b.projection);
  return { value: {
    player: b.player.trim(), opp: b.opp != null ? String(b.opp).trim() : undefined,
    propType: b.propType != null ? String(b.propType).toLowerCase() : undefined,
    line, projection: proj != null && Math.abs(proj) < 1000 ? proj : null,
    verdict: b.verdict != null ? String(b.verdict) : undefined,
    edge: edge != null && Math.abs(edge) < 1000 ? edge : null, confidence: conf != null && conf >= 0 && conf <= 100 ? conf : null,
    gameDate: b.gameDate != null ? String(b.gameDate) : undefined, league: b.league === 'wnba' ? 'wnba' : 'nba',
  } };
}

function cleanUpdateInput(b) {
  if (!b || typeof b !== 'object') return { error: 'body required' };
  const out = {};
  if (b.result !== undefined && b.result !== null && !RESULTS.has(b.result)) return { error: 'result is not valid' };
  if (b.result !== undefined) out.result = b.result;
  for (const k of ['closingLine', 'actualStat']) {
    if (b[k] === undefined || b[k] === null || b[k] === '') continue;
    const n = num(b[k]);
    if (n == null || n < 0 || n > 1000) return { error: `${k} is not valid` };
    out[k] = n;
  }
  if (b.notes !== undefined && b.notes !== null && b.notes !== '') {
    if (typeof b.notes !== 'string' || badString(b.notes, 500) || /[<>]/.test(b.notes)) return { error: 'notes are not valid' };
    out.notes = b.notes;
  }
  return { value: out };
}

// Fixed-window limiter per key. Old keys are swept so the map can't grow without bound.
function createRateLimiter({ windowMs, max, keyFn = req => req.ip, now = () => Date.now(), onBlock = null, message = 'Too many requests. Slow down and try again shortly.' }) {
  const hits = new Map();
  let lastSweep = now();
  return (req, res, next) => {
    const t = now();
    if (t - lastSweep > windowMs) { for (const [k, v] of hits) if (t - v.start > windowMs) hits.delete(k); lastSweep = t; }
    const key = keyFn(req), e = hits.get(key);
    if (!e || t - e.start > windowMs) { hits.set(key, { count: 1, start: t }); return next(); }
    e.count++;
    if (e.count > max) { if (onBlock) onBlock(req); res.set('Retry-After', String(Math.ceil((e.start + windowMs - t) / 1000))); return res.status(429).json({ error: message }); }
    next();
  };
}

// Blocks a source after too many wrong admin tokens, so the token can't be guessed by brute force.
function createFailLimiter({ max = 10, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const fails = new Map();
  return {
    blocked(key) { const e = fails.get(key); return !!e && now() - e.start <= windowMs && e.count >= max; },
    fail(key) { const t = now(), e = fails.get(key); if (!e || t - e.start > windowMs) fails.set(key, { count: 1, start: t }); else e.count++; },
    ok(key) { fails.delete(key); },
  };
}

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
}

// A state-changing request must come from this site's own pages. The session cookie is SameSite=Lax,
// which already stops other sites sending it on a POST; this refuses the request outright as well.
function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch (_) { /* malformed, refused below */ }
    if (host !== req.get('host')) return res.status(403).json({ error: 'Cross-site request refused.' });
  } else if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-site request refused.' });
  next();
}

module.exports = { sameOrigin, badString, queryProblem, bodyProblem, cleanEntryInput, cleanUpdateInput, createRateLimiter, createFailLimiter, securityHeaders };
