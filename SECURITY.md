# Security Audit & Remediation Guide for WIN AI

**Status:** 13 findings identified (1 Critical, 5 High, 5 Medium, 2 Low)  
**Urgency:** Critical and High findings must be fixed before production deployment  
**Last Updated:** 2026-10-22

---

## Executive Summary

WIN AI has **1 critical vulnerability** (XSS in shared prop list → admin token theft) and **5 high-severity issues** (missing auth on data mutation, DoS vectors, unpatched dependencies). All are fixable with code changes below.

**Risk:** An untrusted visitor can:
1. Inject malicious JavaScript into props saved by anyone
2. Forge/delete accuracy tracking records
3. Exhaust the paid Odds API quota
4. Crash the server with malformed requests

**Remediation time:** ~2-3 hours for Orders 1-2 (critical path to production-safe).

---

## Findings Summary (Ranked by Severity)

| ID | Severity | Title | Status | Effort |
|----|----------|-------|--------|--------|
| 1 | 🔴 CRITICAL | Stored XSS in prop list → admin token theft | Verified code + fix ready | 30 min |
| 2 | 🟠 HIGH | CLV records can be forged/deleted by anyone | Verified code | 30 min |
| 3 | 🟠 HIGH | Unprotected cache-clear endpoint → DoS | Verified code | 10 min |
| 4 | 🟠 HIGH | `/api/analyze` is open LLM proxy | Verified code + needs runtime test | 20 min |
| 5 | 🟠 HIGH | Malformed query → process crash | Verified code + minimal repro | 45 min |
| 6 | 🟠 HIGH | Python subprocess queue can be exhausted | Verified code | 30 min |
| 7 | 🟡 MEDIUM | Vulnerable dependencies (npm audit) | Tool output verified | 15 min |
| 8 | 🟡 MEDIUM | LLM output not escaped → DOM XSS | Verified code | 20 min |
| 9 | 🟡 MEDIUM | Admin token: no rate limit, no audit log | Verified code | 20 min |
| 10 | 🟡 MEDIUM | Unbounded JSON file + in-memory caches | Verified code | 30 min |
| 11 | 🟢 LOW | Debug routes leak information | Verified code | 15 min |
| 12 | 🟢 LOW | Inline handler escaping incomplete | Verified code | 10 min |
| 13 | 🟢 LOW | No security headers | Verified code | 10 min |

---

## Recommended Remediation Order

### Order 1 (Critical path — 1 hour, ~45 commits)
**Do before ANY deployment. Fixes the only Critical + helps with Medium findings.**

#### 1a. Input validation on `/api/clv/save`

**File:** `server.js` lines 5668-5689

**Current code:**
```javascript
app.post('/api/clv/save', (req, res) => {
  const { player, opp, propType, line, projection, verdict, edge, confidence, gameDate, league } = req.body;
  // ... stores verbatim, no validation
  const entry = { player, opp, propType, line, projection, verdict, edge, confidence, date: gameDate || getToday(), league };
  entries.push({ ...entry, id: nextId(), source: 'manual', createdAt: getToday() });
  saveEntries(entries);
  res.json({ entry });
});
```

**Vulnerability:** `propType`, `verdict`, `gameDate` are stored unsanitized and later rendered in `index.html:3875` as:
```javascript
${propLabel[b.propType]||b.propType?.toUpperCase()} … ${b.date|''}
// becomes: <span>POINTS</span> vs <span><img src=x onerror=alert(1)></span>
```

**Fix:**
```javascript
const PROP_TYPES = new Set(['points','rebounds','assists','3pm','pra','pr','pa','ra','steals','blocks','turnovers','doubts']);
const VERDICTS = new Set(['OVER','LEAN_OVER','UNDER','LEAN_UNDER','PASS']);

app.post('/api/clv/save', (req, res) => {
  const { player, opp, propType, line, projection, verdict, edge, confidence, gameDate, league } = req.body;
  
  // Validate all fields
  if (!PROP_TYPES.has(propType)) return res.status(400).json({ error: 'Invalid propType' });
  if (!VERDICTS.has(verdict)) return res.status(400).json({ error: 'Invalid verdict' });
  if (gameDate && !/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) return res.status(400).json({ error: 'Invalid gameDate format (YYYY-MM-DD)' });
  if (typeof player !== 'string' || player.length > 80) return res.status(400).json({ error: 'Invalid player (1-80 chars)' });
  if (opp != null && (typeof opp !== 'string' || opp.length > 80)) return res.status(400).json({ error: 'Invalid opponent (1-80 chars)' });
  if (typeof line !== 'number' || !isFinite(line)) return res.status(400).json({ error: 'Invalid line' });

  const entry = { player, opp, propType, line, projection, verdict, edge, confidence, date: gameDate || getToday(), league };
  entries.push({ ...entry, id: nextId(), source: 'manual', createdAt: getToday() });
  saveEntries(entries);
  res.json({ entry });
});
```

**Behavior change:** Requests with invalid propType/verdict/gameDate now return 400 (previously silently stored). Existing poisoned entries in `clv_tracker.json` remain; client escaping (see 1b) neutralizes them.

#### 1b. Escape unescaped sinks in `index.html`

**File:** `public/index.html` lines 3865-3879

**Current code:**
```javascript
const vc=(b.verdict||'pass').toLowerCase().replace('_','-');
const li=`
  <div class="game-chip ${vc}">
    <div class="chip-left">
      <div class="chip-ticker">${propLabel[b.propType]||b.propType?.toUpperCase()} ${b.line}</div>
      <div class="chip-meta">vs ${abbr} · ${b.date||''}</div>
```

**Vulnerability:** `b.propType`, `b.verdict`, `b.date` rendered directly into innerHTML without escaping. An attacker's XSS executes here.

**Fix:**
```javascript
const vc=String(b.verdict||'pass').toLowerCase().replace(/[^a-z_]/g,'').replace('_','-');
const propTypeDisplay = escapeHtml(propLabel[b.propType] || String(b.propType||'').toUpperCase());
const dateDisplay = escapeHtml(b.date||'');
const li=`
  <div class="game-chip ${vc}">
    <div class="chip-left">
      <div class="chip-ticker">${propTypeDisplay} ${b.line}</div>
      <div class="chip-meta">vs ${escapeHtml(abbr)} · ${dateDisplay}</div>
```

**Behavior change:** Raw HTML in stored data now renders as text (e.g., `<img>` shows as text, not as an image). This is correct behavior.

#### 1c. Also fix LLM output (Finding 8 — DOM XSS)

**File:** `public/index.html` lines 2246, 2251, 2367

**Current code:**
```javascript
// Line 2246
const acBody = (label, match, fallback) => {
  const t = (ANALYSIS_CACHE[CURRENT_LEAGUE]||{})[match] || fallback;
  return `<div class="ac-body">${t}</div>`; // t is unescaped
};

// Line 2367
elFor(league,'result-area').innerHTML = `<div class="analysis-text">${fullAnalysis}</div>`; // fullAnalysis is unescaped
```

**Vulnerability:** LLM responses saved to localStorage and re-rendered. If Claude's response contains HTML (e.g., from an attack via poisoned upstream data), it executes.

**Fix:**
```javascript
const acBody = (label, match, fallback) => {
  const t = (ANALYSIS_CACHE[CURRENT_LEAGUE]||{})[match] || fallback;
  return `<div class="ac-body">${escapeHtml(t)}</div>`;
};

// When rendering LLM output:
const analysisDisplay = escapeHtml(fullAnalysis);
elFor(league,'result-area').innerHTML = `<div class="analysis-text">${analysisDisplay}</div>`;

// Also in error handlers (lines 1746, 3046, 3254, 3403):
// Change: console.error(err.message);
// To:     console.error(err.message); el.textContent = 'Error: ' + err.message; // or escapeHtml(err.message)
```

**Behavior change:** Raw HTML in AI responses now renders as text (backwards-incompatible but correct for security). If you were relying on `<b>bold</b>` formatting from Claude, you'll need a safe formatter.

#### 1d. Move admin token to sessionStorage

**File:** `public/admin.html` lines 101, 123, 138

**Current code:**
```javascript
// Line 101
sessionStorage.setItem('winai_admin_token', TOKEN);  // good
// But then line 138:
localStorage.setItem('winai_admin_token', TOKEN);    // bad — persists across browser closes
```

**Fix:** Remove all localStorage references, keep only sessionStorage:
```javascript
// Remove:
// localStorage.setItem('winai_admin_token', TOKEN);
// localStorage.removeItem('winai_admin_token');

// Keep only:
sessionStorage.setItem('winai_admin_token', TOKEN);
sessionStorage.removeItem('winai_admin_token');
```

**Why:** sessionStorage is cleared when the tab closes; localStorage persists indefinitely and is accessible to any same-origin script (including the XSS in finding 1).

**Behavior change:** User must re-enter admin token when opening a new admin tab (slightly less convenient, much more secure).

---

### Order 2 (High severity — ~2 hours)
**Fixes: crash DoS, missing auth, cache quota DoS**

#### 2a. Wrap async handlers to prevent process crashes (Finding 5)

**File:** `server.js` lines 1-50 (near top, after requires)

**Current code:**
```javascript
const app = express();
app.use(express.json());
// ... no error handling for async rejections
```

**Vulnerability:** Express 4 doesn't catch async handler rejections. A single `?date[]=x` query causes `.replace()` to fail, unhandled rejection, Node exits.

**Fix:**
```javascript
// Add this helper near the top (after express() init):
const wrap = (fn) => (req, res, next) => {
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') {
      result.catch(next);
    }
  } catch (err) {
    next(err);
  }
};

// Apply to async routes. Example for /api/schedule:
// OLD: app.get('/api/schedule', async (req, res) => {
// NEW:
app.get('/api/schedule', wrap(async (req, res) => {
  const { date } = req.query;
  if (typeof date !== 'string') return res.status(400).json({ error: 'Invalid date' });
  const data = await fetchWNBASchedule(date.replace(/-/g, ''));
  res.json({ games: data });
}));
```

Also add global error middleware (before `app.listen`):
```javascript
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message, err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason);
});
```

**Alternative (simpler):** Replace query parser globally:
```javascript
// Add after app = express():
app.set('query parser', 'simple'); // disables ?x[]=1, ?x[a]=1 → all become strings
```

**Behavior change:** Malformed queries return 400 (good) instead of crashing (bad).

#### 2b. Add `requireAdmin` to protected routes (Findings 2, 3)

**File:** `server.js` lines 5696, 5782, 5223

**Current code:**
```javascript
app.post('/api/clv/update', (req, res) => {        // NO PROTECTION
  // ... accepts any result value, mutates accuracy tracking
});

app.delete('/api/clv/:id', (req, res) => {         // NO PROTECTION
  // ... deletes entries by anyone
});

app.post('/api/cache-clear', (req, res) => {       // NO PROTECTION
  // ... wipes cache, triggers re-fetch, burns quota
});
```

**Fix:**
```javascript
// Change signatures (wrap with requireAdmin):
app.post('/api/clv/update', requireAdmin, (req, res) => {
  const { id, result, actualStat } = req.body;
  // ... validate result
  if (result !== undefined) {
    if (![null, 'WIN', 'LOSS', 'PUSH', 'NO_BET'].includes(result)) {
      return res.status(400).json({ error: 'Invalid result' });
    }
    entries[idx].result = result;
  }
  res.json({ entry: entries[idx] });
});

app.delete('/api/clv/:id', requireAdmin, (req, res) => {
  // ... existing delete logic
});

app.post('/api/cache-clear', requireAdmin, (req, res) => {
  clearAllCaches();
  res.json({ ok: true });
});

app.post('/api/roster-refresh', requireAdmin, (req, res) => {
  // ... same protection
});
```

**Behavior change:** The UI (index.html) must now send the admin token for prop editing. See finding 9 (admin token in sessionStorage) — for now, the UI retrieves it from sessionStorage.

Future improvement: for user-owned props, add per-browser owner tokens instead of admin-only.

#### 2c. Add error middleware (Part of 2a)

Already covered above in 2a.

---

### Order 3 (High + Medium — ~2 hours)
**Fixes: per-IP rate limiting, LLM proxy auth, subprocess queue, unbounded caches**

#### 3a. Trust proxy header + request validation (Finding 4)

**File:** `server.js` near top, after `const app = express();`

**Current code:**
```javascript
const app = express();
// NO: app.set('trust proxy', 1);
// NO: request validation

app.post('/api/analyze', analyzeRateLimiter, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  // ... sends to Claude with no length check
});
```

**Vulnerability:** Without `trust proxy`, all Railway visitors share one rate-limit bucket (the proxy IP). Attacker can lock out everyone. Also no prompt length check → OOM or exhausted quota.

**Fix:**
```javascript
app.set('trust proxy', 1);  // Add this early, once, after express() init

// Also validate prompt:
app.post('/api/analyze', analyzeRateLimiter, wrap(async (req, res) => {
  const { prompt } = req.body;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 30000) {
    return res.status(400).json({ error: 'Invalid prompt (required, max 30000 chars)' });
  }
  
  // ... send to Claude
}));
```

Also improve the rate limiter's cleanup (lines 26-41):
```javascript
function makeRateLimiter(windowMs, max) {
  const hits = new Map(); // ip -> { count, windowStart }
  return (req, res, next) => {
    const now = Date.now();
    
    // Prune old entries (prevents memory leak)
    for (const [ip, entry] of hits) {
      if (now - entry.windowStart > windowMs) {
        hits.delete(ip);
      }
    }
    
    const entry = hits.get(req.ip);
    if (!entry || now - entry.windowStart > windowMs) {
      hits.set(req.ip, { count: 1, windowStart: now });
      return next();
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests — slow down and try again shortly.' });
    }
    next();
  };
}
```

**Behavior change:** Requests with oversize prompts now return 400. Rate limiting now correctly targets individual IPs instead of treating all as one.

#### 3b. Queue cap + rate limiting on bridge routes (Finding 6)

**File:** `server.js` lines 3589-3720

**Current code:**
```javascript
let bridgeChain = Promise.resolve();  // serial queue, no limit
function fetchViaBridge(playerName, season) {
  // ... just appends to chain, no queue cap, no rate limit on routes
}

app.get('/api/nba-bridge', async (req, res) => {  // NO RATE LIMIT
  const { name, season } = req.query;
  // ... doesn't validate season
});
```

**Vulnerability:** Attacker loops with different names, each taking 20s, queue fills up, legitimate requests hang for hours.

**Fix:**
```javascript
let bridgeChain = Promise.resolve();
let bridgePending = 0;

function enqueueBridge(taskFn) {
  if (bridgePending >= 20) {
    return Promise.resolve({ error: 'Queue full — try again shortly' });
  }
  bridgePending++;
  const scheduled = bridgeChain.then(async () => {
    try {
      return await taskFn();
    } finally {
      bridgePending--;
    }
  });
  bridgeChain = scheduled.catch(() => {}); // keep chain alive even on errors
  return scheduled;
}

// Apply rate limiting to routes:
const bridgeRateLimiter = makeRateLimiter(60 * 1000, 5); // 5 req/min/IP

app.get('/api/nba-bridge', bridgeRateLimiter, wrap(async (req, res) => {
  const { name, season } = req.query;
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
  if (typeof season === 'string' && !/^\d{4}-\d{2}$/.test(season)) season = '2025-26';
  
  const result = await enqueueBridge(() => fetchViaBridge(name, season));
  if (result.error) return res.status(503).json(result);
  res.json(result);
}));

app.get('/api/nba-bridge/batch', bridgeRateLimiter, wrap(async (req, res) => {
  // ... similar
}));

app.get('/api/shotchart', bridgeRateLimiter, wrap(async (req, res) => {
  // ... similar
}));
```

**Behavior change:** Bursts get a "Queue full" error. Season validation prevents invalid values.

#### 3c. Size caps on caches and clv_tracker.json (Finding 10)

**File:** `server.js` lines 5526-5538, 5667-5693

**Current code:**
```javascript
function readEntries() {
  return JSON.parse(fs.readFileSync(CLV_PATH, 'utf8'));
  // no size limit, file can grow unbounded
}

let playerStatsCache = {};  // keyed by player name, no cap
let shotChartCache = {};    // no cap
```

**Vulnerability:** Scriptable `/api/clv/save` grows the file indefinitely. Large files slow down every read/write. In-memory caches grow without bound.

**Fix:**
```javascript
const MAX_ENTRIES = 500;
const MAX_CACHE_SIZE = 100; // LRU cache for stats/shotcharts
const MAX_ENTRY_SIZE = 200; // bytes per field

function readEntries() {
  const entries = JSON.parse(fs.readFileSync(CLV_PATH, 'utf8'));
  // Keep only the last MAX_ENTRIES (FIFO cap)
  return entries.slice(-MAX_ENTRIES);
}

function saveEntries(entries) {
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES); // trim oldest
  }
  fs.writeFileSync(CLV_PATH, JSON.stringify(entries, null, 2), 'utf8');
}

// LRU cache helper
class LRUCache {
  constructor(maxSize) { this.max = maxSize; this.cache = new Map(); }
  get(key) { return this.cache.get(key); }
  set(key, val) {
    this.cache.delete(key); // move to end
    this.cache.set(key, val);
    if (this.cache.size > this.max) {
      const first = this.cache.keys().next().value;
      this.cache.delete(first);
    }
  }
}

let playerStatsCache = new LRUCache(MAX_CACHE_SIZE);
let shotChartCache = new LRUCache(MAX_CACHE_SIZE);
```

**Behavior change:** Oldest entries drop off when limits are hit. This is intentional.

---

### Order 4 (Medium — ~15 minutes)
**Fixes: vulnerable dependencies**

**File:** `package.json`

```bash
npm audit fix          # Fixes most advisories non-breaking
npm install axios@1.20.0  # Bump axios from 1.14.0 to latest 1.x
npm test               # Or manual smoke test: node server.js && curl http://localhost:3001
```

**Verification:**
```bash
npm audit              # Should show 0 high/critical
```

---

### Order 5 (Medium/Low — ~1 hour)
**Fixes: information disclosure, security headers, incomplete escaping**

#### 5a. Gate debug routes behind requireAdmin (Finding 11)

**File:** `server.js` lines 5268, 5163, 3745

```javascript
// OLD:
app.get('/api/debug', (req, res) => { … });

// NEW:
app.get('/api/debug', requireAdmin, (req, res) => { … });
app.get('/api/debug-matchup', requireAdmin, (req, res) => { … });
app.get('/api/data-status', requireAdmin, (req, res) => { … });
```

**But:** `index.html:1039` polls `/api/debug` for UI status. Create a public endpoint instead:
```javascript
// Public endpoint (limited info):
app.get('/api/status', (req, res) => {
  res.json({
    healthy: true,
    uptime: process.uptime(),
  });
});

// Admin endpoint (full debug info):
app.get('/api/debug', requireAdmin, (req, res) => {
  res.json({ …detailed… });
});

// Update index.html to call /api/status instead of /api/debug
```

#### 5b. Replace relayed Python stderr (Finding 11)

**File:** `server.js` lines 3644, 3690

```javascript
// OLD:
} catch (err) {
  return res.status(500).json({ error: `Bridge parse error: ${errout || output}` });
}

// NEW:
} catch (err) {
  console.error('[bridge error]', err.message, errout || output);
  return res.status(500).json({ error: 'Could not fetch data — try again shortly' });
}
```

#### 5c. Add security headers (Finding 13)

**File:** `server.js` after `const app = express();`

```javascript
// Option 1: Use helmet
app.use(require('helmet')());
app.disable('x-powered-by');

// Option 2: Manual headers (if helmet not available)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // Allow framing within same origin
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.removeHeader('X-Powered-By');
  next();
});
```

**CSP (Content Security Policy)** — tricky because of inline onclick handlers:
```javascript
// Partial CSP (allows inline, but blocks external scripts):
res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;");
```

Better long-term: remove `onclick=` handlers from `index.html` and use `addEventListener` instead.

#### 5d. Fix incomplete inline escaping (Finding 12)

**File:** `public/index.html` lines 1070, 1097

```javascript
// OLD:
onclick="selectPlayer('${p.replace(/'/g,"\\'")}','${league}')"

// NEW:
onclick="selectPlayer('${escapeHtml(p).replace(/'/g,"\\'")}','${league}')"
```

Or better, use data attributes:
```html
<!-- OLD: -->
<div onclick="selectPlayer('${p.replace(/'/g,"\\'")}','${league}')">…</div>

<!-- NEW: -->
<div class="player-select" data-player="${escapeHtml(p)}" data-league="${escapeHtml(league)}">…</div>

<!-- JS: -->
document.querySelectorAll('.player-select').forEach(el => {
  el.addEventListener('click', () => selectPlayer(el.dataset.player, el.dataset.league));
});
```

---

## Verification Checklist

After applying fixes, test each one:

- [ ] **Finding 1 (XSS)**: `curl -X POST http://localhost:3001/api/clv/save -H 'Content-Type: application/json' -d '{"player":"x","line":1,"propType":"<img src=x onerror=alert(1)>","verdict":"OVER","league":"nba"}' → 400`
- [ ] **Finding 2 (CLV auth)**: `curl -X POST http://localhost:3001/api/clv/update -H 'Content-Type: application/json' -d '{"id":1,"result":"WIN"}' → 401 or 503`
- [ ] **Finding 3 (cache-clear)**: `curl -X POST http://localhost:3001/api/cache-clear → 401 or 503`
- [ ] **Finding 4 (trust proxy)**: Deploy to Railway, check `req.ip` is per-client in logs
- [ ] **Finding 5 (crash)**: `curl 'http://localhost:3001/api/schedule?date[]=x' → server stays up, returns 400`
- [ ] **Finding 6 (queue)**: Rapid `/api/nba-bridge` requests should hit rate limit (429), not queue indefinitely
- [ ] **Finding 7 (deps)**: `npm audit` → 0 high/critical
- [ ] **Finding 8 (LLM escaping)**: Run analysis, save to history, check browser DevTools → LLM output properly escaped in HTML
- [ ] **Finding 9 (token)**: Enter admin token in `/admin.html`, close tab, reopen → token cleared
- [ ] **Finding 10 (unbounded)**: Add 1000 entries to prop list, check `clv_tracker.json` size is capped
- [ ] **Finding 11 (debug)**: `curl http://localhost:3001/api/debug` → 503 (unless admin token provided)
- [ ] **Finding 12 (inline escape)**: Check `index.html` line 1070 has escapeHtml wrapper
- [ ] **Finding 13 (headers)**: `curl -I http://localhost:3001` → includes `X-Content-Type-Options`, `X-Frame-Options`

---

## Timeline to Production

| Phase | Duration | Work |
|-------|----------|------|
| **Order 1 (Critical)** | 1 hour | Input validation, escaping, token storage |
| **Order 2 (High)** | 2 hours | Error handling, requireAdmin, validation |
| **Order 3 (High/Med)** | 2 hours | Rate limiting, queue caps, cache limits |
| **Order 4 (Medium)** | 15 min | npm audit fix |
| **Order 5 (Low)** | 1 hour | Debug gates, headers, escaping cleanup |
| **Testing** | 30 min | Verification checklist above |
| **Deploy to Railway** | 10 min | Push to GitHub, Railway auto-builds |
| **Total** | ~7 hours | —— |

**Critical path to safe production:** Orders 1-2 only = ~3 hours. Then deploy and fix the rest in follow-up PRs if time-constrained.

---

## Branch strategy

1. Create branch: `git checkout -b security/findings-remediation`
2. Apply fixes in order (test each)
3. Commit: `git commit -m "Security: fix critical XSS and high findings (1-6)" --allow-empty`
4. Push: `git push origin security/findings-remediation`
5. Merge to main once verified
6. Deploy to Railway

---

## Resources

- [OWASP ASVS v4.0.3](https://github.com/OWASP/ASVS/releases/tag/4.0.3) — security maturity framework
- [Node.js security best practices](https://nodejs.org/en/docs/guides/security/)
- [Railway documentation](https://docs.railway.app/)
- [npm audit](https://docs.npmjs.com/cli/v10/commands/npm-audit) — dependency vulnerability scanning

