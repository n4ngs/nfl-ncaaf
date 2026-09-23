"""Can the model EXPLAIN the open->close line move? Adds two kinds of inputs to the portable stage-2 (ridge on
bet-book open - consensus close) and scores them on the 2023-25 holdout exactly like portable.py:

  recency (open-safe, known before the line opens): each team's last-game result against its own closing spread
    (ATS margin), whether it won as an underdog (upset -> "letdown spot" / market overreaction), and the pair diffs.
  key players (LATE NEWS, known at kickoff): the lead back / lead receiver is absent (keyplayers.py), weighted by
    his share, plus the first-snap QB change features already in the research (L_*).

Reports variance of the move explained (R^2), correlation, and CLV per rule; writes data/cache/move.json.
"""
import json, numpy as np, pandas as pd, warnings
from sklearn.linear_model import Ridge
from common import load, evaluate, fmt, HOLDOUT, GROUPS, LATE
warnings.filterwarnings('ignore'); np.seterr(all='ignore')
F = load()
P = pd.read_parquet('data/cache/portable_preds.parquet')[['gid', 'm_fund']]
F = F.merge(P, on='gid', how='left')
# recency (d_last_ats / d_last_upset / d_last_blowout) now comes from the feature walk (features.py, ported to Node)
K = pd.read_parquet('data/cache/keyplayers.parquet')
for side in ('home', 'away'):
    k = K.rename(columns={'team': f'{side}_id', 'rb_out': f'{side}_rb_out', 'wr_out': f'{side}_wr_out', 'rb_share': f'{side}_rb_share', 'wr_share': f'{side}_wr_share'})
    F = F.merge(k, on=['gid', f'{side}_id'], how='left')
for c in ['home_rb_out', 'away_rb_out', 'home_wr_out', 'away_wr_out', 'home_rb_share', 'away_rb_share', 'home_wr_share', 'away_wr_share']: F[c] = F[c].fillna(0)
F['L_d_rb_out'] = F.home_rb_out * F.home_rb_share - F.away_rb_out * F.away_rb_share
F['L_d_wr_out'] = F.home_wr_out * F.home_wr_share - F.away_wr_out * F.away_wr_share
F['tier_g5'] = (F.tier == 'G5').astype(int); F['tier_fcs'] = (F.tier == 'FCS').astype(int)
F['x_open'] = F.bet_line; F['x_open_abs'] = F.bet_line.abs(); F['clv_home'] = F.bet_line - F.close
F['x_gap'] = F.m_fund + F.bet_line
SD = float((F.margin + F.close)[F.season < HOLDOUT[0]].std())
BASE = ['x_gap', 'x_open', 'x_open_abs', 'early', 'home', 'min_n', 'tier_g5', 'tier_fcs', 'conf_game', 'd_mkt', 'd_talent', 'd_qb_pepa', 'd_qb_starts']
REC = ['d_last_ats', 'd_last_upset', 'd_last_blowout']
KEY = ['L_d_rb_out', 'L_d_wr_out']
mk = (F.bet_line.notna() & F.close.notna() & F.m_fund.notna()).values
VARS = {'A (open-safe, shipped)': BASE, 'A + recency (open-safe)': BASE + REC, 'late: + QB (C)': BASE + LATE,
        'late: + QB + key RB/WR': BASE + LATE + KEY, 'late: + QB + key RB/WR + recency': BASE + LATE + KEY + REC}
out = {}
for name, cols in VARS.items():
    for S in HOLDOUT:
        tr = mk & (F.season < S).values; te = mk & (F.season == S).values
        X = F[cols].values.astype(float); mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9
        r = Ridge(alpha=30).fit((X[tr] - mu) / sd, F.clv_home[tr]); F.loc[te, 'pm'] = r.predict((X[te] - mu) / sd)
    H = F[F.season.isin(HOLDOUT) & mk]
    y, p = H.clv_home.values, H.pm.values
    r2 = 1 - np.sum((y - p) ** 2) / np.sum((y - y.mean()) ** 2)
    res = {'r2': round(float(r2), 4), 'corr': round(float(np.corrcoef(p, y)[0, 1]), 3), 'corr_by_season': [round(float(np.corrcoef(H.pm[H.season == S], H.clv_home[H.season == S])[0, 1]), 3) for S in HOLDOUT], 'rules': {}}
    for thr in (1.0, 1.5):
        s = H[H.pm.abs() >= thr]; e = evaluate(s, (s.pm > 0).values, SD)
        e['by_season'] = [evaluate(s[s.season == S], (s[s.season == S].pm > 0).values, SD).get('clv_ev_pct') for S in HOLDOUT]
        res['rules'][thr] = e
    out[name] = res
    print(f"{name:36s} R2 {res['r2']:+.3f} corr {res['corr']:.3f} {res['corr_by_season']} | " + ' | '.join(f">={t}: {fmt(e)} seasons {e.get('by_season')}" for t, e in res['rules'].items()), flush=True)
# how big are the effects? coefficients of the full late model on all seasons, in points of line move per unit
cols = BASE + LATE + KEY + REC
X = F.loc[mk, cols].values.astype(float); r = Ridge(alpha=1).fit(X, F.clv_home[mk])
coef = {c: round(float(v), 3) for c, v in zip(cols, r.coef_) if c in LATE + KEY + REC}
print('raw-unit coefficients (points of move toward HOME per unit):', coef)
chk = F[mk & F.season.isin(HOLDOUT)]
for c in ['home_rb_out', 'away_rb_out']:
    x = chk[(chk[c] == 1) & (chk[c.replace('out', 'share')] > 0)]
    print(f'{c}: n={len(x)} mean move toward home {x.clv_home.mean():+.2f} pts (all games {chk.clv_home.mean():+.2f})')
json.dump({'variants': out, 'coef_raw': coef}, open('data/cache/move.json', 'w'), indent=1, default=float)
