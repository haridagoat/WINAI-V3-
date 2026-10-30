#!/bin/zsh
# Runs the live attack suite against a throwaway copy of the app: its own database, the admin second factor switched on, a slow
# fake AI, and every outside key blank, so it cannot spend credits, send email or touch real data.
#   scripts/redteam.sh        (about a minute; prints PASS/FAIL per attack)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; TMP="$(mktemp -d)"; PORT=${RT_PORT:-3081}
cleanup() { [ -n "$SRV" ] && kill $SRV 2>/dev/null; [ -n "$AI" ] && kill $AI 2>/dev/null; rm -rf "$TMP"; }; trap cleanup EXIT
lsof -nP -iTCP:$PORT -sTCP:LISTEN -t | xargs -I{} kill {} 2>/dev/null; lsof -nP -iTCP:4010 -sTCP:LISTEN -t | xargs -I{} kill {} 2>/dev/null; sleep 1
node "$ROOT/test/redteam/fake_ai.js" >/dev/null 2>&1 & AI=$!
cd "$ROOT" && PORT=$PORT WINAI_DB="$TMP/redteam.db" ADMIN_TOKEN=audit-token-123 ADMIN_TOTP_SECRET=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ AUTH_DEV_LINKS=1 ADMIN_EMAIL=owner@example.com \
  ANTHROPIC_KEY=sk-ant-fake ANTHROPIC_BASE_URL=http://localhost:4010 ODDS_API_KEY= BALLDONTLIE_KEY= RESEND_API_KEY= MAIL_FROM= STRIPE_SECRET_KEY= STRIPE_WEBHOOK_SECRET= STRIPE_PRICE_ID= PAYWALL= \
  GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET= BACKUP_S3_ENDPOINT= HEARTBEAT_URL= ADMIN_ALERT_WEBHOOK= \
  node --disable-warning=ExperimentalWarning server.js >"$TMP/server.log" 2>&1 & SRV=$!
for i in $(seq 1 30); do sleep 1; curl -s -o /dev/null -m 2 http://localhost:$PORT/api/ping && break; done
RT_PORT=$PORT node "$ROOT/test/redteam/attack.js"
