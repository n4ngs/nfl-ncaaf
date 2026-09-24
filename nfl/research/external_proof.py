"""Out-of-sample evidence on the owner's real openers (opens_external.py): does the shipped portable model's open->close
read hold on 2017-22, seasons the research never had an opener for? EVIDENCE ONLY: nothing is fit on these openers and
the shipped model (../lib/nfl-vas-model.json) is not changed by this script.

Stage 1 is rolling, exactly as portable.py (fit 2007..S-1). Stage 2:
  v1 strict   fit only on the research's ESPN open seasons before the test seasons (2014-16), so 2017-22 is untouched
  v2 shipped  the exported stage-2 coefficients (fit on ESPN 2014-16 + 2023-25; never saw a 2017-22 opener)
Truth = the nflverse consensus CLOSE with its juice (as in the research). Bets at the source's OPEN number and OPEN juice
(AusSB decimal -> American; SBRO has no juice, so -110). CLV EV as in common.KeyDist.ev. Bonferroni over the 14 rules.
Caveat: these openers are UNTIMED. AusSB's book is Pinnacle 2014 to Feb 2018 and bet365 after; when each open was posted
relative to the teams' previous game is unknown, and the live read waits for both teams' previous game to be final.
Needs data/cache from prep.py/features.py/proof.py and data/cache/nfl_open_close_clean.csv. Writes data/cache/external_proof.json.
"""
import json, os, warnings, numpy as np, pandas as pd
from scipy import stats
from sklearn.linear_model import Ridge
from common import KeyDist, novig2
from opens_external import dec2am
warnings.filterwarnings('ignore'); np.seterr(all='ignore')
OUT = os.environ.get('OUT_DIR', 'data/cache').rstrip('/') + '/'
P = pd.read_parquet('data/cache/proof_preds.parquet')
kdj = json.load(open('data/cache/keydist.json'))
KM = KeyDist(kdj['margin']['sd'], kdj['margin']['w']); KT = KeyDist(kdj['total']['sd'], kdj['total']['w'])
SHIP = json.load(open('../lib/nfl-vas-model.json'))
S1M = list(dict.fromkeys([c for c in P.columns if c.startswith('d_') and not c.startswith(('d_inj_', 'd_ina_', 'd_qb_news'))] +
                         ['neutral', 'div', 'away_tz', 'west_early', 'home_short', 'away_short', 'home_bye', 'away_bye']))
S1T = ['s_op', 's_or', 's_dp', 's_dr', 's_osr', 's_dsr', 's_st', 's_pf', 's_pa', 's_pace', 's_prate', 's_qb', 'dome', 'neutral']
assert S1M == SHIP['stage1']['margin']['features'], 'stage-1 feature list differs from the shipped model'
S2S = SHIP['stage2']['spread']['features']; S2T = SHIP['stage2']['total']['features']
A1, A2 = 50.0, 10.0

def fit(df, cols, y, alpha):
    X = df[cols].astype(float).fillna(0.0).values; mu, sd = X.mean(0), X.std(0); sd = np.where(sd < 1e-6, 1.0, sd)
    r = Ridge(alpha=alpha).fit((X - mu) / sd, y)
    return {'features': cols, 'mean': mu.tolist(), 'std': sd.tolist(), 'coef': r.coef_.tolist(), 'intercept': float(r.intercept_)}
def pred(mod, df):
    X = df[mod['features']].astype(float).values
    X = np.where(np.isnan(X), np.array(mod['mean']), X)
    return ((X - np.array(mod['mean'])) / np.array(mod['std'])) @ np.array(mod['coef']) + mod['intercept']

for Sn in range(2011, 2027):                                   # rolling stage 1, identical to portable.py
    tr = P[P.season.between(2007, Sn - 1)]; te = P.season == Sn
    P.loc[te, 'pp_margin'] = pred(fit(tr, S1M, tr.y_margin.values, A1), P[te])
    P.loc[te, 'pp_total'] = pred(fit(tr, S1T, tr.y_total.values, A1), P[te])
mk = P.mu_open.notna() & P.mu_close.notna(); mkt = P.mu_open_t.notna() & P.mu_close_t.notna()
P['x_gap'] = P.pp_margin - P.mu_open; P['xt_gap'] = P.pp_total - P.mu_open_t
E = P[mk & P.season.between(2014, 2016)]; Et = P[mkt & P.season.between(2014, 2016)]
V1S = fit(E, S2S, E.move.values, A2); V1T = fit(Et, S2T, Et.move_t.values, A2)

C = pd.read_csv(OUT + 'nfl_open_close_clean.csv')
base = P[['gid', 'season', 'week', 'mu_close', 'mu_close_t', 'close_spread', 'close_total', 'pp_margin', 'pp_total', 'y_margin', 'y_total'] +
         [c for c in dict.fromkeys(S2S + S2T) if c not in ('x_gap', 'x_open', 'x_absopen', 'x_half', 'xt_gap', 'xt_open')]].copy()
base = base.loc[:, ~base.columns.duplicated()]

def frame(src):
    """test frame for one opener source ('aus' = AusSB, 'sbro')"""
    c = C[['gid']].copy()
    c['open_spread'] = C[f'{src}_open_spread']; c['open_total'] = C[f'{src}_open_total']
    c['ok_s'] = C[f'{src}_clean_spread'].astype(bool); c['ok_t'] = C[f'{src}_clean_total'].astype(bool)
    if src == 'aus':
        c['open_hso'] = dec2am(C.aus_open_hso_dec); c['open_aso'] = dec2am(C.aus_open_aso_dec)
        c['open_over'] = dec2am(C.aus_open_over_dec); c['open_under'] = dec2am(C.aus_open_under_dec)
    else:
        for k in ('open_hso', 'open_aso', 'open_over', 'open_under'): c[k] = -110.0
    X = base.merge(c, on='gid', how='inner'); X = X[X.open_spread.notna()].copy()
    X['mu_open'] = [KM.fair_mean(l, novig2(h, a)) for l, h, a in zip(X.open_spread, X.open_hso, X.open_aso)]
    X['mu_open_t'] = [KT.fair_mean(l, novig2(o, u)) if l == l else np.nan for l, o, u in zip(X.open_total, X.open_over, X.open_under)]
    X['x_gap'] = X.pp_margin - X.mu_open; X['x_open'] = X.mu_open; X['x_absopen'] = X.mu_open.abs(); X['x_half'] = (X.open_spread % 1 != 0).astype(float)
    X['xt_gap'] = X.pp_total - X.mu_open_t; X['xt_open'] = X.mu_open_t
    X['move'] = X.mu_close - X.mu_open; X['move_t'] = X.mu_close_t - X.mu_open_t
    X['v1_move'] = pred(V1S, X); X['v1_move_t'] = pred(V1T, X)
    X['v2_move'] = pred(SHIP['stage2']['spread'], X); X['v2_move_t'] = pred(SHIP['stage2']['total'], X)
    return X

def evs(sub, col, market, flat=False):
    side = (sub[col] > 0).values
    if market == 'spread':
        return np.array([KM.ev(m, l, -110 if flat else (h if s else a), s) for m, l, h, a, s in zip(sub.mu_close, sub.open_spread, sub.open_hso, sub.open_aso, side)])
    return np.array([KT.ev(m, l, -110 if flat else (o if s else u), s) for m, l, o, u, s in zip(sub.mu_close_t, sub.open_total, sub.open_over, sub.open_under, side)])
def evaluate(sub, col, market, flat=False):
    ev = evs(sub, col, market, flat); side = (sub[col] > 0).values
    pts = np.where(side, sub.close_spread - sub.open_spread, sub.open_spread - sub.close_spread) if market == 'spread' else \
          np.where(side, sub.close_total - sub.open_total, sub.open_total - sub.close_total)
    if len(ev) < 3: return {'bets': int(len(ev))}
    nz = pts != 0
    return {'bets': int(len(ev)), 'clv_ev_pct': round(float(ev.mean() * 100), 3), 'p': float(stats.ttest_1samp(ev, 0, alternative='greater').pvalue),
            'beat_close': round(float((pts > 0).sum() / max(nz.sum(), 1)), 4), 'clv_pts': round(float(pts.mean()), 3)}

RULES = [('spread', 'pred move', 'move', (0.25, 0.5, 0.75, 1.0)), ('spread', 'gap', 'x_gap', (2.0, 3.0, 4.0)),
         ('total', 'pred move', 'move_t', (0.5, 0.75, 1.0, 1.5)), ('total', 'gap', 'xt_gap', (3.0, 4.0, 5.0))]
NR = sum(len(r[3]) for r in RULES)
def usable(X, market): return X.ok_s if market == 'spread' else (X.ok_t & X.mu_open_t.notna())
def run(X, variant, seasons, label):
    rows = []
    for market, kind, col, thrs in RULES:
        H = X[usable(X, market) & X.season.isin(seasons) & X.mu_close.notna()]
        c = f'{variant}_{col}' if kind == 'pred move' else col
        for thr in thrs:
            s = H[H[c].abs() >= thr]; r = evaluate(s, c, market)
            if r['bets'] < 3: continue
            r['bonf_p'] = min(1.0, r['p'] * NR)
            r['by_season'] = {int(Sn): evaluate(s[s.season == Sn], c, market).get('clv_ev_pct') for Sn in seasons}
            r['seasons_pos'] = sum(1 for v in r['by_season'].values() if v is not None and v > 0)
            rows.append({'label': label, 'variant': variant, 'market': market, 'rule': f'{kind} >= {thr}', **r})
    return rows

AUS, SB = frame('aus'), frame('sbro')
NEW = [2017, 2018, 2019, 2020, 2021, 2022]
rows = run(AUS, 'v1', NEW, 'AusSB 2017-22, strict (stage 2 fit on 2014-16 only)') + run(AUS, 'v2', NEW, 'AusSB 2017-22, shipped coefficients') + \
       run(AUS, 'v1', [2019, 2021], 'AusSB 2019+2021, designated holdout') + run(SB, 'v1', [2017, 2018, 2019, 2020, 2021], 'SBRO 2017-21, strict (-110)') + \
       run(SB, 'v2', [2011, 2012, 2013], 'SBRO 2011-13, shipped coefficients (-110)')
T = pd.DataFrame(rows)

# sensitivity of the shipped rule (totals, |pred move| >= 1.0, strict stage 2) on AusSB 2017-22
H = AUS[usable(AUS, 'total') & AUS.season.isin(NEW)]; s = H[H.v1_move_t.abs() >= 1.0]
rng = np.random.default_rng(0); perm = []
for _ in range(1000):
    r = s.assign(r=rng.choice([-1.0, 1.0], len(s))); perm.append(evs(r, 'r', 'total').mean() * 100)
real = evs(s, 'v1_move_t', 'total').mean() * 100
sens = {'flat_-110_open': evaluate(s, 'v1_move_t', 'total', flat=True), 'overs': evaluate(s[s.v1_move_t > 0], 'v1_move_t', 'total'),
        'unders': evaluate(s[s.v1_move_t < 0], 'v1_move_t', 'total'),
        'pinnacle_era_2017_to_feb_2018': evaluate(s[s.season == 2017], 'v1_move_t', 'total'),
        'bet365_era_2018_22': evaluate(s[s.season >= 2018], 'v1_move_t', 'total'),
        'random_sides': {'mean_ev_pct': round(float(np.mean(perm)), 3), 'max_ev_pct': round(float(np.max(perm)), 3),
                         'perm_p': float((np.array(perm) >= real).mean() + 1 / len(perm))}}
M = P[mk][['gid', 'season', 'open_spread', 'open_total']].merge(AUS[['gid', 'open_spread', 'open_total']], on='gid', suffixes=('_espn', '_aus'))
agree = {int(k): {'games': int(len(g)), 'spread_mae': round(float((g.open_spread_espn - g.open_spread_aus).abs().mean()), 3),
                  'total_mae': round(float((g.open_total_espn - g.open_total_aus).abs().mean()), 3)} for k, g in M.groupby('season')}
out = {'n_rules': NR, 'rows': T.to_dict('records'), 'sensitivity_total_1.0': sens, 'aus_vs_espn_open': agree,
       'note': 'Evidence only. Nothing is fit on these openers; the shipped model is unchanged. Openers are untimed (AusSB: Pinnacle 2014-Feb 2018, bet365 after).'}
json.dump(out, open(OUT + 'external_proof.json', 'w'), indent=1, default=float)
pd.set_option('display.width', 250); pd.set_option('display.max_columns', 30)
for lab in T.label.unique():
    print('\n==', lab); print(T[T.label == lab][['market', 'rule', 'bets', 'clv_ev_pct', 'p', 'bonf_p', 'beat_close', 'seasons_pos', 'by_season']].to_string(index=False))
print('\nsensitivity (totals >= 1.0, AusSB 2017-22):', json.dumps(sens, indent=1))
print('AusSB vs ESPN open:', agree)

# ---------------------------------------------------------------- the model file's evidence block (coefficients untouched)
def pick(label, market, rule):
    r = next((x for x in rows if x['label'] == label and x['market'] == market and x['rule'] == rule), None)
    rd = lambda k, v: float('%.3g' % v) if k in ('p', 'bonf_p') else round(v, 4) if isinstance(v, float) else v
    return None if r is None else {k: rd(k, v) for k, v in r.items() if k not in ('label', 'variant', 'market', 'rule')}
L_V1, L_V2, L_HO = 'AusSB 2017-22, strict (stage 2 fit on 2014-16 only)', 'AusSB 2017-22, shipped coefficients', 'AusSB 2019+2021, designated holdout'
L_SB, L_SB2 = 'SBRO 2017-21, strict (-110)', 'SBRO 2011-13, shipped coefficients (-110)'
evidence = {
    'what': 'Out-of-sample replication on the owner\'s real NFL openers. Evidence only: nothing was fit on these openers and the '
            'stage-1/stage-2 coefficients in this file are unchanged by it (nfl/research/external_proof.py).',
    'source': 'AusSportsBetting nfl.xlsx (owner\'s copy): open and close lines with decimal juice (converted to American). Book: Pinnacle '
              '2014 to Feb 2018, bet365 after. Secondary cross-check: SBRO-format archive 2011-21 (lines only, priced at -110).',
    'caveats': ['Openers are UNTIMED: the export does not say when each open was posted, so whether it came before or after the teams\' '
                'previous game is unknown. The live read waits for both previous games to be final; the live record is what confirms it.',
                'The book changes mid-sample (Pinnacle to Feb 2018, bet365 after).',
                'Truth is the nflverse consensus close (as in the research). Spreads stay UNPROVEN: negative in most seasons.'],
    'rules_tried': NR,
    'total': {'strict_2017_22': {t: pick(L_V1, 'total', f'pred move >= {t}') for t in ('0.75', '1.0', '1.5')},
              'shipped_2017_22': {t: pick(L_V2, 'total', f'pred move >= {t}') for t in ('0.75', '1.0', '1.5')},
              'holdout_2019_2021': {t: pick(L_HO, 'total', f'pred move >= {t}') for t in ('0.75', '1.0')},
              'sbro_2017_21': {t: pick(L_SB, 'total', f'pred move >= {t}') for t in ('0.75', '1.0')},
              'sbro_2011_13_shipped': {t: pick(L_SB2, 'total', f'pred move >= {t}') for t in ('0.75', '1.0')},
              'sensitivity_1.0': sens},
    'spread': {'strict_2017_22': {t: pick(L_V1, 'spread', f'pred move >= {t}') for t in ('0.5', '1.0')},
               'shipped_2017_22': {t: pick(L_V2, 'spread', f'pred move >= {t}') for t in ('0.5', '1.0')}},
}
out['model_evidence'] = evidence
json.dump(out, open(OUT + 'external_proof.json', 'w'), indent=1, default=float)
if os.environ.get('WRITE_MODEL') == '1':
    # only the evidence block and the note change; every coefficient stays byte-identical
    mp = '../lib/nfl-vas-model.json'; m = json.load(open(mp))
    before = {k: json.dumps(m[k]) for k in ('config', 'stage1', 'stage2', 'keydist', 'tiers', 'status', 'status_by_market')}
    m['external_evidence'] = evidence
    t1, ho = evidence['total']['strict_2017_22']['1.0'], evidence['total']['holdout_2019_2021']['1.0']
    m['notes'] = m['notes'].split(' REPLICATION')[0] + (
        f" REPLICATION (external_evidence, evidence only, no refit): on the owner's AusSportsBetting openers 2017-22, seasons the research never "
        f"had an opener for, the totals rule |pred move| >= 1.0 gave {t1['bets']} bets, CLV EV {t1['clv_ev_pct']:+.2f}%, Bonferroni p < 0.001, "
        f"positive in {t1['seasons_pos']}/6 seasons; on the designated 2019+2021 holdout {ho['clv_ev_pct']:+.2f}% (n={ho['bets']}, p = {ho['p']:.3f} raw, "
        f"{ho['bonf_p']:.2f} Bonferroni). These openers are UNTIMED (Pinnacle 2014-Feb 2018, bet365 after), so the open-timing caveat stands. Spreads: still UNPROVEN.")
    assert before == {k: json.dumps(m[k]) for k in before}
    json.dump(m, open(mp, 'w'), indent=1, default=float)
    print('wrote external_evidence ->', mp)
