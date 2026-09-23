"""Shared definitions: feature groups, pricing math, CLV evaluation."""
import numpy as np, pandas as pd
from scipy import stats
STATS = ['pts', 'epa', 'repa', 'pepa', 'fdr', 'expl', 'ypp', 'st', 'plays']
GROUPS = {
    'team':      [f'd_{s}_{k}' for k in STATS for s in ('o', 'd')],
    'market_rt': ['d_mkt'],
    'preseason': ['d_talent', 'd_ret_off', 'd_ret_def', 'talent_early'],
    'qb':        ['d_qb_starts', 'd_qb_pepa'],
    'context':   ['home', 'conf_game', 'home_fbs', 'away_fbs', 'd_rest', 'min_n', 'early'],
}
TOTAL_X = ['t_pts', 't_plays', 'early', 'min_n', 'neutral']
LATE = ['L_d_qb_starts', 'L_d_qb_pepa', 'L_home_qb_change', 'L_away_qb_change']
HOLDOUT = (2023, 2024, 2025)
OPEN_SEASONS = (2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025)

def load():
    F = pd.read_parquet('data/cache/features.parquet')
    F = F[(F.season >= 2015) & (F.season <= 2025)].reset_index(drop=True)
    F['home'] = 1 - F.neutral; F['talent_early'] = F.d_talent * F.early
    allx = list(dict.fromkeys(sum(GROUPS.values(), []) + TOTAL_X + LATE))
    F[allx] = F[allx].replace([np.inf, -np.inf], np.nan)
    for c in allx: F[c] = F[c].fillna(0.0)
    return F

def dec(am):
    am = np.asarray(am, float); return np.where(am > 0, 1 + am / 100, 1 + 100 / -am)

def mu_close(close, pnv, sd):
    return -np.asarray(close, float) + sd * stats.norm.ppf(np.clip(np.asarray(pnv, float), 0.4, 0.6))

def cover_probs(line, mu, sd, home_side):
    """discretized normal on the integer margin M ~ N(mu, sd). Home bet at `line` wins if M + line > 0."""
    line = np.asarray(line, float); mu = np.asarray(mu, float)
    ge = lambda m: 1 - stats.norm.cdf((m - 0.5 - mu) / sd)          # P(M >= m), m integer
    le = lambda m: stats.norm.cdf((m + 0.5 - mu) / sd)              # P(M <= m)
    thr = -line
    integer = np.isclose(thr, np.round(thr))
    if home_side:
        win = np.where(integer, ge(np.round(thr) + 1), ge(np.ceil(thr)))
    else:
        win = np.where(integer, le(np.round(thr) - 1), le(np.floor(thr)))
    push = np.where(integer, ge(np.round(thr)) - ge(np.round(thr) + 1), 0.0)
    return win, push

def evaluate(sub, side_home, sd, kind='spread', rng=np.random.default_rng(5)):
    """bets at the bet book's OPEN price; CLV EV scored against the (juice-adjusted) consensus CLOSE."""
    side_home = np.asarray(side_home, bool)
    if kind == 'spread':
        line = sub.bet_line.values; odds = np.where(side_home, sub.bet_h_odds, sub.bet_a_odds)
        mu = mu_close(sub.close, sub.close_pnv, sd)
        # the away bet at home line L is a bet that M + L < 0: evaluate with home_side False
        w_h, p_h = cover_probs(line, mu, sd, True); w_a, p_a = cover_probs(line, mu, sd, False)
        win = np.where(side_home, w_h, w_a); push = np.where(side_home, p_h, p_a)
        clv_pts = np.where(side_home, line - sub.close.values, sub.close.values - line)
        res_m = sub.margin.values + line
        won = np.where(side_home, res_m > 0, res_m < 0); pushed = res_m == 0
    else:   # totals: side_home True = OVER
        line = sub.tbet_line.values; odds = np.where(side_home, sub.tbet_o_odds, sub.tbet_u_odds)
        mu = sub.tclose.values + sd * stats.norm.ppf(np.clip(sub.tclose_pnv.values, 0.4, 0.6))
        # over at L wins if T > L  <=>  (-T) + L < 0 : reuse with M=-T, mu=-mu
        w_o, p_o = cover_probs(line, -mu, sd, False); w_u, p_u = cover_probs(line, -mu, sd, True)
        win = np.where(side_home, w_o, w_u); push = np.where(side_home, p_o, p_u)
        clv_pts = np.where(side_home, sub.tclose.values - line, line - sub.tclose.values)
        won = np.where(side_home, sub.total.values > line, sub.total.values < line); pushed = sub.total.values == line
    d = dec(odds)
    ev = win * (d - 1) - (1 - win - push)
    roi = np.where(pushed, 0.0, np.where(won, d - 1, -1.0))
    n = len(ev)
    if n < 3: return {'bets': int(n)}
    t = stats.ttest_1samp(ev, 0, alternative='greater')
    nz = clv_pts != 0
    b = stats.binomtest(int((clv_pts > 0).sum()), int(nz.sum()), 0.5, alternative='greater') if nz.sum() else None
    bs = [rng.choice(roi, n).mean() for _ in range(2000)]
    return {'bets': int(n), 'clv_ev_pct': round(float(ev.mean() * 100), 2), 't': round(float(t.statistic), 2), 'p': float(t.pvalue),
            'beat_close': round(float((clv_pts > 0).mean()), 3), 'lost_close': round(float((clv_pts < 0).mean()), 3),
            'beat_p': float(b.pvalue) if b else None, 'mean_clv_pts': round(float(clv_pts.mean()), 2),
            'roi_pct': round(float(roi.mean() * 100), 2), 'roi_ci90': [round(float(np.percentile(bs, 5) * 100), 1), round(float(np.percentile(bs, 95) * 100), 1)],
            'real_juice_share': round(float((sub.bet_real_juice if kind == 'spread' else sub.tbet_real_juice).mean()), 2)}

def fmt(r):
    if r.get('bets', 0) < 3: return f"n={r.get('bets', 0)}"
    return (f"n={r['bets']:4d} EV {r['clv_ev_pct']:+.2f}% (t={r['t']:.2f}, p={r['p']:.3g}) beat {r['beat_close']:.1%}/lost {r['lost_close']:.1%} "
            f"(p={r['beat_p']:.3g}) clv {r['mean_clv_pts']:+.2f}pt ROI {r['roi_pct']:+.1f}% {r['roi_ci90']}")
