"""Portable production model (Node-computable: logistic stage 1, ridge stage 1 totals, ridge stage 2) -> mlb-vas-model.json

1. Holdout evaluation of exactly what ships (rolling origin; stage 1 fit on seasons < S, stage 2 on 2021..S-1 using
   out-of-sample stage-1 predictions), same 12 rules as proof.py.
2. PROVEN criterion (stated before looking at the export numbers; stricter than a pooled p-value because the 2025 ESPN
   BET opens are erratic from July and the 2019-23 teamrankings prices are not a real book):
     on CLEAN primary data (2024, 2025 before July, 2026): CLV EV > 0 with Bonferroni(x12) one-sided p < 0.05,
     AND CLV EV > 0 in every one of 2024, 2025-pre-July and 2026 separately.
   The qualifying threshold = DIAMOND; the next looser threshold = GOLD only if its clean CLV EV is positive.
   If nothing qualifies the market is exported with proven=false and its best clean candidate as tiers.
3. Final fit on everything available (stage 1: 2019-2026; stage 2: 2021-2026).
"""
from common import *
import os, json, datetime as dt
from scipy import stats
from sklearn.linear_model import LogisticRegression, Ridge
from market import nb_over
import portable
NB_R = json.load(open('data/cache/market_report.json'))['nb_size']
P = load(); P = P[P.season >= FIRST_TRAIN].reset_index(drop=True)
P['src_tr'] = (P.ml_src == 'tr').astype(float); P['tsrc_tr'] = (P.tot_src == 'tr').astype(float); P['s_sp_lbf'] = P.home_sp_lbf + P.away_sp_lbf
P['move'] = logit(P.p_close) - logit(P.p_open); P['tmove'] = P.mu_close - P.mu_open
MOVE_ML = ['x_gap', 'x_open', 'd_sp_fip', 'd_sp_lbf', 'home_sp_lbf', 'away_sp_lbf', 'd_lu_exp', 'd_off', 'd_bp', 'src_tr']
MOVE_TOT = ['t_gap', 'mu_open', 'park', 's_sp_fip', 's_sp_lbf', 's_lu_exp', 's_off', 's_bp', 'tsrc_tr']
def zfit(X):
    mu, sd = X.mean(0), X.std(0); return mu, np.where(sd < 1e-6, 1.0, sd)
def fit_lin(cols, idx, target, kind):
    X = P.loc[idx, cols].values.astype(float); mu, sd = zfit(X); Z = (X - mu) / sd
    if kind == 'logit':
        m = LogisticRegression(C=0.3, max_iter=4000).fit(Z, P.loc[idx, target]); coef, b = m.coef_[0], float(m.intercept_[0])
    else:
        m = Ridge(alpha=10).fit(Z, P.loc[idx, target]); coef, b = m.coef_, float(m.intercept_)
    return {'features': cols, 'mean': mu.tolist(), 'std': sd.tolist(), 'coef': [float(c) for c in coef], 'intercept': b}
def lin(mod, idx):
    return ((P.loc[idx, mod['features']].values.astype(float) - np.array(mod['mean'])) / np.array(mod['std'])) @ np.array(mod['coef']) + mod['intercept']
for S in range(2021, 2027):
    tr = P.season < S; te = P.season == S
    P.loc[te, 'pf'] = sig(lin(fit_lin(ML_OPEN, tr, 'y', 'logit'), te)); P.loc[te, 'mf'] = lin(fit_lin(TOT_OPEN, tr, 'total', 'ridge'), te)
P['x_gap'] = logit(P.pf) - logit(P.p_open); P['x_open'] = logit(P.p_open); P['t_gap'] = P.mf - P.mu_open
mk = P.p_open.notna() & P.p_close.notna() & P.pf.notna(); tk = P.mu_open.notna() & P.mu_close.notna() & P.mf.notna()
for S in TEST:
    P.loc[mk & (P.season == S), 'pm'] = lin(fit_lin(MOVE_ML, mk & P.season.between(2021, S - 1), 'move', 'ridge'), mk & (P.season == S))
    P.loc[tk & (P.season == S), 'tm'] = lin(fit_lin(MOVE_TOT, tk & P.season.between(2021, S - 1), 'tmove', 'ridge'), tk & (P.season == S))
H = P[P.season.isin(TEST)].copy(); H['clean'] = ~((H.season == 2025) & (H.day >= '2025-07-01'))
H.loc[H.clean & (H.season == 2025), 'part'] = '2025_pre_july'; H.loc[H.season == 2024, 'part'] = '2024'; H.loc[H.season == 2026, 'part'] = '2026'
def evs(sub, mkt, col):
    side = (sub[col] > 0).values
    if mkt == 'ML':
        po = np.where(side, sub.ml_oh, sub.ml_oa).astype(float); ev = np.where(side, sub.p_close, 1 - sub.p_close) * np.array([dec(a) for a in po]) - 1
        clv = np.where(side, sub.p_close - sub.p_open, sub.p_open - sub.p_close)
    else:
        ev = []
        for r, s in zip(sub.itertuples(), side):
            o, pu, u = nb_over(r.mu_close, NB_R, r.tot_ol); ev.append((o if s else u) * dec(r.tot_oo if s else r.tot_ou) + pu - 1)
        ev = np.array(ev); clv = np.where(side, sub.mu_close - sub.mu_open, sub.mu_open - sub.mu_close)
    return ev, clv
RULES = {'ML': [('pm', (0.03, 0.05, 0.08)), ('x_gap', (0.10, 0.20, 0.30))], 'TOT': [('tm', (0.10, 0.20, 0.30)), ('t_gap', (0.30, 0.50, 0.80))]}
report = {}; choice = {}
for mkt, fams in RULES.items():
    base = H[(mk if mkt == 'ML' else tk).reindex(H.index)]
    report[mkt] = {}
    for col, thrs in fams:
        for thr in thrs:
            sub = base[base[col].abs() >= thr]; ev, clv = evs(sub, mkt, col); c = sub.clean.values
            t_all = stats.ttest_1samp(ev, 0, alternative='greater'); t_c = stats.ttest_1samp(ev[c], 0, alternative='greater')
            nz = clv[c] != 0; b = stats.binomtest(int((clv[c] > 0).sum()), int(nz.sum()), 0.5, alternative='greater')
            parts = {}
            for part in ('2024', '2025_pre_july', '2026'):
                m = (sub.part == part).values
                if m.sum() > 2:
                    tp = stats.ttest_1samp(ev[m], 0, alternative='greater')
                    parts[part] = {'n': int(m.sum()), 'ev_pct': round(float(ev[m].mean() * 100), 2), 'p': float(tp.pvalue), 'beat_close': round(float((clv[m] > 0).mean()), 3)}
            m25 = (sub.season == 2025).values
            r = {'rule': col, 'threshold': thr, 'n_all': int(len(ev)), 'ev_all_pct': round(float(ev.mean() * 100), 2), 'p_all': float(t_all.pvalue),
                 'ev_2025_full_pct': round(float(ev[m25].mean() * 100), 2) if m25.sum() else None,
                 'n_clean': int(c.sum()), 'ev_clean_pct': round(float(ev[c].mean() * 100), 2), 'p_clean': float(t_c.pvalue), 'bonferroni_clean': min(1.0, float(t_c.pvalue) * 12),
                 'beat_close_clean': round(float((clv[c] > 0).sum() / max(nz.sum(), 1)), 3), 'beat_close_clean_p': float(b.pvalue), 'parts': parts}
            r['qualifies'] = bool(r['ev_clean_pct'] > 0 and r['bonferroni_clean'] < 0.05 and len(parts) == 3 and all(v['ev_pct'] > 0 for v in parts.values()))
            report[mkt][f'{col}>={thr}'] = r
            print(f"{mkt:3s} {col:6s}>={thr:.2f} n={r['n_all']:5d} EV {r['ev_all_pct']:+.2f}% | CLEAN n={r['n_clean']} EV {r['ev_clean_pct']:+.2f}% p={r['p_clean']:.2g} bonf={r['bonferroni_clean']:.2g} "
                  f"beat {r['beat_close_clean']} | " + '  '.join(f"{k}: {v['ev_pct']:+.2f}% n={v['n']} p={v['p']:.2g}" for k, v in parts.items()) + f"  QUALIFIES={r['qualifies']}", flush=True)
    # choose: qualifying rule with the most bets; else the best clean-EV candidate (unproven)
    q = [(k, v) for k, v in report[mkt].items() if v['qualifies']]
    if q:
        k, v = max(q, key=lambda kv: kv[1]['n_clean']); proven = True
    else:
        k, v = max(report[mkt].items(), key=lambda kv: (min(p['ev_pct'] for p in kv[1]['parts'].values()) if len(kv[1]['parts']) == 3 else -99)); proven = False
    col = v['rule']; thrs = dict(RULES[mkt])[col]; i = thrs.index(v['threshold'])
    gold = thrs[i - 1] if i > 0 else None
    if gold is not None and report[mkt][f'{col}>={gold}']['ev_clean_pct'] <= 0: gold = None        # never label a losing tier as a lean
    choice[mkt] = {'rule': 'move' if col in ('pm', 'tm') else 'gap', 'rule_col': col, 'proven': proven, 'diamond': v['threshold'], 'gold': gold, 'evidence': v}
    print(f'{mkt} choice: {choice[mkt]["rule"]} >= {v["threshold"]} proven={proven}', flush=True)

# ---------------- final fit on everything
S1 = fit_lin(ML_OPEN, P.season.between(FIRST_TRAIN, 2026), 'y', 'logit'); T1 = fit_lin(TOT_OPEN, P.season.between(FIRST_TRAIN, 2026), 'total', 'ridge')
S2 = fit_lin(MOVE_ML, mk & P.season.between(2021, 2026), 'move', 'ridge'); T2 = fit_lin(MOVE_TOT, tk & P.season.between(2021, 2026), 'tmove', 'ridge')
model = {'version': 'mlb-vas-portable-v1', 'trained_at': dt.datetime.utcnow().isoformat() + 'Z', 'config': portable.CFG,
         'ml': {'stage1': S1, 'stage2': S2, 'rule': choice['ML']['rule'], 'proven': choice['ML']['proven'],
                'tiers': {'diamond': choice['ML']['diamond'], 'gold': choice['ML']['gold']}, 'evidence': choice['ML']['evidence']},
         'tot': {'stage1': T1, 'stage2': T2, 'nb_size': NB_R, 'rule': choice['TOT']['rule'], 'proven': choice['TOT']['proven'],
                 'tiers': {'diamond': choice['TOT']['diamond'], 'gold': choice['TOT']['gold']}, 'evidence': choice['TOT']['evidence']},
         'holdout_report': report,
         'notes': ('Rule "move": tier on |predicted open->close move| (ML logit units, totals runs). Rule "gap": tier on |model - open|. '
                   'proven=false means no threshold met the PROVEN criterion (clean 2024/2025-preJuly/2026 CLV EV>0 each, Bonferroni x12 p<0.05); '
                   'such tiers are candidates to paper-track, not bets. Stage 2 expects the OPEN price of a single book (src_tr=0).')}
json.dump(model, open('data/cache/mlb-vas-model.json', 'w'), indent=1)
P[['pk', 'season', 'day', 'pf', 'mf', 'pm', 'tm', 'x_gap', 't_gap']].to_parquet('data/cache/portable_preds.parquet')
# prediction parity fixture: final-model stage-1 outputs on 2025+ games (Node must reproduce them from its own features)
if os.path.exists('data/cache/parity/features_py.json'):
    Q = derive(pd.read_json('data/cache/parity/features_py.json', orient='records'))      # the parity walk's own features
    z = lambda mod: ((Q[mod['features']].values.astype(float) - np.array(mod['mean'])) / np.array(mod['std'])) @ np.array(mod['coef']) + mod['intercept']
    pp = pd.DataFrame({'pk': Q.pk, 'p': sig(z(S1)), 'mu': z(T1)})
    pp.to_json('data/cache/parity/preds_py.json', orient='records')
print('exported data/cache/mlb-vas-model.json')
