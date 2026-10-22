# Deploy WIN AI to Railway (24/7 hosting, ~$5/month)

## ⚠️ PRE-DEPLOYMENT SECURITY CHECKLIST

**Before deploying to production, review [SECURITY.md](SECURITY.md)** for critical findings that must be fixed:

- [ ] **Critical XSS vulnerability** in prop list — fix input validation on `/api/clv/save`
- [ ] **Missing authentication** on CLV update/delete routes — add requireAdmin
- [ ] **Unprotected cache-clear endpoint** — can burn Odds API quota
- [ ] **Vulnerable dependencies** — run `npm audit fix` and upgrade axios
- [ ] **LLM output escaping** — escape AI responses before rendering
- [ ] **Admin token in localStorage** — move to sessionStorage

See [SECURITY.md](SECURITY.md) for detailed fixes and verification steps.

---

## Step 1 — Create GitHub repo
1. Go to https://github.com and sign in
2. Click "+" → "New repository"
3. Name it: `win-ai`
4. Set to Private
5. Click "Create repository"

## Step 2 — Push your files to GitHub
Open Command Prompt in your winai folder:
```
cd "C:\Users\User2\Desktop\NBA AI Model\winai"
git init
git add server.js package.json package-lock.json public/ railway.json Procfile .env.example .gitignore
git commit -m "WIN AI initial deploy" -m "See SECURITY.md for pre-deploy fixes"
git remote add origin https://github.com/YOUR_USERNAME/win-ai.git
git push -u origin main
```
Replace YOUR_USERNAME with your GitHub username.

**Important files:**
- `Procfile` — tells Railway how to start the app (`web: node server.js`)
- `railway.json` — Railway-specific config (health check endpoint, restart policy, builder type)
- `package.json` / `package-lock.json` — Node dependencies (lock file ensures everyone installs the same versions)
- `public/` — frontend HTML, CSS, JavaScript (both `index.html` and `admin.html`)
- `.env.example` — template for environment variables (serves as documentation)
- `.gitignore` — excludes `.env` (your real API keys) from version control

## Step 3 — Apply security patches (REQUIRED)
**Do not skip this step.** See [SECURITY.md](SECURITY.md) for detailed fixes.

Quick checklist:
```bash
# 1. Input validation on /api/clv/save and /api/clv/update
# 2. Escape LLM output in index.html before innerHTML
# 3. Move admin token to sessionStorage in admin.html
# 4. Add error handling middleware
# 5. Add requireAdmin to protected routes
# 6. Run npm audit fix
npm install
```

**Local test before pushing:**
```bash
cp .env.example .env
# Edit .env with your real API keys
node server.js
# Test: POST to /api/clv/save with XSS payload → should get 400
# Test: Visit /admin.html → unlock with token → should work
# Test: GET /api/schedule?date[]=x → server should stay up
```

## Step 4 — Deploy on Railway
1. Go to https://railway.app and sign in with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your win-ai repo
4. Railway auto-detects Node.js and starts building

## Step 5 — Add environment variables
In Railway dashboard → your project → "Variables" tab, add:
```
BALLDONTLIE_KEY   = your_key_here
ANTHROPIC_KEY     = your_key_here
ODDS_API_KEY      = your_key_here
RAPIDAPI_KEY      = your_key_here
ADMIN_TOKEN       = 32+ random characters (see below)
PORT              = 3001
NODE_ENV          = production
```

### Generating a secure ADMIN_TOKEN
Generate a cryptographically random 32+ character token:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Security guidelines:**
- **Never copy-paste tokens into the Railway UI form.** Use your password manager or terminal instead
- **Save the token in a password manager** — you cannot retrieve it from Railway later
- **Must be 32+ characters** — shorter tokens are rejected by the server
- **What it protects:** admin scouting notes, prop list edits, cache clearing, roster refresh
- **If misconfigured:** admin routes return 503 and refuse all changes (fail-safe)

### API Keys
- **ANTHROPIC_KEY**: Get from https://console.anthropic.com (keep this secret — it's paid-per-token)
- **ODDS_API_KEY**: Get from https://the-odds-api.com (free tier available)
- **BALLDONTLIE_KEY**: Get from https://balldontlie.io (free tier available)
- **RAPIDAPI_KEY**: Get from https://rapidapi.com (needed for Tank01 lineups API)

**Never commit `.env` to git** — it contains real keys. Only `.env.example` (with placeholders) goes in the repo.

## Step 6 — Verify deployment
Once Railway finishes building:
1. Visit your app URL: `https://win-ai-production.up.railway.app` (or your assigned domain)
2. Check health endpoint: `https://win-ai-production.up.railway.app/api/health` → should return `200 OK`
3. Test the main UI — run an analysis on a player
4. Visit `/admin.html` and enter your ADMIN_TOKEN to verify the admin panel works
5. Check Railway logs for any errors

## Step 7 — Ongoing maintenance

### Running fetch_stats.py
- **Does NOT run on Railway** — it requires Python + nba_api, which aren't on the Node.js dyno
- **Keep running it locally:** `python fetch_stats.py` once per day
- **Stat JSON files are excluded from git** (in `.gitignore`) but cached on disk
- **Alternative:** if you want stats to refresh on Railway, commit the JSON files by removing them from `.gitignore`
- **Cron job:** server.js has a 7am cron that tries to run fetch_stats.py, but fails silently on Railway (this is OK — just run it locally)

### Monitoring
- **Railway dashboard:** shows CPU, memory, request count, error logs
- **Health check:** periodically verify `/api/health` returns 200
- **API costs:** monitor Anthropic usage at https://console.anthropic.com (set spending limits if needed)
- **Rate limits:** watch logs for "Too many requests" — indicates someone is attacking the `/api/analyze` endpoint

### Troubleshooting

**Deployment fails during build:**
- Check Railway's build log for errors
- Ensure `package-lock.json` exists (run `npm install` locally if missing)
- Ensure `.gitignore` excludes `.env` (don't commit your real keys)

**App starts but routes return 500:**
- Check Railway's application logs
- Verify all environment variables are set (Variables tab in Railway)
- Ensure ADMIN_TOKEN is exactly as generated (no extra spaces)

**Admin panel locked / token not working:**
- ADMIN_TOKEN must be 32+ characters (test locally first)
- Token cannot contain the placeholder "XXXXX"
- After deploying, you **cannot** view the token again in Railway — save it in your password manager before deploying

**Odds API quota exhausted:**
- Check if someone called `/api/cache-clear` multiple times (now protected in Step 3)
- Wait for the quota to reset (usually daily at UTC midnight)

---

## Security reminders

✅ **What's protected:**
- API keys stored in Railway's secure variable store (not in code)
- `.env` excluded from git via `.gitignore`
- Admin token uses constant-time comparison (prevents timing attacks)
- Request validation prevents injection attacks

⚠️ **Still vulnerable (will be fixed in Step 3):**
- XSS in prop list (CRITICAL) — waiting for input validation patch
- Missing auth on CLV update/delete (HIGH) — waiting for requireAdmin patch
- LLM output not escaped (MEDIUM) — waiting for escapeHtml patch

💡 **After deploying:**
- Monitor logs regularly
- Keep dependencies up to date (`npm audit`, `npm update`)
- Rotate ADMIN_TOKEN periodically
- Set spending limits on Anthropic API
