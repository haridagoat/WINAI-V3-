"""
WIN AI: blend the current NBA season's stat files with the previous season's.

The current season dominates. The previous season is only a slight prior, and it fades as the season goes on:
  - up to 10 games in, a player or team leans on it more (a stat like usage from 1-4 games is not usable on its own)
  - from 10 games on it is about 15% of the value
  - from 20 to 60 games it fades down to about 5%
A row that exists only last season (a player who has not played yet) is kept as it was. A row that exists only this
season (a rookie) is kept as it is.

Per-game averages and rates are blended directly. Season TOTALS (points, rebounds, minutes in some files...) are blended
as per-game values and then multiplied back by this season's games played, so the files keep the shape the server
reads (total / GP = per game). Names, ids, ages, teams and rank columns always come from the current season.

Pure functions, tested in tests_py/test_season_blend.py.
"""
import json
import os
import shutil

PRIOR_FLOOR = 0.15          # prior weight once there are 10+ games
PRIOR_END = 0.05            # prior weight from 60 games on
EARLY_GAMES = 10            # below this many games the prior counts for more
MAX_PRIOR = 0.6

# Files fetched with nba.com's default "Totals" mode: some of their columns are season totals.
TOTALS_FILES = {
    'player_stats', 'player_advanced', 'player_misc', 'player_scoring',
    'team_traditional', 'team_advanced', 'team_four_factors', 'team_misc', 'team_scoring',
    'team_opp_shooting', 'team_defense', 'team_base',
}
# In these files MIN is the season total; in the others (player advanced/scoring, team scoring) it is minutes per game.
MIN_TOTAL_FILES = {
    'player_stats', 'player_misc', 'team_traditional', 'team_advanced', 'team_four_factors', 'team_misc',
    'team_opp_shooting', 'team_defense',
}
COUNT_COLS = {
    'FGM', 'FGA', 'FG3M', 'FG3A', 'FTM', 'FTA', 'OREB', 'DREB', 'REB', 'AST', 'TOV', 'STL', 'BLK', 'BLKA', 'PF', 'PFD',
    'PTS', 'PLUS_MINUS', 'NBA_FANTASY_PTS', 'WNBA_FANTASY_PTS', 'DD2', 'TD3', 'W', 'L', 'POSS',
    'PTS_OFF_TOV', 'PTS_2ND_CHANCE', 'PTS_FB', 'PTS_PAINT',
}
KEEP_NEW = {'PLAYER_ID', 'TEAM_ID', 'AGE', 'GP', 'TEAM_COUNT', 'CLOSE_DEF_PERSON_ID'}   # never blended
KEY_COLS = ('PLAYER_ID', 'CLOSE_DEF_PERSON_ID', 'TEAM_ID')                              # first one a file has is its row key


def prior_weight(games):
    """Share of the blended value that comes from last season, given how many games this season has produced."""
    if games is None or games <= 0:
        return 1.0
    if games <= 20:
        floor = PRIOR_FLOOR
    else:
        floor = max(PRIOR_END, PRIOR_FLOOR - (PRIOR_FLOOR - PRIOR_END) * (games - 20) / 40)
    boost = 0.5 * (1 - games / EARLY_GAMES) if games < EARLY_GAMES else 0.0
    return min(MAX_PRIOR, max(floor, boost))


def is_total(fname, col):
    if fname not in TOTALS_FILES:
        return False
    if col == 'MIN':
        return fname in MIN_TOTAL_FILES
    if col in COUNT_COLS:
        return True
    return col.startswith('OPP_') and not col.endswith(('_PCT', '_RATE', '_RATING'))


def _load(path):
    with open(path) as f:
        return json.load(f)


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v


def _key_of(rows):
    for k in KEY_COLS:
        if rows and k in rows[0]:
            return k
    return None


def blend_rows(fname, new_rows, prior_rows, team_games=None):
    """Blend two lists of row dicts. `team_games` is this season's games played so far, used for files whose rows have
    no GP column of their own."""
    if not prior_rows:
        return new_rows
    if not new_rows:
        return prior_rows
    key = _key_of(new_rows) or _key_of(prior_rows)
    if key is None:
        return new_rows
    new_keys = [r.get(key) for r in new_rows]
    prior_by = {}
    dup = set()
    for r in prior_rows:
        k = r.get(key)
        if k in prior_by:
            dup.add(k)
        prior_by[k] = r
    out = []
    for r in new_rows:
        k = r.get(key)
        p = prior_by.get(k)
        if p is None or k in dup or new_keys.count(k) > 1:
            out.append(r)
            continue
        g1 = r.get('GP') if _num(r.get('GP')) else team_games
        g0 = p.get('GP') if _num(p.get('GP')) else None
        if not g1 or g1 <= 0:                    # no games yet this season: nothing but last season to go on
            out.append(dict(p, **{c: r[c] for c in r if c in KEEP_NEW and c != 'GP'}))
            continue
        w0 = prior_weight(g1)
        w1 = 1 - w0
        row = dict(r)
        for col, v1 in r.items():
            v0 = p.get(col)
            if col in KEEP_NEW or col.endswith('_RANK') or not _num(v1) or not _num(v0):
                continue
            if is_total(fname, col):
                if not g0 or g0 <= 0 or not _num(r.get('GP')):
                    continue
                per_game = w1 * (v1 / g1) + w0 * (v0 / g0)
                row[col] = round(per_game * g1, 3)
            else:
                row[col] = round(w1 * v1 + w0 * v0, 6)
        out.append(row)
    # Players who have not appeared this season yet keep their last-season row (flagged), so a returning player has a baseline.
    seen = set(new_keys)
    for k, p in prior_by.items():
        if k not in seen and k is not None and key == 'PLAYER_ID':
            out.append(dict(p, PRIOR_SEASON_ONLY=True))
    return out


def team_games_played(rows):
    gps = sorted(r['GP'] for r in rows if _num(r.get('GP')))
    return gps[len(gps) // 2] if gps else None


MIN_ROWS_SHARE = 0.5     # a fresh file with fewer than half the rows of last season's is treated as a bad response


def _write_json_atomic(path, rows):
    """Write to a temporary file, then swap it in, so the server never reads a half-written file."""
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w') as f:
            json.dump(rows, f, allow_nan=False)    # refuse to write NaN or Infinity: Node cannot read them
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def blend_dir(raw_dir, prior_dir, out_dir, log=print):
    """Blend every json file present in raw_dir with its twin in prior_dir and write the result to out_dir.
    Returns the names written. A file is left as it was (and reported) when the fresh one looks like a bad response."""
    gp_ref = None
    tt = os.path.join(raw_dir, 'team_traditional.json')
    if os.path.exists(tt):
        gp_ref = team_games_played(_load(tt))
    wrote = []
    for fn in sorted(os.listdir(raw_dir)):
        if not fn.endswith('.json') or fn.startswith('package') or fn == 'season_meta.json':
            continue
        try:
            new_rows = _load(os.path.join(raw_dir, fn))
            pp = os.path.join(prior_dir, fn)
            if isinstance(new_rows, list) and os.path.exists(pp):
                prior_rows = _load(pp)
                if isinstance(prior_rows, list):
                    if len(prior_rows) >= 10 and len(new_rows) < MIN_ROWS_SHARE * len(prior_rows):
                        log(f"  SKIPPED {fn}: only {len(new_rows)} rows against {len(prior_rows)} last season, so it looks like a bad response. Left as it was.")
                        continue
                    new_rows = blend_rows(fn[:-5], new_rows, prior_rows, gp_ref)
            _write_json_atomic(os.path.join(out_dir, fn), new_rows)
            wrote.append(fn)
        except Exception as e:           # one bad file must not stop the others
            log(f"  SKIPPED {fn}: {e}")
    log(f"  Blended {len(wrote)} files (this season {gp_ref} games in; last-season weight {prior_weight(gp_ref):.0%} for a team)")
    return wrote


def current_nba_season(today=None):
    import datetime
    d = today or datetime.date.today()
    y = d.year if d.month >= 10 else d.year - 1
    return f"{y}-{(y + 1) % 100:02d}"
