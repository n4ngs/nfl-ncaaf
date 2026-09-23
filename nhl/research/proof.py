"""Can an OPEN-SAFE model beat the closing line? (closing-line value, the industry standard proof)

Open-safe = only information available when the line opens: team vectors, CNN shot maps, the PROJECTED starter
(recent-starts + back-to-back rule, never the confirmed one) and the previous game's lineup.

Stage 1  fundamentals (logistic + gradient boosting + Keras MLP), rolling origin by season, outcome target.
Stage 2  line-movement aggregate: predicts logit(close) - logit(open) from the model/market gap and context
         (ridge + gradient boosting + Keras MLP, averaged), trained only on seasons before the test season.
Bet at the OPEN price when the predicted move is large enough; score against the no-vig CLOSE:
  CLV EV% = p_close(side) * decimal_open_price - 1   (expected ROI if the close is the truth)
Holdout: 2024-25 and 2025-26. Every fitted piece sees only earlier seasons.
"""
import os, json, warnings
os.environ.setdefault('KERAS_BACKEND', 'torch'); warnings.filterwarnings('ignore')
import numpy as np, pandas as pd, keras
from scipy import stats
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
np.seterr(all='ignore'); rng = np.random.default_rng(3)

F = pd.read_parquet('data/cache/features.parquet').merge(pd.read_parquet('data/cache/cnn.parquet'), on='gid', how='left')
M = pd.read_parquet('data/cache/predictions.parquet')[['gid', 'mkt_open', 'mkt_close', 'bet_open_h', 'bet_open_a', 'bet_close_h', 'bet_close_a', 'n_books']]
F = F.merge(M, on='gid', how='left')
F['cnn_logit'] = np.log(F.cnn_share / (1 - F.cnn_share))
for s in ('home', 'away'):
    F[f'{s}_og_logshots'] = np.log1p(F[f'{s}_og_shots'])
TEAM = ['ev_xgf', 'ev_xga', 'ev_hdf', 'ev_hda', 'pp_xgf', 'pk_xga', 'pp_toi_pg', 'pk_toi_pg', 'ev_finish', 'ev_saves', 'win_pg', 'all_gf_pg', 'all_ga_pg']
OPEN = [f'd_{c}' for c in TEAM] + ['cnn_logit', 'd_rest', 'home_b2b', 'away_b2b']
for c in ['og_gsax100', 'og_logshots', 'o_lineup']:
    F['d_' + c] = F['home_' + c] - F['away_' + c]; OPEN.append('d_' + c)
OPEN += ['home_og_share20', 'away_og_share20', 'home_o_proj_share10', 'away_o_proj_share10', 'home_og_b2b', 'away_og_b2b']
F = F[F.season >= 2016].reset_index(drop=True)
F[OPEN] = F[OPEN].replace([np.inf, -np.inf], np.nan)
for c in OPEN: F[c] = F[c].fillna(F[c].median())
logit = lambda p: np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
sig = lambda z: 1 / (1 + np.exp(-z))
ll = lambda p, y: float(-np.mean(y * np.log(np.clip(p, 1e-6, 1 - 1e-6)) + (1 - y) * np.log(1 - np.clip(p, 1e-6, 1 - 1e-6))))

def mlp(n_in, out='sigmoid', seed=0):
    keras.utils.set_random_seed(seed)
    m = keras.Sequential([keras.Input((n_in,)), keras.layers.Dense(32, activation='gelu', kernel_regularizer=keras.regularizers.l2(1e-3)),
                          keras.layers.Dropout(0.3), keras.layers.Dense(16, activation='gelu'), keras.layers.Dense(1, activation=out)])
    m.compile(keras.optimizers.Adam(1e-3), 'binary_crossentropy' if out == 'sigmoid' else 'mse'); return m

# ---------------------------------------------------------------- stage 1: open-safe fundamentals
for S in range(2018, 2026):
    tr = F.season.between(2016, S - 1).values; te = (F.season == S).values
    X, y = F[OPEN].values, F.y.values
    sc = StandardScaler().fit(X[tr]); Xs = sc.transform(X)
    lr = LogisticRegression(C=0.3, max_iter=4000).fit(Xs[tr], y[tr])
    gb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.03, max_leaf_nodes=15, min_samples_leaf=80, l2_regularization=1.0, random_state=0).fit(X[tr], y[tr])
    va = F.season.values == S - 1
    nn_p = []
    for sd in (1, 2, 3):
        m = mlp(len(OPEN), seed=sd); fit_idx = tr & ~va
        m.fit(Xs[fit_idx], y[fit_idx], validation_data=(Xs[va], y[va]), epochs=60, batch_size=256, verbose=0,
              callbacks=[keras.callbacks.EarlyStopping(patience=6, restore_best_weights=True)])
        nn_p.append(m.predict(Xs[te], verbose=0)[:, 0])
    F.loc[te, 'o_lr'] = lr.predict_proba(Xs[te])[:, 1]; F.loc[te, 'o_gbm'] = gb.predict_proba(X[te])[:, 1]; F.loc[te, 'o_nn'] = np.mean(nn_p, 0)
    F.loc[te, 'o_fund'] = sig((logit(F.loc[te, 'o_lr']) + logit(F.loc[te, 'o_gbm']) + logit(F.loc[te, 'o_nn'])) / 3)
    print(f'stage1 {S}: logloss lr {ll(F.o_lr[te], y[te]):.4f} gbm {ll(F.o_gbm[te], y[te]):.4f} nn {ll(F.o_nn[te], y[te]):.4f} agg {ll(F.o_fund[te], y[te]):.4f}', flush=True)

# ---------------------------------------------------------------- stage 2: line-movement aggregate
F['x_gap'] = logit(F.o_fund) - logit(F.mkt_open); F['x_open'] = logit(F.mkt_open)
F['move'] = logit(F.mkt_close) - logit(F.mkt_open)
MOVE = ['x_gap', 'x_open', 'home_o_proj_share10', 'away_o_proj_share10', 'home_og_b2b', 'away_og_b2b', 'home_b2b', 'away_b2b', 'd_og_gsax100', 'cnn_logit', 'd_ev_xgf', 'd_ev_xga']
mk = F.mkt_open.notna() & F.mkt_close.notna()
for S in (2024, 2025):
    tr = (mk & F.season.between(2023, S - 1)).values; te = (mk & (F.season == S)).values
    X, t = F[MOVE].values, F.move.values
    sc = StandardScaler().fit(X[tr]); Xs = sc.transform(X)
    r = Ridge(alpha=10).fit(Xs[tr], t[tr])
    g = HistGradientBoostingRegressor(max_iter=200, learning_rate=0.03, max_leaf_nodes=8, min_samples_leaf=60, random_state=0).fit(X[tr], t[tr])
    ks = []
    for sd in (1, 2, 3):
        m = mlp(len(MOVE), out='linear', seed=sd)
        m.fit(Xs[tr], t[tr], validation_split=0.15, epochs=80, batch_size=128, verbose=0, callbacks=[keras.callbacks.EarlyStopping(patience=8, restore_best_weights=True)])
        ks.append(m.predict(Xs[te], verbose=0)[:, 0])
    F.loc[te, 'pm_ridge'] = r.predict(Xs[te]); F.loc[te, 'pm_gbm'] = g.predict(X[te]); F.loc[te, 'pm_nn'] = np.mean(ks, 0)
    F.loc[te, 'pred_move'] = F.loc[te, ['pm_ridge', 'pm_gbm', 'pm_nn']].mean(1)
    c = np.corrcoef(F.pred_move[te], t[te])[0, 1]
    print(f'stage2 {S}: corr(predicted move, actual move) = {c:.3f}  (ridge {np.corrcoef(F.pm_ridge[te], t[te])[0,1]:.3f}, gbm {np.corrcoef(F.pm_gbm[te], t[te])[0,1]:.3f}, keras {np.corrcoef(F.pm_nn[te], t[te])[0,1]:.3f})', flush=True)

# ---------------------------------------------------------------- the proof: bets at the open, scored against the close
T = F[F.season.isin([2024, 2025]) & mk & F.bet_open_h.notna() & F.pred_move.notna()].copy()
dec = lambda a: 1 + (a / 100 if a > 0 else 100 / -a)
def evaluate(sub, side):
    po = np.where(side == 1, sub.bet_open_h, sub.bet_open_a).astype(float)
    pc = np.where(side == 1, sub.mkt_close, 1 - sub.mkt_close)                      # no-vig close prob of the side
    ev = pc * np.array([dec(a) for a in po]) - 1                                     # CLV expected ROI vs the close
    clv_pts = np.where(side == 1, sub.mkt_close - sub.mkt_open, sub.mkt_open - sub.mkt_close)
    won = np.where(side == 1, sub.y == 1, sub.y == 0)
    roi = np.where(won, [dec(a) - 1 for a in po], -1.0)
    t_ev = stats.ttest_1samp(ev, 0, alternative='greater') if len(ev) > 2 else None
    b = stats.binomtest(int((clv_pts > 0).sum()), int((clv_pts != 0).sum()), 0.5, alternative='greater') if (clv_pts != 0).sum() else None
    bs = [rng.choice(roi, len(roi)).mean() for _ in range(2000)] if len(roi) else [np.nan]
    return {'bets': int(len(ev)), 'clv_ev_pct': round(float(ev.mean() * 100), 2), 'clv_ev_t': round(float(t_ev.statistic), 2) if t_ev else None,
            'clv_ev_p': float(t_ev.pvalue) if t_ev else None, 'beat_close_rate': round(float((clv_pts > 0).mean()), 3),
            'beat_close_p': float(b.pvalue) if b else None, 'mean_clv_pts': round(float(clv_pts.mean() * 100), 2),
            'actual_roi_pct': round(float(roi.mean() * 100), 2), 'roi_ci90': [round(float(np.percentile(bs, 5) * 100), 2), round(float(np.percentile(bs, 95) * 100), 2)]}

out = {'holdout_games': int(len(T)), 'rules': []}
print(f'\nHOLDOUT 2024-26: {len(T)} games with open + close lines')
for rule, col in (('predicted line move', 'pred_move'), ('model-vs-open gap', 'x_gap')):
    for thr in ((0.03, 0.05, 0.08) if col == 'pred_move' else (0.1, 0.2, 0.3)):
        sub = T[T[col].abs() >= thr]; side = (sub[col] > 0).astype(int).values
        res = {'rule': rule, 'threshold': thr, **evaluate(sub, side)}
        for S in (2024, 2025):
            s2 = sub[sub.season == S]; res[f'season_{S}'] = evaluate(s2, (s2[col] > 0).astype(int).values) if len(s2) else None
        out['rules'].append(res)
        print(f"{rule:20s} >= {thr:.2f}: bets {res['bets']:4d}  CLV EV {res['clv_ev_pct']:+.2f}% (t={res['clv_ev_t']}, p={res['clv_ev_p']:.2g})  "
              f"beat close {res['beat_close_rate']:.1%} (p={res['beat_close_p']:.2g})  ROI {res['actual_roi_pct']:+.2f}% {res['roi_ci90']}  "
              f"| 24-25 EV {res['season_2024']['clv_ev_pct']:+.2f}% n={res['season_2024']['bets']}  25-26 EV {res['season_2025']['clv_ev_pct']:+.2f}% n={res['season_2025']['bets']}", flush=True)
json.dump(out, open('data/cache/proof.json', 'w'), indent=1, default=float)
F.to_parquet('data/cache/proof_preds.parquet')
