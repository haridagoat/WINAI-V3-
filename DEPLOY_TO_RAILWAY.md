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
git add server.js package.json package-lock.json public/index.html railway.json Procfile
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
