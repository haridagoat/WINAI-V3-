"""
What each NBA defense gives up to guards, forwards and centers, per game, from FantasyPros' public "defense vs position" table.

    python3 fetch_dvp.py

Writes dvp_positions.json. The page lists PG, SG, SF, PF and C separately for the season and for the last 7/15/30 games; this adds PG+SG into
guards and SF+PF into forwards (the five positions add up to the team's total, so these are what the defense allowed to each group).
One request a day is well inside the site's robots.txt (crawl delay 5 s). Nothing is written unless the table passes the checks below, so a
redesign of the page leaves the last good file in place and fails loudly instead of feeding the model bad numbers.
"""
import json, os, re, sys
import requests                                     # already installed with nba_api; ships its own certificates
from datetime import datetime, timezone

URL = 'https://www.fantasypros.com/daily-fantasy/nba/fanduel-defense-vs-position.php'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dvp_positions.json')
COLS = ['pts', 'reb', 'ast', 'fg3m', 'stl', 'blk', 'tov', 'fdpts']      # the page's order after GP
WINDOWS = {'GC-0': 'season', 'GC-15': 'last15'}
GROUPS = {'G': ('PG', 'SG'), 'F': ('SF', 'PF'), 'C': ('C',)}


def fetch_html():
    r = requests.get(URL, headers={'User-Agent': 'Mozilla/5.0 (WIN AI stats refresh; once a day)'}, timeout=30)
    r.raise_for_status()
    return r.text


def parse_rows(html):
    """-> {window: {position: {team: {'gp': n, 'pts': x, ...}}}}"""
    out = {}
    for m in re.finditer(r'<tr[^>]*class="(GC-\d+) ([A-Z]+)"[^>]*>(.*?)</tr>', html, re.S):
        gc, pos, body = m.groups()
        if gc not in WINDOWS:
            continue
        team = re.search(r'</span>\s*([^<]+?)\s*</td>', body)
        nums = re.findall(r'<b>\s*(-?[\d.]+)\s*</b>', body)
        if not team or len(nums) < 1 + len(COLS):
            raise ValueError(f'unexpected row shape for {gc} {pos}: {body[:120]!r}')
        vals = [float(x) for x in nums[:1 + len(COLS)]]
        out.setdefault(WINDOWS[gc], {}).setdefault(pos, {})[team.group(1).strip()] = {'gp': int(vals[0]), **dict(zip(COLS, vals[1:]))}
    return out


def build(parsed):
    result = {}
    for window, by_pos in parsed.items():
        for pos in ('PG', 'SG', 'SF', 'PF', 'C', 'TM'):
            if pos not in by_pos or len(by_pos[pos]) != 30:
                raise ValueError(f'{window}: expected 30 teams for {pos}, got {len(by_pos.get(pos, {}))}')
        teams = {}
        for team, total in by_pos['TM'].items():
            entry = {'gp': int(total['gp']), 'total': {k: total[k] for k in COLS}}
            for g, members in GROUPS.items():
                entry[g] = {k: round(sum(by_pos[p][team][k] for p in members), 3) for k in COLS}
            # the groups must add back up to the team's total (the page rounds, so allow a little)
            for k in ('pts', 'reb', 'ast'):
                s = sum(entry[g][k] for g in GROUPS)
                if not (0.9 * total[k] <= s <= 1.1 * total[k]):
                    raise ValueError(f'{window} {team}: groups add up to {s:.1f} {k} but the team total is {total[k]:.1f}')
            if not (0 < entry['gp'] <= 90) or not (60 < total['pts'] < 160):
                raise ValueError(f'{window} {team}: implausible games or points ({entry["gp"]}, {total["pts"]})')
            teams[team] = entry
        result[window] = teams
    for w in WINDOWS.values():
        if w not in result:
            raise ValueError(f'window {w} missing from the page')
    return result


def main():
    html = fetch_html()
    season = re.search(r'(20\d\d)\s*-\s*(20\d\d)', html)
    data = {'source': URL, 'fetchedAt': datetime.now(timezone.utc).isoformat(), 'season': f'{season.group(1)}-{season.group(2)}' if season else None,
            'windows': build(parse_rows(html))}
    tmp = OUT + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, allow_nan=False)
    os.replace(tmp, OUT)
    n = len(data['windows']['season'])
    print(f'dvp_positions.json: {n} teams, season window games {min(t["gp"] for t in data["windows"]["season"].values())}-{max(t["gp"] for t in data["windows"]["season"].values())}')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:                        # keep the last good file; the caller sees the non-zero exit
        print(f'fetch_dvp failed: {e}', file=sys.stderr)
        sys.exit(1)
