"""Line shopping: best OPEN price across all two-way books vs a single book, for the full and portable models."""
import json, numpy as np, pandas as pd
from scipy import stats
TWO_WAY = ['ESPN BET', 'Draft Kings', 'MGM', 'Caesars Sportsbook (New Jersey)', 'Caesars Sportsbook (Colorado)', 'Caesars Sportsbook',
           'Caesars Sportsbook (Tennessee)', 'Caesars Sportsbook (Pennsylvania)', 'PointsBet', 'SugarHouse', 'BetfairSportsbook', 'Westgate']
TEAM = {'NJ': 'NJD', 'TB': 'TBL', 'LA': 'LAK', 'SJ': 'SJS', 'UTAH': 'UTA', 'MON': 'MTL', 'NAS': 'NSH'}
dec = lambda a: 1 + (a / 100 if a > 0 else 100 / -a)
rows = []
for line in open('data/espn/games.jsonl'):
    e = json.loads(line); best = {'home': None, 'away': None}; nb = 0
    for b in e.get('books') or []:
        if b['book'] not in TWO_WAY: continue
        h, a = b['home']['open'], b['away']['open']
        if h is None or a is None: continue
        ph = 1 / dec(h); pa = 1 / dec(a)
        if not 1.0 < ph + pa < 1.12: continue
        nb += 1
        for s, v in (('home', h), ('away', a)):
            if best[s] is None or dec(v) > dec(best[s]): best[s] = v
    rows.append({'home': TEAM.get(e['home'], e['home']), 'away': TEAM.get(e['away'], e['away']), 'day': e['date'][:10],
                 'best_open_h': best['home'], 'best_open_a': best['away'], 'open_books': nb})
B = pd.DataFrame(rows)
G = pd.read_parquet('data/cache/games.parquet')[['gid', 'home', 'away', 'start']]
G['day'] = pd.to_datetime(G.start).dt.strftime('%Y-%m-%d')
B = G.merge(B, on=['home', 'away', 'day'])[['gid', 'best_open_h', 'best_open_a', 'open_books']]
out = {}
for name, path, col in (('full model (proof.py)', 'data/cache/proof_preds.parquet', 'pred_move'), ('portable model', 'data/cache/portable_feats.parquet', 'pred_move')):
    P = pd.read_parquet(path)
    if 'mkt_open' not in P: P = P.merge(pd.read_parquet('data/cache/predictions.parquet')[['gid', 'mkt_open', 'mkt_close', 'bet_open_h', 'bet_open_a', 'y']], on='gid')
    P = P.merge(B, on='gid', how='left')
    H = P[P.season.isin([2024, 2025]) & P.mkt_open.notna() & P.mkt_close.notna() & P[col].notna() & P.best_open_h.notna()]
    print(f'\n{name}: median books with an open line = {H.open_books.median():.0f}')
    for thr in (0.05, 0.08, 0.10):
        s = H[H[col].abs() >= thr]; side = (s[col] > 0).values; pc = np.where(side, s.mkt_close, 1 - s.mkt_close)
        for label, hc, ac in (('one book', 'bet_open_h', 'bet_open_a'), ('BEST book', 'best_open_h', 'best_open_a')):
            po = np.where(side, s[hc], s[ac]).astype(float); ev = pc * np.array([dec(a) for a in po]) - 1
            t = stats.ttest_1samp(ev, 0, alternative='greater')
            by = {int(S): round(float(ev[(s.season == S).values].mean() * 100), 2) for S in (2024, 2025)}
            out[f'{name}|{thr}|{label}'] = {'bets': int(len(ev)), 'ev': round(float(ev.mean() * 100), 2), 't': round(float(t.statistic), 2), 'p': float(t.pvalue), 'by_season': by}
            print(f'  move >= {thr:.2f} {label:9s}: bets {len(ev):4d}  CLV EV {ev.mean()*100:+.2f}%  t={t.statistic:.2f}  p={t.pvalue:.2g}  by season {by}')
json.dump(out, open('data/cache/shop.json', 'w'), indent=1)
