"""Robustness of the portable CLV result (run after portable.py).
  1. scoring model: key-number distribution (default) vs a plain normal (no key weights)
  2. close: nflverse consensus close (default) vs the SAME book's own close (ESPN BET / DraftKings, 2024+ only)
  3. drop games whose open juice had to be imputed (-110/-110)
  4. era split: 2016 offshore opener vs 2023-25 book opens
  5. sign-flip permutation of the stage-2 prediction (is the pooled EV a vig artefact of the threshold?)
"""
import json, warnings, numpy as np, pandas as pd
from scipy import stats
from common import KeyDist, novig2, dec
warnings.filterwarnings('ignore'); np.seterr(all='ignore'); rng = np.random.default_rng(7)
P = pd.read_parquet('data/cache/proof_preds.parquet').merge(pd.read_parquet('data/cache/portable_preds.parquet').drop(columns='season'), on='gid')
MK = pd.read_parquet('data/cache/market.parquet')
P = P.merge(MK[['gid'] + [c for c in MK.columns if c.startswith(('bclose_', 'juice_imputed')) and c not in P.columns]], on='gid', how='left')
kd = json.load(open('data/cache/keydist.json'))
KM = KeyDist(kd['margin']['sd'], kd['margin']['w']); KT = KeyDist(kd['total']['sd'], kd['total']['w'])
NM = KeyDist(kd['margin']['sd'], np.ones(201)); NT = KeyDist(kd['total']['sd'], np.ones(201))
POOL = [2016, 2023, 2024, 2025]
out = {}
def ev_rows(s, market, dist, close_mu_col):
    side = (s.pp_move > 0).values if market == 'spread' else (s.pp_move_t > 0).values
    if market == 'spread':
        return np.array([dist.ev(m, l, h if sd else a, sd) for m, l, h, a, sd in zip(s[close_mu_col], s.open_spread, s.open_hso, s.open_aso, side)])
    return np.array([dist.ev(m, l, o if sd else u, sd) for m, l, o, u, sd in zip(s[close_mu_col], s.open_total, s.open_over, s.open_under, side)])
def show(name, ev):
    t = stats.ttest_1samp(ev, 0, alternative='greater') if len(ev) > 2 else None
    out[name] = {'bets': int(len(ev)), 'ev': round(float(ev.mean() * 100), 2) if len(ev) else None, 'p': float(t.pvalue) if t else None}
    print(f'  {name:62s} n={len(ev):4d} CLV EV {ev.mean()*100:+.2f}%  p={t.pvalue if t else float("nan"):.4f}')
for market, col, thr, kdist, ndist, mucol in (('total', 'pp_move_t', 1.0, KT, NT, 'mu_close_t'), ('spread', 'pp_move', 0.75, KM, NM, 'mu_close')):
    base = (P.mu_open_t.notna() & P.mu_close_t.notna()) if market == 'total' else (P.mu_open.notna() & P.mu_close.notna())
    H = P[base & P.season.isin(POOL) & (P[col].abs() >= thr)].copy()
    print(f'\n{market.upper()} portable rule |pred move| >= {thr}')
    show(f'{market}: default (key-number dist, consensus close)', ev_rows(H, market, kdist, mucol))
    # plain normal: fair means must be re-solved under the normal
    if market == 'total':
        H['mu_n'] = [ndist.fair_mean(l, novig2(o, u)) for l, o, u in zip(H.close_total, H.close_over, H.close_under)]
    else:
        H['mu_n'] = [ndist.fair_mean(l, novig2(a, b)) for l, a, b in zip(H.close_spread, H.close_hso, H.close_aso)]
    show(f'{market}: plain normal sd={kdist.sd:.2f} (no key numbers)', ev_rows(H, market, ndist, 'mu_n'))
    # same-book close (2024+)
    B = H[H.season >= 2024].copy()
    if market == 'total':
        B = B[B.bclose_total.notna()]; B['mu_b'] = [kdist.fair_mean(l, novig2(o, u)) for l, o, u in zip(B.bclose_total, B.bclose_over, B.bclose_under)]
    else:
        B = B[B.bclose_spread.notna()]; B['mu_b'] = [kdist.fair_mean(l, novig2(a, b)) for l, a, b in zip(B.bclose_spread, B.bclose_hso, B.bclose_aso)]
    show(f'{market}: 2024-25 vs consensus close', ev_rows(B, market, kdist, mucol))
    show(f'{market}: 2024-25 vs the SAME book\'s own close', ev_rows(B, market, kdist, 'mu_b'))
    imp = 'juice_imputed_open_over' if market == 'total' else 'juice_imputed_open_hso'
    K = H[H[imp].isna()] if imp in H else H
    show(f'{market}: excluding imputed open juice ({len(H) - len(K)} games dropped)', ev_rows(K, market, kdist, mucol))
    Hf = H.copy()
    for c in (('open_over', 'open_under') if market == 'total' else ('open_hso', 'open_aso')): Hf[c] = -110.0
    show(f'{market}: every open priced at -110 (ignore recorded open juice)', ev_rows(Hf, market, kdist, mucol))
    show(f'{market}: 2016 offshore opener only', ev_rows(H[H.season == 2016], market, kdist, mucol))
    show(f'{market}: 2023-25 book opens only', ev_rows(H[H.season >= 2023], market, kdist, mucol))
    # permutation: random sides on the same games (how much EV does picking a side at random earn?)
    evs = []
    for _ in range(500):
        flip = rng.random(len(H)) < 0.5; Q = H.copy(); Q[col] = np.where(flip, -Q[col], Q[col]); evs.append(ev_rows(Q, market, kdist, mucol).mean())
    real = ev_rows(H, market, kdist, mucol).mean()
    pp = float((np.array(evs) >= real).mean())
    out[f'{market}: permutation p'] = pp
    print(f'  {market}: random-side permutation: mean EV {np.mean(evs)*100:+.2f}%, real {real*100:+.2f}%, permutation p={pp:.3f}')
json.dump(out, open('data/cache/sensitivity.json', 'w'), indent=1)
