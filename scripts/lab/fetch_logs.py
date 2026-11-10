"""
Downloads league-wide game logs for the replay lab: one nba.com call per season and kind returns EVERY player's game lines (or every
team's results) for that season, so a few calls give the lab tens of thousands of player-games to learn from.

    python3 scripts/lab/fetch_logs.py            # this season, last season, the one before
Writes lab_data/players_<season>.json and lab_data/teams_<season>.json (ignored by git).
"""
import json, os, sys, time
from nba_api.stats.endpoints import leaguegamelog

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
OUT = os.path.join(ROOT, 'lab_data')
sys.path.insert(0, ROOT)
import season_blend

PLAYER_COLS = ['PLAYER_ID', 'PLAYER_NAME', 'TEAM_ID', 'TEAM_ABBREVIATION', 'GAME_ID', 'GAME_DATE', 'MATCHUP', 'WL', 'MIN',
               'PTS', 'REB', 'AST', 'FG3M', 'STL', 'BLK', 'TOV', 'FGA', 'FTA', 'PLUS_MINUS']
TEAM_COLS = ['TEAM_ID', 'TEAM_ABBREVIATION', 'GAME_ID', 'GAME_DATE', 'MATCHUP', 'WL', 'PTS', 'PLUS_MINUS']


def seasons():
    cur = season_blend.current_nba_season()
    y = int(cur[:4])
    return [f"{y - i}-{str(y - i + 1)[2:]}" for i in range(3)]


def fetch(season, kind, cols):
    for attempt in range(4):
        try:
            df = leaguegamelog.LeagueGameLog(season=season, player_or_team_abbreviation=kind, season_type_all_star='Regular Season', timeout=60).get_data_frames()[0]
            rows = df[[c for c in cols if c in df.columns]].to_dict('records')
            for r in rows:
                for k, v in list(r.items()):
                    if v != v:   # NaN -> None
                        r[k] = None
            return rows
        except Exception as e:
            print(f'  retry {attempt + 1} for {season} {kind}: {e}', flush=True)
            time.sleep(3 + attempt * 3)
    return None


def fetch_positions():
    """Every player's listed position (G, F, C, G-F, ...), so the lab can group players into guards, forwards and centers."""
    from nba_api.stats.endpoints import playerindex
    for attempt in range(4):
        try:
            df = playerindex.PlayerIndex(historical_nullable=1, timeout=60).get_data_frames()[0]
            rows = {str(int(r.PERSON_ID)): r.POSITION for r in df.itertuples() if isinstance(r.POSITION, str) and r.POSITION}
            path = os.path.join(OUT, 'positions.json')
            with open(path, 'w') as f:
                json.dump(rows, f, allow_nan=False)
            print(f'positions: {len(rows)} players -> {os.path.relpath(path, ROOT)}', flush=True)
            return
        except Exception as e:
            print(f'  retry {attempt + 1} for positions: {e}', flush=True)
            time.sleep(3 + attempt * 3)
    print('positions: FAILED', flush=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    fetch_positions()
    for season in seasons():
        for kind, cols, name in (('P', PLAYER_COLS, 'players'), ('T', TEAM_COLS, 'teams')):
            rows = fetch(season, kind, cols)
            if rows is None:
                print(f'{season} {name}: FAILED', flush=True)
                continue
            path = os.path.join(OUT, f'{name}_{season}.json')
            with open(path, 'w') as f:
                json.dump(rows, f, allow_nan=False)
            print(f'{season} {name}: {len(rows)} rows -> {os.path.relpath(path, ROOT)}', flush=True)
            time.sleep(1.5)


if __name__ == '__main__':
    main()
