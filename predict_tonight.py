#!/usr/bin/env python3
"""
WIN AI — NBA API Bridge
Usage:
  python3 predict_tonight.py "Player Name"
  python3 predict_tonight.py "Player Name" 2025-26
  python3 predict_tonight.py "Player Name" 2025-26 "Opponent Team"  <- H2H mode
"""
import sys, json, time

try:
    from nba_api.stats.endpoints import playergamelog
    from nba_api.stats.static import players as nba_players
except ImportError:
    print(json.dumps({"error": "nba_api not installed. Run: pip3 install nba_api pandas"}))
    sys.exit(1)

# ── Complete team name/city/nickname → nba.com MATCHUP abbreviation ──
# Every possible way a user might type a team name
TEAM_ABBREVS = {
    # Atlanta Hawks
    'hawks': 'ATL', 'atlanta': 'ATL', 'atlanta hawks': 'ATL', 'atl': 'ATL',
    # Boston Celtics
    'celtics': 'BOS', 'boston': 'BOS', 'boston celtics': 'BOS', 'bos': 'BOS',
    # Brooklyn Nets
    'nets': 'BKN', 'brooklyn': 'BKN', 'brooklyn nets': 'BKN', 'bkn': 'BKN', 'nj nets': 'BKN',
    # Charlotte Hornets
    'hornets': 'CHA', 'charlotte': 'CHA', 'charlotte hornets': 'CHA', 'cha': 'CHA', 'buzz city': 'CHA',
    # Chicago Bulls
    'bulls': 'CHI', 'chicago': 'CHI', 'chicago bulls': 'CHI', 'chi': 'CHI',
    # Cleveland Cavaliers
    'cavaliers': 'CLE', 'cavs': 'CLE', 'cleveland': 'CLE', 'cleveland cavaliers': 'CLE', 'cle': 'CLE',
    # Dallas Mavericks
    'mavericks': 'DAL', 'mavs': 'DAL', 'dallas': 'DAL', 'dallas mavericks': 'DAL', 'dal': 'DAL',
    # Denver Nuggets
    'nuggets': 'DEN', 'denver': 'DEN', 'denver nuggets': 'DEN', 'den': 'DEN',
    # Detroit Pistons
    'pistons': 'DET', 'detroit': 'DET', 'detroit pistons': 'DET', 'det': 'DET',
    # Golden State Warriors
    'warriors': 'GSW', 'golden state': 'GSW', 'golden state warriors': 'GSW',
    'gsw': 'GSW', 'gs warriors': 'GSW', 'dubs': 'GSW', 'bay area': 'GSW',
    # Houston Rockets
    'rockets': 'HOU', 'houston': 'HOU', 'houston rockets': 'HOU', 'hou': 'HOU',
    # Indiana Pacers
    'pacers': 'IND', 'indiana': 'IND', 'indiana pacers': 'IND', 'ind': 'IND',
    # LA Clippers
    'clippers': 'LAC', 'la clippers': 'LAC', 'los angeles clippers': 'LAC', 'lac': 'LAC',
    # Los Angeles Lakers
    'lakers': 'LAL', 'la lakers': 'LAL', 'los angeles lakers': 'LAL', 'lal': 'LAL', 'purple gold': 'LAL',
    # Memphis Grizzlies
    'grizzlies': 'MEM', 'memphis': 'MEM', 'memphis grizzlies': 'MEM', 'mem': 'MEM', 'grizz': 'MEM',
    # Miami Heat
    'heat': 'MIA', 'miami': 'MIA', 'miami heat': 'MIA', 'mia': 'MIA',
    # Milwaukee Bucks
    'bucks': 'MIL', 'milwaukee': 'MIL', 'milwaukee bucks': 'MIL', 'mil': 'MIL', 'mil bucks': 'MIL',
    # Minnesota Timberwolves
    'timberwolves': 'MIN', 'minnesota': 'MIN', 'minnesota timberwolves': 'MIN',
    'min': 'MIN', 'wolves': 'MIN', 'twolves': 'MIN',
    # New Orleans Pelicans
    'pelicans': 'NOP', 'new orleans': 'NOP', 'new orleans pelicans': 'NOP',
    'nop': 'NOP', 'pels': 'NOP', 'no pelicans': 'NOP',
    # New York Knicks
    'knicks': 'NYK', 'new york': 'NYK', 'new york knicks': 'NYK', 'nyk': 'NYK', 'ny knicks': 'NYK',
    # Oklahoma City Thunder
    'thunder': 'OKC', 'oklahoma city': 'OKC', 'oklahoma city thunder': 'OKC',
    'okc': 'OKC', 'oklahoma': 'OKC',
    # Orlando Magic
    'magic': 'ORL', 'orlando': 'ORL', 'orlando magic': 'ORL', 'orl': 'ORL',
    # Philadelphia 76ers
    '76ers': 'PHI', 'sixers': 'PHI', 'philadelphia': 'PHI', 'philadelphia 76ers': 'PHI',
    'phi': 'PHI', 'phila': 'PHI', 'philly': 'PHI', 'phila 76ers': 'PHI', 'the sixers': 'PHI',
    # Phoenix Suns
    'suns': 'PHX', 'phoenix': 'PHX', 'phoenix suns': 'PHX', 'phx': 'PHX',
    # Portland Trail Blazers
    'trail blazers': 'POR', 'blazers': 'POR', 'portland': 'POR',
    'portland trail blazers': 'POR', 'por': 'POR', 'rip city': 'POR',
    # Sacramento Kings
    'kings': 'SAC', 'sacramento': 'SAC', 'sacramento kings': 'SAC', 'sac': 'SAC',
    # San Antonio Spurs
    'spurs': 'SAS', 'san antonio': 'SAS', 'san antonio spurs': 'SAS', 'sas': 'SAS', 'sa spurs': 'SAS',
    # Toronto Raptors
    'raptors': 'TOR', 'toronto': 'TOR', 'toronto raptors': 'TOR', 'tor': 'TOR', 'raps': 'TOR',
    # Utah Jazz
    'jazz': 'UTA', 'utah': 'UTA', 'utah jazz': 'UTA', 'uta': 'UTA',
    # Washington Wizards
    'wizards': 'WAS', 'washington': 'WAS', 'washington wizards': 'WAS',
    'was': 'WAS', 'wiz': 'WAS', 'dc': 'WAS',
}

def get_abbrevs(opponent):
    """Convert any opponent string into NBA abbreviation(s) for MATCHUP matching."""
    opp = opponent.lower().strip()
    abbrevs = set()

    # Direct full-string lookup
    if opp in TEAM_ABBREVS:
        abbrevs.add(TEAM_ABBREVS[opp])

    # Single word lookup
    for word in opp.split():
        if word in TEAM_ABBREVS:
            abbrevs.add(TEAM_ABBREVS[word])

    # Two-word combos
    words = opp.split()
    for i in range(len(words) - 1):
        combo = words[i] + ' ' + words[i+1]
        if combo in TEAM_ABBREVS:
            abbrevs.add(TEAM_ABBREVS[combo])

    # Three-word combos (e.g. "golden state warriors")
    for i in range(len(words) - 2):
        combo = words[i] + ' ' + words[i+1] + ' ' + words[i+2]
        if combo in TEAM_ABBREVS:
            abbrevs.add(TEAM_ABBREVS[combo])

    # Fallback keywords (3+ chars, not common words)
    SKIP = {'the','and','los','las','san','new','vs','at'}
    keywords = [w for w in words if len(w) >= 3 and w not in SKIP]

    return list(abbrevs), keywords

def matches_opponent(matchup_str, abbrevs, keywords):
    """Check if a MATCHUP string (e.g. 'PHX vs. PHI') matches the opponent."""
    m = matchup_str.upper()
    # Abbreviation match — most reliable
    # MATCHUP format: "TEAM vs. OPP" or "TEAM @ OPP"
    # The opponent is always AFTER vs. or @
    parts = m.replace('@', 'vs.').split('VS.')
    opp_part = parts[-1].strip() if len(parts) > 1 else m
    for abbr in abbrevs:
        if abbr in opp_part:
            return True
    # Keyword fallback
    m_lower = matchup_str.lower()
    for kw in keywords:
        if kw in m_lower:
            return True
    return False

def find_player(name):
    results = nba_players.find_players_by_full_name(name)
    if not results:
        last = name.split()[-1]
        results = [p for p in nba_players.get_active_players()
                   if last.lower() in p['full_name'].lower()]
    if not results:
        first = name.split()[0]
        results = [p for p in nba_players.get_active_players()
                   if first.lower() in p['full_name'].lower()]
    return results[0] if results else None

def sf(v, d=0):
    try: return float(v or d)
    except: return d

def si(v, d=0):
    try: return int(v or d)
    except: return d

def parse_min(m):
    try:
        parts = str(m).split(':')
        return float(parts[0]) + (float(parts[1])/60 if len(parts) > 1 else 0)
    except: return 0.0

def row_to_game(row):
    matchup = str(row.get('MATCHUP', ''))
    return {
        'date':       str(row.get('GAME_DATE', '')),
        'matchup':    matchup,
        'home':       '@' not in matchup,  # nba_api MATCHUP is "TEAM vs. OPP" (home) or "TEAM @ OPP" (away)
        'wl':         str(row.get('WL', '')),
        'min':        str(row.get('MIN', '')),
        'pts':        si(row.get('PTS')),
        'reb':        si(row.get('REB')),
        'ast':        si(row.get('AST')),
        'fgm':        si(row.get('FGM')),
        'fga':        si(row.get('FGA')),
        'fg_pct':     round(sf(row.get('FG_PCT')) * 100, 1),
        'fg3m':       si(row.get('FG3M')),
        'fg3a':       si(row.get('FG3A')),
        'fg3_pct':    round(sf(row.get('FG3_PCT')) * 100, 1),
        'ftm':        si(row.get('FTM')),
        'fta':        si(row.get('FTA')),
        'oreb':       si(row.get('OREB')),
        'dreb':       si(row.get('DREB')),
        'stl':        si(row.get('STL')),
        'blk':        si(row.get('BLK')),
        'tov':        si(row.get('TOV')),
        'plus_minus': si(row.get('PLUS_MINUS')),
    }

def calc_avgs(games):
    if not games: return {}
    n = len(games)
    keys = ['pts','reb','ast','fgm','fga','fg3m','fg3a','ftm','fta',
            'oreb','dreb','stl','blk','tov']
    avgs = {k: round(sum(g.get(k, 0) for g in games) / n, 1) for k in keys}
    if avgs.get('fga', 0) > 0:
        avgs['fg_pct']  = round(avgs['fgm'] / avgs['fga'] * 100, 1)
    if avgs.get('fg3a', 0) > 0:
        avgs['fg3_pct'] = round(avgs['fg3m'] / avgs['fg3a'] * 100, 1)
    if avgs.get('fta', 0) > 0:
        avgs['ft_pct']  = round(avgs['ftm'] / avgs['fta'] * 100, 1)
    mins = [parse_min(g['min']) for g in games if parse_min(g['min']) > 0]
    if mins: avgs['min'] = round(sum(mins) / len(mins), 1)
    return avgs

def get_log(pid, season, max_attempts=2):
    """Fetch a game log with 429/rate-limit backoff — mirrors fetch_stats.py's retry logic."""
    for attempt in range(max_attempts):
        try:
            log = playergamelog.PlayerGameLog(player_id=pid, season=season, timeout=30)
            return log.get_data_frames()[0]
        except Exception as e:
            msg = str(e)
            is_last = attempt == max_attempts - 1
            if not is_last and ('429' in msg or 'rate' in msg.lower()):
                time.sleep((attempt + 1) * 4)
                continue
            raise

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: predict_tonight.py "Player" [season] [opponent]'}))
        sys.exit(1)

    player_name = sys.argv[1]
    season      = sys.argv[2] if len(sys.argv) > 2 else '2025-26'
    opponent    = sys.argv[3] if len(sys.argv) > 3 else None

    player = find_player(player_name)
    if not player:
        print(json.dumps({'error': f'Player not found: {player_name}'}))
        sys.exit(1)

    pid = player['id']

    # Fetch current season
    try:
        df = get_log(pid, season)
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)

    # Fallback to previous season
    if df.empty or len(df) < 3:
        try:
            yr = int(season[:4])
            prev = f'{yr-1}-{str(yr)[-2:]}'
            df2 = get_log(pid, prev)
            if not df2.empty: df = df2
        except: pass

    if df.empty:
        print(json.dumps({'error': f'No game log for {player_name}'}))
        sys.exit(1)

    all_games = [row_to_game(row) for _, row in df.iterrows()]

    # ── H2H MODE ────────────────────────────────────────────────────
    if opponent:
        abbrevs, keywords = get_abbrevs(opponent)
        h2h_games = []
        seen_dates = set()

        # Search current season first — only go back if not enough games
        seasons_to_try = [season]
        if season != '2024-25': seasons_to_try.append('2024-25')
        if season != '2023-24': seasons_to_try.append('2023-24')
        # Only add 2022-23 if we really need more data (checked after current season)
        for i, try_season in enumerate(seasons_to_try):
            if i > 0:
                time.sleep(0.6)  # space out sequential nba.com hits
            try:
                df_s = get_log(pid, try_season)
                if df_s.empty: continue
                for _, row in df_s.iterrows():
                    matchup   = str(row.get('MATCHUP', ''))
                    game_date = str(row.get('GAME_DATE', ''))
                    if game_date not in seen_dates and \
                       matches_opponent(matchup, abbrevs, keywords):
                        seen_dates.add(game_date)
                        h2h_games.append(row_to_game(row))
            except: continue
            # If we have 6+ games already, that's enough — stop fetching more seasons
            if len(h2h_games) >= 6:
                break

        if not h2h_games:
            print(json.dumps({
                'player':           player['full_name'],
                'id':               pid,
                'opponent':         opponent,
                'searched_abbrevs': abbrevs,
                'searched_keywords': keywords,
                'h2h':              None,
                'error': f'No H2H games found vs {opponent} (abbrevs tried: {abbrevs})'
            }))
            sys.exit(0)

        avgs = calc_avgs(h2h_games)
        mid   = max(1, len(h2h_games) // 2)
        r_pts = sum(g['pts'] for g in h2h_games[:mid]) / mid
        o_pts = sum(g['pts'] for g in h2h_games[mid:]) / max(len(h2h_games) - mid, 1)
        trend = 'IMPROVING' if r_pts > o_pts + 2 else \
                'DECLINING'  if r_pts < o_pts - 2 else 'STABLE'

        print(json.dumps({
            'player':   player['full_name'],
            'id':       pid,
            'opponent': opponent,
            'h2h': {
                'gamesVsOpp':  len(h2h_games),
                'avgs':        avgs,
                'trend':       trend,
                'recentGames': h2h_games,   # all games, newest first
            }
        }))
        return

    # ── REGULAR MODE ────────────────────────────────────────────────
    # all_games already holds the full current-season log (nba_api fetches it
    # in one call) — season-long averages are essentially free, just use them
    # as a shrinkage baseline instead of throwing the rest of the season away.
    print(json.dumps({
        'player':     player['full_name'],
        'id':         pid,
        'season':     season,
        'source':     'nba_api (live)',
        'gamesFound': len(all_games),
        'l5':         calc_avgs(all_games[:5]),
        'l10':        calc_avgs(all_games[:10]),
        'season_avg': calc_avgs(all_games),
        'games':      all_games[:20],  # bumped from 10 so the UI's home/away filters have enough games to draw from
    }))

if __name__ == '__main__':
    main()
