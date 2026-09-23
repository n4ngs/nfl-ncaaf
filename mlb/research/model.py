"""Stage 1 fundamentals, rolling origin by season (fit only on earlier seasons), open-safe features.

Moneyline: logistic regression, gradient boosting, Keras MLP (3 seeds, early stopping on the last training season),
plus the Keras tower MLP / GRU sequence models from nn.py when data/cache/nn_preds.parquet exists.
Totals: ridge, gradient boosting, Keras MLP (Poisson loss) on total runs.
Aggregates: logit average of LR+GBM+MLP ('agg3'), and a stacker fit only on earlier seasons ('stack').
Scores vs the market open and close (log loss / Brier; totals: MAE of mean runs).
Output: data/cache/stage1.parquet, data/cache/model_report.json
"""
from common import *
import json, sys, keras
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor

F = load()
F = F[F.season >= FIRST_TRAIN].reset_index(drop=True)
X_ml = F[ML_OPEN].values.astype(float); X_t = F[TOT_OPEN].values.astype(float)
y = F.y.values.astype(float); tot = F.total.values.astype(float)
SEEDS = (1, 2, 3)

def mlp(n_in, kind, seed):
    keras.utils.set_random_seed(seed)
    out = keras.layers.Dense(1, activation='sigmoid' if kind == 'bin' else 'exponential')
    m = keras.Sequential([keras.Input((n_in,)), keras.layers.Dense(32, activation='gelu', kernel_regularizer=keras.regularizers.l2(1e-3)),
                          keras.layers.Dropout(0.3), keras.layers.Dense(16, activation='gelu'), out])
    m.compile(keras.optimizers.Adam(1e-3), 'binary_crossentropy' if kind == 'bin' else 'poisson'); return m

for S in range(2021, 2027):
    tr = (F.season < S).values; te = (F.season == S).values; va = (F.season == S - 1).values; fit = tr & ~va
    mu, sd = X_ml[tr].mean(0), X_ml[tr].std(0) + 1e-9; Xs = (X_ml - mu) / sd
    lr = LogisticRegression(C=0.3, max_iter=4000).fit(Xs[tr], y[tr])
    gb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.03, max_leaf_nodes=15, min_samples_leaf=100, l2_regularization=1.0, random_state=0).fit(X_ml[tr], y[tr])
    ps = []
    for sd_ in SEEDS:
        m = mlp(Xs.shape[1], 'bin', sd_)
        m.fit(Xs[fit], y[fit], validation_data=(Xs[va], y[va]), epochs=60, batch_size=256, verbose=0,
              callbacks=[keras.callbacks.EarlyStopping(patience=6, restore_best_weights=True)])
        ps.append(m.predict(Xs[te], verbose=0)[:, 0])
    F.loc[te, 'p_lr'] = lr.predict_proba(Xs[te])[:, 1]; F.loc[te, 'p_gbm'] = gb.predict_proba(X_ml[te])[:, 1]; F.loc[te, 'p_mlp'] = np.mean(ps, 0)
    F.loc[te, 'p_home'] = y[tr].mean()
    # totals
    mt, st = X_t[tr].mean(0), X_t[tr].std(0) + 1e-9; Ts = (X_t - mt) / st
    rg = Ridge(alpha=10).fit(Ts[tr], tot[tr])
    gt = HistGradientBoostingRegressor(loss='poisson', max_iter=300, learning_rate=0.03, max_leaf_nodes=15, min_samples_leaf=100, random_state=0).fit(X_t[tr], tot[tr])
    ts = []
    for sd_ in SEEDS:
        m = mlp(Ts.shape[1], 'pois', sd_)
        m.fit(Ts[fit], tot[fit], validation_data=(Ts[va], tot[va]), epochs=60, batch_size=256, verbose=0,
              callbacks=[keras.callbacks.EarlyStopping(patience=6, restore_best_weights=True)])
        ts.append(m.predict(Ts[te], verbose=0)[:, 0])
    F.loc[te, 'mu_ridge'] = rg.predict(Ts[te]); F.loc[te, 'mu_gbm'] = gt.predict(X_t[te]); F.loc[te, 'mu_mlp'] = np.mean(ts, 0)
    print(f'stage1 {S}: ML logloss lr {ll(F.p_lr[te], y[te]):.4f} gbm {ll(F.p_gbm[te], y[te]):.4f} mlp {ll(F.p_mlp[te], y[te]):.4f} | '
          f'TOT mae ridge {np.abs(F.mu_ridge[te] - tot[te]).mean():.3f} gbm {np.abs(F.mu_gbm[te] - tot[te]).mean():.3f} mlp {np.abs(F.mu_mlp[te] - tot[te]).mean():.3f}', flush=True)

F['p_agg3'] = sig((logit(F.p_lr) + logit(F.p_gbm) + logit(F.p_mlp)) / 3)
F['mu_agg3'] = (F.mu_ridge + F.mu_gbm + F.mu_mlp) / 3
import os
NN = []
if os.path.exists('data/cache/nn_preds.parquet'):
    N = pd.read_parquet('data/cache/nn_preds.parquet'); NN = [c for c in N.columns if c.startswith('p_') or c.startswith('mu_')]
    F = F.merge(N[['pk'] + NN], on='pk', how='left')
    pn = [c for c in NN if c.startswith('p_')]
    if pn:
        F['p_nn'] = sig(np.mean([logit(F[c]) for c in pn], 0)); F['p_agg_all'] = sig((logit(F.p_lr) + logit(F.p_gbm) + logit(F.p_mlp) + logit(F.p_nn)) / 4)
    mn = [c for c in NN if c.startswith('mu_')]
    if mn: F['mu_nn'] = F[mn].mean(1); F['mu_agg_all'] = (F.mu_ridge + F.mu_gbm + F.mu_mlp + F.mu_nn) / 4
# stacker: logistic over member logits, fit on seasons < S (members' own out-of-sample predictions only)
mem = ['p_lr', 'p_gbm', 'p_mlp'] + (['p_nn'] if 'p_nn' in F else [])
for S in range(2023, 2027):
    tr = (F.season.between(2021, S - 1) & F[mem].notna().all(1)).values; te = (F.season == S).values & F[mem].notna().all(1).values
    Z = np.column_stack([logit(F[c]) for c in mem])
    st = LogisticRegression(C=1.0).fit(Z[tr], y[tr]); F.loc[te, 'p_stack'] = st.predict_proba(Z[te])[:, 1]

rep = {'moneyline': {}, 'totals': {}}
T = F[F.season.isin(TEST) & F.p_open.notna() & F.p_close.notna()]
print(f'\nHOLDOUT {TEST}: {len(T)} games with open+close moneyline')
cols = ['p_home', 'p_lr', 'p_gbm', 'p_mlp', 'p_agg3'] + [c for c in ['p_tower', 'p_gru', 'p_nn', 'p_agg_all', 'p_stack'] if c in T] + ['p_open', 'p_close', 'p_close_med']
for c in cols:
    m = T[c].notna()
    r = {'n': int(m.sum()), 'logloss': round(ll(T.loc[m, c], T.y[m]), 5), 'brier': round(brier(T.loc[m, c], T.y[m]), 5),
         'by_season': {int(S): round(ll(d[c], d.y), 5) for S, d in T[m].groupby('season')}}
    rep['moneyline'][c] = r; print(f'  {c:12s} n={r["n"]:5d} logloss {r["logloss"]:.5f} brier {r["brier"]:.5f}  {r["by_season"]}')
T = F[F.season.isin(TEST) & F.mu_open.notna() & F.mu_close.notna()]
print(f'\nHOLDOUT totals: {len(T)} games with open+close totals')
for c in ['mu_ridge', 'mu_gbm', 'mu_mlp', 'mu_agg3'] + [c for c in ['mu_tower', 'mu_gru', 'mu_nn', 'mu_agg_all'] if c in T] + ['mu_open', 'mu_close']:
    m = T[c].notna()
    r = {'n': int(m.sum()), 'mae': round(float((T.loc[m, c] - T.total[m]).abs().mean()), 4), 'rmse': round(float(np.sqrt(((T.loc[m, c] - T.total[m]) ** 2).mean())), 4),
         'by_season_mae': {int(S): round(float((d[c] - d.total).abs().mean()), 4) for S, d in T[m].groupby('season')}}
    rep['totals'][c] = r; print(f'  {c:12s} n={r["n"]:5d} MAE {r["mae"]:.4f} RMSE {r["rmse"]:.4f}  {r["by_season_mae"]}')
json.dump(rep, open('data/cache/model_report.json', 'w'), indent=1)
F.to_parquet('data/cache/stage1.parquet')
