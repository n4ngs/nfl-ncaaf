"""Collect NHL regular-season games + every sportsbook's moneyline (open/close) from ESPN's public API.
Output: data/espn/games.jsonl (one line per event). Resumable: skips events already saved."""
import json, os, sys, time, datetime as dt, urllib.request
from concurrent.futures import ThreadPoolExecutor
OUT = 'data/espn/games.jsonl'
UA = {}  # ESPN's edge rejects some custom agents; the library default is accepted
def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1: return {'_error': str(e)}
            time.sleep(2 * (i + 1))
def am(x):
    try: return int(str(x).replace('+', '')) if x not in (None, '', 'OFF', 'EVEN') else (100 if x == 'EVEN' else None)
    except ValueError: return None
def side(o):
    g = lambda k: am(((o.get(k) or {}).get('moneyLine') or {}).get('american'))
    return {'ml': am(o.get('moneyLine')), 'open': g('open'), 'close': g('close'), 'teamId': o.get('teamId')}
def odds(eid):
    d = get(f'https://sports.core.api.espn.com/v2/sports/hockey/leagues/nhl/events/{eid}/competitions/{eid}/odds?limit=50')
    return [{'book': it['provider']['name'], 'home': side(it.get('homeTeamOdds') or {}), 'away': side(it.get('awayTeamOdds') or {})}
            for it in d.get('items', [])] if '_error' not in d else None
def events(day):
    d = get(f'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates={day:%Y%m%d}&limit=50')
    out = []
    for e in d.get('events', []):
        if (e.get('season') or {}).get('type') != 2: continue
        c = e['competitions'][0]; st = c['status']['type']
        if not st.get('completed'): continue
        t = {x['homeAway']: x for x in c['competitors']}
        out.append({'id': e['id'], 'date': e['date'], 'season': e['season']['year'],
                    'home': t['home']['team']['abbreviation'], 'away': t['away']['team']['abbreviation'],
                    'homeId': t['home']['team']['id'], 'awayId': t['away']['team']['id'],
                    'homeScore': int(t['home']['score']), 'awayScore': int(t['away']['score']),
                    'homeWin': bool(t['home'].get('winner')), 'period': c['status'].get('period'),
                    'detail': st.get('shortDetail')})
    return out
def main():
    done = set()
    if os.path.exists(OUT):
        done = {json.loads(l)['id'] for l in open(OUT)}
    for y in range(2021, 2026):
        days = []; d = dt.date(y, 10, 1)
        while d <= dt.date(y + 1, 4, 30): days.append(d); d += dt.timedelta(days=1)
        t0 = time.time()
        with ThreadPoolExecutor(8) as ex:
            evs = [e for day in ex.map(events, days) for e in day if e['id'] not in done]
        print(f'season {y}: {len(evs)} new events ({time.time()-t0:.0f}s scoreboard)', flush=True)
        with open(OUT, 'a') as f, ThreadPoolExecutor(8) as ex:
            for n, (e, o) in enumerate(zip(evs, ex.map(lambda e: odds(e['id']), evs)), 1):
                e['books'] = o; f.write(json.dumps(e) + '\n'); f.flush()
        print(f'season {y}: odds saved ({time.time()-t0:.0f}s total)', flush=True)
    print('done')
if __name__ == '__main__': main()
