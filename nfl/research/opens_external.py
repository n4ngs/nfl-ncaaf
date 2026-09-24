"""External NFL opening lines (the owner's own files): one row per game with real open/close lines, reconciled to nflverse.

Sources (git-ignored, put them in data/external/, or point EXT_DIR at them):
  AusSB  nfl.xlsx           AusSportsBetting export, 2006-2025. Open, min, max and close with DECIMAL juice from 2014
                            on (converted to American here). Before 2014 only one line is stored (in the Open columns),
                            so it is NOT an opener and is not used as one. The book is Pinnacle 2014 to Feb 2018 and
                            bet365 after that. Openers are UNTIMED: the export does not say when the open was posted.
  SBRO   nfl_archive_10Y.json  SportsbookReviewsOnline-format archive, 2011-21. Lines only (no juice, priced at -110),
                            no timestamps. Secondary cross-check only.
Every spread in the output is nflverse style: home-favoured-positive (home covers if result > line).
Rows whose close disagrees with the nflverse close by > 1.5 pts, whose favourite flips at >= 2.5, whose line moves > 6
(spread) / > 8 (total), or whose numbers are garbage are flagged and excluded via {src}_clean_spread / _clean_total.

Output: data/cache/nfl_open_close_clean.csv (OUT_DIR to redirect). About 1.2 MB, so it is not committed.
Used by external_proof.py. Nothing here is fed to the shipped model's fit.
"""
import json, os, numpy as np, pandas as pd

EXT = os.environ.get('EXT_DIR', 'data/external').rstrip('/') + '/'
OUT = os.environ.get('OUT_DIR', 'data/cache').rstrip('/') + '/'
TOL = 1.5

def dec2am(d):
    """decimal odds -> American (2.00 -> +100, 1.909 -> -110); NaN stays NaN"""
    d = np.asarray(d, float)
    with np.errstate(divide='ignore', invalid='ignore'):
        return np.where(d >= 2, (d - 1) * 100, -100 / (d - 1))

NM = {'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL', 'Buffalo Bills': 'BUF', 'Carolina Panthers': 'CAR', 'Chicago Bears': 'CHI',
      'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE', 'Dallas Cowboys': 'DAL', 'Denver Broncos': 'DEN', 'Detroit Lions': 'DET', 'Green Bay Packers': 'GB',
      'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAX', 'Kansas City Chiefs': 'KC', 'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC',
      'Los Angeles Rams': 'LA', 'Miami Dolphins': 'MIA', 'Minnesota Vikings': 'MIN', 'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG',
      'New York Jets': 'NYJ', 'Oakland Raiders': 'OAK', 'Philadelphia Eagles': 'PHI', 'Pittsburgh Steelers': 'PIT', 'San Diego Chargers': 'SD', 'San Francisco 49ers': 'SF',
      'Seattle Seahawks': 'SEA', 'St. Louis Rams': 'STL', 'Tampa Bay Buccaneers': 'TB', 'Tennessee Titans': 'TEN', 'Washington Commanders': 'WAS',
      'Washington Football Team': 'WAS', 'Washington Redskins': 'WAS'}

def games():
    G = pd.read_parquet('data/cache/games.parquet')
    G = G[G.season.between(2011, 2025) & G.played].copy(); G['date'] = pd.to_datetime(G.gameday)
    return G

def date_keys(G, a, b):
    """(date +-1 day, a, b) -> (gid, swapped); swapped = the source's home is nflverse's away (neutral sites)"""
    k = {}
    for r in G.itertuples():
        for dd in (-1, 0, 1):
            d = r.date + pd.Timedelta(days=dd)
            k.setdefault((d, getattr(r, a), getattr(r, b)), []).append((r.gid, False))
            k.setdefault((d, getattr(r, b), getattr(r, a)), []).append((r.gid, True))
    return k

def load_aussb(G, path=None):
    """AusSB opener source: open_src='AusSB', lines nflverse-style, juice in decimal AND American."""
    x = pd.read_excel(path or EXT + 'nfl.xlsx')
    x['date'] = pd.to_datetime(x.Date); x['h'] = x['Home Team'].map(NM); x['a'] = x['Away Team'].map(NM)
    gk = {k: list(dict.fromkeys(v)) for k, v in date_keys(G, 'home', 'away').items()}
    rows, unm = [], 0
    for _, r in x.iterrows():
        m = gk.get((r.date, r.h, r.a), [])
        if len(m) != 1: unm += 1; continue
        gid, sw = m[0]; s = -1 if sw else 1
        has_open = (r.date.year - (r.date.month < 6)) >= 2014           # before 2014 the one stored line is not an opener
        H, A = ('Away', 'Home') if sw else ('Home', 'Away')
        rows.append({'gid': gid, 'aus_swapped': sw,
                     'aus_open_spread': -s * r['Home Line Open'] if has_open else np.nan,
                     'aus_close_spread': -s * (r['Home Line Close'] if has_open else r['Home Line Open']),
                     'aus_open_hso_dec': r[f'{H} Line Odds Open'] if has_open else np.nan, 'aus_open_aso_dec': r[f'{A} Line Odds Open'] if has_open else np.nan,
                     'aus_close_hso_dec': r[f'{H} Line Odds Close'] if has_open else np.nan, 'aus_close_aso_dec': r[f'{A} Line Odds Close'] if has_open else np.nan,
                     'aus_open_total': r['Total Score Open'] if has_open else np.nan,
                     'aus_close_total': r['Total Score Close'] if has_open else r['Total Score Open'],
                     'aus_open_over_dec': r['Total Score Over Open'] if has_open else np.nan, 'aus_open_under_dec': r['Total Score Under Open'] if has_open else np.nan,
                     'aus_open_hml_dec': r[f'{H} Odds Open'], 'aus_open_aml_dec': r[f'{A} Odds Open'],
                     'aus_close_hml_dec': r[f'{H} Odds Close'], 'aus_close_aml_dec': r[f'{A} Odds Close']})
    A_ = pd.DataFrame(rows); A_ = A_[~A_.gid.duplicated(keep=False)].copy()
    for k in ('open_hso', 'open_aso', 'open_over', 'open_under', 'close_hso', 'close_aso'):
        if f'aus_{k}_dec' in A_: A_[f'aus_{k}'] = dec2am(A_[f'aus_{k}_dec'])
    A_['aus_open_src'] = np.where(A_.aus_open_spread.notna(), 'AusSB', None)
    print(f'AusSB: {len(x)} rows, {len(A_)} matched 1:1 to nflverse, {unm} unmatched/ambiguous')
    return A_

def load_sbro(G, path=None):
    """SBRO archive (secondary): lines only, matched by date +-1 and final score."""
    j = pd.DataFrame(json.load(open(path or EXT + 'nfl_archive_10Y.json')))
    j['date'] = pd.to_datetime(j.date.astype(int).astype(str), format='%Y%m%d')
    for c in ['home_final', 'away_final', 'home_open_spread', 'home_close_spread', 'open_over_under', 'close_over_under', 'home_close_ml', 'away_close_ml']:
        j[c] = pd.to_numeric(j[c], errors='coerce')
    G = G.assign(hs=G.home_score.astype(int), as_=G.away_score.astype(int))
    key = {k: list(dict.fromkeys(v)) for k, v in date_keys(G, 'hs', 'as_').items()}
    rows, unm = [], 0
    for r in j.itertuples():
        if r.home_final != r.home_final or r.away_final != r.away_final: unm += 1; continue
        c = key.get((r.date, int(r.home_final), int(r.away_final)), [])
        if len(c) != 1: unm += 1; continue
        gid, sw = c[0]; s = -1 if sw else 1
        rows.append({'gid': gid, 'sbro_swapped': sw, 'sbro_open_spread': -s * r.home_open_spread, 'sbro_close_spread': -s * r.home_close_spread,
                     'sbro_open_total': r.open_over_under, 'sbro_close_total': r.close_over_under,
                     'sbro_close_hml': r.away_close_ml if sw else r.home_close_ml, 'sbro_close_aml': r.home_close_ml if sw else r.away_close_ml})
    S = pd.DataFrame(rows); S = S[~S.gid.duplicated(keep=False)].copy()
    print(f'SBRO: {len(j)} rows, {len(S)} matched 1:1, {unm} unmatched/ambiguous')
    return S

def flag(O, src):
    os_, cs, ot, ct = (O[f'{src}_{k}'] for k in ('open_spread', 'close_spread', 'open_total', 'close_total'))
    O[f'{src}_flag_close_spread_off'] = (cs - O.nv_close_spread).abs() > TOL
    O[f'{src}_flag_close_total_off'] = (ct - O.nv_close_total).abs() > TOL
    O[f'{src}_flag_fav_flip'] = (np.sign(os_) * np.sign(cs) < 0) & (os_.abs() >= 2.5) & (cs.abs() >= 2.5)
    O[f'{src}_flag_big_spread_move'] = (cs - os_).abs() > 6
    O[f'{src}_flag_big_total_move'] = (ct - ot).abs() > 8
    O[f'{src}_flag_garbage'] = (os_.abs() > 30) | (cs.abs() > 30) | (ot < 25) | (ct < 25) | (ot > 70) | (ct > 70)
    O[f'{src}_clean_spread'] = os_.notna() & cs.notna() & ~O[f'{src}_flag_close_spread_off'] & ~O[f'{src}_flag_fav_flip'] & ~O[f'{src}_flag_big_spread_move'] & ~((os_.abs() > 30) | (cs.abs() > 30))
    O[f'{src}_clean_total'] = ot.notna() & ct.notna() & ~O[f'{src}_flag_close_total_off'] & ~O[f'{src}_flag_big_total_move'] & ~((ot < 25) | (ct < 25) | (ot > 70) | (ct > 70))

def build():
    G = games()
    O = G[['gid', 'season', 'week', 'game_type', 'gameday', 'home', 'away', 'home_score', 'away_score', 'result', 'total', 'spread_line', 'home_spread_odds',
           'away_spread_odds', 'total_line', 'over_odds', 'under_odds', 'home_moneyline', 'away_moneyline']].rename(columns={
        'spread_line': 'nv_close_spread', 'total_line': 'nv_close_total', 'home_spread_odds': 'nv_hso', 'away_spread_odds': 'nv_aso', 'over_odds': 'nv_over',
        'under_odds': 'nv_under', 'home_moneyline': 'nv_hml', 'away_moneyline': 'nv_aml', 'result': 'home_margin', 'total': 'total_points'})
    O = O.merge(load_sbro(G), on='gid', how='left').merge(load_aussb(G), on='gid', how='left')
    for src in ('sbro', 'aus'): flag(O, src)
    O['open_spread_src_diff'] = (O.aus_open_spread - O.sbro_open_spread).abs()      # two independent sources agreeing on the open
    O['open_total_src_diff'] = (O.aus_open_total - O.sbro_open_total).abs()
    return O.sort_values(['season', 'gameday', 'gid'])

if __name__ == '__main__':
    O = build()
    os.makedirs(OUT, exist_ok=True); O.to_csv(OUT + 'nfl_open_close_clean.csv', index=False)
    t = O.groupby('season').agg(games=('gid', 'size'), aus_open=('aus_open_spread', 'count'), aus_clean_s=('aus_clean_spread', 'sum'),
                                aus_clean_t=('aus_clean_total', 'sum'), sbro_open=('sbro_open_spread', 'count'), sbro_clean_t=('sbro_clean_total', 'sum'))
    print(t.to_string()); print('->', OUT + 'nfl_open_close_clean.csv', len(O), 'rows')
