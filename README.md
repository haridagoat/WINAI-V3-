# WIN AI

NBA and WNBA player-prop analytics: projections, sportsbook lines, matchups and a tracked record. Analytics, not betting advice. Must be 21+.

Node (Express) server, a single-page front end in `public/`, SQLite storage (`winai.db`), and Python scripts that fetch stats.

```bash
cp .env.example .env     # then fill in the keys you have (see the comments in the file)
npm install
npm start                # http://localhost:3001
npm test                 # the whole suite
```

| Read | For |
|---|---|
| [SETUP_GUIDE.txt](SETUP_GUIDE.txt) | first-time setup, step by step |
| [DEPLOY_TO_RAILWAY.md](DEPLOY_TO_RAILWAY.md) | going live: hosting, backups, accounts, payments, monitoring |
| [METHODOLOGY.md](METHODOLOGY.md) | how the projections, win chances and confidence are worked out |
| [.env.example](.env.example) | every setting, with what it does |

Layout: `server.js` (routes and scheduled jobs), `lib/` (the math and services, each with tests in `test/`), `public/index.html` (the app) and `public/admin.html` (the admin page, behind `ADMIN_TOKEN`), `fetch_*.py` and `predict_tonight.py` (stat fetchers), `scripts/` (backup restore, the replay lab, red-team checks).
