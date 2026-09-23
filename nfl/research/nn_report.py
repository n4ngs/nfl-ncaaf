"""Do the Keras networks help? Stage-1 accuracy vs the market, aggregation, and the downstream CLV test.

Stage-1 candidates (all rolling origin, fit only on earlier seasons): ridge, GBM, Keras MLP (proof.py), TowerNet and GRU
SeqNet (nn.py); aggregates: plain mean of all five, and a ridge stacker fit on earlier seasons (2011..S-1).
Scored on every season 2014-2025 against the nflverse CLOSE and, where available, the OPEN.
Then each stage-1 variant feeds the same portable ridge stage 2; CLV EV at the open vs the no-vig close is compared.
"""
import json, warnings, numpy as np, pandas as pd
from scipy import stats
from sklearn.linear_model import Ridge
from common import KeyDist
warnings.filterwarnings('ignore'); np.seterr(all='ignore')
P = pd.read_parquet('data/cache/proof_preds.parquet').merge(pd.read_parquet('data/cache/nn_preds.parquet').drop(columns='season'), on='gid', how='left')
kd = json.load(open('data/cache/keydist.json')); KM = KeyDist(kd['margin']['sd'], kd['margin']['w'])
P['tower_m'] = P['tower__margin']; P['gru_m'] = P['seq_gru__margin']
BASE = ['m_ridge', 'm_gbm', 'm_nn', 'tower_m', 'gru_m']
P['mean5'] = P[BASE].mean(1)
for Sn in range(2014, 2027):
    tr = P.season.between(2011, Sn - 1) & P[BASE].notna().all(1); te = (P.season == Sn) & P[BASE].notna().all(1)
    st = Ridge(alpha=1.0).fit(P.loc[tr, BASE], P.y_margin[tr]); P.loc[te, 'stack'] = st.predict(P.loc[te, BASE])
    if Sn == 2025: stack_w = dict(zip(BASE, st.coef_.round(3)))
P['tower_t'] = P['tower__total']; P['gru_t'] = P['seq_gru__total']
pw = lambda mu: np.array([(lambda a, b: a / max(1 - b, 1e-9))(*KM.probs(m, 0)) for m in mu])
ll = lambda p, y: float(-np.mean(y * np.log(np.clip(p, 1e-6, 1 - 1e-6)) + (1 - y) * np.log(1 - np.clip(p, 1e-6, 1 - 1e-6))))
E = P[P.season.between(2014, 2025) & (P.y_margin != 0) & P[BASE].notna().all(1)].copy(); yw = (E.y_margin > 0).astype(int).values
rows = []
for name, col in [('ridge (portable)', 'm_ridge'), ('GBM', 'm_gbm'), ('Keras MLP', 'm_nn'), ('Keras TowerNet', 'tower_m'), ('Keras GRU SeqNet', 'gru_m'),
                  ('proof aggregate (ridge+GBM+MLP)', 'm_fund'), ('mean of 5', 'mean5'), ('ridge stacker (earlier seasons)', 'stack'), ('market CLOSE', 'mu_close')]:
    p = pw(E[col].values)
    r = {'model': name, 'margin_rmse': round(float(np.sqrt(np.mean((E[col] - E.y_margin) ** 2))), 3), 'win_logloss': round(ll(p, yw), 5)}
    if col in ('tower_m', 'gru_m'):
        r['win_logloss_win_head'] = round(ll(E['tower__win' if col == 'tower_m' else 'seq_gru__win'].values, yw), 5)
    rows.append(r)
tab = pd.DataFrame(rows); print('STAGE 1, seasons 2014-2025 (%d games), every model fit only on earlier seasons' % len(E)); print(tab.to_string(index=False))
# totals
Et = P[P.season.between(2014, 2025) & P.tower_t.notna()]
TC = ['t_ridge', 't_gbm', 't_nn', 'tower_t', 'gru_t']
trm = {c: float(np.sqrt(np.mean((Et[c] - Et.y_total) ** 2))) for c in TC}
trm['mean of 5'] = float(np.sqrt(np.mean((Et[TC].mean(1) - Et.y_total) ** 2))); trm['market close'] = float(np.sqrt(np.mean((Et.mu_close_t - Et.y_total) ** 2)))
print('\ntotal rmse 2014-2025:', {k: round(v, 3) for k, v in trm.items()})
# ATS head at the open line (open seasons)
O = P[P.mu_open.notna() & P.season.isin([2016, 2023, 2024, 2025]) & (P.y_margin != P.open_spread)]
yo = (O.y_margin > O.open_spread).astype(int).values
ats = {'games': int(len(O))}
for nm, col in (('TowerNet ATS head', 'tower__cover_open'), ('GRU ATS head', 'seq_gru__cover_open')):
    ats[nm] = round(ll(O[col].values, yo), 5)
ats['market open (fair) cover prob'] = round(ll(np.array([(lambda a, b: a / max(1 - b, 1e-9))(*KM.probs(m, l)) for m, l in zip(O.mu_open, O.open_spread)]), yo), 5)
ats['market close (fair) cover prob of the OPEN number'] = round(ll(np.array([(lambda a, b: a / max(1 - b, 1e-9))(*KM.probs(m, l)) for m, l in zip(O.mu_close, O.open_spread)]), yo), 5)
print('\nATS at the OPEN number, log loss:', ats)

# downstream: stage-2 ridge on each stage-1 variant
mk = P.mu_open.notna() & P.mu_close.notna(); POOL = [2016, 2023, 2024, 2025]
S2 = ['x_gap', 'x_open', 'x_absopen', 'x_half', 'd_qb', 'home_qbshare', 'away_qbshare', 'd_m_QB', 'd_m_OL', 'd_m_DB', 'd_rest', 'd_op', 'd_dp', 'd_pf', 'd_pa', 'neutral', 'div']
down = {}
print('\nSTAGE 2 (portable ridge) fed by each stage-1 variant; bets at the open, CLV EV vs no-vig close, seasons', POOL)
for name, col in [('ridge', 'm_ridge'), ('proof aggregate', 'm_fund'), ('TowerNet', 'tower_m'), ('GRU', 'gru_m'), ('mean of 5', 'mean5'), ('stacker', 'stack')]:
    Q = P.copy(); Q['x_gap'] = Q[col] - Q.mu_open; Q['pm'] = np.nan
    for Sn in POOL:
        tr = (mk & (Q.season < Sn) & Q.x_gap.notna()).values; te = (mk & (Q.season == Sn)).values
        X = Q[S2].astype(float).fillna(0.0).values; mu, sd = X[tr].mean(0), X[tr].std(0); sd = np.where(sd < 1e-6, 1, sd)
        Q.loc[te, 'pm'] = Ridge(alpha=10).fit((X[tr] - mu) / sd, Q.move.values[tr]).predict((X[te] - mu) / sd)
    H = Q[mk & Q.season.isin(POOL)]
    line = f'  {name:16s} corr {np.corrcoef(H.pm, H.move)[0, 1]:.3f}'
    down[name] = {'corr': round(float(np.corrcoef(H.pm, H.move)[0, 1]), 3)}
    for thr in (0.5, 0.75):
        s = H[H.pm.abs() >= thr]; side = (s.pm > 0).values
        ev = np.array([KM.ev(m, l, h if sd_ else a, sd_) for m, l, h, a, sd_ in zip(s.mu_close, s.open_spread, s.open_hso, s.open_aso, side)])
        if len(ev) < 3: continue
        t = stats.ttest_1samp(ev, 0, alternative='greater')
        down[name][thr] = {'bets': int(len(ev)), 'ev': round(float(ev.mean() * 100), 2), 'p': float(t.pvalue)}
        line += f' | >={thr}: n={len(ev)} EV {ev.mean()*100:+.2f}% p={t.pvalue:.3f}'
    print(line)

# downstream for TOTALS (the only market with a candidate edge)
from common import KeyDist as _KD
KT = _KD(kd['total']['sd'], kd['total']['w'])
mkt = P.mu_open_t.notna() & P.mu_close_t.notna()
S2T = ['xt_gap', 'xt_open', 'dome', 's_pace', 's_prate', 's_qb', 's_op', 's_dp', 's_pf', 's_pa', 'neutral']
P['mean5_t'] = P[TC].mean(1)
print('\nSTAGE 2 TOTALS (portable ridge) fed by each stage-1 total variant')
for name, col in [('ridge', 't_ridge'), ('proof aggregate', 't_fund'), ('TowerNet', 'tower_t'), ('GRU', 'gru_t'), ('mean of 5', 'mean5_t')]:
    Q = P.copy(); Q['xt_gap'] = Q[col] - Q.mu_open_t; Q['pt'] = np.nan
    for Sn in POOL:
        tr = (mkt & (Q.season < Sn) & Q.xt_gap.notna()).values; te = (mkt & (Q.season == Sn)).values
        X = Q[S2T].astype(float).fillna(0.0).values; mu, sd = X[tr].mean(0), X[tr].std(0); sd = np.where(sd < 1e-6, 1, sd)
        Q.loc[te, 'pt'] = Ridge(alpha=10).fit((X[tr] - mu) / sd, Q.move_t.values[tr]).predict((X[te] - mu) / sd)
    H = Q[mkt & Q.season.isin(POOL)]
    down['total|' + name] = {'corr': round(float(np.corrcoef(H.pt, H.move_t)[0, 1]), 3)}
    line = f'  {name:16s} corr {down["total|" + name]["corr"]:.3f}'
    for thr in (0.75, 1.0):
        s_ = H[H.pt.abs() >= thr]; side = (s_.pt > 0).values
        ev = np.array([KT.ev(m, l, o if sd_ else u, sd_) for m, l, o, u, sd_ in zip(s_.mu_close_t, s_.open_total, s_.open_over, s_.open_under, side)])
        t = stats.ttest_1samp(ev, 0, alternative='greater')
        by = [round(float(ev[(s_.season == S).values].mean() * 100), 2) for S in POOL]
        down['total|' + name][thr] = {'bets': int(len(ev)), 'ev': round(float(ev.mean() * 100), 2), 'p': float(t.pvalue), 'by_season': by}
        line += f' | >={thr}: n={len(ev)} EV {ev.mean()*100:+.2f}% p={t.pvalue:.3f} {by}'
    print(line)
json.dump({'stage1': rows, 'total_rmse': trm, 'stack_weights_2025': {k: float(v) for k, v in stack_w.items()}, 'ats_open': ats, 'downstream': down}, open('data/cache/nn_report.json', 'w'), indent=1)
