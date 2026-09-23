"""Which inputs carry the line-movement signal? Node-portable math only (ridge stage 1 -> ridge stage 2), rolling origin,
same holdout / pricing as proof.py. Drops one feature group at a time from the full open-safe set, and adds the
research-only groups (cross-book opens, late QB) one at a time. Reports stage-2 correlation and CLV at thresholds."""
import numpy as np, pandas as pd, warnings, json
from sklearn.linear_model import Ridge
from common import load, evaluate, GROUPS, LATE, HOLDOUT
warnings.filterwarnings('ignore'); np.seterr(all='ignore')
F = load()
F['tier_g5'] = (F.tier == 'G5').astype(int); F['tier_fcs'] = (F.tier == 'FCS').astype(int)
F['x_open'] = F.bet_line; F['x_open_abs'] = F.bet_line.abs(); F['x_open_vs_cons'] = (F.bet_line - F.open).fillna(0.0); F['clv_home'] = F.bet_line - F.close
SD = float((F.margin + F.close)[F.season < HOLDOUT[0]].std())
CTX2 = ['x_open', 'x_open_abs', 'early', 'home', 'min_n', 'tier_g5', 'tier_fcs', 'conf_game']
def run(s1_cols, s2_extra, use_gap=True):
    Q = F.copy()
    for S in range(2017, 2026):
        tr = Q.season.between(2015, S - 1).values; te = (Q.season == S).values
        X = Q[s1_cols].values; mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9
        Q.loc[te, 'm'] = Ridge(alpha=30).fit((X[tr] - mu) / sd, Q.margin[tr]).predict((X[te] - mu) / sd)
    Q['x_gap'] = Q.m + Q.bet_line
    mk = (Q.bet_line.notna() & Q.close.notna() & Q.m.notna()).values
    cols = (['x_gap'] if use_gap else []) + CTX2 + s2_extra
    for S in HOLDOUT:
        tr = mk & (Q.season < S).values; te = mk & (Q.season == S).values
        X = Q[cols].values; mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9
        Q.loc[te, 'pm'] = Ridge(alpha=30).fit((X[tr] - mu) / sd, Q.clv_home[tr]).predict((X[te] - mu) / sd)
    H = Q[Q.season.isin(HOLDOUT) & mk & Q.pm.notna()]
    out = {'corr': round(float(np.corrcoef(H.pm, H.clv_home)[0, 1]), 3), 'corr_by_season': [round(float(np.corrcoef(H.pm[H.season == S], H.clv_home[H.season == S])[0, 1]), 3) for S in HOLDOUT]}
    for thr in (0.5, 1.0):
        s = H[H.pm.abs() >= thr]; r = evaluate(s, (s.pm > 0).values, SD)
        out[thr] = {k: r.get(k) for k in ('bets', 'clv_ev_pct', 'p', 'beat_close', 'mean_clv_pts')}
        out[thr]['by_season'] = [evaluate(s[s.season == S], (s[s.season == S].pm > 0).values, SD).get('clv_ev_pct') for S in HOLDOUT]
    return out
ALL = sum(GROUPS.values(), [])
S2BASE = ['d_mkt', 'd_talent', 'd_qb_pepa', 'd_qb_starts']
res = {}
res['full open-safe'] = run(ALL, S2BASE)
for g, cols in GROUPS.items():
    res[f'- {g}'] = run([c for c in ALL if c not in cols], [c for c in S2BASE if c not in cols])
res['no stage-1 gap (context + open only)'] = run(ALL, S2BASE, use_gap=False)
res['+ cross-book opens'] = run(ALL, S2BASE + ['x_open_vs_cons'])
res['+ late QB (first-snap starter)'] = run(ALL + LATE, S2BASE + LATE)
res['+ late QB + cross-book'] = run(ALL + LATE, S2BASE + LATE + ['x_open_vs_cons'])
for k, v in res.items():
    print(f"{k:38s} corr {v['corr']:+.3f} {v['corr_by_season']} | >=0.5: n={v[0.5]['bets']} EV {v[0.5]['clv_ev_pct']:+.2f}% p={v[0.5]['p']:.3g} beat {v[0.5]['beat_close']:.1%} seasons {v[0.5]['by_season']} "
          f"| >=1.0: n={v[1.0]['bets']} EV {v[1.0].get('clv_ev_pct') or float('nan'):+.2f}% p={v[1.0].get('p') or float('nan'):.3g} seasons {v[1.0]['by_season']}", flush=True)
json.dump(res, open('data/cache/ablate.json', 'w'), indent=1, default=float)
