"""Previous-season Statcast priors (point-in-time safe) + do they add anything beyond the boxscore features?

For a season-S game: starter = PROBABLE pitcher, lineup = the team's previous starting nine (the same expected nine as
portable.py). Prior = PA-weighted blend of seasons S-1 (weight 1) and S-2 (weight 0.5), shrunk to the league mean with
k=150 PA (pitchers) / 150 PA (batters). Unknown players get the league mean (plus a 'known' share feature).
Metrics: xwOBA (against), whiff %, barrel %, K-BB %. Output: data/cache/statcast.parquet.
Test: logistic stage 1 (+ ridge stage 2) with and without these, rolling origin, clean CLV of the gap>=0.30 rule.
"""
from common import *
import pickle, json
from scipy import stats
from sklearn.linear_model import LogisticRegression, Ridge
import portable
K = 150.0
def load_lb(kind):
    out = {}
    for y in range(2017, 2026):
        d = pd.read_csv(f'data/savant/{kind}_{y}.csv', encoding='utf-8-sig')
        d['xwoba'] = pd.to_numeric(d.xwoba, errors='coerce'); d['kbb'] = d.k_percent - d.bb_percent
        out[y] = d.set_index('player_id')[['pa', 'xwoba', 'whiff_percent', 'barrel_batted_rate', 'kbb']]
    return out
LB = {'pitcher': load_lb('pitcher'), 'batter': load_lb('batter')}
def prior(kind, pid, S):
    num = {m: 0.0 for m in ('xwoba', 'whiff_percent', 'barrel_batted_rate', 'kbb')}; w = 0.0; lg = {}
    for y, wt in ((S - 1, 1.0), (S - 2, 0.5)):
        t = LB[kind].get(y)
        if t is None: continue
        if not lg:
            for m in num: lg[m] = float(np.nansum(t[m] * t.pa) / t.pa[t[m].notna()].sum())
        if pid in t.index:
            r = t.loc[pid]
            if isinstance(r, pd.DataFrame): r = r.iloc[0]
            if r.pa > 0 and r[list(num)].notna().all():
                for m in num: num[m] += wt * r.pa * r[m]
                w += wt * r.pa
    if not lg: return None
    return {m: (num[m] + K * lg[m]) / (w + K) for m in num} | {'known': float(w > 0), 'lpa': np.log1p(w)}

G = pickle.load(open('data/cache/history.pkl', 'rb'))
last_nine = {}; rows = []
i = 0
while i < len(G):
    day = G[i]['day']; j = i
    while j < len(G) and G[j]['day'] == day: j += 1
    dg = G[i:j]; i = j
    for g in dg:
        r = {'pk': g['pk']}
        for side in ('home', 'away'):
            p = prior('pitcher', g['prob'][side], g['season']) if g['prob'][side] else None
            p = p or prior('pitcher', -1, g['season'])
            for k, v in p.items(): r[f'{side}_scp_{k}'] = v
            for tag, nine in (('exp', last_nine.get(g[side])), ('conf', portable.starters9(g['box'][side]['bat']))):
                vals = [prior('batter', b, g['season']) for b in (nine or [])]
                vals = [v for v in vals if v] or [prior('batter', -1, g['season'])]
                for m in ('xwoba', 'barrel_batted_rate', 'kbb', 'known'): r[f'{side}_scb{tag}_{m}'] = float(np.mean([v[m] for v in vals]))
        rows.append(r)
    for g in dg:
        for side in ('home', 'away'):
            n = portable.starters9(g['box'][side]['bat'])
            if len(n) >= 9: last_nine[g[side]] = n
S = pd.DataFrame(rows); S.to_parquet('data/cache/statcast.parquet'); print('statcast priors', S.shape, flush=True)

# ---------------- does it add anything? (Node-portable math, same protocol as ablate.py / export.py)
P = load().merge(S, on='pk'); P = P[P.season >= FIRST_TRAIN].reset_index(drop=True)
for m in ('xwoba', 'whiff_percent', 'barrel_batted_rate', 'kbb', 'known', 'lpa'): P[f'd_scp_{m}'] = P[f'home_scp_{m}'] - P[f'away_scp_{m}']
for m in ('xwoba', 'barrel_batted_rate', 'kbb', 'known'): P[f'd_scbexp_{m}'] = P[f'home_scbexp_{m}'] - P[f'away_scbexp_{m}']
SC = ['d_scp_xwoba', 'd_scp_whiff_percent', 'd_scp_barrel_batted_rate', 'd_scp_kbb', 'd_scp_known', 'd_scp_lpa', 'd_scbexp_xwoba', 'd_scbexp_barrel_batted_rate', 'd_scbexp_kbb']
P['move'] = logit(P.p_close) - logit(P.p_open); P['src_tr'] = (P.ml_src == 'tr').astype(float)
def run(cols, name):
    Q = P.copy()
    for S_ in range(2021, 2027):
        tr = (Q.season < S_).values; te = (Q.season == S_).values; X = Q[cols].values.astype(float)
        mu, sd = X[tr].mean(0), X[tr].std(0); sd = np.where(sd < 1e-6, 1, sd)
        Q.loc[te, 'pf'] = LogisticRegression(C=0.3, max_iter=4000).fit((X[tr] - mu) / sd, Q.y[tr]).predict_proba((X[te] - mu) / sd)[:, 1]
    Q['xg'] = logit(Q.pf) - logit(Q.p_open)
    H = Q[Q.season.isin(TEST) & Q.p_open.notna() & Q.p_close.notna()]; C = H[~((H.season == 2025) & (H.day >= '2025-07-01'))]
    res = {'logloss_2024_26': round(ll(H.pf, H.y), 5)}
    for thr in (0.25, 0.30, 0.35):
        s = C[C.xg.abs() >= thr]; side = (s.xg > 0).values; po = np.where(side, s.ml_oh, s.ml_oa).astype(float)
        ev = np.where(side, s.p_close, 1 - s.p_close) * np.array([dec(a) for a in po]) - 1
        res[f'gap>={thr}'] = {'n': len(ev), 'ev': round(ev.mean() * 100, 2), 'p': float(stats.ttest_1samp(ev, 0, alternative='greater').pvalue),
                              'by': {int(y): round(ev[(s.season == y).values].mean() * 100, 2) for y in TEST}}
    print(f'{name:30s} {res}', flush=True); return res
out = {'base (shipped)': run(ML_OPEN, 'base (shipped)'), '+statcast priors': run(ML_OPEN + SC, '+statcast priors'),
       'statcast replaces sp/lineup': run([c for c in ML_OPEN if c not in ('d_sp_fip', 'd_sp_k', 'd_lu_exp')] + SC, 'statcast replaces sp/lineup')}
json.dump(out, open('data/cache/statcast_eval.json', 'w'), indent=1)
