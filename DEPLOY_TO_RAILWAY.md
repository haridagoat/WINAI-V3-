# Deploy WIN AI to Railway (24/7 hosting, ~$5/month)

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
git add server.js lib public package.json package-lock.json railway.json Procfile
git commit -m "WIN AI initial deploy"
git remote add origin https://github.com/YOUR_USERNAME/win-ai.git
git push -u origin main
```
Replace YOUR_USERNAME with your GitHub username.

## Step 3 — Deploy on Railway
1. Go to https://railway.app and sign in with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your win-ai repo
4. Railway auto-detects Node.js and starts building

## Step 4 — Add environment variables
In Railway dashboard → your project → "Variables" tab, add:
```
BALLDONTLIE_KEY   = your_key_here
ANTHROPIC_KEY     = your_key_here
ODDS_API_KEY      = your_key_here
RAPIDAPI_KEY      = your_key_here
PORT              = 3001
```

## Step 5 — Get your live URL
Railway gives you a URL like:
  https://win-ai-production.up.railway.app

Open that from any phone, laptop, or device — WIN AI is live 24/7.

## Notes
- fetch_stats.py does NOT run on Railway (it needs Python + nba_api)
- Keep running it locally: `python fetch_stats.py` once per day
- The stat JSON files are NOT pushed to GitHub (in .gitignore)
- If you want Railway to have stat files, commit them without the gitignore exclusion
- The 7am cron job in server.js will try to run fetch_stats.py but will fail silently on Railway (OK — just run it locally and the files cache)

## Storage, admin page and alerts

- **Node 22.13 or newer.** Picks are stored in SQLite (`winai.db`) using Node's built-in `node:sqlite`.
  `package.json` sets `engines`, and Railway reads it. On the first start the old `clv_tracker.json` is
  imported once and left in place.
- **Keep the database.** Railway wipes the disk on each deploy unless you attach a Volume. Mount one
  (for example at `/data`) and set `WINAI_DB=/data/winai.db`. A dated backup is written to `backups/`
  at 3 AM and the newest 7 are kept; point it at the volume too if you want them to survive deploys.
- **Admin page** (`/admin.html`, needs `ADMIN_TOKEN`): Health, Backtest, Calibration and Scouting notes.
- **Alerts to yourself (optional).** Set `ADMIN_ALERT_WEBHOOK` to a Discord or Slack incoming-webhook URL
  to get low-credit, failed-job and failed-test alerts. Without it, alerts only appear on the Health tab.
- **Odds credit budget (optional).** `ODDS_CREDIT_WARN` (default 100), `ODDS_CREDIT_CRIT` (default 40) and
  `ODDS_SCAN_COST` (default 60). When fewer credits are left than a scan costs, the 10 AM scan is skipped
  and an alert is raised instead of the scan dying half way.
- **Set `TRUST_PROXY=1` on Railway.** The app sits behind Railway's proxy. Without this, every visitor
  looks like the same address, so one person hitting a rate limit locks everyone out.
- **Spend protection.** Public AI analysis is capped at `ANALYZE_DAILY_CAP` requests a day (default 400;
  the admin isn't counted). Saves, searches and admin logins are also rate limited, and 10 wrong admin
  tokens lock that address out for 15 minutes.
- **Tests:** `npm test`. They also run on every push through `.github/workflows/test.yml`.

## Accounts and data checks

Visitors can browse everything as guests. An account is only asked for when someone saves a prop, and every
saved prop belongs to the account that saved it. Sign-in is by emailed link, so there are no passwords.

Set these in the host's variables:

| Variable | What it does |
|---|---|
| `RESEND_API_KEY` | Key from resend.com, used to send the sign-in email. |
| `MAIL_FROM` | The sender, on a domain you verified at Resend, for example `WIN AI <login@yourdomain.com>`. |
| `PUBLIC_URL` | Your site address, for example `https://yourapp.up.railway.app`. Sign-in links are built from this, never from the request. |
| `ADMIN_EMAIL` | Your own email. Props saved before accounts existed move to this account the first time it signs in. |
| `USER_MAX_PROPS` | Optional. Props one account can save (default 300). |
| `BLOCKED_EMAIL_DOMAINS` | Optional. Extra throwaway email domains to refuse, comma separated. |

Until `RESEND_API_KEY`, `MAIL_FROM` and `PUBLIC_URL` are all set, sign-in is switched off and visitors see
"Sign-in is not ready" when they try to save.

**On your own computer** you can skip email: set `AUTH_DEV_LINKS=1` in `.env`. The sign-in link is then shown on
screen and printed in the server log instead of being emailed. It only works for requests from the same machine and
is ignored when `NODE_ENV=production`. Never set it on a public site.

**Admin only:** the Users and Data checks tabs on `/admin.html` need the admin token. No public page shows user counts
or check results.

**Data checks** run at startup and every night at 3:10 AM. They fix what is safe (a stale slate cache, a missing
backup, a stat file the server can re-fetch, picks overdue for grading) and alert you about the rest. They never edit a
pick or a stat. The WNBA/NBA stat refresh needs Python on the server, so on Railway it will usually report
"needs you" and you refresh those files on your own computer.
