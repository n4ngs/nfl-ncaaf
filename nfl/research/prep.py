"""Raw downloads -> compact cached tables in data/cache.

games.parquet    one row per game 2006..2026 (all game types), scores, rest, roof, QB ids, nflverse CLOSING lines
plays.parquet    compact play rows from nflverse pbp (offense/defense, EPA, success, dropback, passer, special teams)
market.parquet   OPEN lines from ESPN (spread / total / moneyline with the book's own juice) + CLOSE from nflverse
snaps.parquet    per player-game snap counts with gsis ids (2012+)
injuries.parquet final weekly injury-report designations (2009+)
books.json       per-book sanity scores (catches in-game "Live Odds" leaks)
Team-name trap: nflverse uses LA / LAC / LV / WAS etc. consistently across seasons (relocations already mapped); ESPN
rows are joined through the nflverse game_id <-> espn event id column, never by team name.
"""
import json, os, glob, numpy as np, pandas as pd
from common import novig2
os.makedirs('data/cache', exist_ok=True)

# ---------------------------------------------------------------- games + closing lines (nflverse)
g = pd.read_csv('data/raw/games.csv')
g = g[g.season >= 2006].copy()
keep = ['game_id', 'season', 'game_type', 'week', 'gameday', 'weekday', 'gametime', 'away_team', 'away_score', 'home_team', 'home_score',
        'location', 'result', 'total', 'overtime', 'espn', 'away_rest', 'home_rest', 'away_moneyline', 'home_moneyline', 'spread_line',
        'away_spread_odds', 'home_spread_odds', 'total_line', 'under_odds', 'over_odds', 'div_game', 'roof', 'surface', 'temp', 'wind',
        'away_qb_id', 'home_qb_id', 'away_qb_name', 'home_qb_name']
g = g[keep].rename(columns={'game_id': 'gid', 'home_team': 'home', 'away_team': 'away'})
g['played'] = g.home_score.notna()
g = g.sort_values(['gameday', 'gametime', 'gid']).reset_index(drop=True)
g.to_parquet('data/cache/games.parquet')
print('games', len(g), 'played', int(g.played.sum()), g.groupby('season').size().to_dict())

# ---------------------------------------------------------------- plays (pbp)
PC = ['game_id', 'season', 'week', 'posteam', 'defteam', 'home_team', 'play_type', 'epa', 'success', 'qb_dropback', 'rush', 'pass', 'special',
      'qb_kneel', 'qb_spike', 'passer_id', 'wp', 'weather', 'aborted_play', 'play_deleted']
parts = []
for f in sorted(glob.glob('data/nflverse/play_by_play_*.parquet')):
    y = int(f[-12:-8])
    if y < 2006: continue
    p = pd.read_parquet(f, columns=[c for c in PC if c != 'play_deleted' or y >= 2006])
    parts.append(p)
P = pd.concat(parts, ignore_index=True)
wx = P.groupby('game_id').weather.agg(lambda s: s.dropna().iloc[0] if s.notna().any() else None)
P = P[P.epa.notna() & P.posteam.notna() & P.defteam.notna()]
if 'play_deleted' in P: P = P[P.play_deleted.fillna(0) != 1]
scrim = (P.play_type.isin(['pass', 'run']) | (P.qb_dropback == 1)) & (P.qb_kneel.fillna(0) != 1) & (P.qb_spike.fillna(0) != 1) & (P.special.fillna(0) != 1)
st = (P.special.fillna(0) == 1) & P.play_type.isin(['kickoff', 'punt', 'field_goal', 'extra_point'])
P = P[scrim | st].copy()
P['kind'] = np.where(st.loc[P.index], 's', np.where(P.qb_dropback.fillna(0) == 1, 'p', 'r'))
plays = pd.DataFrame({'gid': P.game_id.values, 'off': P.posteam.values, 'def': P.defteam.values, 'kind': P.kind.values,
                      'epa': P.epa.astype(float).values, 'succ': P.success.fillna(0).astype(int).values,
                      'passer': P.passer_id.fillna('').values, 'wp': P.wp.astype(float).values})
plays = plays.sort_values(['gid'], kind='mergesort').reset_index(drop=True)
plays.to_parquet('data/cache/plays.parquet')
wxs = wx.fillna('').str.lower()
W = pd.DataFrame({'gid': wx.index, 'weather': wx.values, 'precip': wxs.str.contains(r'rain|snow|shower|drizzle|sleet|flurr|storm').astype(int).values})
W.to_parquet('data/cache/weather.parquet')
print('plays', len(plays), plays.kind.value_counts().to_dict(), 'games with plays', plays.gid.nunique())

# ---------------------------------------------------------------- market: OPEN (ESPN) + CLOSE (nflverse)
def f(x): return None if x is None or x != x else float(x)
book_rows, M = [], []
gi = g.set_index('gid')
for line in open('data/espn/odds.jsonl'):
    e = json.loads(line); gid = e['game_id']
    if gid not in gi.index: continue
    x = gi.loc[gid]; B = {b['book']: b for b in e['books']}
    r = {'gid': gid}
    for b in e['books']:                                              # per-book sanity (leak detector)
        if b['spread'] is not None and x.played:
            book_rows.append({'season': int(x.season), 'book': b['book'], 'err': abs(float(x.result) - (-b['spread'])),
                              'terr': abs(float(x.total) - b['total']) if b['total'] is not None else np.nan})
    op = B.get('Opening')
    if op is not None and op['spread'] is not None:                   # 2012-2017 offshore opener (== initialSpread on every book)
        r.update(open_src='Opening', open_spread=-op['spread'], open_hso=op['home']['spread_odds'], open_aso=op['away']['spread_odds'],
                 open_total=op['total'], open_over=op['over_odds'], open_under=op['under_odds'], open_hml=op['home']['ml'], open_aml=op['away']['ml'])
        if op['initial_spread'] is not None and op['initial_spread'] != op['spread']: r['open_flag'] = 'opening!=initial'
    else:
        for name in ('ESPN BET', 'Draft Kings', 'DraftKings', 'MGM'):  # book-level open blocks (2023+); never a "Live Odds" provider
            b = B.get(name)
            if not b or not b['home']['open'] or b['home']['open'].get('pointSpread') is None: continue
            ho, ao, to = b['home']['open'], b['away']['open'], b['tot_open'] or {}
            r.update(open_src=name, open_spread=-ho['pointSpread'], open_hso=ho.get('spread'), open_aso=ao.get('spread'),
                     open_total=to.get('total'), open_over=to.get('over'), open_under=to.get('under'), open_hml=ho.get('moneyLine'), open_aml=ao.get('moneyLine'))
            hc, ac, tc = b['home']['close'] or {}, b['away']['close'] or {}, b['tot_close'] or {}
            if int(x.season) >= 2024 and hc.get('pointSpread') is not None:   # ESPN's 2022-23 'close' blocks are corrupt
                r.update(bclose_spread=-hc['pointSpread'], bclose_hso=hc.get('spread'), bclose_aso=ac.get('spread'),
                         bclose_total=tc.get('total'), bclose_over=tc.get('over'), bclose_under=tc.get('under'))
            break
    M.append(r)
M = pd.DataFrame(M)
M = g[['gid', 'season', 'week', 'game_type', 'played', 'result', 'total', 'spread_line', 'home_spread_odds', 'away_spread_odds', 'total_line',
       'over_odds', 'under_odds', 'home_moneyline', 'away_moneyline']].merge(M, on='gid', how='left')
M = M.rename(columns={'spread_line': 'close_spread', 'home_spread_odds': 'close_hso', 'away_spread_odds': 'close_aso', 'total_line': 'close_total',
                      'over_odds': 'close_over', 'under_odds': 'close_under', 'home_moneyline': 'close_hml', 'away_moneyline': 'close_aml'})
# an open juice outside a sane 2-way market is dropped (the game keeps its line, the price becomes -110/-110, flagged)
for a, b in (('open_hso', 'open_aso'), ('open_over', 'open_under')):
    bad = M.apply(lambda r: r[a] is None or r[a] != r[a] or novig2(r[a], r[b]) is None, axis=1) & M[a.replace('hso', 'spread').replace('over', 'total')].notna()
    M.loc[bad, a] = -110.0; M.loc[bad, b] = -110.0; M.loc[bad, 'juice_imputed_' + a] = 1
M.to_parquet('data/cache/market.parquet')
cov = M[M.played].groupby('season').agg(games=('gid', 'size'), open_spread=('open_spread', 'count'), open_total=('open_total', 'count'),
                                          close_spread=('close_spread', 'count'), src=('open_src', lambda s: ','.join(sorted(set(s.dropna())))))
print(cov.to_string())
Bk = pd.DataFrame(book_rows).groupby(['season', 'book']).agg(n=('err', 'size'), spread_mae=('err', 'mean'), total_mae=('terr', 'mean')).reset_index()
json.dump(Bk.to_dict('records'), open('data/cache/books.json', 'w'), indent=0)
print('\nbook sanity (spread MAE vs margin; pregame books ~9-10.5 depending on season, in-game captures far lower):')
print(Bk[Bk.n >= 50].groupby('book').agg(seasons=('season', 'nunique'), n=('n', 'sum'), spread_mae=('spread_mae', 'mean'), total_mae=('total_mae', 'mean')).round(2).sort_values('spread_mae').to_string())

# ---------------------------------------------------------------- snaps + injuries (personnel)
pl = pd.read_parquet('data/nflverse/players.parquet', columns=['gsis_id', 'pfr_id', 'position'])
pmap = pl.dropna(subset=['pfr_id', 'gsis_id']).drop_duplicates('pfr_id').set_index('pfr_id').gsis_id
S = pd.concat([pd.read_parquet(f) for f in sorted(glob.glob('data/nflverse/snap_counts_*.parquet'))], ignore_index=True)
S['gsis'] = S.pfr_player_id.map(pmap)
S = S.rename(columns={'game_id': 'gid'})[['gid', 'season', 'week', 'team', 'pfr_player_id', 'gsis', 'player', 'position', 'offense_snaps', 'offense_pct', 'defense_snaps', 'defense_pct', 'st_snaps']]
S.to_parquet('data/cache/snaps.parquet')
print('\nsnaps', len(S), 'gsis mapped %.3f' % S.gsis.notna().mean(), 'games', S.gid.nunique(), 'unmatched gids', len(set(S.gid) - set(g.gid)))
I = pd.concat([pd.read_parquet(f) for f in sorted(glob.glob('data/nflverse/injuries_*.parquet'))], ignore_index=True)
I = I[['season', 'game_type', 'team', 'week', 'gsis_id', 'position', 'full_name', 'report_status', 'practice_status', 'date_modified']]
I.to_parquet('data/cache/injuries.parquet')
print('injuries', len(I), I.report_status.value_counts(dropna=False).to_dict())
