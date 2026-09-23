"""ESPN public odds for MLB regular-season games (no login). Resumable: skips events already saved.

  scoreboard  https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=YYYYMMDD&limit=50
  odds        https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/{id}/competitions/{id}/odds?limit=50
  movement    .../odds/1002/history/0/movement?limit=300 (moneyline) and .../history/2/movement (total)
              provider 1002 = "teamrankings": timestamped line history. Only source of OPEN lines before 2024.
Output: data/espn/games.jsonl (one line per event)
NOTE: no custom User-Agent (ESPN's edge 403s custom agents; urllib's default is accepted).
"""
import json, os, time, datetime as dt, urllib.request
from concurrent.futures import ThreadPoolExecutor
OUT = 'data/espn/games.jsonl'
SEASONS = [int(x) for x in os.environ.get('SEASONS', '2019,2020,2021,2022,2023,2024,2025,2026').split(',')]
CORE = 'https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/{0}/competitions/{0}/odds'
def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url), timeout=30) as r: return json.load(r)
        except Exception as e:
            if i == tries - 1: return {'_error': str(e)}
            time.sleep(2 * (i + 1))
def am(x):
    if x in (None, '', 'OFF'): return None
    if x == 'EVEN': return 100
    try: return float(str(x).replace('+', ''))
    except ValueError: return None
def sub(o, *ks):
    for k in ks: o = (o or {}).get(k)
    return o
def side(o):
    return {'ml': o.get('moneyLine'), 'open': am(sub(o, 'open', 'moneyLine', 'american')), 'close': am(sub(o, 'close', 'moneyLine', 'american')),
            'cur': am(sub(o, 'current', 'moneyLine', 'american')),
            'rl_open': am(sub(o, 'open', 'pointSpread', 'american')), 'rl_open_px': am(sub(o, 'open', 'spread', 'american')),
            'rl_close': am(sub(o, 'close', 'pointSpread', 'american')), 'rl_close_px': am(sub(o, 'close', 'spread', 'american'))}
def tot(o):
    return {'line': am(sub(o, 'total', 'american')), 'over': am(sub(o, 'over', 'american')), 'under': am(sub(o, 'under', 'american'))} if o else None
def odds(eid):
    d = get(CORE.format(eid) + '?limit=50')
    if '_error' in d: return None, None
    books = []; tr = False
    for it in d.get('items', []):
        name = it['provider']['name']
        if it['provider'].get('id') == '1002': tr = True
        books.append({'book': name, 'pid': it['provider'].get('id'), 'home': side(it.get('homeTeamOdds') or {}), 'away': side(it.get('awayTeamOdds') or {}),
                      'ou': it.get('overUnder'), 'over': it.get('overOdds'), 'under': it.get('underOdds'),
                      'tot_open': tot(it.get('open')), 'tot_close': tot(it.get('close'))})
    mv = None
    if tr:
        ml = get(CORE.format(eid) + '/1002/history/0/movement?limit=300'); to = get(CORE.format(eid) + '/1002/history/2/movement?limit=300')
        mv = {'ml': [[x.get('lineDate'), x.get('homeOdds'), x.get('awayOdds')] for x in ml.get('items', [])],
              'tot': [[x.get('lineDate'), x.get('line'), x.get('overOdds'), x.get('underOdds')] for x in to.get('items', [])]}
    return books, mv
def events(day):
    d = get(f'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates={day:%Y%m%d}&limit=50')
    out = []
    for e in d.get('events', []):
        if (e.get('season') or {}).get('type') != 2: continue
        c = e['competitions'][0]; st = c['status']['type']
        if not st.get('completed'): continue
        t = {x['homeAway']: x for x in c['competitors']}
        out.append({'id': e['id'], 'date': c.get('date') or e['date'], 'season': e['season']['year'], 'sbday': f'{day:%Y-%m-%d}',
                    'home': t['home']['team']['abbreviation'], 'away': t['away']['team']['abbreviation'],
                    'homeName': t['home']['team'].get('displayName'), 'awayName': t['away']['team'].get('displayName'),
                    'homeScore': int(t['home']['score']), 'awayScore': int(t['away']['score']),
                    'innings': c['status'].get('period'), 'detail': st.get('shortDetail')})
    return out
def main():
    done = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            try: done.add(json.loads(l)['id'])
            except Exception: pass
    for y in SEASONS:
        days = []; d = dt.date(y, 3, 15); end = min(dt.date(y, 10, 6), dt.date.today() - dt.timedelta(days=1))
        while d <= end: days.append(d); d += dt.timedelta(days=1)
        t0 = time.time(); seen = set()
        with ThreadPoolExecutor(8) as ex:
            evs = []
            for day in ex.map(events, days):
                for e in day:
                    if e['id'] not in done and e['id'] not in seen: seen.add(e['id']); evs.append(e)
        print(f'season {y}: {len(evs)} new events ({time.time()-t0:.0f}s scoreboard)', flush=True)
        with open(OUT, 'a') as f, ThreadPoolExecutor(8) as ex:
            for n, (e, o) in enumerate(zip(evs, ex.map(lambda e: odds(e['id']), evs)), 1):
                e['books'], e['move'] = o; f.write(json.dumps(e, separators=(',', ':')) + '\n')
                if n % 500 == 0: f.flush(); print(f'  {y}: {n}/{len(evs)} ({time.time()-t0:.0f}s)', flush=True)
        print(f'season {y}: odds saved ({time.time()-t0:.0f}s total)', flush=True)
    print('done')
if __name__ == '__main__': main()
