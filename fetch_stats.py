"""
WIN AI — NBA Stats Fetcher
Compatible with nba_api 1.11.4 / Python 3.14
Run daily before using WIN AI. Takes 3-5 min due to nba.com rate limiting.
"""
import json, time, os, shutil

import season_blend

from nba_api.stats.endpoints import (
    leaguedashteamstats,
    leaguedashplayerstats,
    leaguedashteamshotlocations,
    leaguedashplayershotlocations,
    leaguedashptdefend,
    leaguedashptteamdefend,
    leaguedashptstats,
    leaguehustlestatsplayer,
    leaguehustlestatsteam,
    synergyplaytypes,
)

# The season follows the calendar (October starts a new one); set WINAI_SEASON to force one.
SEASON = os.environ.get('WINAI_SEASON') or season_blend.current_nba_season()
SLEEP  = 2.5

# The current season is fetched into RAW_DIR untouched. At the end it is blended with last season's files (PRIOR_DIR) and
# the blended result is written next to this script, where the server reads it. Current season dominates; last season is
# a slight prior that fades (see season_blend.py).
RAW_DIR   = 'season_raw'
PRIOR_DIR = 'prior_season'

def _previous_season(season):
    y = int(season[:4])
    return f"{y - 1}-{y % 100:02d}"

def _meta(d):
    try:
        with open(os.path.join(d, 'season_meta.json')) as f:
            return json.load(f).get('season')
    except Exception:
        return None

def prepare_dirs():
    """Make sure last season's files are kept as the prior, and the raw folder belongs to this season."""
    raw_has_files = os.path.isdir(RAW_DIR) and any(f.endswith('.json') and f != 'season_meta.json' for f in os.listdir(RAW_DIR))
    if raw_has_files and _meta(RAW_DIR) not in (None, SEASON):
        # A new season has started since the last run: the old raw files become the prior.
        shutil.rmtree(PRIOR_DIR, ignore_errors=True)
        shutil.copytree(RAW_DIR, PRIOR_DIR)
        shutil.rmtree(RAW_DIR)
        print(f"  New season {SEASON}: kept the {_meta(PRIOR_DIR)} files as the prior")
    elif not os.path.isdir(PRIOR_DIR):
        # First run of this setup: the files already here are last season's, so they become the prior.
        os.makedirs(PRIOR_DIR)
        NOT_NBA_STATS = {'clv_tracker.json', 'scouting_notes.json', 'slate_scan_cache.json', 'test_results.json', 'railway.json', 'season_meta.json'}
        for f in os.listdir('.'):
            if f.endswith('.json') and not f.startswith(('package', 'wnba_')) and f not in NOT_NBA_STATS:
                shutil.copy(f, os.path.join(PRIOR_DIR, f))
        with open(os.path.join(PRIOR_DIR, 'season_meta.json'), 'w') as f:
            json.dump({'season': _previous_season(SEASON)}, f)
        print(f"  First run: saved the existing files as the {_previous_season(SEASON)} prior")
    os.makedirs(RAW_DIR, exist_ok=True)
    with open(os.path.join(RAW_DIR, 'season_meta.json'), 'w') as f:
        json.dump({'season': SEASON}, f)

prepare_dirs()

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
    filename = os.path.join(RAW_DIR, filename)
    with open(filename, 'w') as f:
        json.dump(_sanitize(data), f)
    print(f"  Saved {filename} ({len(data)} rows)")

def safe_cols(df, wanted):
    return [c for c in wanted if c in df.columns]

def fetch(label, fn, **kw):
    print(f"[FETCH] {label}...")
    for attempt in range(3):
        try:
            result = fn(**kw)
            # Handle both get_data_frames() and cases where index 0 fails
            frames = result.get_data_frames()
            if not frames or len(frames) == 0:
                print(f"  ERROR: No data frames returned")
                return None
            df = frames[0]
            if df is None or len(df) == 0:
                print(f"  ERROR: Empty data frame")
                return None
            # Some endpoints (shot locations) return two-level column names like ('Restricted Area', 'FGM');
            # flatten to 'Restricted Area_FGM' so the rows can be written as JSON.
            if getattr(df.columns, 'nlevels', 1) > 1:
                df.columns = ['_'.join(str(p) for p in col if p) for col in df.columns]
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
print(f"WIN AI Stats Fetcher | {SEASON}")
print("=" * 60)

# ── TEAM GENERAL ─────────────────────────────────────────────────
# measure_type_detailed_defense is correct for LeagueDashTeamStats
for label, mtype, fname in [
    ("Team Traditional",  "Base",         "team_traditional.json"),
    ("Team Advanced",     "Advanced",     "team_advanced.json"),
    ("Team Four Factors", "Four Factors", "team_four_factors.json"),
    ("Team Misc",         "Misc",         "team_misc.json"),
    ("Team Scoring",      "Scoring",      "team_scoring.json"),
    ("Team Opponent",     "Opponent",     "team_opp_shooting.json"),
    ("Team Defense",      "Defense",      "team_defense.json"),
]:
    df = fetch(label, leaguedashteamstats.LeagueDashTeamStats,
               season=SEASON, measure_type_detailed_defense=mtype)
    if df is not None:
        save(fname, df.to_dict('records'))
    time.sleep(SLEEP)

df = fetch("Team Base", leaguedashteamstats.LeagueDashTeamStats,
           season=SEASON, measure_type_detailed_defense='Base')
if df is not None:
    c = safe_cols(df, ['TEAM_NAME','W','L','PTS','REB','AST','OPP_PTS'])
    save('team_base.json', df[c].to_dict('records'))
time.sleep(SLEEP)

# ── PLAYER GENERAL ────────────────────────────────────────────────
# measure_type_detailed_defense is correct for LeagueDashPlayerStats on
# nba_api 1.11.4 — measure_type_simple_nullable doesn't exist on this
# version and was silently failing every one of these fetches.
# "Opponent" is not a valid measure type at player granularity (confirmed
# KeyError on both NBA and WNBA) — it's a team-only concept, so it's
# deliberately not in this list; player_opponent.json will never exist.
for label, mtype, fname in [
    ("Player Traditional", "Base",     "player_stats.json"),
    ("Player Advanced",    "Advanced", "player_advanced.json"),
    ("Player Misc",        "Misc",     "player_misc.json"),
    ("Player Scoring",     "Scoring",  "player_scoring.json"),
]:
    df = fetch(label, leaguedashplayerstats.LeagueDashPlayerStats,
               season=SEASON, measure_type_detailed_defense=mtype)
    if df is not None:
        save(fname, df.to_dict('records'))
    time.sleep(SLEEP)

# ── TEAM PAINT DEFENSE ────────────────────────────────────────────
# Paint defense = how teams defend shots inside 6 feet (nba_api 1.11 has no 'PaintTouch' option on LeagueDashTeamPtShot).
df = fetch("Team Paint Defense", leaguedashptteamdefend.LeagueDashPtTeamDefend,
           season=SEASON, defense_category='Less Than 6Ft',
           per_mode_simple='PerGame', season_type_all_star='Regular Season')
if df is not None:
    save('team_paint_defense.json', df.to_dict('records'))
time.sleep(SLEEP)

# ── PLAYER TRACKING ───────────────────────────────────────────────
# per_mode_simple='PerGame' is correct for LeagueDashPtStats
TRACKING = [
    ('PaintTouch',              'player_paint_stats.json'),
    ('Drives',                  'tracking_drives_player.json'),
    ('CatchShoot',              'tracking_catchshoot_player.json'),
    ('Passing',                 'tracking_passing_player.json'),
    ('Touches',                 'tracking_touches_player.json'),
    ('PullUpShot',              'tracking_pullupshot_player.json'),
    ('ElbowTouch',              'tracking_elbowtouch_player.json'),
    ('PostTouch',               'tracking_posttouch_player.json'),
    ('SpeedDistance',           'tracking_speeddistance_player.json'),
    ('Efficiency',              'tracking_efficiency_player.json'),
    # nba.com's measure is called "Rebounding" (the old 'OffensiveReboundChances' / 'DefensiveReboundChances' names are not accepted and never produced a file):
    # rebound chances, contested and uncontested rebounds and how often a chance is converted, offensive, defensive and total.
    ('Rebounding',              'tracking_rebounding_player.json'),
]
for pt_type, fname in TRACKING:
    df = fetch(f"Tracking {pt_type}", leaguedashptstats.LeagueDashPtStats,
               season=SEASON, pt_measure_type=pt_type,
               per_mode_simple='PerGame', player_or_team='Player',
               season_type_all_star='Regular Season')
    if df is not None:
        save(fname, df.to_dict('records'))
    time.sleep(SLEEP)

for pt_type, fname in [
    ('PaintTouch', 'tracking_painttouch_team.json'),
    ('Drives',     'tracking_drives_team.json'),
]:
    df = fetch(f"Tracking {pt_type} (Team)", leaguedashptstats.LeagueDashPtStats,
               season=SEASON, pt_measure_type=pt_type,
               per_mode_simple='PerGame', player_or_team='Team',
               season_type_all_star='Regular Season')
    if df is not None:
        save(fname, df.to_dict('records'))
    time.sleep(SLEEP)

# ── DEFENSE DASHBOARD ─────────────────────────────────────────────
# defense_category_nullable was renamed — fetch overall only (no zone filter)
# The overall file contains all shot zone data in one frame
df = fetch("Defense Dashboard Overall", leaguedashptdefend.LeagueDashPtDefend,
           season=SEASON,
           per_mode_simple='PerGame',
           season_type_all_star='Regular Season')
if df is not None:
    save('defense_overall.json', df.to_dict('records'))
    print(f"  Columns: {list(df.columns[:10])}")
time.sleep(SLEEP)

# ── SHOT DASHBOARD ────────────────────────────────────────────────
# Shot locations — use per_mode_simple='PerGame'
# These endpoints don't take range_type params — just fetch the full dashboard
df = fetch("Shot Dashboard Player (General)",
           leaguedashplayershotlocations.LeagueDashPlayerShotLocations,
           season=SEASON,
           per_mode_detailed='PerGame',
           season_type_all_star='Regular Season')
if df is not None:
    save('shotdash_general_player.json', df.to_dict('records'))
time.sleep(SLEEP)

df = fetch("Shot Dashboard Team (General)",
           leaguedashteamshotlocations.LeagueDashTeamShotLocations,
           season=SEASON,
           per_mode_detailed='PerGame',
           season_type_all_star='Regular Season')
if df is not None:
    save('shotdash_general_team.json', df.to_dict('records'))
    save('opp_shotdash_general_team.json', df.to_dict('records'))
time.sleep(SLEEP)

# ── HUSTLE STATS ──────────────────────────────────────────────────
# per_mode_time is the parameter name in nba_api 1.11 (per_mode_nullable no longer exists)
df = fetch("Hustle Player", leaguehustlestatsplayer.LeagueHustleStatsPlayer,
           season=SEASON,
           per_mode_time='PerGame',
           season_type_all_star='Regular Season')
if df is not None:
    save('hustle_player.json', df.to_dict('records'))
time.sleep(SLEEP)

df = fetch("Hustle Team", leaguehustlestatsteam.LeagueHustleStatsTeam,
           season=SEASON,
           per_mode_time='PerGame',
           season_type_all_star='Regular Season')
if df is not None:
    save('hustle_team.json', df.to_dict('records'))
time.sleep(SLEEP)

# ── PLAYTYPES (Synergy) ───────────────────────────────────────────
# SynergyPlayTypes returns multiple result sets — use index carefully
PLAYTYPES = [
    ('Isolation','isolation'),('Transition','transition'),
    ('PRBallHandler','ballhandler'),('PRRollman','rollman'),
    ('PostUp','postup'),('SpotUp','spotup'),('Handoff','handoff'),
    ('Cut','cut'),('OffScreen','offscreen'),('Putbacks','putbacks'),
]

def _rows_from_raw_resultsets(raw):
    """nba.com's own JSON, parsed by hand — resultSets/headers/rowSet, the
    same shape get_data_frames() is supposed to build from."""
    rs = raw.get('resultSets') or raw.get('resultSet') or []
    if isinstance(rs, dict):
        rs = [rs]
    if not rs:
        return []
    return [dict(zip(rs[0]['headers'], row)) for row in rs[0]['rowSet']]

def fetch_synergy(label, ptype, pot, grp):
    print(f"[FETCH] Playtype {label} ({'player_off' if pot=='P' else 'team_def'})...")
    for attempt in range(3):
        result = None
        try:
            result = synergyplaytypes.SynergyPlayTypes(
                season=SEASON,
                play_type_nullable=ptype,
                per_mode_simple='PerGame',
                player_or_team_abbreviation=pot,
                type_grouping_nullable=grp,
                season_type_all_star='Regular Season'
            )
            frames = result.get_data_frames()
            # SynergyPlayTypes may return result at index 0 or in normalized dict
            if frames and len(frames) > 0 and frames[0] is not None and len(frames[0]) > 0:
                print(f"  OK ({len(frames[0])} rows)")
                return frames[0]
            # Try normalized dict as fallback
            nd = result.get_normalized_dict()
            if nd:
                first_key = list(nd.keys())[0]
                rows = nd[first_key]
                if rows:
                    import pandas as pd
                    df = pd.DataFrame(rows)
                    print(f"  OK via normalized ({len(df)} rows)")
                    return df
            print(f"  ERROR: No data in response")
            return None
        except Exception as e:
            msg = str(e)
            if '429' in msg or 'rate' in msg.lower():
                wait = (attempt + 1) * 10
                print(f"  Rate limited — waiting {wait}s...")
                time.sleep(wait)
                continue
            # If the object itself got built, try parsing its raw JSON by
            # hand before giving up on this attempt — get_data_frames() can
            # raise a bare KeyError('resultSet') even when the underlying
            # response is fine (confirmed live).
            if result is not None:
                try:
                    rows = _rows_from_raw_resultsets(result.get_dict())
                    if rows:
                        import pandas as pd
                        df = pd.DataFrame(rows)
                        print(f"  OK via raw resultSets ({len(df)} rows)")
                        return df
                except Exception:
                    pass
            # A bare KeyError('resultSet') can also happen INSIDE
            # SynergyPlayTypes's own constructor (confirmed live — nba.com
            # itself intermittently returns a malformed response for some
            # play-type+defensive combinations, not consistently, so a
            # retry with backoff — same as the rate-limit path — genuinely
            # helps here instead of being a permanent failure).
            if "resultSet" in msg and attempt < 2:
                wait = (attempt + 1) * 8
                print(f"  Malformed response from nba.com — retrying in {wait}s...")
                time.sleep(wait)
                continue
            print(f"  ERROR: {e}")
            return None
    return None

# ── BLEND FIRST ───────────────────────────────────────────────────
# Everything above is saved. Blend and publish it now, before the play-type calls below: those are the slow and unreliable part (nba.com often
# answers them with malformed responses, and each is retried), and a run that is cut short there used to leave every stat file days old.
print("\n[BLEND] This season is the base; last season is a slight prior...")
season_blend.blend_dir(RAW_DIR, PRIOR_DIR, '.')
with open('season_meta.json', 'w') as f:
    json.dump({'season': SEASON, 'blended_with': _meta(PRIOR_DIR), 'blended_at': time.strftime('%Y-%m-%dT%H:%M:%S')}, f)

# Play types. After three failures in a row, or six minutes, the rest are skipped and the last good files stay as they are.
SYNERGY_BUDGET_S, SYNERGY_MAX_FAILS = 6 * 60, 3
synergy_started, synergy_fails, synergy_stopped = time.time(), 0, False
for label, ptype in PLAYTYPES:
    for pot, grp, gname in [('P','offensive','player_off'),('T','defensive','team_def')]:
        if synergy_stopped:
            break
        if synergy_fails >= SYNERGY_MAX_FAILS or time.time() - synergy_started > SYNERGY_BUDGET_S:
            print(f"  Skipping the remaining play types ({synergy_fails} failures in a row, {int(time.time() - synergy_started)}s used); keeping the last good files.")
            synergy_stopped = True
            break
        df = fetch_synergy(label, ptype, pot, grp)
        if df is not None:
            synergy_fails = 0
            save(f'playtype_{ptype}_{gname}.json', df.to_dict('records'))
        else:
            synergy_fails += 1
        time.sleep(SLEEP)

# ── BLEND WITH LAST SEASON ────────────────────────────────────────
print("\n[BLEND] This season is the base; last season is a slight prior...")
season_blend.blend_dir(RAW_DIR, PRIOR_DIR, '.')
with open('season_meta.json', 'w') as f:
    json.dump({'season': SEASON, 'blended_with': _meta(PRIOR_DIR), 'blended_at': time.strftime('%Y-%m-%dT%H:%M:%S')}, f)

# ── SUMMARY ───────────────────────────────────────────────────────
all_files = sorted([f for f in os.listdir('.') if f.endswith('.json')
                    and not f.startswith('package')])
print(f"\n{'='*60}")
print(f"DONE — {len(all_files)} JSON files saved:")
for f in all_files:
    kb = os.path.getsize(f) // 1024
    print(f"  {f:<50} {kb}kb")
print("="*60)
print("\nRun daily before using WIN AI.")
