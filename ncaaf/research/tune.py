"""Pick the feature-engine config on PRE-holdout seasons only (2017-2022 rolling fits). Holdout seasons are never used."""
import itertools, numpy as np, pandas as pd, json, warnings
from sklearn.linear_model import Ridge
from features import walk, CFG, STATS
warnings.filterwarnings('ignore')
G = pd.read_parquet('data/cache/games.parquet'); M = pd.read_parquet('data/cache/market.parquet')
G = G[G.season <= 2022].merge(M[['gid', 'close']], on='gid', how='left')
cols = ['gid', 'season', 'start', 'neutral', 'conf_game', 'home_id', 'away_id', 'home_pts', 'away_pts', 'home_fbs', 'away_fbs', 'home_qb', 'away_qb', 'close'] + [f'{s}_{k}' for s in ('home', 'away') for k in STATS if k != 'pts']
recs = G[cols].to_dict('records')
for r in recs:
    if r['close'] != r['close']: r['close'] = None
y = (G.home_pts - G.away_pts).values; season = G.season.values
def score(cfg, cols_used):
    f, _ = walk(recs, cfg)
    X = pd.DataFrame([f[g] for g in G.gid])
    X['home'] = 1 - X.neutral
    X = X[cols_used + ['home']].values
    err = []
    for S in (2017, 2018, 2019, 2021, 2022):
        tr = (season >= 2015) & (season < S); te = season == S
        mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9
        r = Ridge(alpha=30).fit((X[tr] - mu) / sd, y[tr]); err.append(np.mean((y[te] - r.predict((X[te] - mu) / sd)) ** 2))
    return float(np.sqrt(np.mean(err)))
TEAM = [f'd_{s}_{k}' for k in STATS for s in ('o', 'd')]
res = []
for hl, ks, carry in itertools.product((4, 6, 9, 12, 14), (1, 2, 4, 8), (0.2, 0.35, 0.5, 0.7, 0.8, 0.9)):
    c = dict(CFG, hl=float(hl), k_shrink=float(ks), carry=carry); res.append(('team', hl, ks, carry, score(c, TEAM)))
best_t = min(res, key=lambda r: r[-1]); print('team best', best_t, flush=True)
res2 = []
for lr, cm, hfa in itertools.product((0.08, 0.15, 0.25, 0.4, 0.55, 0.7), (0.5, 0.7, 0.85, 0.95, 1.0), (2.0, 3.0)):
    c = dict(CFG, lr_m=lr, carry_m=cm, hfa_m=hfa); res2.append(('mkt', lr, cm, hfa, score(c, ['d_mkt'])))
best_m = min(res2, key=lambda r: r[-1]); print('market best', best_m, flush=True)
for kq in (2.0, 4.0, 8.0):
    print('k_qb', kq, score(dict(CFG, k_qb=kq), ['d_qb_pepa', 'd_qb_starts']))
json.dump({'team': res, 'market': res2}, open('data/cache/tune.json', 'w'))
