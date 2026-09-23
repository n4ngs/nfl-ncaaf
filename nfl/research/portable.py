"""Portable open-safe model: exactly what nfl/lib/vas-engine.js computes (features.py portable set + linear models).

Stage 1  ridge: home margin on the d_* / schedule features, total points on the s_* / venue features
Stage 2  ridge: CLOSE - OPEN fair line (points) for spread and total, from the model/open gap, line shape and context
Holdout  identical rolling origin to proof.py (stage 1 fit on 2007..S-1, stage 2 on open seasons < S; tests 2016, 2023-25),
         scored with the same CLV EV at the book's OPEN price vs the no-vig CLOSE.
Tiers    PROVEN only if a threshold passes ALL pre-set criteria on the holdout:
           Bonferroni-adjusted one-sided p < 0.05 (over every rule tried in proof.py + here), CLV EV > 0 pooled,
           CLV EV > 0 in at least 3 of the 4 test seasons, >= 100 bets.
         Otherwise the market is marked UNPROVEN and only a LEAN (best candidate, not proven) threshold is exported.
Export   data/cache/nfl-vas-model.json, fit on every season (stage 1: 2007-2026 wk2; stage 2: all open seasons, using the
         out-of-sample stage-1 predictions exactly as production will see them). Also data/cache/parity/model_py.json.
"""
import json, os, warnings, numpy as np, pandas as pd
from scipy import stats
from sklearn.linear_model import Ridge
from common import KeyDist, novig2
warnings.filterwarnings('ignore'); np.seterr(all='ignore')
P = pd.read_parquet('data/cache/proof_preds.parquet')
kdj = json.load(open('data/cache/keydist.json'))
KM = KeyDist(kdj['margin']['sd'], kdj['margin']['w']); KT = KeyDist(kdj['total']['sd'], kdj['total']['w'])   # rounded, as exported
CFG = json.load(open('data/cache/cfg_used.json'))
GL = ['QB', 'OL', 'WR', 'TE', 'RB', 'DL', 'LB', 'DB']
S1M = [c for c in P.columns if c.startswith('d_') and not c.startswith(('d_inj_', 'd_ina_', 'd_qb_news'))] + ['neutral', 'div', 'away_tz', 'west_early', 'home_short', 'away_short', 'home_bye', 'away_bye']
S1M = list(dict.fromkeys(S1M))
S1T = ['s_op', 's_or', 's_dp', 's_dr', 's_osr', 's_dsr', 's_st', 's_pf', 's_pa', 's_pace', 's_prate', 's_qb', 'dome', 'neutral']
S2S = ['x_gap', 'x_open', 'x_absopen', 'x_half', 'd_qb', 'home_qbshare', 'away_qbshare', 'd_m_QB', 'd_m_OL', 'd_m_DB', 'd_rest', 'd_op', 'd_dp', 'd_pf', 'd_pa', 'neutral', 'div']
S2T = ['xt_gap', 'xt_open', 'dome', 's_pace', 's_prate', 's_qb', 's_op', 's_dp', 's_pf', 's_pa', 'neutral']
POOL = [2016, 2023, 2024, 2025]
mk = P.mu_open.notna() & P.mu_close.notna(); mkt = P.mu_open_t.notna() & P.mu_close_t.notna()
A1, A2 = 50.0, 10.0

def fit(cols, y, idx, alpha):
    X = P.loc[idx, cols].astype(float).fillna(0.0).values; mu, sd = X.mean(0), X.std(0); sd = np.where(sd < 1e-6, 1.0, sd)
    r = Ridge(alpha=alpha).fit((X - mu) / sd, y[idx.values])
    return {'features': cols, 'mean': mu.tolist(), 'std': sd.tolist(), 'coef': r.coef_.tolist(), 'intercept': float(r.intercept_)}
def pred(mod, idx):
    X = P.loc[idx, mod['features']].astype(float).values
    X = np.where(np.isnan(X), np.array(mod['mean']), X)                                  # Node: non-finite -> mean
    return ((X - np.array(mod['mean'])) / np.array(mod['std'])) @ np.array(mod['coef']) + mod['intercept']

# ---------------------------------------------------------------- rolling holdout of the portable pipeline
for Sn in range(2014, 2027):
    tr = P.season.between(2007, Sn - 1); te = P.season == Sn
    P.loc[te, 'pp_margin'] = pred(fit(S1M, P.y_margin.values, tr, A1), te)
    P.loc[te, 'pp_total'] = pred(fit(S1T, P.y_total.values, tr, A1), te)
P['x_gap'] = P.pp_margin - P.mu_open; P['xt_gap'] = P.pp_total - P.mu_open_t
for Sn in POOL + [2026]:
    P.loc[mk & (P.season == Sn), 'pp_move'] = pred(fit(S2S, P.move.values, mk & (P.season < Sn), A2), mk & (P.season == Sn))
    P.loc[mkt & (P.season == Sn), 'pp_move_t'] = pred(fit(S2T, P.move_t.values, mkt & (P.season < Sn), A2), mkt & (P.season == Sn))

def evaluate(sub, col, market):
    side = (sub[col] > 0).values
    if market == 'spread':
        ev = np.array([KM.ev(m, l, h if s else a, s) for m, l, h, a, s in zip(sub.mu_close, sub.open_spread, sub.open_hso, sub.open_aso, side)])
        pts = np.where(side, sub.close_spread - sub.open_spread, sub.open_spread - sub.close_spread)
    else:
        ev = np.array([KT.ev(m, l, o if s else u, s) for m, l, o, u, s in zip(sub.mu_close_t, sub.open_total, sub.open_over, sub.open_under, side)])
        pts = np.where(side, sub.close_total - sub.open_total, sub.open_total - sub.close_total)
    if len(ev) < 3: return {'bets': int(len(ev))}
    t = stats.ttest_1samp(ev, 0, alternative='greater'); nz = pts != 0
    b = stats.binomtest(int((pts > 0).sum()), int(nz.sum()), 0.5, alternative='greater') if nz.sum() else None
    return {'bets': int(len(ev)), 'clv_ev_pct': round(float(ev.mean() * 100), 3), 't': round(float(t.statistic), 2), 'p': float(t.pvalue),
            'beat_close': round(float((pts > 0).sum() / max(nz.sum(), 1)), 3), 'beat_close_p': float(b.pvalue) if b else None,
            'mean_clv_pts': round(float(pts.mean()), 3)}

proof = json.load(open('data/cache/proof.json'))
THR = {'spread': (0.25, 0.5, 0.75, 1.0), 'total': (0.5, 0.75, 1.0, 1.5)}
N_RULES = proof['n_rules'] + sum(len(v) for v in THR.values())
report = {'n_rules_total': N_RULES, 'criteria': 'bonferroni p<0.05, pooled EV>0, EV>0 in >=3 of 4 test seasons, >=100 bets'}
tiers = {}
for market, col, base in (('spread', 'pp_move', mk), ('total', 'pp_move_t', mkt)):
    H = P[base & P.season.isin(POOL) & P[col].notna()]
    Hc = H.move if market == 'spread' else H.move_t
    report[market] = {'corr_pred_move': round(float(np.corrcoef(H[col], Hc)[0, 1]), 3), 'games': int(len(H)), 'thresholds': {}}
    print(f'\nPORTABLE {market.upper()}: holdout {POOL}, {len(H)} games, corr(pred, move) {report[market]["corr_pred_move"]:.3f}')
    proven, best = None, None
    for thr in THR[market]:
        s = H[H[col].abs() >= thr]
        r = evaluate(s, col, market)
        if r['bets'] < 3: continue
        r['bonferroni_p'] = min(1.0, r['p'] * N_RULES)
        r['by_season'] = {int(Sn): evaluate(s[s.season == Sn], col, market) for Sn in POOL}
        r['seasons_positive'] = int(sum(1 for v in r['by_season'].values() if v.get('clv_ev_pct', -1) > 0))
        f26 = P[base & (P.season == 2026) & (P[col].abs() >= thr)]
        r['forward_2026'] = evaluate(f26, col, market) if len(f26) else {'bets': 0}
        ok = r['bonferroni_p'] < 0.05 and r['clv_ev_pct'] > 0 and r['seasons_positive'] >= 3 and r['bets'] >= 100
        r['passes'] = bool(ok)
        report[market]['thresholds'][str(thr)] = r
        per = ' '.join(f"{k}:{v.get('clv_ev_pct', float('nan')):+.2f}%/n{v['bets']}" for k, v in r['by_season'].items())
        print(f"  >= {thr}: n={r['bets']} CLV EV {r['clv_ev_pct']:+.2f}% p={r['p']:.3g} bonf={r['bonferroni_p']:.3g} beat {r['beat_close']:.1%} | {per} | 2026 {r['forward_2026']} {'PASS' if ok else ''}", flush=True)
        if ok and proven is None: proven = thr
        if r['clv_ev_pct'] > 0 and (best is None or r['p'] < report[market]['thresholds'][str(best)]['p']): best = thr
    below = [t for t in THR[market] if proven is not None and t < proven and report[market]['thresholds'].get(str(t), {}).get('clv_ev_pct', -1) > 0]
    tiers[market] = {'proven': proven, 'lean': (max(below) if below else None) if proven is not None else best}

# ---------------------------------------------------------------- final fit on everything, export
allrows = P.season.between(2007, 2026) & P.y_margin.notna()
stage1 = {'margin': fit(S1M, P.y_margin.values, allrows, A1), 'total': fit(S1T, P.y_total.values, allrows, A1)}
# stage 2 on every open season, x_gap from out-of-sample stage-1 predictions (rolling, as production sees them)
stage2 = {'spread': fit(S2S, P.move.values, mk & P.x_gap.notna(), A2), 'total': fit(S2T, P.move_t.values, mkt & P.xt_gap.notna(), A2)}
# injury-matrix display weights: points of home margin per unit of expected missing snap share, by group (2013-2025,
# controlling for the open-safe prediction). Descriptive only - the late-news test decides whether any of it is an edge.
IJ = P[P.season.between(2013, 2025)].copy()
for x in GL: IJ[f'dij_{x}'] = (IJ[f'home_inj_{x}'] - IJ[f'away_inj_{x}']).fillna(0.0)
Xi = IJ[[f'dij_{x}' for x in GL]].values
ri = Ridge(alpha=5.0).fit(Xi, IJ.y_margin - IJ.pp_margin.fillna(IJ.m_fund))
inj_w = {x: round(float(-c), 3) for x, c in zip(GL, ri.coef_)}      # positive = points lost by the injured team
status_by_market = {m: ('PROVEN' if tiers[m]['proven'] else 'UNPROVEN') for m in tiers}
status = 'PROVEN' if 'PROVEN' in status_by_market.values() else 'UNPROVEN'
# era split of every proven tier: 2016 offshore opener vs 2023-25 book opens (the live-relevant era)
for market, col, base in (('spread', 'pp_move', mk), ('total', 'pp_move_t', mkt)):
    thr = tiers[market]['proven']
    if thr is None: continue
    H = P[base & P.season.isin(POOL) & (P[col].abs() >= thr)]
    report[market]['era_split'] = {'2016 offshore opener': evaluate(H[H.season == 2016], col, market), '2023-25 book opens': evaluate(H[H.season >= 2023], col, market)}
    print(market, 'era split', report[market]['era_split'])
if os.path.exists('data/cache/ablate.json'):
    ab = json.load(open('data/cache/ablate.json'))
    report['lag1_sensitivity'] = {'spread': ab.get('spread|lag1'), 'total': ab.get('total|lag1')}
model = {'version': 'nfl-vas-portable-v1', 'trained_at': pd.Timestamp.utcnow().isoformat(), 'status': status, 'status_by_market': status_by_market, 'config': CFG,
         'stage1': stage1, 'stage2': stage2, 'keydist': {'margin': kdj['margin'], 'total': kdj['total']}, 'tiers': tiers,
         'pmiss': json.load(open('data/cache/pmiss.json')), 'injury_weights': inj_w, 'holdout_report': report,
         'notes': ('Stage-2 predicts the open->close move of the fair line in points; tiers are |predicted move| thresholds. '
                   'PROVEN = passed every pre-set holdout criterion; LEAN = best candidate, NOT proven. '
                   'Close = nflverse closing consensus line; open = ESPN Opening (2014-16) / ESPN BET or DraftKings open (2023+). '
                   'CAVEATS: the totals pass is driven mostly by 2016; on 2023-25 book opens alone it is positive but not significant '
                   '(see era_split); with every feature lagged one game the totals edge is not significant (lag1_sensitivity), so it depends on '
                   'the open being posted after the previous game. Verify live with the app\'s own first-seen price before trusting it.')}
json.dump(model, open('data/cache/nfl-vas-model.json', 'w'), indent=1)
print('\nexported data/cache/nfl-vas-model.json  status', status, 'tiers', tiers, 'injury weights', inj_w)

# ---------------------------------------------------------------- model parity fixture (python predictions on the parity walk)
if os.path.exists('data/cache/parity/features_py.json'):
    fx = pd.DataFrame(json.load(open('data/cache/parity/features_py.json')))
    fx = fx.merge(pd.read_parquet('data/cache/market.parquet')[['gid', 'open_spread', 'open_hso', 'open_aso', 'open_total', 'open_over', 'open_under']], on='gid', how='left')
    lin = lambda mod, row: mod['intercept'] + sum(c * ((row[f] if row.get(f) is not None and row[f] == row[f] else m) - m) / s
                                                  for f, c, m, s in zip(mod['features'], mod['coef'], mod['mean'], mod['std']))
    out = []
    for row in fx.to_dict('records'):
        r = {'gid': row['gid'], 'margin': lin(stage1['margin'], row), 'total': lin(stage1['total'], row)}
        if row['open_spread'] == row['open_spread'] and row['open_total'] == row['open_total']:
            mu = KM.fair_mean(row['open_spread'], novig2(row['open_hso'], row['open_aso'])); mut = KT.fair_mean(row['open_total'], novig2(row['open_over'], row['open_under']))
            x = {**row, 'x_gap': r['margin'] - mu, 'x_open': mu, 'x_absopen': abs(mu), 'x_half': float(row['open_spread'] % 1 != 0), 'xt_gap': r['total'] - mut, 'xt_open': mut}
            r.update(spread=row['open_spread'], hp=row['open_hso'], ap=row['open_aso'], tot=row['open_total'], op=row['open_over'], up=row['open_under'],
                     fair=mu, move=lin(stage2['spread'], x), move_t=lin(stage2['total'], x))
        out.append(r)
    json.dump(out, open('data/cache/parity/model_py.json', 'w'))
    print('model parity fixture', len(out), 'games', sum(1 for r in out if 'fair' in r), 'with open lines')
P[['gid', 'season', 'pp_margin', 'pp_total', 'pp_move', 'pp_move_t']].to_parquet('data/cache/portable_preds.parquet')
