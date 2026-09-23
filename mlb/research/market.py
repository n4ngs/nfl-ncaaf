"""Market lines per game from ESPN, joined to MLB gamePks. Output: data/cache/market.parquet (+ data/cache/market_report.json)

Sources (one primary OPEN/CLOSE source per game, always the same source for open and close):
  'book'  a single bettable book's own open + close (ESPN BET 2024-25, DraftKings 2026; ESPN BET 2023 has close only)
  'tr'    teamrankings timestamped line history (2019-2023): open = first line, close = last line BEFORE the
          scheduled first pitch (history keeps running for hours after first pitch), t2h = last line >= 2 h before
Also: multi-book median close (every pregame two-way book that passes the leak screen) for the market log-loss table.
Totals: open/close line + over/under prices; converted to an implied mean run total with a negative binomial whose
dispersion is fit here (so a bet at the OPEN total can be scored against the CLOSE even when the number moved).
Traps handled: '... - Live Odds' providers (in-game), books whose log loss is implausibly low (in-game updates),
a -110/-110 placeholder as the first history entry, ESPN BET 2025 open totals with only one side priced or a line far
from the close, doubleheaders (paired by start order within home/away/date).
"""
import json, math, collections, numpy as np, pandas as pd

def ip(a): return 100 / (a + 100) if a > 0 else -a / (-a + 100)
def novig(h, a, hi=1.15):
    if h is None or a is None or h == 0 or a == 0 or abs(h) < 100 or abs(a) < 100: return None
    ph, pa = ip(h), ip(a); s = ph + pa
    return ph / s if 1.0 < s < hi else None
def dec(a): return 1 + (a / 100 if a > 0 else 100 / -a)

# ---------- negative binomial total-runs model (mean mu, size R)
def nb_pmf(mu, R, kmax=40):
    p = [(R / (R + mu)) ** R]
    for k in range(kmax): p.append(p[-1] * (k + R) / (k + 1) * mu / (R + mu))
    return p
def nb_over(mu, R, line):
    """(P(over), P(push), P(under)) at a total line."""
    p = nb_pmf(mu, R); fl = math.floor(line)
    if line == fl: under = sum(p[:int(fl)]); push = p[int(fl)]
    else: under = sum(p[:int(fl) + 1]); push = 0.0
    return 1.0 - under - push, push, under
def implied_mu(line, p_over_novig, R):
    """mean such that P(over | no push) equals the no-vig over probability."""
    lo, hi = 2.0, 20.0
    for _ in range(60):
        mid = (lo + hi) / 2; o, pu, u = nb_over(mid, R, line)
        if o / (o + u) < p_over_novig: lo = mid
        else: hi = mid
    return (lo + hi) / 2

MAIN_MAX = 135      # a main total is priced near even on both sides; -280/+200 at 5.5 is an alternate line
TWO_WAY_EXCLUDE = ('Live Odds', 'consensus', 'numberfire', 'teamrankings', 'Holland Casino')

def main():
    games = pd.read_parquet('data/cache/games.parquet')
    teams = json.load(open('data/cache/teams.json'))
    E = [json.loads(l) for l in open('data/espn/games.jsonl')]
    # ---- ESPN team -> MLB id by name
    norm = lambda s: (s or '').lower().replace('.', '').replace('oakland ', '').replace('sacramento ', '').strip()
    by_name = {norm(v['name']): int(k) for k, v in teams.items()}
    by_name['cleveland indians'] = by_name['cleveland guardians']        # renamed after 2021
    miss = collections.Counter()
    def tid(name):
        t = by_name.get(norm(name))
        if t is None: miss[name] += 1
        return t
    ev = pd.DataFrame([{'id': e['id'], 'home': tid(e['homeName']), 'away': tid(e['awayName']), 'start': pd.Timestamp(e['date']),
                        'hs': e['homeScore'], 'as': e['awayScore'], 'season': e['season']} for e in E])
    print('unmatched ESPN team names:', dict(miss))
    ev['eday'] = (ev.start - pd.Timedelta(hours=10)).dt.strftime('%Y-%m-%d')      # US-local calendar day of first pitch
    g = games.copy(); g['st'] = pd.to_datetime(g.start)
    g['eday'] = (g.st - pd.Timedelta(hours=10)).dt.strftime('%Y-%m-%d')
    # pair within (home, away, day) by start order; fall back to officialDate
    ev = ev.sort_values(['home', 'away', 'eday', 'start', 'id']); ev['k'] = ev.groupby(['home', 'away', 'eday']).cumcount()
    g = g.sort_values(['home', 'away', 'eday', 'st', 'pk']); g['k'] = g.groupby(['home', 'away', 'eday']).cumcount()
    J = g.merge(ev[['id', 'home', 'away', 'eday', 'k', 'hs', 'as']].rename(columns={'hs': 'e_hs', 'as': 'e_as'}), on=['home', 'away', 'eday', 'k'], how='left')
    rest = J[J.id.isna()].drop(columns=['id', 'e_hs', 'e_as'])
    used = set(J.id.dropna())
    ev2 = ev[~ev.id.isin(used)].copy(); ev2['day'] = ev2.eday
    rest = rest.merge(ev2[['id', 'home', 'away', 'day', 'hs', 'as']].rename(columns={'hs': 'e_hs', 'as': 'e_as'}).drop_duplicates(['home', 'away', 'day']),
                      on=['home', 'away', 'day'], how='left')
    J = pd.concat([J[J.id.notna()], rest], ignore_index=True)
    ok = J.id.notna() & (J.e_hs == J.hs) & (J.e_as == J['as'])
    print('join: games', len(games), 'matched', int(J.id.notna().sum()), 'score-verified', int(ok.sum()),
          '| by season matched share', J.assign(ok=ok).groupby('season').ok.mean().round(3).to_dict())
    J = J[ok]
    E = {e['id']: e for e in E}

    # ---- per-book leak screen (log loss of each book's close vs outcome, per season)
    ll_rows = []
    for r in J.itertuples():
        e = E[r.id]
        for b in e['books'] or []:
            p = novig(b['home']['close'] if b['home']['close'] is not None else b['home']['ml'], b['away']['close'] if b['away']['close'] is not None else b['away']['ml'])
            if p is not None: ll_rows.append({'season': r.season, 'book': b['book'], 'p': p, 'y': r.y})
    LL = pd.DataFrame(ll_rows)
    LL['ll'] = -np.where(LL.y == 1, np.log(LL.p), np.log(1 - LL.p))
    tab = LL.groupby(['season', 'book']).agg(n=('ll', 'size'), logloss=('ll', 'mean')).reset_index()
    med = tab[tab.n >= 300].groupby('season').logloss.median()
    tab['suspect'] = tab.book.str.contains('Live') | (tab.logloss < tab.season.map(med) - 0.006)
    print('\nper-book close log loss (n>=300):'); print(tab[tab.n >= 300].sort_values(['season', 'logloss']).to_string(index=False))
    bad = set(map(tuple, tab.loc[tab.suspect, ['season', 'book']].values))

    # ---- NB dispersion: fit on games with a primary close total (mean from the close), grid MLE
    def primary(e, season):
        out = {}
        bk = {b['book']: b for b in e['books'] or []}
        st = pd.Timestamp(e['date'])
        mv = e.get('move') or {}
        # moneyline
        for name in ('DraftKings', 'ESPN BET'):
            b = bk.get(name)
            if b and b['home']['open'] is not None and b['home']['close'] is not None and novig(b['home']['open'], b['away']['open']) and novig(b['home']['close'], b['away']['close']):
                out.update(ml_src='book', ml_book=name, ml_oh=b['home']['open'], ml_oa=b['away']['open'], ml_ch=b['home']['close'], ml_ca=b['away']['close']); break
        if 'ml_src' not in out and mv.get('ml'):
            pts = [(pd.Timestamp(x[0]), x[1], x[2]) for x in mv['ml'] if novig(x[1], x[2])]
            if len(pts) >= 2 and pts[0][1] == -110 and pts[0][2] == -110: pts = pts[1:]
            pre = [x for x in pts if x[0] < st]
            if pre:
                t2 = [x for x in pre if x[0] <= st - pd.Timedelta(hours=2)]
                out.update(ml_src='tr', ml_book='teamrankings', ml_oh=pre[0][1], ml_oa=pre[0][2], ml_ch=pre[-1][1], ml_ca=pre[-1][2],
                           ml_open_lead_h=(st - pre[0][0]).total_seconds() / 3600, ml_n_moves=len(pre))
                if t2: out.update(ml_t2h=t2[-1][1], ml_t2a=t2[-1][2])
        # totals
        for name in ('DraftKings', 'ESPN BET'):
            b = bk.get(name)
            if not b: continue
            o, c = b.get('tot_open') or {}, b.get('tot_close') or {}
            if all(x.get(k) is not None for x in (o, c) for k in ('line', 'over', 'under')) and 5 <= o['line'] <= 14 and 5 <= c['line'] <= 14 \
               and abs(o['line'] - c['line']) <= 2.0 and novig(o['over'], o['under']) and novig(c['over'], c['under']) \
               and max(abs(o['over']), abs(o['under']), abs(c['over']), abs(c['under'])) <= MAIN_MAX:   # main line only (ESPN BET opens include alt lines)
                out.update(tot_src='book', tot_ol=o['line'], tot_oo=o['over'], tot_ou=o['under'], tot_cl=c['line'], tot_co=c['over'], tot_cu=c['under']); break
        if 'tot_src' not in out and mv.get('tot'):
            pts = [(pd.Timestamp(x[0]), x[1], x[2], x[3]) for x in mv['tot'] if x[1] and 5 <= x[1] <= 14 and novig(x[2], x[3])]
            pre = [x for x in pts if x[0] < st]
            if pre:
                t2 = [x for x in pre if x[0] <= st - pd.Timedelta(hours=2)]
                out.update(tot_src='tr', tot_ol=pre[0][1], tot_oo=pre[0][2], tot_ou=pre[0][3], tot_cl=pre[-1][1], tot_co=pre[-1][2], tot_cu=pre[-1][3])
                if t2: out.update(tot_t2l=t2[-1][1], tot_t2o=t2[-1][2], tot_t2u=t2[-1][3])
        # multi-book median close
        cl, tl = [], []
        for b in e['books'] or []:
            if (season, b['book']) in bad or any(x in b['book'] for x in TWO_WAY_EXCLUDE): continue
            p = novig(b['home']['close'] if b['home']['close'] is not None else b['home']['ml'], b['away']['close'] if b['away']['close'] is not None else b['away']['ml'])
            if p is not None: cl.append(p)
        if cl: out.update(p_close_med=float(np.median(cl)), n_books=len(cl))
        return out
    M = pd.DataFrame([{'pk': r.pk, 'season': r.season, 'y': r.y, 'total': r.total, **primary(E[r.id], r.season)} for r in J.itertuples()])
    M['p_open'] = [novig(h, a) if h == h else np.nan for h, a in zip(M.ml_oh, M.ml_oa)]
    M['p_close'] = [novig(h, a) if h == h else np.nan for h, a in zip(M.ml_ch, M.ml_ca)]
    if 'ml_t2h' in M: M['p_t2h'] = [novig(h, a) if h == h else np.nan for h, a in zip(M.ml_t2h, M.ml_t2a)]
    M['po_open'] = [novig(o, u) if o == o else np.nan for o, u in zip(M.tot_oo, M.tot_ou)]
    M['po_close'] = [novig(o, u) if o == o else np.nan for o, u in zip(M.tot_co, M.tot_cu)]
    if 'tot_t2o' in M: M['po_t2h'] = [novig(o, u) if o == o else np.nan for o, u in zip(M.tot_t2o, M.tot_t2u)]
    # dispersion fit (seasons <= 2023 only, so it is not tuned on the holdout)
    fit = M[M.po_close.notna() & (M.season <= 2023)]
    best = None
    for R in (4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30):
        ll = 0.0
        for r in fit.itertuples():
            mu = implied_mu(r.tot_cl, r.po_close, R); p = nb_pmf(mu, R, 60); k = int(min(r.total, 60)); ll += math.log(max(p[k], 1e-12))
        print(f'NB size {R:3d}: mean log-lik {ll / len(fit):.4f}', flush=True)
        if best is None or ll > best[1]: best = (R, ll)
    R = best[0]; print('NB size chosen', R)
    M['mu_open'] = [implied_mu(l, p, R) if p == p else np.nan for l, p in zip(M.tot_ol, M.po_open)]
    M['mu_close'] = [implied_mu(l, p, R) if p == p else np.nan for l, p in zip(M.tot_cl, M.po_close)]
    if 'po_t2h' in M: M['mu_t2h'] = [implied_mu(l, p, R) if p == p else np.nan for l, p in zip(M.tot_t2l, M.po_t2h)]
    M.to_parquet('data/cache/market.parquet')
    ll = lambda p, y: float(-np.mean(np.where(y == 1, np.log(p), np.log(1 - p))))
    rep = {'nb_size': R, 'coverage': {}}
    for S, d in M.groupby('season'):
        c = {'games': int(len(d)), 'ml_open_close': int(d.p_open.notna().sum()), 'ml_src': d.ml_src.value_counts().to_dict(),
             'tot_open_close': int(d.mu_open.notna().sum()), 'tot_src': d.tot_src.value_counts().to_dict()}
        for col in ('p_open', 'p_close', 'p_close_med'):
            m = d[col].notna()
            if m.sum(): c[f'logloss_{col}'] = round(ll(d.loc[m, col], d.y[m]), 5)
        m = d.mu_open.notna()
        if m.sum(): c['tot_mae_open'] = round(float((d.mu_open[m] - d.total[m]).abs().mean()), 3); c['tot_mae_close'] = round(float((d.mu_close[m] - d.total[m]).abs().mean()), 3)
        rep['coverage'][int(S)] = c; print(S, c)
    json.dump(rep, open('data/cache/market_report.json', 'w'), indent=1, default=str)
if __name__ == '__main__': main()
