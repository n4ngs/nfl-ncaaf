"""Portable, walk-forward MLB features computable in the Node app from MLB Stats API boxscores only.

Mirrored line for line by mlb/lib/vas-engine.js (parity verified by tests/mlb-vas.test.js).
State strictly before each day; all games of a day are featured first, then the day's boxscores update state.

OPEN-SAFE (known when the line opens: schedule, probable starters, completed games):
  team     exponentially weighted per game (half-life hl_team games, carry-over across seasons): wOBA-proxy offense
           (overall and vs the opposing probable starter's hand), runs for / against per game, win rate, bullpen
           (relievers') FIP-per-batter; all shrunk toward a slowly decaying league average
  starter  PROBABLE starter: shrunk FIP-per-batter and K-per-batter (decay by batters faced), outs per start,
           log batters faced (experience), rest days, pitches in last appearance, throws left
  lineup   expected lineup = the team's previous starting nine, mean shrunk batter wOBA
  sched    rest days, night game, day game after a night game
  park     venue runs-per-game ratio (shrunk)
LATE NEWS (not open-safe; tested separately):
  lu_conf  confirmed starting nine value (posted ~2-4 h before first pitch); lu_delta = confirmed - expected
  sp_chg   actual starter != probable; spc_fip actual starter's FIP
  bp_np1/bp_np3  relievers' pitches yesterday / last 3 days (a same-day open can predate yesterday's late games)
  ump      home-plate umpire runs tendency (shrunk);  wx_temp / wx_out (wind out +, in -) / wx_roof
Usage: python portable.py            -> data/cache/features.parquet
       PARITY=2025 python portable.py -> data/cache/parity/{history.json, features_py.json} (games from 2025 on)
"""
import os, json, math, pickle, datetime as dt
import pandas as pd

CFG = dict(hl_team=40.0, carry=0.5, k_pa=300.0, k_g=15.0, hl_league=4000.0, hl_pit_bf=700.0, k_sp=250.0, hl_starts=10.0,
           k_starts=3.0, k_bp=200.0, hl_bat_pa=500.0, k_bat=150.0, hl_park=400.0, k_park=100.0, hl_ump=300.0, k_ump=60.0,
           rest_cap=3, sp_rest_cap=10)
LEAGUE0 = dict(n=10.0, rf=45.0, wn=0.315 * 380, wd=380.0, bpn=0.22 * 120, bpb=120.0, spn=0.20 * 250, spb=250.0, spk=0.22 * 250, spo=160.0, sps=10.0)

def woba(b):  # numerator, denominator of a batting line
    return (0.69 * (b['bb'] - b['ibb']) + 0.72 * b['hbp'] + 0.88 * (b['h'] - b['d'] - b['t'] - b['hr']) + 1.25 * b['d'] + 1.59 * b['t'] + 2.05 * b['hr'],
            b['ab'] + b['bb'] - b['ibb'] + b['sf'] + b['hbp'])
def fipn(p): return 13.0 * p['hr'] + 3.0 * (p['bb'] - p['ibb'] + p['hbp']) - 2.0 * p['k']
def ordinal(day): return dt.date.fromisoformat(day).toordinal()
def starters9(bat): return [b['id'] for b in sorted((b for b in bat if b.get('bo') and b['bo'].endswith('00')), key=lambda b: b['bo'])]

def walk(G, hands, C=CFG):
    d_team = 0.5 ** (1 / C['hl_team']); d_lg = 0.5 ** (1 / C['hl_league']); d_st = 0.5 ** (1 / C['hl_starts'])
    d_park = 0.5 ** (1 / C['hl_park']); d_ump = 0.5 ** (1 / C['hl_ump'])
    L = dict(LEAGUE0); T = {}; P = {}; B = {}; V = {}; U = {}
    season_of = {}; last_game = {}; last_lineup = {}; relief = {}
    TK = ('n', 'rf', 'ra', 'w', 'wn', 'wd', 'wnL', 'wdL', 'wnR', 'wdR', 'bpn', 'bpb')
    def team(t):
        if t not in T: T[t] = {k: 0.0 for k in TK}
        return T[t]
    def bval(pid, lgw):
        b = B.get(pid)
        return (b[0] + C['k_bat'] * lgw) / (b[1] + C['k_bat']) if b else lgw
    def lineup_value(ids, lgw):
        return sum(bval(x, lgw) for x in ids) / len(ids) if ids else lgw
    def sp_feats(pid, day_o, lg):
        p = P.get(pid) if pid else None
        if p is None:
            return {'sp_fip': lg['sp'], 'sp_k': lg['spk'], 'sp_ip': lg['ip'], 'sp_lbf': 0.0, 'sp_rest': float(C['sp_rest_cap']), 'sp_np': 0.0,
                    'sp_L': 1.0 if pid and hands.get(pid) == 'L' else 0.0}
        return {'sp_fip': (p['fn'] + C['k_sp'] * lg['sp']) / (p['bf'] + C['k_sp']), 'sp_k': (p['k'] + C['k_sp'] * lg['spk']) / (p['bf'] + C['k_sp']),
                'sp_ip': (p['so'] + C['k_starts'] * lg['ip']) / (p['ns'] + C['k_starts']), 'sp_lbf': math.log1p(p['bf']),
                'sp_rest': float(min(day_o - p['last'], C['sp_rest_cap'])), 'sp_np': float(p['np']), 'sp_L': 1.0 if hands.get(pid) == 'L' else 0.0}
    def side_feats(g, side, day_o, lg):
        t = g[side]; other = 'away' if side == 'home' else 'home'
        if t in season_of and season_of[t] != g['season']:
            s = team(t)
            for k in TK: s[k] *= C['carry']
            season_of[t] = g['season']
        s = team(t); r = {}
        off = (s['wn'] + C['k_pa'] * lg['woba']) / (s['wd'] + C['k_pa'])
        oh = hands.get(g['prob'][other]) if g['prob'][other] else None
        r['off'] = off
        r['offh'] = (s['wn' + oh] + C['k_pa'] * off) / (s['wd' + oh] + C['k_pa']) if oh in ('L', 'R') else off
        r['rf'] = (s['rf'] + C['k_g'] * lg['rpg']) / (s['n'] + C['k_g']); r['ra'] = (s['ra'] + C['k_g'] * lg['rpg']) / (s['n'] + C['k_g'])
        r['win'] = (s['w'] + C['k_g'] * 0.5) / (s['n'] + C['k_g'])
        r['bp'] = (s['bpn'] + C['k_bp'] * lg['bp']) / (s['bpb'] + C['k_bp'])
        r.update(sp_feats(g['prob'][side], day_o, lg))
        r['lu_exp'] = lineup_value(last_lineup.get(t), lg['woba'])
        lg_ = last_game.get(t)
        r['rest'] = float(min(day_o - lg_[0], C['rest_cap'])) if lg_ else float(C['rest_cap'])
        r['night'] = 1.0 if g['dn'] == 'night' else 0.0
        r['dan'] = 1.0 if (lg_ and day_o - lg_[0] == 1 and lg_[1] == 'night' and g['dn'] == 'day') else 0.0
        # ---- late news (from the game's own pregame information)
        conf = starters9(g['box'][side]['bat'])
        r['lu_conf'] = lineup_value(conf, lg['woba']); r['lu_delta'] = r['lu_conf'] - r['lu_exp']
        act = g['box'][side]['pit'][0]['id']
        r['sp_chg'] = 1.0 if act != g['prob'][side] else 0.0
        r['spc_fip'] = sp_feats(act, day_o, lg)['sp_fip']
        rl = relief.get(t, [])
        r['bp_np1'] = float(sum(n for d, n in rl if day_o - d == 1)); r['bp_np3'] = float(sum(n for d, n in rl if 1 <= day_o - d <= 3))
        return r

    rows = []; i = 0
    while i < len(G):
        day = G[i]['day']; j = i
        while j < len(G) and G[j]['day'] == day: j += 1
        dg = G[i:j]; i = j; day_o = ordinal(day)
        lg = {'woba': L['wn'] / L['wd'], 'rpg': L['rf'] / L['n'], 'bp': L['bpn'] / L['bpb'], 'sp': L['spn'] / L['spb'], 'spk': L['spk'] / L['spb'], 'ip': L['spo'] / L['sps']}
        for g in dg:
            r = {'pk': g['pk']}
            for side in ('home', 'away'):
                for k, v in side_feats(g, side, day_o, lg).items(): r[f'{side}_{k}'] = v
            lgT = 2.0 * lg['rpg']; v = V.get(g['venue'])
            r['park'] = ((v[1] + C['k_park'] * lgT) / (v[0] + C['k_park']) / lgT) if v else 1.0
            u = U.get(g['hp']) if g['hp'] else None
            r['ump'] = (u[1] / (u[0] + C['k_ump'])) if u else 0.0
            w = g['wx']
            r['wx_temp'] = w['temp'] if w['temp'] is not None else 72.0; r['wx_out'] = w['out']; r['wx_roof'] = float(w['roof'])
            r['lg_rpg'] = lg['rpg']; r['lg_woba'] = lg['woba']
            rows.append(r)
        for g in dg:
            runs = {'home': g['hs'], 'away': g['as']}; lgT = 2.0 * L['rf'] / L['n']
            for side, other in (('home', 'away'), ('away', 'home')):
                t = g[side]; s = team(t); bx = g['box'][side]; ob = g['box'][other]
                season_of[t] = g['season']; last_game[t] = (day_o, g['dn'])
                wn = wd = 0.0
                for b in bx['bat']:
                    n_, d_ = woba(b); wn += n_; wd += d_
                    if d_ > 0 or b['pa'] > 0:
                        q = B.get(b['id'], [0.0, 0.0]); dd = 0.5 ** (b['pa'] / C['hl_bat_pa']); B[b['id']] = [q[0] * dd + n_, q[1] * dd + d_]
                oh = hands.get(ob['pit'][0]['id'])
                bpn = sum(fipn(p) for p in bx['pit'][1:]); bpb = float(sum(p['bf'] for p in bx['pit'][1:]))
                obs = {'n': 1.0, 'rf': float(runs[side]), 'ra': float(runs[other]), 'w': 1.0 if runs[side] > runs[other] else 0.0,
                       'wn': wn, 'wd': wd, 'bpn': bpn, 'bpb': bpb}
                for k in TK:
                    s[k] = s[k] * d_team + obs.get(k, 0.0)
                if oh in ('L', 'R'):
                    s['wn' + oh] += wn; s['wd' + oh] += wd
                sp = bx['pit'][0]
                lo = {'n': 1.0, 'rf': float(runs[side]), 'wn': wn, 'wd': wd, 'bpn': bpn, 'bpb': bpb, 'spn': fipn(sp), 'spb': float(sp['bf']),
                      'spk': float(sp['k']), 'spo': float(sp['outs']), 'sps': 1.0}
                for k in LEAGUE0: L[k] = L[k] * d_lg + lo[k]
                for n, p in enumerate(bx['pit']):
                    q = P.get(p['id'])
                    if q is None: q = P[p['id']] = {'bf': 0.0, 'fn': 0.0, 'k': 0.0, 'so': 0.0, 'ns': 0.0, 'last': day_o, 'np': 0.0}
                    dd = 0.5 ** (p['bf'] / C['hl_pit_bf'])
                    q['bf'] = q['bf'] * dd + p['bf']; q['fn'] = q['fn'] * dd + fipn(p); q['k'] = q['k'] * dd + p['k']
                    if n == 0: q['so'] = q['so'] * d_st + p['outs']; q['ns'] = q['ns'] * d_st + 1.0
                    q['last'] = day_o; q['np'] = float(p['np'])
                relief.setdefault(t, []).append((day_o, float(sum(p['np'] for p in bx['pit'][1:]))))
                relief[t] = [x for x in relief[t] if day_o - x[0] <= 3]
                nine = starters9(bx['bat'])
                if len(nine) >= 9: last_lineup[t] = nine
            tot = float(g['hs'] + g['as'])
            v = V.get(g['venue'], [0.0, 0.0]); V[g['venue']] = [v[0] * d_park + 1.0, v[1] * d_park + tot]
            if g['hp']:
                u = U.get(g['hp'], [0.0, 0.0]); U[g['hp']] = [u[0] * d_ump + 1.0, u[1] * d_ump + (tot - lgT)]
    return rows

def load():
    G = pickle.load(open('data/cache/history.pkl', 'rb'))
    people = json.load(open('data/people.json'))
    hands = {int(k): v['p'] for k, v in people.items() if v.get('p')}
    return G, hands

if __name__ == '__main__':
    G, hands = load()
    PARITY = os.environ.get('PARITY')
    if PARITY:
        G = [g for g in G if g['season'] >= int(PARITY)]
        rows = walk(G, hands)
        os.makedirs('data/cache/parity', exist_ok=True)
        used = set()
        for g in G:
            for s in ('home', 'away'):
                used.update(p['id'] for p in g['box'][s]['pit'])
                if g['prob'][s]: used.add(g['prob'][s])
        keep = ('pk', 'season', 'day', 'start', 'venue', 'dn', 'home', 'away', 'hs', 'as', 'prob', 'box', 'hp', 'wx')
        hist = {'games': [{k: g[k] for k in keep} for g in G], 'hands': {str(k): v for k, v in hands.items() if k in used}}
        for h in hist['games']: h['box'] = {s: {'bat': h['box'][s]['bat'], 'pit': h['box'][s]['pit']} for s in ('home', 'away')}
        json.dump(hist, open('data/cache/parity/history.json', 'w'), separators=(',', ':'))
        json.dump(rows, open('data/cache/parity/features_py.json', 'w'))
        print('parity fixture written', len(G), 'games'); raise SystemExit
    rows = walk(G, hands)
    F = pd.DataFrame(rows)
    F.to_parquet('data/cache/features.parquet')
    # loader parity fixture: full-history (2018+) features of 2026 games, checked by tests/mlb-vas.test.js through mlb/lib/vas-data.js
    os.makedirs('data/cache/parity', exist_ok=True)
    season = {g['pk']: g['season'] for g in G}
    json.dump([r for r in rows if season[r['pk']] == 2026], open('data/cache/parity/features_full_2026.json', 'w'))
    print('features', F.shape)
