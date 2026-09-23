"""Which stage-1 models help? Holdout (2023-25) margin RMSE, win log loss, and correlation of each model's gap vs the
open with the actual open->close move, for ridge / GBM / Keras nets and their averages, next to the market."""
import numpy as np, pandas as pd, json
from common import load, HOLDOUT
F = load().merge(pd.read_parquet('data/cache/stage1_preds.parquet').drop(columns=['season']), on='gid').merge(pd.read_parquet('data/cache/nn_preds.parquet').drop(columns=['season']), on='gid', how='left')
T = F[F.season.isin(HOLDOUT) & F.m_all.notna()].copy()
nets = [c[2:] for c in F.columns if c.startswith('m_') and c[2:] in ('vectornet', 'seq_gru', 'seq_transformer')]
T['m_nets'] = T[['m_' + n for n in nets]].mean(1); T['m_lin_gbm'] = T[['m_all', 'm_gbm']].mean(1); T['m_all_models'] = T[['m_all', 'm_gbm'] + ['m_' + n for n in nets]].mean(1)
ll = lambda p, y: float(-np.mean(y * np.log(np.clip(p, 1e-6, 1 - 1e-6)) + (1 - y) * np.log(1 - np.clip(p, 1e-6, 1 - 1e-6))))
mk = T.bet_line.notna() & T.close.notna(); clv = (T.bet_line - T.close)[mk]
rows = []
for name in ['all', 'gbm'] + nets + ['lin_gbm', 'nets', 'all_models']:
    m = T['m_' + name]
    r = {'model': {'all': 'ridge (linear)', 'gbm': 'gradient boosting'}.get(name, name), 'rmse': round(float(np.sqrt(np.mean((T.margin - m) ** 2))), 3),
         'rmse_by_season': [round(float(np.sqrt(np.mean((T.margin - m)[T.season == S] ** 2))), 3) for S in HOLDOUT],
         'gap_vs_move_corr': round(float(np.corrcoef((m + T.bet_line)[mk], clv)[0, 1]), 3)}
    if 'p_' + name in T: d = T[(T.margin != 0) & T.ml_close.notna()]; r['win_logloss_ml_games'] = round(ll(d['p_' + name].values, d.y.values), 4)   # same games as the moneyline
    rows.append(r)
d = T[(T.margin != 0) & T.ml_close.notna()]; rows.append({'model': 'ridge->logistic win prob', 'win_logloss_ml_games': round(ll(d.p_ridge.values, d.y.values), 4)})
rows.append({'model': 'logistic (all features)', 'win_logloss_ml_games': round(ll(d.p_lr.values, d.y.values), 4)})
dc = T[T.close.notna()]; rows.append({'model': 'MARKET close (-spread)', 'rmse': round(float(np.sqrt(np.mean((dc.margin + dc.close) ** 2))), 3)})
do = T[T.open.notna()]; rows.append({'model': 'MARKET open (-spread, median)', 'rmse': round(float(np.sqrt(np.mean((do.margin + do.open) ** 2))), 3)})
dm = T[T.ml_close.notna() & (T.margin != 0)]; rows.append({'model': 'MARKET close moneyline (no-vig)', 'win_logloss_ml_games': round(ll(dm.ml_close.values, dm.y.values), 4)})
R = pd.DataFrame(rows); print(R.to_string(index=False))
json.dump(rows, open('data/cache/nn_report.json', 'w'), indent=1)
