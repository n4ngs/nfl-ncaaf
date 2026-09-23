"""Stage-1 fundamentals vs the market, rolling origin by season (anything predicting season S is fit on seasons < S).
Targets: margin (ridge / GBM) and home win (logistic). Scores per season and for the holdout (2023-2025):
margin RMSE vs the market's -spread (open and close), win log loss / Brier vs the no-vig moneyline close.
Output: data/cache/stage1_preds.parquet, data/cache/model_report.json"""
import json, warnings, numpy as np, pandas as pd
from sklearn.linear_model import Ridge, LogisticRegression
from sklearn.ensemble import HistGradientBoostingRegressor
from common import GROUPS, load, HOLDOUT
warnings.filterwarnings('ignore'); np.seterr(all='ignore')
F = load()
ALL = sum(GROUPS.values(), [])
def zfit(tr, cols):
    X = F.loc[tr, cols].values; return X.mean(0), X.std(0) + 1e-9
ll = lambda p, y: float(-np.mean(y * np.log(np.clip(p, 1e-6, 1 - 1e-6)) + (1 - y) * np.log(1 - np.clip(p, 1e-6, 1 - 1e-6))))
for S in range(2017, 2026):
    tr = F.season.between(2015, S - 1).values; te = (F.season == S).values
    for name, cols in list(GROUPS.items()) + [('all', ALL)]:
        mu, sd = zfit(tr, cols); Xs = (F[cols].values - mu) / sd
        r = Ridge(alpha=30).fit(Xs[tr], F.margin[tr]); F.loc[te, 'm_' + name] = r.predict(Xs[te])
    mu, sd = zfit(tr, ALL); Xs = (F[ALL].values - mu) / sd
    lg = LogisticRegression(C=0.1, max_iter=4000).fit(Xs[tr], F.y[tr]); F.loc[te, 'p_lr'] = lg.predict_proba(Xs[te])[:, 1]
    gb = HistGradientBoostingRegressor(max_iter=400, learning_rate=0.03, max_leaf_nodes=15, min_samples_leaf=60, l2_regularization=1.0, random_state=0).fit(F.loc[tr, ALL], F.margin[tr])
    F.loc[te, 'm_gbm'] = gb.predict(F.loc[te, ALL])
    # margin -> win probability: logistic on the ridge margin, fit on the training seasons' in-sample predictions
    r_all = Ridge(alpha=30).fit(Xs[tr], F.margin[tr]); cal = LogisticRegression(C=1e6).fit(r_all.predict(Xs[tr])[:, None], F.y[tr])
    F.loc[te, 'p_ridge'] = cal.predict_proba(F.loc[te, ['m_all']].values)[:, 1]
F['m_agg'] = (F.m_all + F.m_gbm) / 2
rep = {}
rows = []
for S in list(range(2017, 2026)) + ['holdout']:
    d = F[F.season.isin(HOLDOUT)] if S == 'holdout' else F[F.season == S]
    d = d[d.m_all.notna()]
    r = {'season': S, 'games': len(d)}
    for c in ['m_all', 'm_gbm', 'm_agg'] + ['m_' + g for g in GROUPS]:
        r['rmse_' + c] = round(float(np.sqrt(np.mean((d.margin - d[c]) ** 2))), 3)
    dc = d[d.close.notna()]; r['rmse_close'] = round(float(np.sqrt(np.mean((dc.margin + dc.close) ** 2))), 3)
    r['rmse_model_same_games_as_close'] = round(float(np.sqrt(np.mean((dc.margin - dc.m_agg) ** 2))), 3)
    do = d[d.open.notna()]
    if len(do): r['rmse_open'] = round(float(np.sqrt(np.mean((do.margin + do.open) ** 2))), 3); r['rmse_model_same_games_as_open'] = round(float(np.sqrt(np.mean((do.margin - do.m_agg) ** 2))), 3); r['n_open'] = len(do)
    dm = d[d.ml_close.notna() & (d.margin != 0)]
    r['ll_lr'] = round(ll(dm.p_lr.values, dm.y.values), 4); r['ll_ridge'] = round(ll(dm.p_ridge.values, dm.y.values), 4); r['ll_ml_close'] = round(ll(dm.ml_close.values, dm.y.values), 4)
    r['brier_lr'] = round(float(np.mean((dm.p_lr - dm.y) ** 2)), 4); r['brier_ml_close'] = round(float(np.mean((dm.ml_close - dm.y) ** 2)), 4)
    rows.append(r)
R = pd.DataFrame(rows).set_index('season')
print(R[['games', 'rmse_m_all', 'rmse_m_gbm', 'rmse_m_agg', 'rmse_model_same_games_as_close', 'rmse_close', 'rmse_model_same_games_as_open', 'rmse_open', 'll_lr', 'll_ml_close']].to_string())
print(R[['rmse_m_' + g for g in GROUPS]].to_string())
json.dump(R.reset_index().to_dict('records'), open('data/cache/model_report.json', 'w'), indent=1, default=str)
F[['gid', 'season', 'm_all', 'm_gbm', 'm_agg', 'p_lr', 'p_ridge'] + ['m_' + g for g in GROUPS]].to_parquet('data/cache/stage1_preds.parquet')
