"""Run the walk-forward feature engine over every game (2014..2026) -> data/cache/features.parquet (+ targets, market).
Set PARITY=<season> to also write a Node parity fixture (history + Python features) for that season onward."""
import os, json, numpy as np, pandas as pd, time
from features import walk, CFG, STATS
G = pd.read_parquet('data/cache/games.parquet'); M = pd.read_parquet('data/cache/market.parquet')
G = G.merge(M[['gid', 'close']], on='gid', how='left')
PARITY = os.environ.get('PARITY')
if os.environ.get('CLOSE_SRC') == 'espn':
    # live-loader rule (ncaaf/lib/vas-data.js): consensus close = median of ESPN core odds top-level `spread` over real
    # books (no "Live Odds" provider, no numberfire/teamrankings/accuscore/consensus/SportsInsights/Opening)
    NOT_BOOKS = {'numberfire', 'teamrankings', 'accuscore', 'consensus', 'SportsInsights', 'Opening'}
    ec = {}
    for line in open('data/espn/odds.jsonl'):
        e = json.loads(line)
        v = [b['spread'] for b in (e['books'] or []) if b['book'] not in NOT_BOOKS and 'Live' not in b['book'] and b['spread'] is not None]
        ec[e['id']] = float(np.median(v)) if v else np.nan
    G['close'] = G.gid.map(ec)
if PARITY: G = G[G.season >= int(PARITY)].reset_index(drop=True)
cols = ['gid', 'season', 'start', 'neutral', 'conf_game', 'home_id', 'away_id', 'home_pts', 'away_pts', 'home_fbs', 'away_fbs', 'home_qb', 'away_qb', 'close'] + \
       ([] if PARITY else ['home_qb1', 'away_qb1']) + \
       [f'{s}_{k}' for s in ('home', 'away') for k in STATS if k != 'pts']
recs = []
for r in G[cols].to_dict('records'):
    for k, v in list(r.items()):
        if isinstance(v, (np.integer,)): r[k] = int(v)
        elif isinstance(v, (np.floating,)): r[k] = float(v)
    r['close'] = None if r['close'] != r['close'] else r['close']
    recs.append(r)
t0 = time.time()
feats, W = walk(recs, CFG, keep_sides=bool(PARITY), late=not PARITY)
print(f'walk: {len(feats)} games in {time.time()-t0:.1f}s')
if PARITY:
    os.makedirs('data/cache/parity', exist_ok=True)
    hist = []
    for r in recs:
        h = {k: (None if isinstance(v, float) and v != v else v) for k, v in r.items()}
        h['day'] = r['start'][:10]; hist.append(h)
    SUF = '_espnclose' if os.environ.get('CLOSE_SRC') == 'espn' else ''
    json.dump({'games': hist}, open(f'data/cache/parity/history{SUF}.json', 'w'))
    out = [{'gid': g, **{f'{s}_{k}': v for s in ('home', 'away') for k, v in f['_' + s].items()}, **{k: v for k, v in f.items() if not k.startswith('_')}} for g, f in feats.items()]
    json.dump(out, open(f'data/cache/parity/features_py{SUF}.json', 'w'))
    print('parity fixture written', len(hist), 'games'); raise SystemExit
F = pd.DataFrame([{'gid': g, **f} for g, f in feats.items()]).drop(columns=['neutral', 'conf_game', 'home_fbs', 'away_fbs'])
F = G.drop(columns=['close']).merge(F, on='gid').merge(M, on='gid', how='left')
F['margin'] = F.home_pts - F.away_pts; F['total'] = F.home_pts + F.away_pts; F['y'] = (F.margin > 0).astype(int)
# preseason, open-safe: talent composite z-scored within season over the FBS teams of that season (one value per team,
# exported per team id for the Node runtime), returning production (0.5 when missing)
PRE = {}
for S in sorted(F.season.unique()):
    ts = pd.read_parquet(f'data/sdv/cfb_team_summaries_{S}.parquet'); fbs = set(ts[ts.division == 'fbs'].team_id.astype(int))
    try: tal = pd.read_parquet(f'data/sdv/cfb_team_talent_{S}.parquet'); tal = {int(k): float(v) for k, v in zip(tal.team_id, tal.talent_composite) if pd.notna(v)}
    except Exception: tal = {}
    v = np.array([tal[t] for t in fbs if t in tal])
    mu, sd = (v.mean(), v.std()) if len(v) > 10 else (0.0, 0.0)
    PRE[int(S)] = {t: ((tal[t] - mu) / sd if sd > 0 and t in tal else -2.0) for t in fbs}
for s in ('home', 'away'):
    F[f'{s}_tz'] = [PRE[S].get(t, -2.0) for S, t in zip(F.season, F[f'{s}_id'])]   # non-FBS or unknown talent = -2 sd
json.dump({str(S): {str(t): z for t, z in d.items()} for S, d in PRE.items()}, open('data/cache/talent_z.json', 'w'))
F['d_talent'] = F.home_tz - F.away_tz
F['d_ret_off'] = (F.home_ret_off.fillna(0.5) - F.away_ret_off.fillna(0.5)); F['d_ret_def'] = (F.home_ret_def.fillna(0.5) - F.away_ret_def.fillna(0.5))
F['early'] = (F.week <= 4).astype(int) * (F.stype == 2)
F.to_parquet('data/cache/features.parquet')
print(F.groupby('season').agg(n=('gid', 'size'), has_close=('close', lambda s: s.notna().mean()), qb_change_home=('L_home_qb_change', 'mean')).round(3).to_string())
