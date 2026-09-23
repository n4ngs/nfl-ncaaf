"""ESPN public core odds for every FBS game (spread / total / moneyline, open + close, all providers).
Used to (a) verify the sportsdataverse line file, (b) get the real OPEN juice where ESPN has it (2024+), and
(c) detect leaking "Live Odds" providers. Output data/espn/odds.jsonl, resumable (skips saved event ids).
URL: https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/{id}/competitions/{id}/odds?limit=50
No custom User-Agent: ESPN's edge 403s some custom agents, the urllib default is accepted."""
import json, os, sys, time, urllib.request, pandas as pd
from concurrent.futures import ThreadPoolExecutor
OUT = 'data/espn/odds.jsonl'; os.makedirs('data/espn', exist_ok=True)
SEASONS = [int(x) for x in (sys.argv[1:] or ['2022', '2023', '2024', '2025'])]
def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=25) as r: return json.load(r)
        except Exception as e:
            if i == tries - 1: return {'_error': str(e)}
            time.sleep(2 * (i + 1))
def num(x):
    try:
        x = str(x).replace('+', '')
        return 100.0 if x in ('EVEN', 'even') else float(x)
    except (TypeError, ValueError): return None
def snap(o, k):
    """one snapshot ('open'/'close'/'current') of a team-side odds dict"""
    s = o.get(k) or {}
    return {'pts': num((s.get('pointSpread') or {}).get('american')), 'sp': num((s.get('spread') or {}).get('american')), 'ml': num((s.get('moneyLine') or {}).get('american'))}
def tot(it, k):
    s = it.get(k) or {}
    return {'total': num((s.get('total') or {}).get('american')), 'over': num((s.get('over') or {}).get('american')), 'under': num((s.get('under') or {}).get('american'))}
def odds(gid):
    d = get(f'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/{gid}/competitions/{gid}/odds?limit=50')
    if '_error' in d: return None
    out = []
    for it in d.get('items', []):
        h, a = it.get('homeTeamOdds') or {}, it.get('awayTeamOdds') or {}
        out.append({'book': it['provider']['name'], 'spread': it.get('spread'), 'initialSpread': it.get('initialSpread'), 'overUnder': it.get('overUnder'),
                    'initialOverUnder': it.get('initialOverUnder'), 'overOdds': it.get('overOdds'), 'underOdds': it.get('underOdds'),
                    'home': {'ml': h.get('moneyLine'), 'spOdds': h.get('spreadOdds'), 'open': snap(h, 'open'), 'close': snap(h, 'close'), 'current': snap(h, 'current')},
                    'away': {'ml': a.get('moneyLine'), 'spOdds': a.get('spreadOdds'), 'open': snap(a, 'open'), 'close': snap(a, 'close'), 'current': snap(a, 'current')},
                    'tot': {'open': tot(it, 'open'), 'close': tot(it, 'close'), 'current': tot(it, 'current')}})
    return out
done = {json.loads(l)['id'] for l in open(OUT)} if os.path.exists(OUT) else set()
for S in SEASONS:
    sc = pd.read_csv(f'data/sdv/cfb_schedule_{S}.csv')
    ids = [int(g) for g in sc.game_id if int(g) not in done]
    t0 = time.time()
    with open(OUT, 'a') as f, ThreadPoolExecutor(6) as ex:
        for gid, o in zip(ids, ex.map(odds, ids)):
            f.write(json.dumps({'id': gid, 'season': S, 'books': o}) + '\n')
    print(f'season {S}: {len(ids)} events fetched in {time.time()-t0:.0f}s', flush=True)
print('done')
