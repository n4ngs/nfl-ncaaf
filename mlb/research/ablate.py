"""Which inputs carry the edge? Node-portable math only (logistic stage 1 + ridge stage 2), rolling origin.
For each feature set: stage-1 holdout log loss, stage-2 corr with the open->close move, and CLV EV of the candidate
rules per primary season (plus 2024-26 excluding the erratic 2025 H2 opens). Output: data/cache/ablate.json
"""
from common import *
import json
from scipy import stats
from sklearn.linear_model import LogisticRegression, Ridge
from market import nb_over
NB_R = json.load(open('data/cache/market_report.json'))['nb_size']
P = load()
P = P[P.season >= FIRST_TRAIN].reset_index(drop=True)
P['src_tr'] = (P.ml_src == 'tr').astype(float); P['tsrc_tr'] = (P.tot_src == 'tr').astype(float); P['s_sp_lbf'] = P.home_sp_lbf + P.away_sp_lbf
P['move'] = logit(P.p_close) - logit(P.p_open); P['tmove'] = P.mu_close - P.mu_open
GRP = {'team': ['d_off', 'd_offh', 'd_rf', 'd_ra', 'd_win'], 'starter': ['d_sp_fip', 'd_sp_k', 'd_sp_ip', 'd_sp_lbf', 'home_sp_rest', 'away_sp_rest', 'home_sp_np', 'away_sp_np'],
       'bullpen': ['d_bp'], 'lineup': ['d_lu_exp'], 'sched_park': ['d_rest', 'home_dan', 'away_dan', 'night', 'park']}
TGRP = {'team': ['s_off', 's_offh', 's_rf', 's_ra'], 'starter': ['s_sp_fip', 's_sp_k', 's_sp_ip'], 'bullpen': ['s_bp'], 'lineup': ['s_lu_exp'],
        'park_env': ['park', 'park_x', 'lg_rpg', 'night', 'home_dan', 'away_dan']}
def zfit(X, tr):
    mu, sd = X[tr].mean(0), X[tr].std(0); sd = np.where(sd < 1e-6, 1.0, sd); return mu, sd
def run_ml(cols, s2_extra):
    Q = P.copy()
    for S in range(2021, 2027):
        tr = (Q.season < S).values; te = (Q.season == S).values; X = Q[cols].values.astype(float); mu, sd = zfit(X, tr)
        Q.loc[te, 'pf'] = LogisticRegression(C=0.3, max_iter=4000).fit((X[tr] - mu) / sd, Q.y[tr]).predict_proba((X[te] - mu) / sd)[:, 1]
    Q['x_gap'] = logit(Q.pf) - logit(Q.p_open); Q['x_open'] = logit(Q.p_open)
    S2 = ['x_gap', 'x_open', 'src_tr'] + s2_extra
    mk = Q.p_open.notna() & Q.p_close.notna() & Q.pf.notna()
    for S in TEST:
        tr = (mk & Q.season.between(2021, S - 1)).values; te = (mk & (Q.season == S)).values; X = Q[S2].values.astype(float); mu, sd = zfit(X, tr)
        Q.loc[te, 'pm'] = Ridge(alpha=10).fit((X[tr] - mu) / sd, Q.move[tr]).predict((X[te] - mu) / sd)
    H = Q[Q.season.isin(TEST) & mk]
    res = {'logloss': round(ll(H.pf, H.y), 5), 'corr': round(float(np.corrcoef(H.pm, H.move)[0, 1]), 4)}
    for col, thr in (('pm', 0.08), ('x_gap', 0.30)):
        s = H[H[col].abs() >= thr]; side = (s[col] > 0).values
        po = np.where(side, s.ml_oh, s.ml_oa).astype(float); ev = np.where(side, s.p_close, 1 - s.p_close) * np.array([dec(a) for a in po]) - 1
        clean = ~((s.season == 2025) & (s.day >= '2025-07-01')).values
        res[f'{col}>={thr}'] = {'n': int(len(ev)), 'ev': round(float(ev.mean() * 100), 2), 'p': float(stats.ttest_1samp(ev, 0, alternative='greater').pvalue),
                                'by_season': {int(S): round(float(ev[(s.season == S).values].mean() * 100), 2) for S in TEST},
                                'excl_2025h2': round(float(ev[clean].mean() * 100), 2), 'excl_2025h2_p': float(stats.ttest_1samp(ev[clean], 0, alternative='greater').pvalue)}
    return res
def run_tot(cols, s2_extra):
    Q = P.copy()
    for S in range(2021, 2027):
        tr = (Q.season < S).values; te = (Q.season == S).values; X = Q[cols].values.astype(float); mu, sd = zfit(X, tr)
        Q.loc[te, 'mf'] = Ridge(alpha=10).fit((X[tr] - mu) / sd, Q.total[tr]).predict((X[te] - mu) / sd)
    Q['t_gap'] = Q.mf - Q.mu_open
    S2 = ['t_gap', 'mu_open', 'tsrc_tr'] + s2_extra
    tk = Q.mu_open.notna() & Q.mu_close.notna() & Q.mf.notna()
    for S in TEST:
        tr = (tk & Q.season.between(2021, S - 1)).values; te = (tk & (Q.season == S)).values; X = Q[S2].values.astype(float); mu, sd = zfit(X, tr)
        Q.loc[te, 'tm'] = Ridge(alpha=10).fit((X[tr] - mu) / sd, Q.tmove[tr]).predict((X[te] - mu) / sd)
    H = Q[Q.season.isin(TEST) & tk]
    res = {'mae': round(float((H.mf - H.total).abs().mean()), 4), 'corr': round(float(np.corrcoef(H.tm, H.tmove)[0, 1]), 4)}
    for col, thr in (('tm', 0.30), ('t_gap', 0.80)):
        s = H[H[col].abs() >= thr]; side = (s[col] > 0).values; ev = []
        for r, sd_ in zip(s.itertuples(), side):
            o, pu, u = nb_over(r.mu_close, NB_R, r.tot_ol); ev.append((o if sd_ else u) * dec(r.tot_oo if sd_ else r.tot_ou) + pu - 1)
        ev = np.array(ev); clean = ~((s.season == 2025) & (s.day >= '2025-07-01')).values
        res[f'{col}>={thr}'] = {'n': int(len(ev)), 'ev': round(float(ev.mean() * 100), 2), 'by_season': {int(S): round(float(ev[(s.season == S).values].mean() * 100), 2) for S in TEST},
                                'excl_2025h2': round(float(ev[clean].mean() * 100), 2), 'excl_2025h2_p': float(stats.ttest_1samp(ev[clean], 0, alternative='greater').pvalue)}
    return res
out = {'ml': {}, 'tot': {}}
ALL = sum(GRP.values(), []); TALL = sum(TGRP.values(), [])
S2X = ['d_sp_fip', 'd_sp_lbf', 'home_sp_lbf', 'away_sp_lbf', 'd_lu_exp', 'd_off', 'd_bp']; T2X = ['park', 's_sp_fip', 's_sp_lbf', 's_lu_exp', 's_off', 's_bp']
sets = [('all', ALL, S2X), ('all, stage2 gap+open only', ALL, [])] + [(f'minus {g}', [c for c in ALL if c not in v], S2X) for g, v in GRP.items()] + \
       [(f'only {g}', v + ['night'] if g != 'sched_park' else v, S2X) for g, v in GRP.items()]
for name, cols, s2 in sets:
    out['ml'][name] = r = run_ml(list(dict.fromkeys(cols)), s2); print(f'ML  {name:28s} {r}', flush=True)
tsets = [('all', TALL, T2X), ('all, stage2 gap+open only', TALL, [])] + [(f'minus {g}', [c for c in TALL if c not in v], T2X) for g, v in TGRP.items()]
for name, cols, s2 in tsets:
    out['tot'][name] = r = run_tot(cols, s2); print(f'TOT {name:28s} {r}', flush=True)
json.dump(out, open('data/cache/ablate.json', 'w'), indent=1)
