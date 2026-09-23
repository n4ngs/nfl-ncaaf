"""Can an OPEN-SAFE NFL model beat the closing line? (closing-line value, the industry-standard proof)

Open-safe = only information available when the line opens (Sunday night / Monday for the next week): team EPA vectors
through the last game, the PROJECTED QB (last game's starter), last game's snap-weighted personnel, schedule.

Stage 1  fundamentals, rolling origin by season (fit on 2007..S-1): margin and total regressions
         (ridge + gradient boosting + Keras MLP x3 seeds, early-stopped on season S-1), averaged.
Stage 2  line-movement aggregate: predicts CLOSE - OPEN (points) from the model/open gap and context
         (ridge + gradient boosting + Keras MLP, averaged), trained only on OPEN-LINE seasons before the test season.
Bets at the book's OPEN number and OPEN juice when the predicted move is large enough, scored against the no-vig CLOSE:
  CLV EV% = P_close(side wins at the open number) * decimal_open_price + P_close(push) - 1
  P_close = key-number-aware discrete margin (or total) distribution centred on the close's fair mean (common.KeyDist).
Open-line seasons: 2014-2016 (offshore "Opening" line via ESPN), 2023 (partial) - 2025 (ESPN BET / DraftKings), 2026 wk1-2.
Test seasons: 2016, 2023, 2024, 2025 (each fitted only on earlier open seasons), 2026 wk1-2 reported as a forward peek.
"""
import os, json, warnings
os.environ.setdefault('KERAS_BACKEND', 'torch'); warnings.filterwarnings('ignore')
import numpy as np, pandas as pd, keras
from scipy import stats
from sklearn.linear_model import Ridge
from sklearn.ensemble import HistGradientBoostingRegressor
from common import KeyDist, novig2, dec, logit
np.seterr(all='ignore'); rng = np.random.default_rng(3)

F = pd.read_parquet('data/cache/features.parquet')
M = pd.read_parquet('data/cache/market.parquet').drop(columns=['season', 'week', 'game_type', 'played', 'result', 'total'])
F = F.merge(M, on='gid', how='left')
D = [c for c in F.columns if c.startswith('d_')] + ['neutral', 'div', 'away_tz', 'west_early', 'home_short', 'away_short', 'home_bye', 'away_bye']
S = [c for c in F.columns if c.startswith('s_')] + ['dome', 'neutral']
U = list(dict.fromkeys(D + S)); F[U] = F[U].astype(float).fillna(0.0)

# ---------------------------------------------------------------- scoring distributions (fit on 2006-2013 closes only)
early = F.season.between(2006, 2013)
KM = KeyDist.fit(F.y_margin[early].values, F.close_spread[early].values)
KT = KeyDist.fit(F.y_total[early].values, F.close_total[early].values)
print(f'margin sd {KM.sd:.2f}  w(3)={KM.w[list(range(-80,121)).index(3)]:.2f} w(7)={KM.w[list(range(-80,121)).index(7)]:.2f}  total sd {KT.sd:.2f}', flush=True)
def fair(line, a, b, kd):
    return np.array([kd.fair_mean(l, novig2(x, y)) if l == l else np.nan for l, x, y in zip(line, a, b)])
F['mu_close'] = fair(F.close_spread.values, F.close_hso.values, F.close_aso.values, KM)
F['mu_close_t'] = fair(F.close_total.values, F.close_over.values, F.close_under.values, KT)
F['mu_open'] = fair(F.open_spread.values, F.open_hso.values, F.open_aso.values, KM)
F['mu_open_t'] = fair(F.open_total.values, F.open_over.values, F.open_under.values, KT)

def mlp(n_in, seed=0):
    keras.utils.set_random_seed(seed)
    m = keras.Sequential([keras.Input((n_in,)), keras.layers.Dense(32, activation='gelu', kernel_regularizer=keras.regularizers.l2(1e-3)),
                          keras.layers.Dropout(0.3), keras.layers.Dense(16, activation='gelu'), keras.layers.Dense(1)])
    m.compile(keras.optimizers.Adam(1e-3), 'mse'); return m

def fit_stage(cols, y, tr, te, va=None, alpha=50.0, leaf=80, seeds=(1, 2, 3), scale_y=1.0):
    X = F[cols].values.astype(float); mu, sd = X[tr].mean(0), X[tr].std(0); sd = np.where(sd < 1e-6, 1.0, sd); Xs = (X - mu) / sd   # constant-in-train columns stay unscaled
    r = Ridge(alpha=alpha).fit(Xs[tr], y[tr])
    g = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.03, max_leaf_nodes=8, min_samples_leaf=leaf, l2_regularization=1.0, random_state=0).fit(X[tr], y[tr])
    ks = []
    ym, ysd = y[tr].mean(), y[tr].std()
    for sd_ in seeds:
        m = mlp(len(cols), sd_)
        fit_idx = tr & ~va if va is not None else tr
        kw = dict(validation_data=(Xs[va], (y[va] - ym) / ysd)) if va is not None else dict(validation_split=0.15)
        m.fit(Xs[fit_idx], (y[fit_idx] - ym) / ysd, epochs=80, batch_size=128, verbose=0,
              callbacks=[keras.callbacks.EarlyStopping(patience=8, restore_best_weights=True)], **kw)
        ks.append(m.predict(Xs[te], verbose=0)[:, 0] * ysd + ym)
    return r.predict(Xs[te]), g.predict(X[te]), np.mean(ks, 0)

# ---------------------------------------------------------------- stage 1: open-safe fundamentals, rolling origin
for Sn in range(2009, 2027):
    tr = F.season.between(2007, Sn - 1).values; te = (F.season == Sn).values; va = (F.season == Sn - 1).values
    for tgt, cols, y in (('m', D, F.y_margin.values), ('t', S, F.y_total.values)):
        a, b, c = fit_stage(cols, y, tr, te, va, alpha=50.0, leaf=80)
        F.loc[te, f'{tgt}_ridge'] = a; F.loc[te, f'{tgt}_gbm'] = b; F.loc[te, f'{tgt}_nn'] = c
        F.loc[te, f'{tgt}_fund'] = (a + b + c) / 3
    t = F[te]; rm = lambda c: np.sqrt(np.mean((t[c] - t.y_margin) ** 2)); rt = lambda c: np.sqrt(np.mean((t[c] - t.y_total) ** 2))
    print(f'stage1 {Sn}: margin rmse ridge {rm("m_ridge"):.2f} gbm {rm("m_gbm"):.2f} nn {rm("m_nn"):.2f} agg {rm("m_fund"):.2f} close {np.sqrt(np.mean((t.close_spread - t.y_margin)**2)):.2f} | '
          f'total rmse agg {rt("t_fund"):.2f} close {np.sqrt(np.mean((t.close_total - t.y_total)**2)):.2f}', flush=True)

# ---------------------------------------------------------------- stage 2: line-movement aggregate (points)
F['x_gap'] = F.m_fund - F.mu_open; F['x_open'] = F.mu_open; F['x_absopen'] = F.mu_open.abs()
F['x_half'] = (F.open_spread % 1 != 0).astype(float)
F['move'] = F.mu_close - F.mu_open
F['xt_gap'] = F.t_fund - F.mu_open_t; F['xt_open'] = F.mu_open_t; F['move_t'] = F.mu_close_t - F.mu_open_t
MOVE = ['x_gap', 'x_open', 'x_absopen', 'x_half', 'd_qb', 'home_qbshare', 'away_qbshare', 'd_m_QB', 'd_m_OL', 'd_m_DB', 'd_rest', 'd_op', 'd_dp', 'd_pf', 'd_pa', 'neutral', 'div']
MOVE_T = ['xt_gap', 'xt_open', 'dome', 's_pace', 's_prate', 's_qb', 's_op', 's_dp', 's_pf', 's_pa', 'neutral']
F[['home_qbshare', 'away_qbshare']] = F[['home_qbshare', 'away_qbshare']].fillna(0.0)
mk = F.mu_open.notna() & F.mu_close.notna(); mkt = F.mu_open_t.notna() & F.mu_close_t.notna()
OPEN_SEASONS = sorted(F.loc[mk, 'season'].unique())
TESTS = [2016, 2023, 2024, 2025, 2026]
for Sn in TESTS:
    for tgt, cols, y, m_ in (('pm', MOVE, F.move.values, mk), ('pt', MOVE_T, F.move_t.values, mkt)):
        tr = (m_ & (F.season < Sn)).values; te = (m_ & (F.season == Sn)).values
        a, b, c = fit_stage(cols, y, tr, te, None, alpha=10.0, leaf=60)
        F.loc[te, f'{tgt}_ridge'] = a; F.loc[te, f'{tgt}_gbm'] = b; F.loc[te, f'{tgt}_nn'] = c; F.loc[te, f'{tgt}_move'] = (a + b + c) / 3
    t = F[(F.season == Sn) & mk]; tt = F[(F.season == Sn) & mkt]
    cc = lambda d, c, y: np.corrcoef(d[c], d[y])[0, 1]
    print(f'stage2 {Sn}: spread corr(pred, actual move) agg {cc(t, "pm_move", "move"):.3f} (ridge {cc(t, "pm_ridge", "move"):.3f} gbm {cc(t, "pm_gbm", "move"):.3f} keras {cc(t, "pm_nn", "move"):.3f}) '
          f'n={len(t)} | total corr agg {cc(tt, "pt_move", "move_t"):.3f} (ridge {cc(tt, "pt_ridge", "move_t"):.3f}) n={len(tt)}', flush=True)

# ---------------------------------------------------------------- the proof: bets at the open, scored against the close
def evaluate(sub, side, market='spread'):
    """side: 1 = home / over, 0 = away / under"""
    if len(sub) == 0: return None
    if market == 'spread':
        kd, mu_c, line, po = KM, sub.mu_close.values, sub.open_spread.values, np.where(side == 1, sub.open_hso, sub.open_aso).astype(float)
        clv_pts = np.where(side == 1, sub.close_spread - sub.open_spread, sub.open_spread - sub.close_spread)
        outcome = sub.y_margin.values
    else:
        kd, mu_c, line, po = KT, sub.mu_close_t.values, sub.open_total.values, np.where(side == 1, sub.open_over, sub.open_under).astype(float)
        clv_pts = np.where(side == 1, sub.close_total - sub.open_total, sub.open_total - sub.close_total)
        outcome = sub.y_total.values
    ev = np.array([kd.ev(m, l, p, s == 1) for m, l, p, s in zip(mu_c, line, po, side)])
    win = np.where(side == 1, outcome > line, outcome < line); push = outcome == line
    roi = np.where(push, 0.0, np.where(win, np.array([dec(p) - 1 for p in po]), -1.0))
    t_ev = stats.ttest_1samp(ev, 0, alternative='greater') if len(ev) > 2 else None
    nz = clv_pts != 0
    b = stats.binomtest(int((clv_pts > 0).sum()), int(nz.sum()), 0.5, alternative='greater') if nz.sum() else None
    bs = [rng.choice(roi, len(roi)).mean() for _ in range(2000)]
    return {'bets': int(len(ev)), 'clv_ev_pct': round(float(ev.mean() * 100), 2), 'clv_ev_t': round(float(t_ev.statistic), 2) if t_ev else None,
            'clv_ev_p': float(t_ev.pvalue) if t_ev else None, 'beat_close_rate': round(float((clv_pts > 0).sum() / max(nz.sum(), 1)), 3),
            'moved_against_rate': round(float((clv_pts < 0).mean()), 3), 'beat_close_p': float(b.pvalue) if b else None,
            'mean_clv_pts': round(float(clv_pts.mean()), 3), 'actual_roi_pct': round(float(roi.mean() * 100), 2),
            'roi_ci90': [round(float(np.percentile(bs, 5) * 100), 2), round(float(np.percentile(bs, 95) * 100), 2)],
            'ats_win_rate': round(float(win.sum() / max((~push).sum(), 1)), 3)}

POOL = [2016, 2023, 2024, 2025]
RULES = [('spread', 'predicted line move', 'pm_move', (0.5, 0.75, 1.0)), ('spread', 'model-vs-open gap', 'x_gap', (2.0, 3.0, 4.0)),
         ('total', 'predicted line move', 'pt_move', (0.75, 1.0, 1.5)), ('total', 'model-vs-open gap', 'xt_gap', (3.0, 4.0, 5.0))]
N_RULES = sum(len(r[3]) for r in RULES)
out = {'n_rules': N_RULES, 'pool_seasons': POOL, 'margin_sd': KM.sd, 'total_sd': KT.sd, 'rules': []}
for market, rule, col, thrs in RULES:
    base = mk if market == 'spread' else mkt
    T = F[base & F[col].notna() & F.season.isin(POOL + [2026])]
    print(f'\n{market.upper()} HOLDOUT {POOL}: {int(T.season.isin(POOL).sum())} games with open + close ({rule})')
    for thr in thrs:
        sub = T[(T[col].abs() >= thr) & T.season.isin(POOL)]; side = (sub[col] > 0).astype(int).values
        res = {'market': market, 'rule': rule, 'threshold': thr, **(evaluate(sub, side, market) or {})}
        res['bonferroni_p'] = min(1.0, res['clv_ev_p'] * N_RULES) if res.get('clv_ev_p') is not None else None
        for Sn in POOL + [2026]:
            s2 = T[(T[col].abs() >= thr) & (T.season == Sn)]
            res[f'season_{Sn}'] = evaluate(s2, (s2[col] > 0).astype(int).values, market)
        out['rules'].append(res)
        per = '  '.join(f"{Sn}: EV {res[f'season_{Sn}']['clv_ev_pct']:+.2f}% n={res[f'season_{Sn}']['bets']}" if res[f'season_{Sn}'] else f'{Sn}: -' for Sn in POOL + [2026])
        if res.get('bets'):
            print(f"  >= {thr}: bets {res['bets']:4d}  CLV EV {res['clv_ev_pct']:+.2f}% (t={res['clv_ev_t']}, p={res['clv_ev_p']:.2g}, bonf {res['bonferroni_p']:.2g})  "
                  f"beat close {res['beat_close_rate']:.1%} (p={res['beat_close_p']:.2g})  mean CLV {res['mean_clv_pts']:+.2f} pts  ROI {res['actual_roi_pct']:+.2f}% {res['roi_ci90']} | {per}", flush=True)

# ---------------------------------------------------------------- models vs market: log loss / Brier / RMSE on the pooled holdout
def pwin(mu, kd):
    a, b = kd.probs(mu, 0); return a / max(1 - b, 1e-9)
def pcover(mu, line, kd):
    a, b = kd.probs(mu, line); return a / max(1 - b, 1e-9)
ll = lambda p, y: float(-np.mean(y * np.log(np.clip(p, 1e-6, 1 - 1e-6)) + (1 - y) * np.log(1 - np.clip(p, 1e-6, 1 - 1e-6))))
br = lambda p, y: float(np.mean((p - y) ** 2))
H = F[F.season.isin(POOL) & mk & (F.y_margin != 0)].copy()
H['yw'] = (H.y_margin > 0).astype(int)
tab = {}
for name, col in (('model stage-1 ridge', 'm_ridge'), ('model stage-1 GBM', 'm_gbm'), ('model stage-1 Keras', 'm_nn'), ('model stage-1 aggregate', 'm_fund'),
                  ('market OPEN (fair spread)', 'mu_open'), ('market CLOSE (fair spread)', 'mu_close')):
    p = np.array([pwin(m, KM) for m in H[col]])
    tab[name] = {'win_logloss': round(ll(p, H.yw.values), 5), 'win_brier': round(br(p, H.yw.values), 5), 'margin_rmse': round(float(np.sqrt(np.mean((H[col] - H.y_margin) ** 2))), 3)}
Hc = H[H.y_margin != H.close_spread]; yc = (Hc.y_margin > Hc.close_spread).astype(int).values
for name, col in (('model stage-1 aggregate', 'm_fund'), ('market OPEN (fair spread)', 'mu_open'), ('market CLOSE (fair spread)', 'mu_close')):
    p = np.array([pcover(m, l, KM) for m, l in zip(Hc[col], Hc.close_spread)])
    tab[name].update({'ats_close_logloss': round(ll(p, yc), 5), 'ats_close_brier': round(br(p, yc), 5)})
Ht = F[F.season.isin(POOL) & mkt]
for name, col in (('model stage-1 aggregate', 't_fund'), ('market OPEN (fair spread)', 'mu_open_t'), ('market CLOSE (fair spread)', 'mu_close_t')):
    tab[name]['total_rmse'] = round(float(np.sqrt(np.mean((Ht[col] - Ht.y_total) ** 2))), 3)
print('\nMODELS vs MARKET on the pooled holdout (%d games):' % len(H))
for k, v in tab.items(): print(f'  {k:30s} {v}')
out['models_vs_market'] = tab; out['holdout_games'] = int(len(H))
json.dump(out, open('data/cache/proof.json', 'w'), indent=1, default=float)
F.to_parquet('data/cache/proof_preds.parquet')
json.dump({'margin': KM.to_json(), 'total': KT.to_json()}, open('data/cache/keydist.json', 'w'))
