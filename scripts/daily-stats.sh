#!/bin/bash
# Fetches fresh NBA stats on this computer and uploads them to the live site. Run daily by a macOS scheduled job
# (see the "Stats on Railway" section of DEPLOY_TO_RAILWAY.md). Safe to run by hand:  scripts/daily-stats.sh
# Add "push-only" to skip the fetch and just upload the files already here.
# The live address is LIVE_SITE_URL in .env.
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:/Library/Frameworks/Python.framework/Versions/3.13/bin:/usr/bin:/bin"
LOG="$HOME/Library/Logs/winai-stats.log"
mkdir -p "$(dirname "$LOG")"
{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') daily stats ==="
  if [ "${1:-}" != "push-only" ]; then
    if python3 fetch_stats.py > /tmp/winai-fetch.out 2>&1; then tail -3 /tmp/winai-fetch.out; else echo "FETCH FAILED (exit $?). Last lines:"; tail -8 /tmp/winai-fetch.out; fi
  fi
  if [ "${1:-}" != "push-only" ]; then
    # every player's and team's shot chart (about 10 minutes); a failure keeps yesterday's copies and does not stop the upload
    node scripts/build-shotcharts.js 2>&1 | tail -3 || echo "SHOT CHARTS FAILED"
  fi
  node scripts/push-stats.js || echo "UPLOAD FAILED"
  echo
} >> "$LOG" 2>&1
tail -n 12 "$LOG"
