"""Market table: consensus open / close lines per game + the price a bettor could actually take at the OPEN.

Books: sportsdataverse line file (data/cache/books_sdv.parquet, from build_games.py) + ESPN core odds
(data/espn/odds.jsonl, from fetch_espn.py). Excluded: model/consensus feeds that are not books (numberfire,
teamrankings, accuscore, consensus, SportsInsights, 'Opening' pseudo-book) and every "... Live Odds" provider
(in-game prices). Every remaining book's CLOSE is scored against the result (leak check) before it is used.

Spread probability model (stated choice): the final margin M (home - away) is an integer; given the market close we
model M ~ discretized Normal(mu, SD) with SD estimated on training seasons (printed) and mu = -close_home_spread
shifted by the close juice (median over books of SD * Phi^-1(no-vig home-cover prob)). A bet on home at line L wins
if M + L > 0, pushes if M + L == 0. Totals: same with the total points, mu = close total (+ juice shift).
"""
import json, numpy as np, pandas as pd, warnings
from scipy import stats
warnings.filterwarnings('ignore')
NOT_BOOKS = {'numberfire', 'teamrankings', 'accuscore', 'consensus', 'SportsInsights', 'Opening'}
G = pd.read_parquet('data/cache/games.parquet')
SDV = pd.read_parquet('data/cache/books_sdv.parquet').rename(columns={'game_id': 'gid'})
SDV = SDV[~SDV.book.isin(NOT_BOOKS)]

# ------------------------------------------------------------------ ESPN books
rows = []
for line in open('data/espn/odds.jsonl'):
    e = json.loads(line)
    for b in e['books'] or []:
        nm = b['book']
        if nm in NOT_BOOKS: continue
        h, a = b['home'], b['away']
        r = {'gid': e['id'], 'book': 'espn:' + nm, 'h_close': b['spread'], 'h_close_odds': h['spOdds'], 'a_close_odds': a['spOdds'],
             't_close': b['overUnder'], 'o_close_odds': b['overOdds'], 'u_close_odds': b['underOdds'], 'h_ml': h['ml'], 'a_ml': a['ml'],
             'h_open': h['open']['pts'] if h['open']['pts'] is not None else b.get('initialSpread'),
             'h_open_odds': h['open']['sp'], 'a_open_odds': a['open']['sp'],
             't_open': b['tot']['open']['total'] if b['tot']['open']['total'] is not None else b.get('initialOverUnder'),
             'o_open_odds': b['tot']['open']['over'], 'u_open_odds': b['tot']['open']['under'], 'live': 'Live' in nm}
        rows.append(r)
ES = pd.DataFrame(rows)
# ESPN trap: in some 2022-23 rows close.pointSpread holds the juice (e.g. "+110"), so the top-level `spread` is used for the
# close; open points come from open.pointSpread (checked below against the close: |open - close| <= 14).
ES.loc[(ES.h_open - ES.h_close).abs() > 14, 'h_open'] = np.nan
ES.loc[(ES.t_open - ES.t_close).abs() > 20, 't_open'] = np.nan
print('ESPN rows', len(ES), 'games', ES.gid.nunique(), 'live-odds rows', int(ES.live.sum()))
B = pd.concat([SDV.assign(live=False), ES], ignore_index=True)
# same sanity rule for every source: an 'open' more than 14 pts (spread) / 20 pts (total) from that book's own close is a data error
B.loc[(B.h_open - B.h_close).abs() > 14, 'h_open'] = np.nan
B.loc[(B.t_open - B.t_close).abs() > 20, 't_open'] = np.nan
B = B.merge(G[['gid', 'season', 'home_pts', 'away_pts', 'tier']], on='gid', how='inner')
B['margin'] = B.home_pts - B.away_pts; B['total'] = B.home_pts + B.away_pts

# ------------------------------------------------------------------ leak check: every book's close vs the result
def novig(h, a):
    ph = np.where(h > 0, 100 / (h + 100), -h / (-h + 100)); pa = np.where(a > 0, 100 / (a + 100), -a / (-a + 100)); s = ph + pa
    return np.where((s > 1.0) & (s < 1.15), ph / s, np.nan)
B['p_ml'] = novig(B.h_ml.astype(float), B.a_ml.astype(float))
B['homewin'] = (B.margin > 0).astype(float)
lk = []
for bk, d in B.groupby('book'):
    if len(d) < 150: continue
    x = d.dropna(subset=['h_close'])
    p = d.dropna(subset=['p_ml']); p = p[p.margin != 0]
    ll = float(-np.mean(p.homewin * np.log(p.p_ml.clip(1e-4, 1 - 1e-4)) + (1 - p.homewin) * np.log(1 - p.p_ml.clip(1e-4, 1 - 1e-4)))) if len(p) > 100 else np.nan
    lk.append({'book': bk, 'n': len(x), 'spread_mae': round(float((x.margin + x.h_close).abs().mean()), 2), 'ml_n': len(p), 'ml_logloss': round(ll, 4), 'seasons': f'{d.season.min()}-{d.season.max()}'})
lk = pd.DataFrame(lk).sort_values('spread_mae'); print(lk.to_string(index=False))
leak = set(lk[(lk.spread_mae < 10.0) | (lk.ml_logloss < 0.40)].book) | set(B[B.live].book.unique())
print('EXCLUDED as leaking / in-game:', sorted(leak))
B = B[~B.book.isin(leak)]
json.dump(lk.to_dict('records'), open('data/cache/book_leak_check.json', 'w'), indent=1)

# ------------------------------------------------------------------ consensus per game
dec = lambda am: np.where(am > 0, 1 + am / 100, 1 + 100 / -am)
M = []
OPEN_PRIORITY = ['espn:ESPN BET', '5Dimes & sportbet', 'Bovada', 'DraftKings', 'ESPN Bet', 'espn:5Dimes.eu', 'espn:BOVADA.lv', 'espn:Westgate', 'espn:BETONLINE.ag']
for gid, d in B.groupby('gid'):
    r = {'gid': gid}
    c = d.dropna(subset=['h_close'])
    if len(c):
        r['close'] = float(np.median(c.h_close)); r['n_close'] = int(len(c))
        j = c.dropna(subset=['h_close_odds', 'a_close_odds']); j = j[(j.h_close_odds.abs() >= 100) & (j.a_close_odds.abs() >= 100)]
        pj = novig(j.h_close_odds.values.astype(float), j.a_close_odds.values.astype(float))
        r['close_pnv'] = float(np.nanmedian(pj)) if np.isfinite(pj).any() else 0.5
    t = d.dropna(subset=['t_close'])
    if len(t):
        r['tclose'] = float(np.median(t.t_close))
        j = t.dropna(subset=['o_close_odds', 'u_close_odds']); j = j[(j.o_close_odds.abs() >= 100) & (j.u_close_odds.abs() >= 100)]
        pj = novig(j.o_close_odds.values.astype(float), j.u_close_odds.values.astype(float))
        r['tclose_pnv'] = float(np.nanmedian(pj)) if np.isfinite(pj).any() else 0.5
    m = d.dropna(subset=['p_ml'])
    if len(m): r['ml_close'] = float(np.median(m.p_ml))
    o = d.dropna(subset=['h_open'])
    if len(o):
        r['open'] = float(np.median(o.h_open)); r['n_open'] = int(len(o))
        for bk in OPEN_PRIORITY + sorted(set(o.book) - set(OPEN_PRIORITY)):
            x = o[o.book == bk]
            if len(x):
                x = x.iloc[0]; real = pd.notna(x.h_open_odds) and pd.notna(x.a_open_odds) and abs(x.h_open_odds) >= 100 and abs(x.a_open_odds) >= 100
                r.update(bet_book=bk, bet_line=float(x.h_open), bet_h_odds=float(x.h_open_odds) if real else -110.0,
                         bet_a_odds=float(x.a_open_odds) if real else -110.0, bet_real_juice=int(real)); break
    o = d.dropna(subset=['t_open'])
    if len(o):
        r['topen'] = float(np.median(o.t_open))
        for bk in OPEN_PRIORITY + sorted(set(o.book) - set(OPEN_PRIORITY)):
            x = o[o.book == bk]
            if len(x):
                x = x.iloc[0]; real = pd.notna(x.o_open_odds) and pd.notna(x.u_open_odds) and abs(x.o_open_odds) >= 100 and abs(x.u_open_odds) >= 100
                r.update(tbet_book=bk, tbet_line=float(x.t_open), tbet_o_odds=float(x.o_open_odds) if real else -110.0,
                         tbet_u_odds=float(x.u_open_odds) if real else -110.0, tbet_real_juice=int(real)); break
    M.append(r)
M = pd.DataFrame(M)
F = G[['gid', 'season', 'tier', 'home_pts', 'away_pts']].merge(M, on='gid', how='left')
F['margin'] = F.home_pts - F.away_pts; F['total'] = F.home_pts + F.away_pts
cov = F[F.season <= 2025].groupby('season').agg(games=('gid', 'size'), close=('close', lambda s: round(s.notna().mean(), 3)), open=('open', lambda s: round(s.notna().mean(), 3)),
                                               topen=('topen', lambda s: round(s.notna().mean(), 3)), real_juice=('bet_real_juice', lambda s: round((s == 1).mean(), 3)))
print(cov.to_string())
print('open bet book by season:\n', F.groupby(['season', 'bet_book']).size().unstack(0).fillna(0).astype(int).to_string())
F.drop(columns=['home_pts', 'away_pts', 'margin', 'total', 'season', 'tier']).to_parquet('data/cache/market.parquet')
x = F.dropna(subset=['close'])
print('SD of (margin + close spread) by season:', x.groupby('season').apply(lambda d: round(float((d.margin + d.close).std()), 2)).to_dict())
x = F.dropna(subset=['tclose'])
print('SD of (total - close total) by season:', x.groupby('season').apply(lambda d: round(float((d.total - d.tclose).std()), 2)).to_dict())
x = F.dropna(subset=['close', 'open'])
print('mean |open - close| spread by season:', x.groupby('season').apply(lambda d: round(float((d.open - d.close).abs().mean()), 2)).to_dict())
