"""Compare Keras networks with the logistic vector model and the market on the 2024-26 holdout."""
import json, warnings, numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
warnings.filterwarnings('ignore'); np.seterr(all='ignore'); rng = np.random.default_rng(5)
P = pd.read_parquet('data/cache/predictions.parquet').merge(pd.read_parquet('data/cache/nn_preds.parquet').drop(columns='season'), on='gid')
def logit(p): p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6); return np.log(p / (1 - p))
def ll(p, y): p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6); return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
NN = [c for c in ('p_vectornet', 'p_seq_gru', 'p_seq_transformer') if c in P]
P['p_nn_ens'] = P[NN].mean(1)
P['p_all_ens'] = (P.p_lr + P.p_nn_ens) / 2
P['p_logit_ens'] = 1 / (1 + np.exp(-(logit(P.p_lr) + sum(logit(P[c]) for c in NN)) / (1 + len(NN))))
cands = ['p_home_only', 'p_lr', 'p_gbm'] + NN + ['p_nn_ens', 'p_all_ens', 'p_logit_ens']

T = P[P.season.isin([2024, 2025]) & P.mkt_close.notna()]
rows = []
for c in cands + ['mkt_open', 'mkt_close']:
    t = T[T[c].notna()]
    r = {'predictor': c, 'n': len(t), 'logloss_all': round(ll(t[c], t.y), 5)}
    for S in (2024, 2025):
        u = t[t.season == S]; r[f'logloss_{S}'] = round(ll(u[c], u.y), 5)
    rows.append(r)
tab = pd.DataFrame(rows); print(tab.to_string(index=False))

# market stack with the best fundamental ensemble, fit only on earlier seasons
best = min(cands[1:], key=lambda c: ll(T[c], T.y)); print('\nbest fundamental predictor on holdout:', best)
res = {}
for S in (2023, 2024, 2025):
    tr = P.season.between(2021, S - 1) & P.mkt_close.notna() & P[best].notna(); te = (P.season == S) & P.mkt_close.notna()
    X = lambda d, m: np.c_[logit(d[m]), logit(d[best]) - logit(d[m])]
    st = LogisticRegression(C=1e6).fit(X(P[tr], 'mkt_close'), P.y[tr])
    P.loc[te, 'p_stack_nn'] = st.predict_proba(X(P[te], 'mkt_close'))[:, 1]
    to = te & P.mkt_open.notna()
    P.loc[to, 'p_stack_nn_open'] = st.predict_proba(X(P[to], 'mkt_open'))[:, 1]
T = P[P.season.isin([2024, 2025]) & P.mkt_close.notna()]
print(f"stack(best+market close) logloss {ll(T.p_stack_nn, T.y):.5f}   market close {ll(T.mkt_close, T.y):.5f}")
O = T[T.mkt_open.notna() & T.p_stack_nn_open.notna()].copy()
print(f"stack(best+market OPEN) logloss {ll(O.p_stack_nn_open, O.y):.5f}   market open {ll(O.mkt_open, O.y):.5f}   market close {ll(O.mkt_close, O.y):.5f}")
mv = logit(O.mkt_close) - logit(O.mkt_open)
for c in ('p_lr', best):
    ed = logit(O[c]) - logit(O.mkt_open); print(f'corr(edge vs open, open->close move) using {c}: {np.corrcoef(ed, mv)[0, 1]:.3f}')
def payout(a): return a / 100 if a > 0 else 100 / -a
O['edge'] = O.p_stack_nn_open - O.mkt_open; O['side'] = (O.edge > 0).astype(int)
O['clv'] = np.where(O.side == 1, O.mkt_close - O.mkt_open, O.mkt_open - O.mkt_close)
out = []
for thr in (0.01, 0.02, 0.03):
    s = O[(O.edge.abs() >= thr) & O.bet_open_h.notna()]
    r = np.array([payout(x.bet_open_h if x.side else x.bet_open_a) if (x.y == x.side) else -1.0 for x in s.itertuples()])
    bs = [rng.choice(r, len(r)).mean() for _ in range(2000)] if len(r) else [np.nan]
    out.append({'edge_min': thr, 'bets': len(r), 'roi': round(float(r.mean()), 4) if len(r) else None,
                'ci90': [round(float(np.percentile(bs, 5)), 4), round(float(np.percentile(bs, 95)), 4)],
                'clv_pos_rate': round(float((s.clv > 0).mean()), 3), 'mean_clv_pts': round(float(s.clv.mean() * 100), 2)})
    print(f"open bets edge>={thr:.2f}: {out[-1]}")
rep = json.load(open('data/cache/report.json'))
rep['neural'] = {'table': rows, 'best': best, 'open_bets': out,
                 'stack_close_logloss': round(ll(T.p_stack_nn, T.y), 5), 'market_close_logloss': round(ll(T.mkt_close, T.y), 5)}
json.dump(rep, open('data/cache/report.json', 'w'), indent=1, default=float)
P.to_parquet('data/cache/predictions_nn.parquet')
