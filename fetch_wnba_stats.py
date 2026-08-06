"""
WIN AI — WNBA Stats Fetcher
Mirrors fetch_stats.py but pulls from stats.nba.com with LeagueID='10' (WNBA) —
the same underlying database that serves nba.com, just a different league ID.
Run daily before using WIN AI's WNBA tab.

NOTE: Synergy playtypes, SportVU/Second Spectrum tracking (drives, touches,
paint touches, catch & shoot, etc.), hustle stats, and the pt-defend shot
dashboard all confirmed return 0 rows / unsupported params for LeagueID=10 —
those data sources genuinely don't exist for the WNBA and are not fetched
here. Team/player box-score-derived stats (traditional, advanced, four
factors, misc, scoring, opponent, shot locations) and full shot chart detail
DO exist and are pulled below.
"""
import json, time, os

from nba_api.stats.endpoints import (
    leaguedashteamstats,
    leaguedashplayerstats,
    leaguedashplayershotlocations,
)


# stats.nba.com's WNBA endpoints want a single year ('2026'), not the
# NBA-style 'YYYY-YY' range ('2025-26') used in fetch_stats.py — the WNBA
# season runs within one calendar year, unlike the NBA's. Passing the wrong
# format doesn't error, it silently returns the prior *completed* season
# (confirmed: '2025-26' and '2025' both return identical results — Atlanta
# Dream 30-14/44 GP — while '2026' returns the real live 18-11/29 GP that
# matches ESPN). This was already fixed in shotchart.py's
# to_wnba_stats_season() but never applied here, so every team/player file
# this script produces has been serving last season's final stats.
SEASON     = '2026'
LEAGUE_ID  = '10'  # WNBA
SLEEP      = 2.5

def _sanitize(obj):
    """Python's json module writes bare NaN/Infinity by default, which is
    NOT valid JSON — Node's JSON.parse rejects it outright, silently
    breaking any file with a 0-attempt shooting split (0/0 -> NaN in
    pandas). Replace with null so every consumer can actually parse it."""
    if isinstance(obj, float) and (obj != obj or obj in (float('inf'), float('-inf'))):
        return None
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    return obj

def save(filename, data):
    with open(filename, 'w') as f:
        json.dump(_sanitize(data), f)
    print(f"  Saved {filename} ({len(data)} rows)")

def fetch(label, fn, **kw):
    print(f"[FETCH] {label}...")
    for attempt in range(3):
        try:
            result = fn(**kw)
            frames = result.get_data_frames()
            if not frames or len(frames) == 0:
                print(f"  ERROR: No data frames returned")
                return None
            df = frames[0]
            if df is None or len(df) == 0:
                print(f"  ERROR: Empty data frame")
                return None
            print(f"  OK ({len(df)} rows)")
            return df
        except Exception as e:
            msg = str(e)
            if '429' in msg or 'rate' in msg.lower():
                wait = (attempt + 1) * 10
                print(f"  Rate limited — waiting {wait}s...")
                time.sleep(wait)
            else:
                print(f"  ERROR: {e}")
                return None
    print(f"  FAILED after 3 attempts")
    return None

print("=" * 60)
print(f"WIN AI WNBA Stats Fetcher | {SEASON}")
print("=" * 60)

# ── TEAM GENERAL ─────────────────────────────────────────────────
for label, mtype, fname in [
    ("Team Traditional",  "Base",         "wnba_team_traditional.json"),
    ("Team Advanced",     "Advanced",     "wnba_team_advanced.json"),
    ("Team Four Factors", "Four Factors", "wnba_team_four_factors.json"),
    ("Team Misc",         "Misc",         "wnba_team_misc.json"),
    ("Team Scoring",      "Scoring",      "wnba_team_scoring.json"),
    ("Team Opponent",     "Opponent",     "wnba_team_opp_shooting.json"),
]:
    df = fetch(label, leaguedashteamstats.LeagueDashTeamStats,
               season=SEASON, league_id_nullable=LEAGUE_ID, measure_type_detailed_defense=mtype)
    if df is not None:
        save(fname, df.to_dict('records'))
    time.sleep(SLEEP)

# ── PLAYER GENERAL ────────────────────────────────────────────────
# "Opponent" is not a valid measure type at player granularity (confirmed
# KeyError on both NBA and WNBA) — deliberately omitted here.
for label, mtype, fname in [
    ("Player Traditional", "Base",     "wnba_player_stats.json"),
    ("Player Advanced",    "Advanced", "wnba_player_advanced.json"),
    ("Player Misc",        "Misc",     "wnba_player_misc.json"),
    ("Player Scoring",     "Scoring",  "wnba_player_scoring.json"),
]:
    df = fetch(label, leaguedashplayerstats.LeagueDashPlayerStats,
               season=SEASON, league_id_nullable=LEAGUE_ID, measure_type_detailed_defense=mtype)
    if df is not None:
        save(fname, df.to_dict('records'))
    time.sleep(SLEEP)

# ── PLAYER SHOT LOCATIONS (zone-based, not SportVU tracking) ──────
# This endpoint returns MultiIndex columns like ('Restricted Area','FGM') —
# flatten to 'Restricted Area_FGM' so json.dump can serialize the keys.
df = fetch("Player Shot Locations", leaguedashplayershotlocations.LeagueDashPlayerShotLocations,
           season=SEASON, league_id_nullable=LEAGUE_ID, per_mode_detailed='PerGame',
           season_type_all_star='Regular Season')
if df is not None:
    df.columns = ['_'.join(str(p) for p in col if p) for col in df.columns]
    save('wnba_shotdash_general_player.json', df.to_dict('records'))
time.sleep(SLEEP)

# ── SUMMARY ───────────────────────────────────────────────────────
all_files = sorted([f for f in os.listdir('.') if f.startswith('wnba_') and f.endswith('.json')])
print(f"\n{'='*60}")
print(f"DONE — {len(all_files)} WNBA JSON files saved:")
for f in all_files:
    kb = os.path.getsize(f) // 1024
    print(f"  {f:<50} {kb}kb")
print("="*60)
print("\nRun daily before using WIN AI's WNBA tab.")
