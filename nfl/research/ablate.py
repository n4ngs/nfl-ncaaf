"""Which inputs carry the edge (if any)? Node-portable math only (ridge stage 1 + ridge stage 2), same rolling origin and
test seasons as proof.py, same CLV scoring.

1. stage-1 feature groups removed one at a time (and team-EPA only)
2. stage-2 input sets (gap only / gap + line shape / full context)
3. sensitivity: every side feature LAGGED one game (state before the team's previous game). If an ESPN "open" were a
   look-ahead line posted before the previous game, only this version would be open-safe.
"""
import json, warnings, numpy as np, pandas as pd
from scipy import stats
from sklearn.linear_model import Ridge
from common import KeyDist
warnings.filterwarnings('ignore'); np.seterr(all='ignore')
P = pd.read_parquet('data/cache/proof_preds.parquet')
kd = json.load(open('data/cache/keydist.json'))
KM = KeyDist(kd['margin']['sd'], kd['margin']['w']); KT = KeyDist(kd['total']['sd'], kd['total']['w'])
POOL = [2016, 2023, 2024, 2025]
GL = ['QB', 'OL', 'WR', 'TE', 'RB', 'DL', 'LB', 'DB']
G = {'team EPA': ['d_op', 'd_or', 'd_dp', 'd_dr', 'd_osr', 'd_dsr'], 'scoring+ST': ['d_pf', 'd_pa', 'd_st'], 'style': ['d_pace', 'd_prate'],
     'QB': ['d_qb', 'd_qbx', 'd_qbshare'], 'personnel': [f'd_m_{x}' for x in GL],
     'schedule': ['d_rest', 'd_bye', 'd_short', 'neutral', 'div', 'away_tz', 'west_early', 'home_short', 'away_short', 'home_bye', 'away_bye']}
GT = {'team EPA': ['s_op', 's_or', 's_dp', 's_dr', 's_osr', 's_dsr'], 'scoring+ST': ['s_pf', 's_pa', 's_st'], 'style': ['s_pace', 's_prate'],
      'QB': ['s_qb'], 'venue': ['dome', 'neutral']}
S2 = {'gap only': ['x_gap'], 'gap + line shape': ['x_gap', 'x_open', 'x_absopen', 'x_half'],
      'full (proof set)': ['x_gap', 'x_open', 'x_absopen', 'x_half', 'd_qb', 'home_qbshare', 'away_qbshare', 'd_m_QB', 'd_m_OL', 'd_m_DB', 'd_rest', 'd_op', 'd_dp', 'd_pf', 'd_pa', 'neutral', 'div']}
S2T = {'gap only': ['xt_gap'], 'full (proof set)': ['xt_gap', 'xt_open', 'dome', 's_pace', 's_prate', 's_qb', 's_op', 's_dp', 's_pf', 's_pa', 'neutral']}
mk = P.mu_open.notna() & P.mu_close.notna(); mkt = P.mu_open_t.notna() & P.mu_close_t.notna()

def ridge_roll(Q, cols, y, mask, seasons, first, alpha):
    out = pd.Series(np.nan, index=Q.index)
    for Sn in seasons:
        tr = (mask & Q.season.between(first, Sn - 1)).values; te = (mask & (Q.season == Sn)).values
        X = Q[cols].astype(float).fillna(0.0).values; mu, sd = X[tr].mean(0), X[tr].std(0); sd = np.where(sd < 1e-6, 1.0, sd)
        out[te] = Ridge(alpha=alpha).fit((X[tr] - mu) / sd, y[tr]).predict((X[te] - mu) / sd)
    return out

def run(Q, s1cols, s2cols, market='spread'):
    Q = Q.copy()
    allm = pd.Series(True, index=Q.index)
    if market == 'spread':
        Q['p1'] = ridge_roll(Q, s1cols, Q.y_margin.values, allm, range(2014, 2027), 2007, 50.0)
        Q['x_gap'] = Q.p1 - Q.mu_open
        Q['p2'] = ridge_roll(Q, s2cols, Q.move.values, mk, POOL, 2000, 10.0)
        H = Q[mk & Q.season.isin(POOL)]
        corr = np.corrcoef(H.p2, H.move)[0, 1]; thrs = (0.5, 0.75)
    else:
        Q['p1'] = ridge_roll(Q, s1cols, Q.y_total.values, allm, range(2014, 2027), 2007, 50.0)
        Q['xt_gap'] = Q.p1 - Q.mu_open_t
        Q['p2'] = ridge_roll(Q, s2cols, Q.move_t.values, mkt, POOL, 2000, 10.0)
        H = Q[mkt & Q.season.isin(POOL)]
        corr = np.corrcoef(H.p2, H.move_t)[0, 1]; thrs = (0.75, 1.0)
    res = {'corr': round(float(corr), 3)}
    for thr in thrs:
        s = H[H.p2.abs() >= thr]; side = (s.p2 > 0).values
        if market == 'spread':
            ev = np.array([KM.ev(m, l, h if sd_ else a, sd_) for m, l, h, a, sd_ in zip(s.mu_close, s.open_spread, s.open_hso, s.open_aso, side)])
        else:
            ev = np.array([KT.ev(m, l, o if sd_ else u, sd_) for m, l, o, u, sd_ in zip(s.mu_close_t, s.open_total, s.open_over, s.open_under, side)])
        t = stats.ttest_1samp(ev, 0, alternative='greater') if len(ev) > 2 else None
        res[thr] = {'bets': int(len(ev)), 'ev': round(float(ev.mean() * 100), 2) if len(ev) else None, 'p': float(t.pvalue) if t else None,
                    'by_season': [round(float(ev[(s.season == S).values].mean() * 100), 2) if (s.season == S).any() else None for S in POOL]}
    return res

def fmt(name, r):
    parts = [f"{name:34s} corr {r['corr']:.3f}"]
    for k, v in r.items():
        if k == 'corr': continue
        parts.append(f">={k}: n={v['bets']} EV {v['ev']:+.2f}% p={v['p']:.3f} seasons {v['by_season']}" if v['bets'] > 2 else f'>={k}: n={v["bets"]}')
    return ' | '.join(parts)

out = {}
ALL = sum(G.values(), []); ALLT = sum(GT.values(), [])
print('SPREAD (stage-1 ridge on groups, stage-2 ridge full set); seasons', POOL)
for name, cols in [('all groups', ALL), ('team EPA only', G['team EPA'])] + [(f'- {k}', [c for c in ALL if c not in v]) for k, v in G.items()]:
    r = run(P, cols, S2['full (proof set)']); out['spread|s1|' + name] = r; print(fmt(name, r), flush=True)
for name, cols in S2.items():
    r = run(P, ALL, cols); out['spread|s2|' + name] = r; print(fmt('stage-2: ' + name, r), flush=True)
print('\nTOTALS')
for name, cols in [('all groups', ALLT)] + [(f'- {k}', [c for c in ALLT if c not in v]) for k, v in GT.items()]:
    r = run(P, cols, S2T['full (proof set)'], 'total'); out['total|s1|' + name] = r; print(fmt(name, r), flush=True)
for name, cols in S2T.items():
    r = run(P, ALLT, cols, 'total'); out['total|s2|' + name] = r; print(fmt('stage-2: ' + name, r), flush=True)

# ---- lag-1 sensitivity: replace every side feature by the one computed before the team's previous game
side_keys = ['op', 'or', 'dp', 'dr', 'osr', 'dsr', 'st', 'pf', 'pa', 'pace', 'prate', 'qb', 'qbx', 'qbshare'] + [f'm_{x}' for x in GL]
FR = {'STL': 'LA', 'SD': 'LAC', 'OAK': 'LV'}
L = P.sort_values(['gameday', 'gametime', 'gid']).copy()
long = []
for s in ('home', 'away'):
    x = L[['gid', 'gameday', 'gametime', s] + [f'{s}_{k}' for k in side_keys]].copy(); x.columns = ['gid', 'gameday', 'gametime', 'team'] + side_keys
    x['team'] = x.team.map(lambda t: FR.get(t, t)); x['side'] = s; long.append(x)
long = pd.concat(long).sort_values(['gameday', 'gametime', 'gid'], kind='mergesort')
lagged = long.groupby('team')[side_keys].shift(1)
long[side_keys] = lagged.values
for s in ('home', 'away'):
    x = long[long.side == s].set_index('gid')[side_keys]
    for k in side_keys: L[f'{s}_{k}'] = L.gid.map(x[k])
for k in side_keys: L[f'd_{k}'] = L[f'home_{k}'] - L[f'away_{k}']
for k in ['op', 'or', 'dp', 'dr', 'osr', 'dsr', 'st', 'pf', 'pa', 'pace', 'prate', 'qb']: L[f's_{k}'] = L[f'home_{k}'] + L[f'away_{k}']
L = L.sort_index()
r = run(L, ALL, S2['full (proof set)']); out['spread|lag1'] = r; print('\n' + fmt('SPREAD, all features lagged 1 game', r))
r = run(L, ALLT, S2T['full (proof set)'], 'total'); out['total|lag1'] = r; print(fmt('TOTAL, all features lagged 1 game', r))
json.dump(out, open('data/cache/ablate.json', 'w'), indent=1, default=str)
