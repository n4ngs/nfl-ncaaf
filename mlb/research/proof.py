"""Can an OPEN-SAFE model beat the closing line? (closing-line value, the industry-standard proof)

Open-safe = only what is known when the line opens: schedule, PROBABLE starters, completed games (team form,
starter/bullpen/batter ratings), the previous game's lineup, park. Stage 1 = model.py aggregate (LR+GBM+Keras MLP,
logit average) fit on earlier seasons only.
Stage 2 line-movement aggregate (ridge + GBM + Keras MLP, averaged), trained only on seasons before the test season:
  moneyline target  logit(p_close) - logit(p_open)           (no-vig, same source for open and close)
  totals target     mu_close - mu_open                       (NB-implied mean runs, same source)
Bet at the OPEN price when the predicted move is large enough; score against the no-vig CLOSE:
  ML   CLV EV = p_close(side) * decimal_open_price - 1
  TOT  CLV EV = P_close(win at the OPEN total) * decimal_open_price + P_close(push) - 1, P from NB(mu_close)
Primary holdout: 2024, 2025, 2026 (single bettable book: ESPN BET / DraftKings). Secondary: 2022-2023 (teamrankings).
12 pre-registered rules (6 ML + 6 totals) -> Bonferroni x12 reported.
"""
from common import *
import json, keras
from scipy import stats
from sklearn.linear_model import Ridge
from sklearn.ensemble import HistGradientBoostingRegressor
from market import nb_over
rng = np.random.default_rng(3)
NB_R = json.load(open('data/cache/market_report.json'))['nb_size']
P1 = os.environ.get('P1', 'p_agg3'); M1 = os.environ.get('M1', 'mu_agg3')
F = pd.read_parquet('data/cache/stage1.parquet')
F['src_tr'] = (F.ml_src == 'tr').astype(float); F['tsrc_tr'] = (F.tot_src == 'tr').astype(float)
F['x_gap'] = logit(F[P1]) - logit(F.p_open); F['x_open'] = logit(F.p_open); F['move'] = logit(F.p_close) - logit(F.p_open)
F['t_gap'] = F[M1] - F.mu_open; F['tmove'] = F.mu_close - F.mu_open
MOVE_ML = ['x_gap', 'x_open', 'd_sp_fip', 'd_sp_lbf', 'home_sp_lbf', 'away_sp_lbf', 'd_lu_exp', 'd_off', 'd_bp', 'src_tr']
MOVE_TOT = ['t_gap', 'mu_open', 'park', 's_sp_fip', 's_sp_lbf', 's_lu_exp', 's_off', 's_bp', 'tsrc_tr']
F['s_sp_lbf'] = F.home_sp_lbf + F.away_sp_lbf
HOLD = [2022, 2023] + TEST

def mlp(n_in, seed):
    keras.utils.set_random_seed(seed)
    m = keras.Sequential([keras.Input((n_in,)), keras.layers.Dense(32, activation='gelu', kernel_regularizer=keras.regularizers.l2(1e-3)),
                          keras.layers.Dropout(0.3), keras.layers.Dense(16, activation='gelu'), keras.layers.Dense(1)])
    m.compile(keras.optimizers.Adam(1e-3), 'mse'); return m

def stage2(cols, target, ok, pref):
    for S in HOLD:
        tr = (ok & F.season.between(2021, S - 1)).values; te = (ok & (F.season == S)).values
        if tr.sum() < 500 or te.sum() == 0: continue
        X, t = F[cols].values.astype(float), F[target].values.astype(float)
        mu, sd = X[tr].mean(0), X[tr].std(0); sd = np.where(sd < 1e-6, 1.0, sd); Xs = (X - mu) / sd   # constant column (e.g. source flag) -> no blow-up
        r = Ridge(alpha=10).fit(Xs[tr], t[tr])
        g = HistGradientBoostingRegressor(max_iter=200, learning_rate=0.03, max_leaf_nodes=8, min_samples_leaf=80, random_state=0).fit(X[tr], t[tr])
        ks = []
        for sd_ in (1, 2, 3):
            m = mlp(len(cols), sd_)
            m.fit(Xs[tr], t[tr], validation_split=0.15, epochs=80, batch_size=128, verbose=0, callbacks=[keras.callbacks.EarlyStopping(patience=8, restore_best_weights=True)])
            ks.append(m.predict(Xs[te], verbose=0)[:, 0])
        F.loc[te, pref + '_ridge'] = r.predict(Xs[te]); F.loc[te, pref + '_gbm'] = g.predict(X[te]); F.loc[te, pref + '_nn'] = np.mean(ks, 0)
        F.loc[te, pref] = F.loc[te, [pref + '_ridge', pref + '_gbm', pref + '_nn']].mean(1)
        c = lambda col: np.corrcoef(F.loc[te, col], t[te])[0, 1]
        print(f'stage2 {pref} {S}: n_train {tr.sum()} n_test {te.sum()} corr(pred, actual move) {c(pref):.3f} (ridge {c(pref + "_ridge"):.3f}, gbm {c(pref + "_gbm"):.3f}, keras {c(pref + "_nn"):.3f}); gap alone {c("x_gap" if pref == "pm" else "t_gap"):.3f}', flush=True)

mk = F.p_open.notna() & F.p_close.notna() & F[P1].notna()
tk = F.mu_open.notna() & F.mu_close.notna() & F[M1].notna()
stage2(MOVE_ML, 'move', mk, 'pm')
stage2(MOVE_TOT, 'tmove', tk, 'tm')

def summarize(ev, clv, roi):
    t_ev = stats.ttest_1samp(ev, 0, alternative='greater') if len(ev) > 2 else None
    nz = int((clv != 0).sum()); b = stats.binomtest(int((clv > 0).sum()), nz, 0.5, alternative='greater') if nz else None
    bs = [rng.choice(roi, len(roi)).mean() for _ in range(1000)] if len(roi) else [np.nan]
    return {'bets': int(len(ev)), 'clv_ev_pct': round(float(ev.mean() * 100), 2) if len(ev) else None,
            'clv_ev_t': round(float(t_ev.statistic), 2) if t_ev else None, 'clv_ev_p': float(t_ev.pvalue) if t_ev else None,
            'beat_close_rate': round(float((clv > 0).sum() / nz), 3) if nz else None, 'beat_close_p': float(b.pvalue) if b else None,
            'actual_roi_pct': round(float(roi.mean() * 100), 2) if len(roi) else None,
            'roi_ci90': [round(float(np.percentile(bs, 5) * 100), 2), round(float(np.percentile(bs, 95) * 100), 2)] if len(roi) else None}
def eval_ml(sub, side):
    po = np.where(side == 1, sub.ml_oh, sub.ml_oa).astype(float); d = np.array([dec(a) for a in po])
    pc = np.where(side == 1, sub.p_close, 1 - sub.p_close); ev = pc * d - 1
    clv = np.where(side == 1, sub.p_close - sub.p_open, sub.p_open - sub.p_close)
    won = np.where(side == 1, sub.y == 1, sub.y == 0); roi = np.where(won, d - 1, -1.0)
    return summarize(ev, clv, roi)
def eval_tot(sub, side, line='tot_ol', over='tot_oo', under='tot_ou', mu0='mu_open'):
    ev, roi = [], []
    for r, s in zip(sub.itertuples(), side):
        L = getattr(r, line); o, pu, u = nb_over(r.mu_close, NB_R, L)
        a = getattr(r, over) if s == 1 else getattr(r, under); d = dec(a); pw = o if s == 1 else u
        ev.append(pw * d + pu - 1)
        res = r.total - L; roi.append(0.0 if res == 0 else (d - 1 if (res > 0) == (s == 1) else -1.0))
    clv = np.where(side == 1, sub.mu_close - sub[mu0], sub[mu0] - sub.mu_close)
    return summarize(np.array(ev), clv, np.array(roi))

RULES = [('ML', 'predicted line move', 'pm', (0.03, 0.05, 0.08)), ('ML', 'model-vs-open gap', 'x_gap', (0.10, 0.20, 0.30)),
         ('TOT', 'predicted total move', 'tm', (0.10, 0.20, 0.30)), ('TOT', 'model-vs-open total gap', 't_gap', (0.30, 0.50, 0.80))]
NR = sum(len(r[3]) for r in RULES)
out = {'nb_size': NB_R, 'stage1': P1, 'stage1_tot': M1, 'n_rules': NR, 'rules': []}
for mkt, rule, col, thrs in RULES:
    base = (mk if mkt == 'ML' else tk) & F[col].notna()
    for thr in thrs:
        res = {'market': mkt, 'rule': rule, 'col': col, 'threshold': thr}
        for label, seasons in (('primary_2024_2026', TEST), ('secondary_2022_2023', [2022, 2023])):
            sub = F[base & F.season.isin(seasons) & (F[col].abs() >= thr)]; side = (sub[col] > 0).astype(int).values
            res[label] = (eval_ml if mkt == 'ML' else eval_tot)(sub, side)
            res[label]['bonferroni_p'] = min(1.0, res[label]['clv_ev_p'] * NR) if res[label]['clv_ev_p'] is not None else None
            for S in seasons:
                s2 = F[base & (F.season == S) & (F[col].abs() >= thr)]
                res[label][f'season_{S}'] = (eval_ml if mkt == 'ML' else eval_tot)(s2, (s2[col] > 0).astype(int).values) if len(s2) > 2 else None
            if label.startswith('primary'):   # 2025 ESPN BET opens are erratic from July (stale/placeholder); calendar-only sensitivity
                s2 = F[base & (F.season == 2025) & (F.day < '2025-07-01') & (F[col].abs() >= thr)]
                res[label]['season_2025_pre_july'] = (eval_ml if mkt == 'ML' else eval_tot)(s2, (s2[col] > 0).astype(int).values) if len(s2) > 2 else None
                s2 = F[base & F.season.isin(TEST) & ~((F.season == 2025) & (F.day >= '2025-07-01')) & (F[col].abs() >= thr)]
                res[label]['excl_2025_h2'] = (eval_ml if mkt == 'ML' else eval_tot)(s2, (s2[col] > 0).astype(int).values) if len(s2) > 2 else None
        out['rules'].append(res)
        p = res['primary_2024_2026']; s = res['secondary_2022_2023']
        per = '  '.join(f"{S}: EV {p[k]['clv_ev_pct']:+.2f}% n={p[k]['bets']} p={p[k]['clv_ev_p']:.2g}" for S, k in [(S, f'season_{S}') for S in TEST] + [('25preJul', 'season_2025_pre_july'), ('exclH2', 'excl_2025_h2')] if p.get(k))
        print(f"{mkt:3s} {rule:24s} >= {thr:.2f}: n {p['bets']:5d} CLV EV {p['clv_ev_pct']:+.2f}% (t={p['clv_ev_t']}, p={p['clv_ev_p']:.2g}, bonf={p['bonferroni_p']:.2g}) "
              f"beat close {p['beat_close_rate']} (p={p['beat_close_p']:.2g}) ROI {p['actual_roi_pct']:+.2f}% {p['roi_ci90']} | {per} || 22-23: n {s['bets']} EV {s['clv_ev_pct']}% p={s['clv_ev_p']:.2g}", flush=True)
json.dump(out, open('data/cache/proof.json', 'w'), indent=1, default=float)
F.to_parquet('data/cache/proof_preds.parquet')
