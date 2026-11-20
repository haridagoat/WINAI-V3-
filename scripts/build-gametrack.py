#!/usr/bin/env python3
"""
Builds gametrack_nba.json: every player's box score for every game this season, with nba.com's player-tracking numbers for that game
(rebound chances, passes, secondary assists, free-throw assists, touches). The live site reads it for the "Opportunities, game by game" graphs.

  python3 scripts/build-gametrack.py            add the games played since the last run (the first run fetches the whole season, a few minutes)
  python3 scripts/build-gametrack.py --full     start again from nothing

One call gives every player's basic box score for the season; one more call per NEW game gives the tracking numbers for both teams.
Potential assists are only published as season averages (tracking_passing_player.json), not per game, so they are not here.
"""
import json, os, sys, time
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(HERE)
try:
    from nba_api.stats.endpoints import leaguegamelog, boxscoreplayertrackv3
except ImportError:
    print('nba_api is not installed'); sys.exit(1)

OUT = 'gametrack_nba.json'
SLEEP = 0.7

def season():
    try:
        return json.load(open('season_meta.json')).get('season')
    except Exception:
        return None

def mins(v):
    try:
        s = str(v)
        if ':' in s:
            a, b = s.split(':')[:2]; return round(int(a) + int(b) / 60, 1)
        return round(float(s), 1)
    except Exception:
        return 0.0

def num(v, d=0):
    try:
        f = float(v)
        return d if f != f else f
    except Exception:
        return d

def retry(fn, tries=3):
    for i in range(tries):
        try:
            return fn()
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(3 * (i + 1))

def main():
    full = '--full' in sys.argv
    sea = season()
    if not sea:
        print('No season_meta.json here. Run the stats fetch first.'); sys.exit(1)
    old = {}
    if not full and os.path.exists(OUT):
        try: old = json.load(open(OUT)).get('games', {})
        except Exception: old = {}
    log = retry(lambda: leaguegamelog.LeagueGameLog(season=sea, player_or_team_abbreviation='P', season_type_all_star='Regular Season', timeout=90).get_data_frames()[0])
    if log.empty:
        print('nba.com returned no games'); sys.exit(1)
    games = {}
    for r in log.to_dict('records'):
        gid = str(r['GAME_ID']); pid = str(r['PLAYER_ID'])
        g = games.setdefault(gid, {'date': str(r['GAME_DATE'])[:10], 'players': {}})
        g['players'][pid] = {
            'n': r['PLAYER_NAME'], 't': r['TEAM_ABBREVIATION'], 'm': r['MATCHUP'], 'wl': r.get('WL'),
            'min': mins(r['MIN']), 'pts': int(num(r['PTS'])), 'reb': int(num(r['REB'])), 'ast': int(num(r['AST'])), 'fg3m': int(num(r['FG3M'])),
            'stl': int(num(r['STL'])), 'blk': int(num(r['BLK'])), 'tov': int(num(r['TOV'])), 'fga': int(num(r['FGA'])), 'fgm': int(num(r['FGM'])),
            'oreb': int(num(r['OREB'])), 'dreb': int(num(r['DREB'])),
        }
    new_ids = [g for g in games if not old.get(g, {}).get('tracked')]
    print(f'{sea}: {len(games)} games, {len(new_ids)} to add tracking numbers for')
    failed = 0
    for i, gid in enumerate(sorted(new_ids)):
        try:
            dfs = retry(lambda: boxscoreplayertrackv3.BoxScorePlayerTrackV3(game_id=gid, timeout=60).get_data_frames())
            for r in dfs[0].to_dict('records'):
                p = games[gid]['players'].get(str(r['personId']))
                if not p: continue
                p['rc'] = int(num(r.get('reboundChancesTotal'))); p['orc'] = int(num(r.get('reboundChancesOffensive'))); p['drc'] = int(num(r.get('reboundChancesDefensive')))
                p['pas'] = int(num(r.get('passes'))); p['sast'] = int(num(r.get('secondaryAssists'))); p['fast'] = int(num(r.get('freeThrowAssists'))); p['tch'] = int(num(r.get('touches')))
            games[gid]['tracked'] = True
        except Exception as e:
            failed += 1
            print(f'  {gid}: tracking not available ({str(e)[:60]}); the box score is kept without it')
            games[gid]['tracked'] = False
        if (i + 1) % 20 == 0: print(f'  {i + 1}/{len(new_ids)}')
        time.sleep(SLEEP)
    for gid, g in games.items():                       # games already built keep their tracking numbers
        if gid in old and old[gid].get('tracked') and not g.get('tracked'):
            for pid, p in g['players'].items():
                o = old[gid]['players'].get(pid, {})
                for k in ('rc', 'orc', 'drc', 'pas', 'sast', 'fast', 'tch'):
                    if k in o: p[k] = o[k]
            g['tracked'] = True
    tmp = OUT + '.tmp'
    json.dump({'builtAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'season': sea, 'games': games}, open(tmp, 'w'), separators=(',', ':'))
    os.replace(tmp, OUT)
    tracked = sum(1 for g in games.values() if g.get('tracked'))
    print(f'Done: {len(games)} games ({tracked} with tracking numbers, {failed} failed this time) -> {OUT}, {os.path.getsize(OUT) / 1048576:.1f} MB')

if __name__ == '__main__':
    main()
