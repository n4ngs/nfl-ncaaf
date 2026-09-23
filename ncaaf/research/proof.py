"""Can an OPEN-SAFE model beat the college football CLOSING line? (closing-line value, spread market first)

Stage 1  fundamentals -> predicted home margin: ridge + gradient boosting (model.py) + Keras nets (nn.py), averaged
         (every prediction for season S was fit on seasons < S).
Stage 2  line-movement aggregate: predicts the CLV of a HOME bet at the bet book's opening line,
         target = open_line - consensus_close (points; > 0 means the market moved toward the home side),
         from the model-vs-open gap and context (ridge + gradient boosting + Keras MLP averaged), trained only on
         earlier seasons that have opening lines (2014-2019, 2021-2022 for the first holdout season).
Bet at the OPEN when the predicted CLV is large enough (or when the stage-1 gap is large), priced at the book's actual
open juice (-110 when the source has no open juice; share reported), scored against the juice-adjusted consensus
CLOSE with a discretized-normal margin model (SD estimated on training seasons):
  CLV EV% = P_close(win) * (decimal_open - 1) - P_close(lose)       (push returns the stake)
Holdout: 2023, 2024, 2025. Totals tested separately at the end.
"""
import os, json, warnings
os.environ.setdefault('KERAS_BACKEND', 'torch'); warnings.filterwarnings('ignore')
import numpy as np, pandas as pd, keras
from sklearn.linear_model import Ridge
from sklearn.ensemble import HistGradientBoostingRegressor
from common import load, evaluate, fmt, HOLDOUT, GROUPS, LATE
np.seterr(all='ignore')
F = load()
S1 = pd.read_parquet('data/cache/stage1_preds.parquet')[['gid', 'm_all', 'm_gbm']]
F = F.merge(S1, on='gid', how='left')
NN = pd.read_parquet('data/cache/nn_preds.parquet') if os.path.exists('data/cache/nn_preds.parquet') else None
nn_cols = [c for c in (NN.columns if NN is not None else []) if c.startswith('m_')]
if nn_cols: F = F.merge(NN[['gid'] + nn_cols], on='gid', how='left')
use_nn = os.environ.get('NO_NN') is None and nn_cols
F['m_fund'] = F[['m_all', 'm_gbm'] + (nn_cols if use_nn else [])].mean(1, skipna=True)
F['m_lin'] = F.m_all
print('stage-1 members:', ['m_all', 'm_gbm'] + (nn_cols if use_nn else []))

mk = F.bet_line.notna() & F.close.notna() & F.m_fund.notna()     # stage-1 predictions exist from 2017 (first fit on 2015-16)
F['x_gap'] = F.m_fund + F.bet_line            # model margin minus the open's implied margin (-line), points
F['x_gap_lin'] = F.m_lin + F.bet_line
F['x_open'] = F.bet_line; F['x_open_abs'] = F.bet_line.abs()
F['x_open_vs_cons'] = (F.bet_line - F.open).fillna(0.0)     # this book's open vs the median open across books
F['clv_home'] = F.bet_line - F.close
F['tier_g5'] = (F.tier == 'G5').astype(int); F['tier_fcs'] = (F.tier == 'FCS').astype(int)
MOVE = ['x_gap', 'x_open', 'x_open_abs', 'd_mkt', 'd_talent', 'early', 'home', 'min_n', 'd_qb_pepa', 'd_qb_starts', 'tier_g5', 'tier_fcs', 'conf_game']
# cross-book: this book's open vs the median open of all books. Kept OUT of the main open-safe set: other books' 'opens'
# may be stamped later than the bet book's open, so this is only actionable if you can see them before the bet book moves.
XBOOK = ['x_open_vs_cons']

def mlp(n_in, seed):
    keras.utils.set_random_seed(seed)
    m = keras.Sequential([keras.Input((n_in,)), keras.layers.Dense(32, activation='gelu', kernel_regularizer=keras.regularizers.l2(1e-3)),
                          keras.layers.Dropout(0.3), keras.layers.Dense(16, activation='gelu'), keras.layers.Dense(1)])
    m.compile(keras.optimizers.Adam(1e-3), keras.losses.Huber(2.0)); return m

def stage2(cols, tag, seasons=HOLDOUT, members=('ridge', 'gbm', 'nn')):
    out = {}
    for S in seasons:
        tr = (mk & (F.season < S)).values; te = (mk & (F.season == S)).values
        X, t = F[cols].values, F.clv_home.values
        mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9; Xs = (X - mu) / sd
        preds = {}
        preds['ridge'] = Ridge(alpha=30).fit(Xs[tr], t[tr]).predict(Xs[te])
        if 'gbm' in members:
            preds['gbm'] = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.03, max_leaf_nodes=8, min_samples_leaf=80, random_state=0).fit(X[tr], t[tr]).predict(X[te])
        if 'nn' in members:
            ks = []
            for sdd in (1, 2, 3):
                m = mlp(len(cols), sdd)
                m.fit(Xs[tr], t[tr], validation_split=0.15, epochs=80, batch_size=128, verbose=0, callbacks=[keras.callbacks.EarlyStopping(patience=8, restore_best_weights=True)])
                ks.append(m.predict(Xs[te], verbose=0)[:, 0])
            preds['nn'] = np.mean(ks, 0)
        agg = np.mean([preds[k] for k in preds], 0)
        for k, v in preds.items(): F.loc[te, f'{tag}_{k}'] = v
        F.loc[te, tag] = agg
        out[S] = {k: round(float(np.corrcoef(v, t[te])[0, 1]), 3) for k, v in {**preds, 'agg': agg}.items()}
        print(f'stage2[{tag}] {S}: corr(pred CLV, actual CLV) {out[S]}', flush=True)
    return out

# SD of the margin around the close, estimated on pre-holdout seasons only
SD = float((F.margin + F.close)[F.season < HOLDOUT[0]].std()); print(f'margin SD around the close (2015-2022): {SD:.2f}')
TSD = float((F.total - F.tclose)[F.season < HOLDOUT[0]].std()); print(f'total SD around the close (2015-2022): {TSD:.2f}')
report = {'sd_margin': SD, 'sd_total': TSD, 'stage2_corr': {}, 'rules': []}
report['stage2_corr']['main'] = stage2(MOVE, 'pred')

T = F[F.season.isin(HOLDOUT) & mk & F.pred.notna()].copy()
print(f'\nHOLDOUT {HOLDOUT}: {len(T)} games with an open bet price and a close. Market moved toward home: {(T.clv_home > 0).mean():.3f}, away {(T.clv_home < 0).mean():.3f}')
print('baseline (bet every home side at open):', fmt(evaluate(T, np.ones(len(T), bool), SD)))
print('baseline (bet every away side at open):', fmt(evaluate(T, np.zeros(len(T), bool), SD)))
n_rules = 0
def run(rule, col, thrs, sub_mask=None, label=''):
    global n_rules
    for thr in thrs:
        n_rules += 1
        s = T[(T[col].abs() >= thr) & (True if sub_mask is None else sub_mask(T))]; side = (s[col] > 0).values
        res = {'rule': rule + label, 'threshold': thr, **evaluate(s, side, SD)}
        for S in HOLDOUT:
            s2 = s[s.season == S]; res[f's{S}'] = evaluate(s2, (s2[col] > 0).values, SD)
        report['rules'].append(res)
        per = '  '.join(f"{S}: EV {res[f's{S}'].get('clv_ev_pct', float('nan')):+.2f}% n={res[f's{S}']['bets']}" for S in HOLDOUT)
        print(f'{rule + label:34s} >= {thr:<4}: {fmt(res)} | {per}', flush=True)
print()
run('A open-safe: predicted CLV', 'pred', (0.5, 1.0, 1.5, 2.0))
run('model-vs-open gap (pts)', 'x_gap', (3.0, 5.0, 7.0, 10.0))
for tier in ('P5', 'G5', 'MIX', 'FCS'):
    run('A open-safe: predicted CLV', 'pred', (0.5, 1.0), sub_mask=lambda d, tier=tier: d.tier == tier, label=f' [{tier}]')
print('\nB: + cross-book opens (see caveat):')
report['stage2_corr']['xbook'] = stage2(MOVE + XBOOK, 'pred_x')
T = F[F.season.isin(HOLDOUT) & mk & F.pred.notna()].copy()
run('B +cross-book: predicted CLV', 'pred_x', (0.5, 1.0, 1.5, 2.0))

# ---------------------------------------------------------------- late news: the actual starting QB (NOT open-safe)
print('\nLATE-NEWS variants (actual starter known after the open; tests whether knowing it predicts the move):')
report['stage2_corr']['late_qb'] = stage2(MOVE + LATE, 'pred_late')
T = F[F.season.isin(HOLDOUT) & mk & F.pred.notna()].copy()
run('C LATE (first-snap QB): pred CLV', 'pred_late', (0.5, 1.0, 1.5, 2.0))
chg = T[(T.L_home_qb_change + T.L_away_qb_change) > 0]
print(f'games with a QB change vs last start: {len(chg)} ({len(chg)/len(T):.1%}); mean |open-close| {chg.clv_home.abs().mean():.2f} vs {T.clv_home.abs().mean():.2f} overall')
# direction: bet AGAINST the team whose starter changed (only one side changed)
one = T[(T.L_home_qb_change + T.L_away_qb_change) == 1]; side = one.L_away_qb_change.values == 1; n_rules += 1
r = evaluate(one, side, SD); report['qb_change_fade'] = r; print('fade the side with a new starting QB (at open):', fmt(r))
for S in HOLDOUT:
    o2 = one[one.season == S]; print(f'   {S}:', fmt(evaluate(o2, o2.L_away_qb_change.values == 1, SD)))

# ---------------------------------------------------------------- totals (separate market)
print('\nTOTALS: stage-1 total points ridge, stage-2 CLV of an OVER bet at the open')
tk = F.tbet_line.notna() & F.tclose.notna()
TOT = ['t_pts', 't_plays', 'early', 'min_n', 'neutral', 'home_fbs', 'away_fbs']
for S in range(2017, 2026):
    tr = (F.season < S).values; te = (F.season == S).values
    X = F[TOT].values; mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9
    F.loc[te, 't_fund'] = Ridge(alpha=30).fit((X[tr] - mu) / sd, F.total[tr]).predict((X[te] - mu) / sd)
F['tx_gap'] = F.t_fund - F.tbet_line; F['tx_open'] = F.tbet_line; F['tclv_over'] = F.tclose - F.tbet_line
F['tx_open_vs_cons'] = (F.tbet_line - F.topen).fillna(0.0)
F['x_open_abs'] = F.bet_line.abs().fillna(F.bet_line.abs().median())
TM = ['tx_gap', 'tx_open', 'early', 'min_n', 'tier_g5', 'tier_fcs', 'x_open_abs']      # A: open-safe
tk = tk & F.t_fund.notna()
report['totals'] = []; n_t = 0
for tag, cols in (('tpred', TM), ('tpred_x', TM + ['tx_open_vs_cons'])):
    for S in HOLDOUT:
        tr = (tk & (F.season < S)).values; te = (tk & (F.season == S)).values
        X = F[cols].values; mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9
        r1 = Ridge(alpha=30).fit((X[tr] - mu) / sd, F.tclv_over[tr]).predict((X[te] - mu) / sd)
        r2 = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.03, max_leaf_nodes=8, min_samples_leaf=80, random_state=0).fit(X[tr], F.tclv_over[tr]).predict(X[te])
        F.loc[te, tag] = (r1 + r2) / 2; F.loc[te, tag + '_ridge'] = r1
        print(f'totals stage2 [{tag}] {S}: corr ridge {np.corrcoef(r1, F.tclv_over[te])[0,1]:.3f} gbm {np.corrcoef(r2, F.tclv_over[te])[0,1]:.3f} agg {np.corrcoef(F.loc[te, tag], F.tclv_over[te])[0,1]:.3f}')
TT = F[F.season.isin(HOLDOUT) & tk & F.tpred.notna()].copy()
for col, thrs, label in (('tpred', (0.5, 1.0, 1.5, 2.0), 'A open-safe'), ('tpred_x', (0.5, 1.0, 1.5, 2.0), 'B +cross-book'), ('tx_gap', (3.0, 5.0, 8.0), 'model-vs-open gap')):
    for thr in thrs:
        n_t += 1; s = TT[TT[col].abs() >= thr]; side = (s[col] > 0).values
        res = {'rule': f'totals {label} ({col})', 'threshold': thr, **evaluate(s, side, TSD, kind='total')}
        for S in HOLDOUT:
            s2 = s[s.season == S]; res[f's{S}'] = evaluate(s2, (s2[col] > 0).values, TSD, kind='total')
        report['totals'].append(res)
        print(f'totals {label:18s} >= {thr:<4}: {fmt(res)} | ' + '  '.join(f"{S}: EV {res[f's{S}'].get('clv_ev_pct', float('nan')):+.2f}% n={res[f's{S}']['bets']}" for S in HOLDOUT), flush=True)
report['n_rules_totals'] = n_t
report['n_rules_spread'] = n_rules
print(f'\nTOTAL rules tried on the holdout: spread {n_rules} + totals {n_t} = {n_rules + n_t} (Bonferroni factor)')
json.dump(report, open('data/cache/proof.json', 'w'), indent=1, default=float)
F.to_parquet('data/cache/proof_preds.parquet')
