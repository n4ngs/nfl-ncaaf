"""Every sportsbook's NFL spread / total / moneyline (open, close, current) from ESPN's public core odds API.

Input : data/raw/games.csv (nflverse, carries the ESPN event id per game).
Output: data/espn/odds.jsonl, one line per event: {"espn": id, "game_id": nflverse id, "books": [...]}. Resumable.

What ESPN actually holds (verified 2026-09-23, see README):
  2006-2011  nothing (2012-13 only a 'consensus' row that is itself the opener)
  2014-2016  "Opening" provider + item.initialSpread / initialOverUnder on every offshore book (open spread & total)
  2017-2022  current (= final) numbers only, no open
  2023-2026  "ESPN BET" (2023 partial) / "Draft Kings" open / close / current blocks (spread, juice, moneyline, total, o/u juice);
             ESPN BET's close block is corrupt before 2024
"... - Live Odds" providers are in-game prices and must never be used (they leak the result).
No custom User-Agent: ESPN's edge 403s some; Python urllib's default is accepted.
"""
import json, os, time, urllib.request
import pandas as pd
from concurrent.futures import ThreadPoolExecutor
OUT = 'data/espn/odds.jsonl'
URL = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{e}/competitions/{e}/odds?limit=100'

def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url), timeout=25) as r:
                return json.load(r)
        except Exception as e:
            if '404' in str(e): return {'items': []}
            if i == tries - 1: return {'_error': str(e)}
            time.sleep(2 * (i + 1))

def num(x):
    if x in (None, '', 'OFF'): return None
    if x == 'EVEN': return 100.0
    try: return float(str(x).replace('+', ''))
    except ValueError: return None

def blk(b, keys):
    if not isinstance(b, dict): return None
    return {k: num((b.get(k) or {}).get('american')) for k in keys}

def side(o):
    o = o or {}
    r = {'ml': num(o.get('moneyLine')), 'spread_odds': num(o.get('spreadOdds'))}
    for s in ('open', 'close', 'current'):
        r[s] = blk(o.get(s), ('pointSpread', 'spread', 'moneyLine'))
    return r

def compact(it):
    r = {'book': it['provider']['name'], 'book_id': it['provider'].get('id'), 'spread': num(it.get('spread')), 'initial_spread': num(it.get('initialSpread')),
         'total': num(it.get('overUnder')), 'initial_total': num(it.get('initialOverUnder')), 'over_odds': num(it.get('overOdds')), 'under_odds': num(it.get('underOdds')),
         'home': side(it.get('homeTeamOdds')), 'away': side(it.get('awayTeamOdds'))}
    for s in ('open', 'close', 'current'):
        r['tot_' + s] = blk(it.get(s), ('over', 'under', 'total'))
    return r

def fetch(e):
    d = get(URL.format(e=e))
    if '_error' in d: return None
    return [compact(it) for it in d.get('items', [])]

def main():
    os.makedirs('data/espn', exist_ok=True)
    g = pd.read_csv('data/raw/games.csv')
    g = g[(g.season >= 2006) & g.espn.notna() & g.home_score.notna()]
    done = set()
    if os.path.exists(OUT):
        done = {json.loads(l)['espn'] for l in open(OUT)}
    todo = [(int(r.espn), r.game_id) for r in g.itertuples() if int(r.espn) not in done]
    print(f'{len(todo)} events to fetch ({len(done)} cached)', flush=True)
    t0 = time.time(); bad = 0
    with open(OUT, 'a') as f, ThreadPoolExecutor(6) as ex:
        for n, ((e, gid), books) in enumerate(zip(todo, ex.map(lambda t: fetch(t[0]), todo)), 1):
            if books is None: bad += 1; continue          # transient error: retried on the next run
            f.write(json.dumps({'espn': e, 'game_id': gid, 'books': books}) + '\n'); f.flush()
            if n % 250 == 0: print(f'{n}/{len(todo)} ({time.time()-t0:.0f}s, {bad} errors)', flush=True)
    print(f'done, {bad} errors (re-run to retry)', flush=True)

if __name__ == '__main__': main()
