"""Join schedules + compact boxscores into one ordered game history (the exact input the Node engine walks).

Output: data/cache/history.pkl  list of games oldest first (day, scheduled start, gamePk) with
  pk, season, day (officialDate), start (UTC scheduled), dh (gameNumber), venue, dn, home, away (MLB team ids),
  hs, as (runs), prob {home, away} (schedule probable pitcher, known at the open), box (compact, see fetch_statsapi),
  hp (home-plate umpire id), wx {temp, wind, dir, roof}
        data/cache/games.parquet flat table (one row per game) + team id -> abbreviation map in data/cache/teams.json
Checks: every final scheduled game has a boxscore; duplicates by gamePk (postponed + makeup) resolved to the final.
"""
import json, os, re, glob, pickle, pandas as pd, urllib.request
SEASONS = sorted(int(os.path.basename(p)[:4]) for p in glob.glob('data/sched/*.json'))

def wx(info):
    w, wd = (info or {}).get('Weather') or '', (info or {}).get('Wind') or ''
    m = re.match(r'\s*(-?\d+)\s*degrees', w); temp = float(m.group(1)) if m else None
    roof = int(bool(re.search(r'Roof Closed|Dome', w, re.I)))
    m = re.match(r'\s*(\d+)\s*mph,?\s*(.*?)\.?\s*$', wd); spd = float(m.group(1)) if m else 0.0; d = (m.group(2) if m else '').strip()
    sign = 1 if d.lower().startswith('out') else -1 if d.lower().startswith('in') else 0
    return {'temp': temp, 'wind': spd, 'dir': d, 'out': 0.0 if roof else sign * spd, 'roof': roof}

def main():
    teams = {}
    try:
        with urllib.request.urlopen('https://statsapi.mlb.com/api/v1/teams?sportId=1&season=2026', timeout=30) as r:
            for t in json.load(r)['teams']: teams[t['id']] = {'abbr': t['abbreviation'], 'name': t['name']}
    except Exception as e: print('teams lookup failed', e)
    games = {}
    for S in SEASONS:
        box = {}
        for l in open(f'data/box/{S}.jsonl'):
            g = json.loads(l); box[g['pk']] = g
        n_final = 0
        for d in json.load(open(f'data/sched/{S}.json'))['dates']:
            for x in d['games']:
                st = x['status']
                if x.get('gameType') != 'R' or st.get('abstractGameState') != 'Final' or st.get('codedGameState') not in ('F', 'O'): continue
                n_final += 1; b = box.get(x['gamePk'])
                if b is None: continue
                h, a = x['teams']['home'], x['teams']['away']
                for s in (h, a): teams.setdefault(s['team']['id'], {'abbr': str(s['team']['id']), 'name': s['team'].get('name')})
                prob = {k: (x['teams'][k].get('probablePitcher') or {}).get('id') for k in ('home', 'away')}
                games[x['gamePk']] = {'pk': x['gamePk'], 'season': S, 'day': x['officialDate'], 'start': x['gameDate'], 'dh': x.get('gameNumber', 1),
                                      'dhtype': x.get('doubleHeader'), 'venue': (x.get('venue') or {}).get('id'), 'dn': x.get('dayNight'),
                                      'home': h['team']['id'], 'away': a['team']['id'], 'hs': h.get('score'), 'as': a.get('score'),
                                      'inn': None, 'prob': prob, 'box': b['teams'], 'hp': b.get('hp'), 'wx': wx(b.get('info')),
                                      'tbd': bool(st.get('startTimeTBD'))}
        print(f'{S}: {n_final} final scheduled, {sum(1 for g in games.values() if g["season"] == S)} with boxscore', flush=True)
    G = sorted(games.values(), key=lambda g: (g['day'], g['start'], g['pk']))
    bad = [g['pk'] for g in G if g['hs'] is None or g['as'] is None or not g['box']['home']['pit'] or not g['box']['away']['pit']]
    print('games', len(G), 'missing score/pitchers', len(bad))
    G = [g for g in G if g['pk'] not in set(bad)]
    os.makedirs('data/cache', exist_ok=True)
    pickle.dump(G, open('data/cache/history.pkl', 'wb'))
    json.dump({str(k): v for k, v in teams.items()}, open('data/cache/teams.json', 'w'))
    flat = pd.DataFrame([{k: g[k] for k in ('pk', 'season', 'day', 'start', 'dh', 'dhtype', 'venue', 'dn', 'home', 'away', 'hs', 'as', 'hp', 'tbd')} |
                         {'prob_home': g['prob']['home'], 'prob_away': g['prob']['away'],
                          'sp_home': g['box']['home']['pit'][0]['id'], 'sp_away': g['box']['away']['pit'][0]['id'],
                          **{'wx_' + k: v for k, v in g['wx'].items()}} for g in G])
    flat['y'] = (flat.hs > flat['as']).astype(int); flat['total'] = flat.hs + flat['as']
    flat.to_parquet('data/cache/games.parquet')
    print(flat.groupby('season').agg(n=('pk', 'size'), home_win=('y', 'mean'), runs=('total', 'mean'), prob_missing=('prob_home', lambda s: s.isna().mean()),
                                     prob_is_starter=('prob_home', lambda s: (s == flat.loc[s.index, 'sp_home']).mean())).round(3))
if __name__ == '__main__': main()
