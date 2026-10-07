#!/usr/bin/env python3
"""
WIN AI — Shot Chart Bridge
Real shot-location data straight from stats.nba.com (same backend serves
NBA and WNBA under different league IDs — verified empirically, see
METHODOLOGY.md). No public source exists for full SportVU/tracking shot
dashboards on the WNBA side, but per-shot LOC_X/LOC_Y + zone + make/miss
via ShotChartDetail works for both leagues.

Usage:
  python3 shotchart.py nba  player  "Anthony Edwards" [season]
  python3 shotchart.py wnba player  "A'ja Wilson"      [season]
  python3 shotchart.py nba  defense "Denver Nuggets"   [season]
  python3 shotchart.py wnba defense "Chicago Sky"      [season]
"""
import sys, json, os, time
from collections import Counter
import requests

try:
    from nba_api.stats.endpoints import shotchartdetail
    from nba_api.stats.static import players as nba_players, teams as nba_teams
except ImportError:
    print(json.dumps({'error': 'nba_api not installed. Run: pip3 install nba_api pandas'}))
    sys.exit(1)

LEAGUE_IDS = {'nba': '00', 'wnba': '10'}
HERE = os.path.dirname(os.path.abspath(__file__))
BENCHMARK_TTL = 24 * 60 * 60  # league-wide zone averages barely move day to day

# ── stats.wnba.com fallback — covers the 2026 expansion teams ──────
# stats.nba.com/nba_api's static player list and league dash endpoints
# haven't onboarded Toronto Tempo / Portland Fire yet (confirmed empirically:
# they're entirely absent from every stats.nba.com WNBA response). WNBA.com
# runs a separate, newer stats site (stats.wnba.com) on its own "Hana" API
# that already tracks both new teams. It requires a full realistic browser
# header set (x-nba-stats-origin / x-nba-stats-token plus Sec-Fetch-* /
# Sec-Ch-Ua) — requests missing any of these are silently black-holed
# (connection accepted, no response ever sent) rather than rejected, which
# is what made this look unreachable before the full header set was found.
WNBA_STATS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Referer": "https://stats.wnba.com/players/shooting/",
    "Pragma": "no-cache",
    "Cache-Control": "no-cache",
    "Sec-Ch-Ua": '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "x-nba-stats-origin": "stats",
    "x-nba-stats-token": "true",
}
WNBA_ZONE_TTL = 6 * 60 * 60  # 6h — league-wide by-zone shooting barely moves day to day

def to_wnba_stats_season(season):
    """stats.wnba.com wants a single year ('2026'), not the NBA-style
    'YYYY-YY' range ('2025-26') used everywhere else in this app. Passing
    the wrong format doesn't error — it silently returns a different
    (stale) season's data, which is what happened here originally."""
    if '-' in season:
        return str(int(season.split('-')[0]) + 1)
    return season

def fetch_wnba_zone_table(season):
    """League-wide by-zone shooting (season totals) for every current WNBA
    player, straight from stats.wnba.com. One call (TeamID=0, all teams)
    gives every player's zone breakdown plus enough to build a real league
    benchmark — including players on the two 2026 expansion teams."""
    wnba_season = to_wnba_stats_season(season)
    cache_file = os.path.join(HERE, f'.wnba_stats_zonetable_{wnba_season}.json')
    try:
        with open(cache_file) as f:
            cached = json.load(f)
        if time.time() - cached.get('ts', 0) < WNBA_ZONE_TTL:
            return cached['rows']
    except Exception:
        pass

    params = {
        "College": "", "Conference": "", "Country": "", "DateFrom": "", "DateTo": "",
        "DistanceRange": "By Zone", "Division": "", "DraftPick": "", "DraftYear": "",
        "GameScope": "", "GameSegment": "", "Height": "", "LastNGames": "0", "Location": "",
        "MeasureType": "Base", "Month": "0", "OpponentTeamID": "0", "Outcome": "", "PORound": "0",
        "PaceAdjust": "N", "PerMode": "Totals", "Period": "0", "PlayerExperience": "",
        "PlayerPosition": "", "PlusMinus": "N", "Rank": "N", "Season": wnba_season, "SeasonSegment": "",
        "SeasonType": "Regular Season", "ShotClockRange": "", "StarterBench": "", "TeamID": "0",
        "VsConference": "", "VsDivision": "", "Weight": "", "LeagueID": "10",
    }
    r = requests.get(
        "https://stats.wnba.com/stats/leaguedashplayershotlocations",
        params=params, headers=WNBA_STATS_HEADERS, timeout=30,
    )
    r.raise_for_status()
    rs = r.json()['resultSets']
    zone_names = rs['headers'][0]['columnNames']
    n_meta = 6  # PLAYER_ID, PLAYER_NAME, TEAM_ID, TEAM_ABBREVIATION, AGE, NICKNAME
    rows = []
    for raw in rs['rowSet']:
        entry = {'PLAYER_ID': raw[0], 'PLAYER_NAME': raw[1], 'TEAM_ID': raw[2], 'TEAM_ABBREVIATION': raw[3]}
        zones = []
        for zi, zname in enumerate(zone_names):
            base = n_meta + zi * 3
            fgm, fga, fgpct = raw[base] or 0, raw[base+1] or 0, raw[base+2] or 0
            zones.append({'zone': zname, 'fgm': fgm, 'fga': fga, 'fgPct': round(fgpct * 100, 1)})
        entry['zones'] = zones
        rows.append(entry)

    try:
        with open(cache_file, 'w') as f:
            json.dump({'ts': time.time(), 'rows': rows}, f)
    except Exception:
        pass
    return rows

def wnba_zone_benchmark(rows):
    tally = {}
    for row in rows:
        for z in row['zones']:
            b = tally.setdefault(z['zone'], {'fgm': 0, 'fga': 0})
            b['fgm'] += z['fgm']
            b['fga'] += z['fga']
    return {z: round(v['fgm'] / v['fga'] * 100, 1) for z, v in tally.items() if v['fga']}

RANKED_ZONES = ['Restricted Area', 'In The Paint (Non-RA)', 'Mid-Range',
                'Above the Break 3', 'Left Corner 3', 'Right Corner 3']

def compute_team_defense_ranks(df):
    """Where every team ranks in FG% allowed, zone by zone (1 = toughest to
    score on). Built from the same league-wide shot table the benchmark
    already fetches, so it costs no extra API call: each shot row carries the
    home/visitor team codes, and whichever of the two isn't the shooter's own
    team is the defender. A team's own code is the one code present in every
    one of its shot rows.

    Returns {team_id (str): {zone: {'pct', 'rank', 'rankOf'}}}, or {} if the
    table doesn't have the columns (ranks are an extra, never required)."""
    try:
        needed = {'TEAM_ID', 'HTM', 'VTM', 'SHOT_ZONE_BASIC', 'SHOT_MADE_FLAG'}
        if not len(df) or not needed.issubset(df.columns):
            return {}
        own = {}
        for tid, grp in df.groupby('TEAM_ID'):
            own[int(tid)] = Counter(list(grp['HTM']) + list(grp['VTM'])).most_common(1)[0][0]
        abbr_to_id = {ab: tid for tid, ab in own.items()}
        shooter_abbr = df['TEAM_ID'].map(own)
        defender = df['VTM'].where(shooter_abbr == df['HTM'], df['HTM'])
        sub = df[df['SHOT_ZONE_BASIC'].isin(RANKED_ZONES)].copy()
        sub['DEF'] = defender[sub.index]
        agg = sub.groupby(['DEF', 'SHOT_ZONE_BASIC'])['SHOT_MADE_FLAG'].agg(['sum', 'count'])
        pct_by_zone = {}
        for (abbr, zone), row in agg.iterrows():
            if row['count'] > 0:
                pct_by_zone.setdefault(zone, {})[abbr] = row['sum'] / row['count'] * 100
        out = {}
        for zone, by_abbr in pct_by_zone.items():
            values = sorted(by_abbr.values())
            for abbr, v in by_abbr.items():
                tid = abbr_to_id.get(abbr)
                if tid is None:
                    continue
                out.setdefault(str(tid), {})[zone] = {
                    'pct': round(v, 1),
                    'rank': 1 + sum(1 for x in values if x < v),  # ties share the better rank
                    'rankOf': len(values),
                }
        return out
    except Exception:
        return {}

def get_league_bundle(league, season):
    """One league-wide fetch feeds both things that need it: the per-zone
    league FG% benchmark, and each team's defensive rank in every zone."""
    league_id = LEAGUE_IDS.get(league, '00')
    cache_file = os.path.join(HERE, f'.shotchart_benchmark_{league}_{season}.json')
    try:
        with open(cache_file) as f:
            cached = json.load(f)
        # Files written before team ranks existed have no 'defense' key —
        # treat those as a miss so ranks get built once.
        if time.time() - cached.get('ts', 0) < BENCHMARK_TTL and 'defense' in cached:
            return {'zones': cached['zones'], 'defense': cached['defense']}
    except Exception:
        pass

    r = shotchartdetail.ShotChartDetail(
        team_id=0, player_id=0, league_id=league_id,
        context_measure_simple='FGA', season_nullable=season,
        season_type_all_star='Regular Season', timeout=55,
    )
    df = r.get_data_frames()[0]
    records = df[['SHOT_ZONE_BASIC', 'SHOT_MADE_FLAG']].to_dict('records') if len(df) else []
    tally = {}
    for row in records:
        z = row.get('SHOT_ZONE_BASIC', 'Unknown')
        b = tally.setdefault(z, {'fgm': 0, 'fga': 0})
        b['fga'] += 1
        if row.get('SHOT_MADE_FLAG') == 1:
            b['fgm'] += 1
    benchmark = {z: round(v['fgm'] / v['fga'] * 100, 1) for z, v in tally.items() if v['fga']}
    defense = compute_team_defense_ranks(df)
    try:
        with open(cache_file, 'w') as f:
            json.dump({'ts': time.time(), 'zones': benchmark, 'defense': defense}, f)
    except Exception:
        pass
    return {'zones': benchmark, 'defense': defense}

def get_league_benchmark(league, season):
    """League-wide FG% by zone — every zone rating below is judged against
    this, not a fixed cutoff, since 'good' varies by zone and by league."""
    return get_league_bundle(league, season)['zones']

def zone_rating(pct, benchmark_pct, threshold=3.0):
    """green = notably above league average for this zone, red = notably
    below, gray = close to average. Same sign convention is reused for both
    charts: for a player's own shot chart green means 'shoots well there';
    for a defense chart green means 'opponents shoot well there' (i.e. easy
    to score) — the color always tracks 'FG% above average', the reader
    just interprets it through whichever lens the card is labeled with."""
    diff = pct - benchmark_pct
    if diff >= threshold: return 'green'
    if diff <= -threshold: return 'red'
    return 'gray'

def load_json(fname):
    try:
        with open(os.path.join(HERE, fname)) as f:
            return json.load(f)
    except Exception:
        return []

def resolve_nba_player(name):
    results = nba_players.find_players_by_full_name(name)
    if not results:
        last = name.split()[-1]
        results = [p for p in nba_players.get_active_players() if last.lower() in p['full_name'].lower()]
    return results[0] if results else None

def resolve_wnba_player(name, season='2026'):
    rows = load_json('wnba_player_stats.json')
    lower = name.lower().strip()
    for r in rows:
        if r.get('PLAYER_NAME', '').lower() == lower:
            return {'id': r['PLAYER_ID'], 'full_name': r['PLAYER_NAME']}
    # Fallback requires every query token (first AND last name) to appear
    # as a whole token in the candidate's name — not a bare last-name
    # substring. A substring match previously matched an unrelated player
    # sharing a surname (e.g. a query for a player not yet in this file
    # silently returned a different real player's shot data under the
    # wrong name instead of an honest "not found").
    query_tokens = set(lower.split())
    for r in rows:
        name_tokens = set(r.get('PLAYER_NAME', '').lower().split())
        if query_tokens and query_tokens.issubset(name_tokens):
            return {'id': r['PLAYER_ID'], 'full_name': r['PLAYER_NAME']}
    # Not in the local stats.nba.com snapshot — that snapshot hasn't
    # onboarded the WNBA's 2026 expansion teams yet. stats.wnba.com already
    # tracks them, so check there before giving up.
    try:
        zone_rows = fetch_wnba_zone_table(season)
        for r in zone_rows:
            if r.get('PLAYER_NAME', '').lower() == lower:
                return {'id': r['PLAYER_ID'], 'full_name': r['PLAYER_NAME'], '_zoneRow': r}
        for r in zone_rows:
            name_tokens = set(r.get('PLAYER_NAME', '').lower().split())
            if query_tokens and query_tokens.issubset(name_tokens):
                return {'id': r['PLAYER_ID'], 'full_name': r['PLAYER_NAME'], '_zoneRow': r}
    except Exception:
        pass
    return None

def resolve_team(league, name):
    lower = name.lower()
    if league == 'wnba':
        matches = nba_teams.find_wnba_teams_by_full_name(name)
        if matches:
            return matches[0]
        for t in nba_teams.get_wnba_teams():
            if lower in t['full_name'].lower() or t['nickname'].lower() in lower or t['city'].lower() in lower:
                return t
        # Static list is missing the newest expansion teams — fall back to
        # the locally-fetched team file, which ESPN-derived team names match.
        for r in load_json('wnba_team_advanced.json'):
            tn = r.get('TEAM_NAME', '')
            if lower in tn.lower() or tn.lower() in lower:
                return {'id': r['TEAM_ID'], 'full_name': tn}
        return None
    matches = nba_teams.find_teams_by_full_name(name)
    if matches:
        return matches[0]
    for t in nba_teams.get_teams():
        if lower in t['full_name'].lower() or t['nickname'].lower() in lower or t['city'].lower() in lower:
            return t
    return None

def aggregate_by_zone(records, benchmark=None, ranks=None):
    """ranks: {zone: {'rank', 'rankOf'}} for one team's defense (optional)."""
    zones = {}
    for row in records:
        z = row.get('SHOT_ZONE_BASIC', 'Unknown')
        bucket = zones.setdefault(z, {'fgm': 0, 'fga': 0})
        bucket['fga'] += 1
        if row.get('SHOT_MADE_FLAG') == 1:
            bucket['fgm'] += 1
    out = []
    for z, v in zones.items():
        pct = round(v['fgm'] / v['fga'] * 100, 1) if v['fga'] else 0
        entry = {'zone': z, 'fgm': v['fgm'], 'fga': v['fga'], 'fgPct': pct}
        if benchmark and z in benchmark:
            entry['leagueAvgPct'] = benchmark[z]
            entry['rating'] = zone_rating(pct, benchmark[z])
        if ranks and z in ranks:
            entry['rank'] = ranks[z]['rank']
            entry['rankOf'] = ranks[z]['rankOf']
        out.append(entry)
    out.sort(key=lambda x: -x['fga'])
    return out

def main():
    if len(sys.argv) < 4:
        print(json.dumps({'error': 'Usage: shotchart.py <nba|wnba> <player|defense> "<name>" [season]'}))
        sys.exit(1)

    league = sys.argv[1].lower()
    mode = sys.argv[2]
    name = sys.argv[3]
    season = sys.argv[4] if len(sys.argv) > 4 else '2025-26'
    # Normalize once, immediately, for every WNBA path (benchmark,
    # ShotChartDetail, resolve_wnba_player) — the caller (server.js) still
    # defaults to the NBA-style '2025-26', and stats.nba.com silently
    # returns the prior completed season for that format on WNBA endpoints
    # instead of erroring (confirmed: it returns 2025 season shots dated
    # from May 2025, not the live 2026 season). This was previously only
    # applied inside fetch_wnba_zone_table's fallback path, missing the
    # main ShotChartDetail calls below.
    if league == 'wnba':
        season = to_wnba_stats_season(season)
    league_id = LEAGUE_IDS.get(league, '00')

    try:
        bundle = get_league_bundle(league, season)
        benchmark = bundle['zones']
        if mode == 'player':
            player = resolve_nba_player(name) if league == 'nba' else resolve_wnba_player(name, season)
            if not player:
                print(json.dumps({'error': f'Player not found: {name}'}))
                sys.exit(1)

            if league == 'wnba' and player.get('_zoneRow'):
                # Resolved via the stats.wnba.com fallback (expansion-team
                # player not in the stats.nba.com snapshot) — that source
                # already returns pre-aggregated by-zone shooting, so there's
                # no shotchartdetail call to make here.
                zone_rows = fetch_wnba_zone_table(season)
                benchmark_w = wnba_zone_benchmark(zone_rows)
                out_zones = []
                for z in player['_zoneRow']['zones']:
                    entry = {'zone': z['zone'], 'fgm': z['fgm'], 'fga': z['fga'], 'fgPct': z['fgPct']}
                    if z['zone'] in benchmark_w:
                        entry['leagueAvgPct'] = benchmark_w[z['zone']]
                        entry['rating'] = zone_rating(z['fgPct'], benchmark_w[z['zone']])
                    out_zones.append(entry)
                out_zones.sort(key=lambda x: -x['fga'])
                print(json.dumps({
                    'mode': 'player',
                    'name': player['full_name'],
                    'season': season,
                    'totalShots': sum(z['fga'] for z in out_zones),
                    'zones': out_zones,
                    'shots': [],
                }))
            else:
                r = shotchartdetail.ShotChartDetail(
                    team_id=0, player_id=player['id'], league_id=league_id,
                    context_measure_simple='FGA', season_nullable=season,
                    season_type_all_star='Regular Season', timeout=30,
                )
                df = r.get_data_frames()[0]
                records = df[['LOC_X', 'LOC_Y', 'SHOT_MADE_FLAG', 'SHOT_ZONE_BASIC', 'SHOT_DISTANCE']].to_dict('records') if len(df) else []
                print(json.dumps({
                    'mode': 'player',
                    'name': player.get('full_name', name),
                    'season': season,
                    'totalShots': len(records),
                    'zones': aggregate_by_zone(records, benchmark),
                    'shots': records[:400],  # cap payload size for rendering
                }))
        elif mode == 'defense':
            team = resolve_team(league, name)
            if not team:
                print(json.dumps({'error': f'Team not found: {name}'}))
                sys.exit(1)
            r = shotchartdetail.ShotChartDetail(
                team_id=0, player_id=0, league_id=league_id,
                opponent_team_id=team['id'], context_measure_simple='FGA',
                season_nullable=season, season_type_all_star='Regular Season', timeout=30,
            )
            df = r.get_data_frames()[0]
            records = df[['SHOT_ZONE_BASIC', 'SHOT_MADE_FLAG']].to_dict('records') if len(df) else []
            print(json.dumps({
                'mode': 'defense',
                'team': team.get('full_name', name),
                'season': season,
                'totalShotsFaced': len(records),
                'zones': aggregate_by_zone(records, benchmark, bundle['defense'].get(str(team['id']))),
            }))
        else:
            print(json.dumps({'error': 'mode must be "player" or "defense"'}))
            sys.exit(1)
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()
