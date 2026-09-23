"""Official NHL boxscores -> games (results, starters) + lineups (dressed skaters with TOI)."""
import gzip, json, glob, pandas as pd
def toi(v):
    try: m, s = str(v).split(':'); return int(m) + int(s) / 60
    except Exception: return 0.0
games, lineups = [], []
for f in sorted(glob.glob('data/nhlbox/*.json.gz')):
    b = json.loads(gzip.decompress(open(f, 'rb').read()))
    if b.get('gameType') != 2 or b.get('gameState') not in ('OFF', 'FINAL'): continue
    r = {'gid': b['id'], 'season': b['id'] // 1000000, 'start': b['startTimeUTC'], 'date': b['gameDate'],
         'last_period': (b.get('gameOutcome') or {}).get('lastPeriodType')}
    ok = True
    for side in ('home', 'away'):
        t = b[side + 'Team']; p = (b.get('playerByGameStats') or {}).get(side + 'Team') or {}
        r[side] = t['abbrev']; r[side + '_tid'] = t['id']; r[side + '_goals'] = t['score']; r[side + '_sog'] = t.get('sog')
        gl = p.get('goalies') or []
        st = [g for g in gl if g.get('starter')]
        if not st and gl: st = sorted(gl, key=lambda g: toi(g.get('toi')), reverse=True)[:1]
        if not st: ok = False; break
        r[side + '_starter'] = st[0]['playerId']
        r[side + '_starter_name'] = (st[0].get('name') or {}).get('default')
        r[side + '_pulled'] = int(toi(st[0].get('toi')) < 40 and any(toi(g.get('toi')) > 0 for g in gl if g is not st[0]))
        for pos in ('forwards', 'defense'):
            for x in p.get(pos) or []:
                lineups.append({'gid': b['id'], 'side': side, 'team': t['abbrev'], 'pid': x['playerId'], 'pos': 'D' if pos == 'defense' else 'F',
                                'toi': toi(x.get('toi')), 'g': x.get('goals', 0), 'a': x.get('assists', 0)})
    if ok and r['home_goals'] != r['away_goals']: games.append(r)
G = pd.DataFrame(games).sort_values(['start', 'gid']).reset_index(drop=True)
G['y'] = (G.home_goals > G.away_goals).astype(int)
G.to_parquet('data/cache/games.parquet'); pd.DataFrame(lineups).to_parquet('data/cache/lineups.parquet')
print(len(G), 'games', G.groupby('season').size().to_dict(), 'home win %.3f' % G.y.mean())
