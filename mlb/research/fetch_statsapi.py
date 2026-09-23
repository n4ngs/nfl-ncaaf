"""MLB Stats API (statsapi.mlb.com, free, public): regular-season schedules + compact boxscores + player handedness.

Outputs (resumable; re-run to pick up newly completed games):
  data/sched/{season}.json   raw schedule (hydrate=probablePitcher,weather,officials) per season
  data/box/{season}.jsonl    one compact boxscore per completed game (per-player batting/pitching lines,
                             batting order, starter, weather/wind/first pitch/umpire)
  data/people.json           {pid: {'p': pitchHand, 'b': batSide}}
"""
import json, os, sys, time, datetime as dt, urllib.request
from concurrent.futures import ThreadPoolExecutor
SEASONS = [int(x) for x in os.environ.get('SEASONS', '2018,2019,2020,2021,2022,2023,2024,2025,2026').split(',')]
API = 'https://statsapi.mlb.com/api/v1'
def get(url, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r: return json.load(r)
        except Exception as e:
            if i == tries - 1: return {'_error': str(e)}
            time.sleep(2 * (i + 1))

def schedule(S):
    path = f'data/sched/{S}.json'
    today = dt.date.today().isoformat()
    if os.path.exists(path) and S < dt.date.today().year: return json.load(open(path))
    d = get(f'{API}/schedule?sportId=1&gameType=R&startDate={S}-02-15&endDate={S}-11-30&hydrate=probablePitcher,weather,officials')
    if '_error' in d: raise SystemExit(f'schedule {S}: {d}')
    json.dump(d, open(path, 'w')); return d

N = lambda v: int(v) if isinstance(v, (int, float)) else 0
def outs_of(ip):
    try: w, f = str(ip).split('.'); return int(w) * 3 + int(f)
    except Exception: return 0
def compact(pk):
    b = get(f'{API}/game/{pk}/boxscore')
    if '_error' in b: return None
    out = {'pk': pk, 'teams': {}}
    for side in ('home', 'away'):
        t = b['teams'][side]; P = t['players']
        bat = []
        for pid in t.get('batters', []):
            p = P.get(f'ID{pid}') or {}; s = (p.get('stats') or {}).get('batting') or {}
            if not s: continue
            bat.append({'id': pid, 'bo': p.get('battingOrder'), 'pos': (p.get('position') or {}).get('abbreviation'),
                        'pa': N(s.get('plateAppearances')), 'ab': N(s.get('atBats')), 'h': N(s.get('hits')), 'd': N(s.get('doubles')),
                        't': N(s.get('triples')), 'hr': N(s.get('homeRuns')), 'bb': N(s.get('baseOnBalls')), 'ibb': N(s.get('intentionalWalks')),
                        'hbp': N(s.get('hitByPitch')), 'so': N(s.get('strikeOuts')), 'sf': N(s.get('sacFlies')), 'r': N(s.get('runs'))})
        pit = []
        for pid in t.get('pitchers', []):
            p = P.get(f'ID{pid}') or {}; s = (p.get('stats') or {}).get('pitching') or {}
            pit.append({'id': pid, 'outs': N(s.get('outs')) or outs_of(s.get('inningsPitched')), 'bf': N(s.get('battersFaced')), 'k': N(s.get('strikeOuts')),
                        'bb': N(s.get('baseOnBalls')), 'ibb': N(s.get('intentionalWalks')), 'hbp': N(s.get('hitBatsmen')), 'hr': N(s.get('homeRuns')),
                        'h': N(s.get('hits')), 'er': N(s.get('earnedRuns')), 'r': N(s.get('runs')), 'np': N(s.get('numberOfPitches') or s.get('pitchesThrown')),
                        'gs': N(s.get('gamesStarted'))})
        ts = (t.get('teamStats') or {}).get('batting') or {}
        out['teams'][side] = {'id': t['team']['id'], 'order': t.get('battingOrder', []), 'bat': bat, 'pit': pit,
                              'bullpen': t.get('bullpen', []), 'bench': t.get('bench', []), 'runs': N(ts.get('runs'))}
    info = {x['label']: x.get('value', '') for x in b.get('info', []) if 'label' in x}
    out['info'] = {k: info.get(k) for k in ('Weather', 'Wind', 'First pitch', 'T', 'Att', 'Venue')}
    out['hp'] = next((o['official']['id'] for o in b.get('officials', []) if o.get('officialType') == 'Home Plate'), None)
    return out

def main():
    for S in SEASONS:
        d = schedule(S)
        games = {}
        for day in d.get('dates', []):
            for g in day['games']:
                if g.get('gameType') != 'R': continue
                st = g['status']
                if st.get('abstractGameState') == 'Final' and st.get('codedGameState') in ('F', 'O'):   # F final, O game over; not postponed/cancelled
                    games[g['gamePk']] = g
        path = f'data/box/{S}.jsonl'
        done = set()
        if os.path.exists(path):
            for l in open(path):
                try: done.add(json.loads(l)['pk'])
                except Exception: pass
        todo = [pk for pk in sorted(games) if pk not in done]
        t0 = time.time(); n = 0
        with open(path, 'a') as f, ThreadPoolExecutor(6) as ex:
            for r in ex.map(compact, todo):
                if r: f.write(json.dumps(r, separators=(',', ':')) + '\n'); n += 1
                if n % 500 == 0 and n: f.flush(); print(f'  {S}: {n}/{len(todo)} ({time.time()-t0:.0f}s)', flush=True)
        print(f'season {S}: {len(games)} final games, {n} new boxscores ({time.time()-t0:.0f}s)', flush=True)
    # handedness for every player seen
    pids = set()
    for S in SEASONS:
        for l in open(f'data/box/{S}.jsonl'):
            g = json.loads(l)
            for side in ('home', 'away'):
                pids.update(x['id'] for x in g['teams'][side]['bat']); pids.update(x['id'] for x in g['teams'][side]['pit'])
        for day in json.load(open(f'data/sched/{S}.json')).get('dates', []):
            for g in day['games']:
                for side in ('home', 'away'):
                    pp = g['teams'][side].get('probablePitcher')
                    if pp: pids.add(pp['id'])
    people = json.load(open('data/people.json')) if os.path.exists('data/people.json') else {}
    todo = sorted(p for p in pids if str(p) not in people)
    for i in range(0, len(todo), 150):
        d = get(f'{API}/people?personIds=' + ','.join(map(str, todo[i:i + 150])))
        for p in d.get('people', []):
            people[str(p['id'])] = {'p': (p.get('pitchHand') or {}).get('code'), 'b': (p.get('batSide') or {}).get('code'), 'n': p.get('fullName')}
    json.dump(people, open('data/people.json', 'w'))
    print('people', len(people), 'done')
if __name__ == '__main__': main()
