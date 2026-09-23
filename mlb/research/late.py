"""LATE-NEWS variants (NOT open-safe), tested separately from the open-safe proof. Node-portable math only (ridge).

Groups: confirmed lineup (value of the posted nine minus the expected nine), starter change (actual != probable),
bullpen fatigue (relievers' pitches yesterday / last 3 days), weather (temperature, wind out/in, roof) and home-plate
umpire (totals only).
(a) information test: does the group improve the stage-2 prediction of the open->close move? (rolling origin)
(b) realistic bet: teamrankings seasons 2022-2023 have timestamped history -> bet at the last price >= 2 h before first
    pitch (confirmed lineups are usually out ~2-4 h before), stage 2 re-targeted to t2h->close, score vs the close.
(c) optimistic bet: 2024-2026 at the OPEN price with late info (not actually available at the open; upper bound).
Output: data/cache/late.json
"""
from common import *
import json
from scipy import stats
from sklearn.linear_model import Ridge
from market import nb_over
NB_R = json.load(open('data/cache/market_report.json'))['nb_size']
F = pd.read_parquet('data/cache/proof_preds.parquet')
F['s_sp_lbf'] = F.home_sp_lbf + F.away_sp_lbf
BASE_ML = ['x_gap', 'x_open', 'd_sp_fip', 'd_sp_lbf', 'home_sp_lbf', 'away_sp_lbf', 'd_lu_exp', 'd_off', 'd_bp', 'src_tr']
BASE_T = ['t_gap', 'mu_open', 'park', 's_sp_fip', 's_sp_lbf', 's_lu_exp', 's_off', 's_bp', 'tsrc_tr']
GROUPS_ML = {'lineup': ['d_lu_delta'], 'starter_change': ['home_sp_chg', 'away_sp_chg', 'd_spc_fip'], 'bullpen_fatigue': ['home_bp_np1', 'away_bp_np1', 'home_bp_np3', 'away_bp_np3']}
GROUPS_T = {'lineup': ['s_lu_delta'], 'starter_change': ['s_sp_chg', 's_spc_fip'], 'bullpen_fatigue': ['s_bp_np1', 's_bp_np3'],
            'weather': ['wx_temp', 'wx_out', 'wx_roof'], 'umpire': ['ump']}
for g in list(GROUPS_ML): pass
GROUPS_ML['all_late'] = sum(GROUPS_ML.values(), []); GROUPS_T['all_late'] = sum(GROUPS_T.values(), [])
def ridge_pred(cols, target, ok, S, lo=2021):
    tr = (ok & F.season.between(lo, S - 1)).values; te = (ok & (F.season == S)).values
    X = F[cols].values.astype(float); mu, sd = X[tr].mean(0), X[tr].std(0); sd = np.where(sd < 1e-6, 1.0, sd)
    r = Ridge(alpha=10).fit((X[tr] - mu) / sd, F[target].values[tr]); return te, r.predict((X[te] - mu) / sd)
out = {'info_test': {}, 't2h_bets': {}, 'open_bets_optimistic': {}}
# ---------------- (a) information: corr of predicted vs actual open->close move, per holdout season
mk = F.p_open.notna() & F.p_close.notna() & F.x_gap.notna(); tk = F.mu_open.notna() & F.mu_close.notna() & F.t_gap.notna()
for mkt, base, groups, target, ok in (('ML', BASE_ML, GROUPS_ML, 'move', mk), ('TOT', BASE_T, GROUPS_T, 'tmove', tk)):
    for name, extra in [('base', [])] + list(groups.items()):
        res = {}
        for S in [2022, 2023] + TEST:
            te, p = ridge_pred(base + extra, target, ok, S); res[S] = round(float(np.corrcoef(p, F[target].values[te])[0, 1]), 4)
        out['info_test'][f'{mkt}:{name}'] = res; print(f'info {mkt:3s} {name:16s} corr(pred, open->close move) by season {res}', flush=True)
# ---------------- (b) realistic: bet at T-2h (teamrankings seasons) with late info
F['x_gap2'] = logit(F.p_agg3) - logit(F.p_t2h); F['x_t2h'] = logit(F.p_t2h); F['move2'] = logit(F.p_close) - logit(F.p_t2h)
F['t_gap2'] = F.mu_agg3 - F.mu_t2h; F['tmove2'] = F.mu_close - F.mu_t2h
m2 = F.p_t2h.notna() & F.p_close.notna() & F.x_gap2.notna() & (F.ml_src == 'tr'); t2 = F.mu_t2h.notna() & F.mu_close.notna() & F.t_gap2.notna() & (F.tot_src == 'tr')
B2_ML = ['x_gap2', 'x_t2h', 'd_sp_fip', 'd_sp_lbf', 'd_lu_exp', 'd_off', 'd_bp']; B2_T = ['t_gap2', 'mu_t2h', 'park', 's_sp_fip', 's_lu_exp', 's_off', 's_bp']
def summ(ev, clv):
    t = stats.ttest_1samp(ev, 0, alternative='greater') if len(ev) > 2 else None; nz = int((clv != 0).sum())
    b = stats.binomtest(int((clv > 0).sum()), nz, 0.5, alternative='greater') if nz else None
    return {'bets': int(len(ev)), 'clv_ev_pct': round(float(np.mean(ev) * 100), 2) if len(ev) else None, 'p': float(t.pvalue) if t else None,
            'beat_close_rate': round(float((clv > 0).sum() / nz), 3) if nz else None, 'beat_close_p': float(b.pvalue) if b else None}
def ml_ev(sub, side, ph, pa, p0):
    po = np.where(side == 1, sub[ph], sub[pa]).astype(float); d = np.array([dec(a) for a in po])
    return np.where(side == 1, sub.p_close, 1 - sub.p_close) * d - 1, np.where(side == 1, sub.p_close - sub[p0], sub[p0] - sub.p_close)
def tot_ev(sub, side, L, o_, u_, m0):
    ev = []
    for r, s in zip(sub.itertuples(), side):
        o, pu, u = nb_over(r.mu_close, NB_R, getattr(r, L)); ev.append((o if s == 1 else u) * dec(getattr(r, o_) if s == 1 else getattr(r, u_)) + pu - 1)
    return np.array(ev), np.where(side == 1, sub.mu_close - sub[m0], sub[m0] - sub.mu_close)
for mkt, base, groups, target, ok, thrs in (('ML', B2_ML, GROUPS_ML, 'move2', m2, (0.03, 0.05, 0.08)), ('TOT', B2_T, GROUPS_T, 'tmove2', t2, (0.1, 0.2, 0.3))):
    for name, extra in [('base', [])] + list(groups.items()):
        col = f'pl_{mkt}_{name}'; F[col] = np.nan
        for S in (2022, 2023):                                 # stage-1 predictions start in 2021 -> first stage-2 test is 2022
            te, p = ridge_pred(base + extra, target, ok, S, lo=2021); F.loc[te, col] = p
        for thr in thrs:
            sub = F[ok & F.season.between(2022, 2023) & (F[col].abs() >= thr)]; side = (sub[col] > 0).astype(int).values
            ev, clv = ml_ev(sub, side, 'ml_t2h', 'ml_t2a', 'p_t2h') if mkt == 'ML' else tot_ev(sub, side, 'tot_t2l', 'tot_t2o', 'tot_t2u', 'mu_t2h')
            r = summ(ev, clv); out['t2h_bets'][f'{mkt}:{name}:{thr}'] = r
            print(f't2h {mkt:3s} {name:16s} >= {thr}: {r}', flush=True)
# ---------------- (c) optimistic: at the open with late info, 2024-2026
for mkt, base, groups, target, ok, thrs in (('ML', BASE_ML, GROUPS_ML, 'move', mk, (0.05, 0.08)), ('TOT', BASE_T, GROUPS_T, 'tmove', tk, (0.2, 0.3))):
    for name, extra in [('base', [])] + list(groups.items()):
        col = f'po_{mkt}_{name}'; F[col] = np.nan
        for S in TEST:
            te, p = ridge_pred(base + extra, target, ok, S); F.loc[te, col] = p
        for thr in thrs:
            sub = F[ok & F.season.isin(TEST) & (F[col].abs() >= thr)]; side = (sub[col] > 0).astype(int).values
            ev, clv = ml_ev(sub, side, 'ml_oh', 'ml_oa', 'p_open') if mkt == 'ML' else tot_ev(sub, side, 'tot_ol', 'tot_oo', 'tot_ou', 'mu_open')
            r = summ(ev, clv); r['by_season'] = {int(S): round(float(ev[(sub.season == S).values].mean() * 100), 2) for S in TEST if (sub.season == S).any()}
            out['open_bets_optimistic'][f'{mkt}:{name}:{thr}'] = r
            print(f'open* {mkt:3s} {name:16s} >= {thr}: {r}', flush=True)
json.dump(out, open('data/cache/late.json', 'w'), indent=1, default=float)
