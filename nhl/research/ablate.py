"""Which inputs carry the proven edge? Node-portable math only (logistic + ridge), full-model feature sets."""
import numpy as np, pandas as pd, warnings
from scipy import stats
from sklearn.linear_model import LogisticRegression, Ridge
warnings.filterwarnings('ignore'); np.seterr(all='ignore')
P = pd.read_parquet('data/cache/proof_preds.parquet')
logit = lambda p: np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
dec = lambda a: 1 + (a / 100 if a > 0 else 100 / -a)
TEAM = [f'd_{c}' for c in ['ev_xgf', 'ev_xga', 'ev_hdf', 'ev_hda', 'pp_xgf', 'pk_xga', 'pp_toi_pg', 'pk_toi_pg', 'ev_finish', 'ev_saves', 'win_pg', 'all_gf_pg', 'all_ga_pg']]
GOAL = ['d_og_gsax100', 'd_og_logshots', 'home_og_share20', 'away_og_share20', 'home_o_proj_share10', 'away_o_proj_share10', 'home_og_b2b', 'away_og_b2b']
SCH = ['d_rest', 'home_b2b', 'away_b2b']
sets = {'team+goalie+sched': TEAM + GOAL + SCH, '+lineup': TEAM + GOAL + SCH + ['d_o_lineup'], '+cnn': TEAM + GOAL + SCH + ['cnn_logit'],
        '+lineup+cnn (all)': TEAM + GOAL + SCH + ['d_o_lineup', 'cnn_logit']}
mk = P.mkt_open.notna() & P.mkt_close.notna()
for name, cols in sets.items():
    Q = P.copy()
    for S in range(2018, 2026):
        tr = Q.season.between(2016, S - 1); te = Q.season == S
        X = Q.loc[tr, cols].values; mu, sd = X.mean(0), X.std(0) + 1e-9
        m = LogisticRegression(C=0.3, max_iter=4000).fit((X - mu) / sd, Q.y[tr])
        Q.loc[te, 'pf'] = m.predict_proba((Q.loc[te, cols].values - mu) / sd)[:, 1]
    Q['xg'] = logit(Q.pf) - logit(Q.mkt_open); Q['xo'] = logit(Q.mkt_open)
    S2 = ['xg', 'xo', 'home_o_proj_share10', 'away_o_proj_share10', 'home_og_b2b', 'away_og_b2b', 'home_b2b', 'away_b2b', 'd_og_gsax100', 'd_ev_xgf', 'd_ev_xga']
    for S in (2024, 2025):
        tr = mk & Q.season.between(2023, S - 1); te = mk & (Q.season == S)
        X = Q.loc[tr, S2].values; mu, sd = X.mean(0), X.std(0) + 1e-9
        r = Ridge(alpha=10).fit((X - mu) / sd, Q.move[tr]); Q.loc[te, 'pm'] = r.predict((Q.loc[te, S2].values - mu) / sd)
    H = Q[Q.season.isin([2024, 2025]) & mk & Q.bet_open_h.notna()]
    line = []
    for thr in (0.08, 0.10):
        s = H[H.pm.abs() >= thr]; side = (s.pm > 0).values
        po = np.where(side, s.bet_open_h, s.bet_open_a).astype(float); ev = np.where(side, s.mkt_close, 1 - s.mkt_close) * np.array([dec(a) for a in po]) - 1
        t = stats.ttest_1samp(ev, 0, alternative='greater'); by = [round(float(ev[(s.season == S).values].mean() * 100), 2) for S in (2024, 2025)]
        line.append(f'>={thr}: n={len(ev)} EV {ev.mean()*100:+.2f}% p={t.pvalue:.3f} seasons {by}')
    print(f'{name:22s} ' + ' | '.join(line), flush=True)
