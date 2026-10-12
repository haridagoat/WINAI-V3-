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

Visitors can browse everything as guests. An account is only asked for when someone saves a prop, and every saved
prop belongs to the account that saved it. People sign in with **email and password**, or with **Google**.

- **Sign up** asks for a first name, an email, a password (at least 10 characters, not a common one, not containing
  their email name or first name) and the 21+ box. They are signed in straight away.
- **Email confirmation can be switched off** with `EMAIL_CONFIRMATION=off`. People then sign up and are in straight away,
  nothing is emailed, and subscribing does not wait for it. Use this until you have a verified sending domain at Resend,
  then remove the line. Password reset emails still need working email.
- **Nothing is emailed until someone signs up.** Then one email confirms the address. A reset email goes out only when
  someone asks for it. Subscribing needs a confirmed address.
- **Passwords** are stored only as salted scrypt hashes. Nobody, including you, can read one. Five wrong tries on an
  address pause it for 15 minutes. Confirmation and reset emails can go out once every 5 minutes per address (20 a day) (the screen offers a reset). A wrong email and a wrong password give the same answer.
- If an address is already in use, sign up says **"Email is already taken"**.
- Older accounts made with email links or Google keep working. They can add a password with "Forgot password".

Set these in the host's variables (the first three turn on the confirmation and reset emails):

| Variable | What it does |
|---|---|
| `RESEND_API_KEY` | Key from resend.com, used to send the confirmation and reset emails. |
| `MAIL_FROM` | The sender, on a domain you verified at Resend, for example `WIN AI <login@yourdomain.com>`. |
| `PUBLIC_URL` | Your site address, for example `https://yourapp.up.railway.app`. Links in emails are built from this, never from the request. |
| `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` | Optional. Make the white Continue with Google button work (steps below). The button always shows. |
| `ADMIN_EMAIL` | Your own email. Props saved before accounts existed move to this account the first time it signs in. |
| `USER_MAX_PROPS` | Optional. Props one account can save (default 300). |
| `BLOCKED_EMAIL_DOMAINS` | Optional. Extra throwaway email domains to refuse, comma separated. |

Without the email variables, people can still sign up and sign in, but nobody can confirm an address or reset a
password, so the Data checks tab flags it and the paywall stays off. Set them before you go live.

**Sign in with Google (recommended).** The white button sends the whole page to Google's own sign-in, then back to WIN AI
signed in, with the account made. The button always shows; until Google is set up, tapping it says so. To turn it on:
1. console.cloud.google.com: create a project, then APIs & Services > OAuth consent screen (External, add your app
   name and support email, and publish it so anyone can sign in, not just test users).
2. Credentials > Create credentials > OAuth client ID > **Web application**. Under **Authorized redirect URIs** add
   `https://yourapp.up.railway.app/auth/google/callback` (your `PUBLIC_URL` plus `/auth/google/callback`). For local testing also add
   `http://localhost:3001/auth/google/callback`. It has to match exactly.
3. Copy the **Client ID** into `GOOGLE_CLIENT_ID` and the **Client secret** into `GOOGLE_CLIENT_SECRET`. The secret stays on
   the server and is never sent to the browser. If only one of the two is set, Google sign-in stays off and the Data
   checks tab says which is missing.

The server asks Google for the person's name and email only. It trades Google's one-time code for a signed note and
checks it (signature, your client id, expiry, verified email, and a one-time nonce) before trusting it. A Google sign-in
and a password sign-in with the same address reach the same account. New accounts still confirm 21+: a brand-new
person is sent back to tick the box and tap Google again. If a stranger had signed up with someone's address before they
confirmed it, signing in with Google (or resetting the password) throws away the stranger's password and sessions.

**On your own computer** you can skip email: set `AUTH_DEV_LINKS=1` in `.env`. The confirmation and reset links are then
shown on screen and printed in the server log instead of being emailed. It only works for requests from the same machine and
is ignored when `NODE_ENV=production`. Never set it on a public site.

**Admin only:** the Users and Data checks tabs on `/admin.html` need the admin token. No public page shows user counts
or check results.

**Data checks** run at startup and every night at 3:10 AM. They fix what is safe (a stale slate cache, a missing
backup, a stat file the server can re-fetch, picks overdue for grading) and alert you about the rest. They never edit a
pick or a stat. The WNBA/NBA stat refresh needs Python on the server, so on Railway it will usually report
"needs you" and you refresh those files on your own computer.

## Payments (Pro subscriptions)

Pro is a subscription sold through Stripe. Stripe's own pages take the card, so card details never reach this
server. The server only learns the result from a signed webhook, and it never trusts the browser about who is Pro.

**What is free and what is Pro** (limits are enforced on the server, not just hidden in the page):

| Free (guests and free accounts) | Pro |
|---|---|
| Today, Daily Matchups, team pages, search, the top 3 picks, the full track record, export and delete my data | The prop analyzer, up to `PRO_DAILY_ANALYSES` a day (default 100) |
| The top of the Prop Board | The full Prop Board |
| 1 prop analysis a day, free account required (`FREE_DAILY_ANALYSES`) | The Prop List (save props, auto-grading, up to 300) |

A free analysis counts only once it works, so a failed one never uses up the day. Saved props stay readable and
exportable if a subscription ends. Your own account (`ADMIN_EMAIL`) is always Pro, and the Users tab on
`/admin.html` has a Give Pro button for friends and testing.

**Setup, in order. Do it in Stripe's Test mode first.**
1. At dashboard.stripe.com, switch to **Test mode**. Create a product ("WIN AI Pro") with a recurring monthly
   price. Copy the price id (`price_...`) into `STRIPE_PRICE_ID`. The amount lives in Stripe; the site reads it.
2. Developers > API keys: copy the **secret key** (`sk_test_...`) into `STRIPE_SECRET_KEY`.
3. Settings > Billing > **Customer portal**: turn it on, and allow customers to **cancel subscriptions** and update
   payment methods.
4. Developers > Webhooks > Add endpoint: `https://YOUR-SITE/api/stripe/webhook`, with these events:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`. Copy its **signing secret** (`whsec_...`) into
   `STRIPE_WEBHOOK_SECRET`.
5. Set `PUBLIC_URL` (see above), then **`PAYWALL=on`**. The paywall only switches on when the key, the price and
   the webhook secret are all set and sign-in works. If anything is missing, nothing is limited and the Data checks
   tab says why. Nobody can be locked out by a half-finished setup.
6. Test with Stripe's test card `4242 4242 4242 4242` (any future date, any CVC). Check that the account becomes
   Pro, that Manage subscription opens, and that cancelling returns it to free.
7. To go live: repeat steps 1 to 4 in **Live mode** with live keys, and swap the three values. The Users tab shows
   whether the server is in test or live mode.

**Local testing:** install the Stripe CLI and run `stripe listen --forward-to localhost:3001/api/stripe/webhook`.
It prints a `whsec_...` secret to use as `STRIPE_WEBHOOK_SECRET` locally.

Optional: `STRIPE_PRICE_ID_YEARLY` (a yearly price), `STRIPE_AUTOMATIC_TAX=1` (Stripe Tax, once you have set it up in
Stripe).

**Before charging real money:** add Terms and a Privacy page, a "21+, analytics not advice, not a sportsbook"
notice, and responsible-gambling help text. Check your state's rules on selling gambling-related picks and on
advertising claims, and get a quick legal review. Refunds and disputes are handled in the Stripe dashboard.

## Offsite backups

The app already writes a daily copy of its database, but that copy lives on the same disk. If the disk is lost, both go. Offsite backups keep an **encrypted** copy somewhere else.

1. Make a bucket at any S3-compatible service. Cloudflare R2 is the simplest (free tier, no download fees): Cloudflare dashboard, R2, Create bucket, then **Manage R2 API Tokens**, create a token with *Object Read & Write* on that bucket.
2. In Railway, add these variables: `BACKUP_S3_ENDPOINT` (for R2: `https://<account-id>.r2.cloudflarestorage.com`), `BACKUP_S3_BUCKET`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET`, and `BACKUP_PASSPHRASE` (a long phrase you make up, at least 12 characters).
3. **Store the passphrase somewhere else too** (a password manager). The copies are encrypted with it. Without it nobody can open them, including you.
4. Redeploy. Each night at 3:05 AM a copy is uploaded and the newest 14 are kept. Once a week the app downloads the newest copy, decrypts it, opens it as a database and checks it. The result shows on the admin page under Data checks, "Offsite backup". If a copy cannot be restored, it tells you that day.

To restore after a disaster, on any computer with this project and the same five settings in `.env`:

```
node scripts/restore-backup.js list
node scripts/restore-backup.js restore restored.db
```

Then stop the app, replace `winai.db` with `restored.db` (delete `winai.db-wal` and `winai.db-shm`), and start it again. The script never overwrites an existing file.

## Errors and uptime alerts

Two settings tell you when something breaks. Both are free to set up, and the admin page (Data checks) flags them as "needs you" once real people have accounts and either is missing.

1. **Errors:** make a Discord or Slack channel webhook and put its address in `ADMIN_ALERT_WEBHOOK`. Every server error, crash and error in someone's browser is written to the admin page (grouped, with emails and tokens removed) and one message per new problem is sent to the webhook. At most 5 messages an hour, so a bad day never floods your phone.
2. **Site down:** a site that is down cannot message you, so something outside has to notice the silence. Make a free check at healthchecks.io (period 5 minutes, grace 10), copy its ping URL into `HEARTBEAT_URL`, and add your phone or email as its alert channel. The app pings it every 5 minutes. As an alternative, point any uptime watcher (UptimeRobot, Better Stack) at `https://your-site/api/ping`, which answers `{"ok":true}` only when the database is working.

## Protect the admin page with a code from your phone

The admin page can read every account, so the admin token should not be its only lock. With a second factor on, the token alone opens nothing: signing in also needs the 6-digit code from an authenticator app, and the code can be used only once.

1. On your own computer, in this project folder, run `node scripts/make-admin-2fa.js you@example.com`. It prints a secret and a setup key.
2. In your authenticator app (Google Authenticator, 1Password, Authy), add an account by entering that setup key. Save the secret in your password manager as well: it is the way back in if you lose your phone.
3. In Railway, add the variable `ADMIN_TOTP_SECRET` with the secret and redeploy.
4. Open the admin page. Enter the token, then the code. You stay signed in for 8 hours, or until you press Lock.

If you lose the phone and the saved secret, remove `ADMIN_TOTP_SECRET` from the server and set up a new one. After this is on, scripts that call admin routes with only the token stop working; that is the point.
