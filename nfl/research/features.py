"""Walk-forward pregame features for every NFL game 2006..2026. Nothing from a game day is used until that day is over.

PORTABLE (open-safe, mirrored line-for-line by nfl/lib/vas-engine.js):
  TEAM      exponentially weighted (half-life in games, part carried over the summer), empirical-Bayes-shrunk,
            opponent-adjusted EPA/play: pass offense, rush offense, pass defense, rush defense; success rate for/against;
            special-teams EPA/game; points for/against per game; pace (scrimmage plays/game); pass rate (dropback share)
            Opponent adjustment is single-pass: obs - n * (opponent's pre-day shrunk rating - league mean).
            Garbage time (win prob outside [wp_lo, wp_hi]) is excluded from EPA/success/pass rate.
  QB        PROJECTED starter = the team's starter last game (most dropbacks). Shrunk opponent-adjusted EPA/dropback,
            decayed per dropback; prior = league mean + qb_rep (replacement level). log experience; share of recent starts.
  PERSONNEL previous game's snap-weighted personnel: expected snap share (EW over team games) of regulars who did NOT play
            the team's last game, by position group (QB, OL, WR, TE, RB, DL, LB, DB).
  SCHEDULE  rest days (capped), bye, short week, time-zone shift of the away team, west-coast team in an early kick, neutral,
            division game, dome.
LATE NEWS (not open-safe, research only; computed from the same state):
  qb_*_act  the confirmed starter (nflverse starting QB) and a QB-change flag
  inj_*     Friday injury-report designations x expected snap share x P(miss | status), by position group ("Injury Matrix")
  ina_*     actual inactives proxy: expected snap share of regulars with no snaps in THIS game, by group
  weather   wind, temperature, precipitation (game-time observations)

PARITY=<season> restricts history to that season onward and writes data/cache/parity/{history,features_py}.json for the
Node parity test.
"""
import json, os, math, numpy as np, pandas as pd
from collections import defaultdict

CFG = dict(hl_team=8.0, carry=0.4, league_carry=0.5, k_pass=250.0, k_rush=200.0, k_sr=200.0, k_game=3.0, wp_lo=0.05, wp_hi=0.95,
           hl_qb=500.0, k_qb=250.0, qb_rep=-0.10, hl_pl=4.0, pl_carry=0.3, min_share=0.05, rest_cap=14, bye_min=12, short_max=5, recent_starts=8)
if os.path.exists('data/cache/cfg_override.json') and not os.environ.get('NO_OVERRIDE'):
    CFG.update(json.load(open('data/cache/cfg_override.json')))
if os.environ.get('CFG_JSON'): CFG.update(json.loads(os.environ['CFG_JSON']))
FRANCHISE = {'STL': 'LA', 'SD': 'LAC', 'OAK': 'LV'}
if not os.environ.get('CFG_JSON'): json.dump(CFG, open('data/cache/cfg_used.json', 'w'), indent=1)
TZ = {**{t: -5 for t in 'ATL BAL BUF CAR CIN CLE DET IND JAX MIA NE NYG NYJ PHI PIT TB WAS'.split()},
      **{t: -6 for t in 'CHI DAL GB HOU KC MIN NO TEN STL'.split()}, **{t: -7 for t in 'DEN ARI'.split()},
      **{t: -8 for t in 'LA LAC LV OAK SD SEA SF'.split()}}
GROUPS = {'QB': 'QB', 'T': 'OL', 'G': 'OL', 'C': 'OL', 'OL': 'OL', 'OT': 'OL', 'OG': 'OL', 'WR': 'WR', 'TE': 'TE', 'RB': 'RB', 'FB': 'RB', 'HB': 'RB',
          'DE': 'DL', 'DT': 'DL', 'NT': 'DL', 'DL': 'DL', 'LB': 'LB', 'OLB': 'LB', 'ILB': 'LB', 'MLB': 'LB', 'CB': 'DB', 'S': 'DB', 'SS': 'DB', 'FS': 'DB', 'DB': 'DB'}
GL = ['QB', 'OL', 'WR', 'TE', 'RB', 'DL', 'LB', 'DB']
OFFG = {'QB', 'OL', 'WR', 'TE', 'RB'}
TEAM_KEYS = ['pe', 'pn', 're', 'rn', 'ps', 'sn', 'dpe', 'dpn', 'dre', 'drn', 'dps', 'dsn', 'st', 'pf', 'pa', 'pl', 'n']
SIDE = ['op', 'or', 'dp', 'dr', 'osr', 'dsr', 'st', 'pf', 'pa', 'pace', 'prate', 'qb', 'qbx', 'qbshare', 'rest', 'bye', 'short'] + ['m_' + x for x in GL]

PARITY = os.environ.get('PARITY')
games = pd.read_parquet('data/cache/games.parquet')
games = games[games.played].copy()
plays = pd.read_parquet('data/cache/plays.parquet').rename(columns={'def': 'dfn'})
snaps = pd.read_parquet('data/cache/snaps.parquet')
if PARITY:
    games = games[games.season >= int(PARITY)]
games = games.sort_values(['gameday', 'gametime', 'gid']).reset_index(drop=True)
plays = plays[plays.gid.isin(games.gid)]
snaps = snaps[snaps.gid.isin(games.gid)]
fr = lambda t: FRANCHISE.get(t, t)

# ---------------------------------------------------------------- per team-game aggregates (same arithmetic in Node)
AGG = defaultdict(lambda: defaultdict(float))     # (gid, team) -> sums
QBG = defaultdict(lambda: defaultdict(lambda: [0, 0, 0.0]))   # (gid, team) -> passer -> [all dropbacks, neutral dropbacks, neutral epa]
for r in plays.itertuples(index=False):
    off, dfn = fr(r.off), fr(r.dfn)            # pbp already uses LA/LAC/LV for every season; games.csv keeps STL/SD/OAK
    o, d = AGG[(r.gid, off)], AGG[(r.gid, dfn)]
    if r.kind == 's':
        o['st'] += r.epa; d['st'] -= r.epa; continue
    o['pl'] += 1
    if r.kind == 'p' and r.passer: QBG[(r.gid, off)][r.passer][0] += 1
    neutral = not (r.wp == r.wp) or (CFG['wp_lo'] <= r.wp <= CFG['wp_hi'])
    if not neutral: continue
    o['sn'] += 1; o['ps'] += r.succ; d['dsn'] += 1; d['dps'] += r.succ
    if r.kind == 'p':
        o['pe'] += r.epa; o['pn'] += 1; d['dpe'] += r.epa; d['dpn'] += 1
        if r.passer: q = QBG[(r.gid, off)][r.passer]; q[1] += 1; q[2] += r.epa
    else:
        o['re'] += r.epa; o['rn'] += 1; d['dre'] += r.epa; d['drn'] += 1

def starter_of(gid, team):
    m = QBG.get((gid, team))
    if not m: return None
    best, n = None, -1
    for pid, v in m.items():
        if v[0] > n or (v[0] == n and pid > best): best, n = pid, v[0]
    return best

SN = {(k[0], fr(k[1])): v for k, v in snaps.groupby(['gid', 'team'])}

# ---------------------------------------------------------------- state
dT = 0.5 ** (1 / CFG['hl_team']); dP = 0.5 ** (1 / CFG['hl_pl'])
T = defaultdict(lambda: defaultdict(float)); L = defaultdict(float); season_of = {}; league_season = [None]
QB = defaultdict(lambda: [0.0, 0.0]); starts = defaultdict(list); last_game = {}
PS = defaultdict(dict)       # team -> pid -> [ew share, group]
PN = defaultdict(float)      # team -> ew team-game count (for shares)
last_played = {}             # team -> set of pids who played the last game

def lrate(num, den): return L[num] / L[den] if L[den] > 0 else 0.0
def team_rates(t):
    s = T[t]; out = {}
    lp, lr_, lsr = lrate('pe', 'pn'), lrate('re', 'rn'), lrate('ps', 'sn')
    out['op'] = (s['pe'] + CFG['k_pass'] * lp) / (s['pn'] + CFG['k_pass'])
    out['or'] = (s['re'] + CFG['k_rush'] * lr_) / (s['rn'] + CFG['k_rush'])
    out['dp'] = (s['dpe'] + CFG['k_pass'] * lp) / (s['dpn'] + CFG['k_pass'])
    out['dr'] = (s['dre'] + CFG['k_rush'] * lr_) / (s['drn'] + CFG['k_rush'])
    out['osr'] = (s['ps'] + CFG['k_sr'] * lsr) / (s['sn'] + CFG['k_sr'])
    out['dsr'] = (s['dps'] + CFG['k_sr'] * lsr) / (s['dsn'] + CFG['k_sr'])
    n = s['n']; kg = CFG['k_game']
    out['st'] = s['st'] / (n + kg)
    out['pf'] = (s['pf'] + kg * lrate('pf', 'n')) / (n + kg)
    out['pa'] = (s['pa'] + kg * lrate('pf', 'n')) / (n + kg)
    out['pace'] = (s['pl'] + kg * lrate('pl', 'n')) / (n + kg)
    out['prate'] = (s['pn'] + CFG['k_sr'] * lrate('pn', 'sn')) / (s['sn'] + CFG['k_sr'])
    return out
def qb_feats(q, t):
    n, e = QB[q] if q else (0.0, 0.0)
    prior = lrate('pe', 'pn') + CFG['qb_rep']
    rec = starts[t][-CFG['recent_starts']:]
    return {'qb': (e + CFG['k_qb'] * prior) / (n + CFG['k_qb']), 'qbx': math.log1p(n), 'qbshare': (rec.count(q) / len(rec)) if (rec and q) else 0.0}
def share(t, pid): v = PS[t].get(pid); return v[0] / PN[t] if (v and PN[t] > 0) else 0.0
def missing(t, avail):
    """expected snap share (by group) of the team's regulars who are not in `avail`"""
    m = {g: 0.0 for g in GL}
    if PN[t] <= 0: return m
    for pid in sorted(PS[t]):
        s, grp = PS[t][pid][0] / PN[t], PS[t][pid][1]
        if s >= CFG['min_share'] and pid not in avail: m[grp] += s
    return m

def carry(t, season):
    if season_of.get(t) not in (None, season):
        for k in list(T[t]): T[t][k] *= CFG['carry']
        for pid in PS[t]: PS[t][pid][0] *= CFG['pl_carry']
        PN[t] *= CFG['pl_carry']
    season_of[t] = season

def side_feats(team, season, day, gtime):
    t = fr(team); carry(t, season)
    r = team_rates(t)
    proj = starts[t][-1] if starts[t] else None
    r.update(qb_feats(proj, t)); r['proj'] = proj
    rest = min((pd.Timestamp(day) - pd.Timestamp(last_game[t])).days, CFG['rest_cap']) if t in last_game else CFG['rest_cap']
    r['rest'] = rest; r['bye'] = int(rest >= CFG['bye_min']); r['short'] = int(rest <= CFG['short_max'])
    lp = last_played.get(t)
    mm = missing(t, lp) if lp is not None else {g: 0.0 for g in GL}
    for g_ in GL: r['m_' + g_] = mm[g_]
    return r

def combine(h, a, g):
    f = {}
    for k in SIDE: f['d_' + k] = h[k] - a[k]
    for k in ('op', 'or', 'dp', 'dr', 'osr', 'dsr', 'st', 'pf', 'pa', 'pace', 'prate', 'qb'): f['s_' + k] = h[k] + a[k]
    neutral = int(g['neutral']); f['neutral'] = neutral; f['div'] = int(g['div'])
    f['dome'] = int(g['roof'] in ('dome', 'closed'))
    tz = 0 if neutral else TZ.get(g['home'], -5) - TZ.get(g['away'], -5)
    f['away_tz'] = tz
    hour = int(str(g['time'] or '13:00')[:2])
    f['west_early'] = int(tz >= 2 and hour < 14)
    f['home_short'] = h['short']; f['away_short'] = a['short']; f['home_bye'] = h['bye']; f['away_bye'] = a['bye']
    return f

rows = []
gd = games.assign(neutral=(games.location == 'Neutral').astype(int))
for day, dg in gd.groupby('gameday', sort=True):
    if league_season[0] is not None and dg.season.iloc[0] != league_season[0]:
        for k in list(L): L[k] *= CFG['league_carry']
    league_season[0] = int(dg.season.iloc[0])
    feats = {}
    for g in dg.itertuples():
        G = {'home': g.home, 'away': g.away, 'neutral': g.neutral, 'div': g.div_game, 'roof': g.roof, 'time': g.gametime}
        h = side_feats(g.home, g.season, day, g.gametime); a = side_feats(g.away, g.season, day, g.gametime)
        f = combine(h, a, G)
        r = {'gid': g.gid, **f}
        for s, x in (('home', h), ('away', a)):
            for k in SIDE + ['proj']: r[f'{s}_{k}'] = x[k]
        # ---- late news (research only): confirmed starter, inactives proxy (this game's snaps), weather is merged later
        for s, team in (('home', g.home), ('away', g.away)):
            t = fr(team); act = getattr(g, s + '_qb_id')
            act = act if isinstance(act, str) and act else None
            q = qb_feats(act, t) if act else {'qb': r[f'{s}_qb'], 'qbx': r[f'{s}_qbx'], 'qbshare': r[f'{s}_qbshare']}
            r[f'{s}_qb_act'] = q['qb']; r[f'{s}_qbx_act'] = q['qbx']; r[f'{s}_act'] = act
            r[f'{s}_qb_change'] = int(act is not None and r[f'{s}_proj'] is not None and act != r[f'{s}_proj'])
            S = SN.get((g.gid, t))
            if S is not None and PN[t] > 0:
                played = set(S.pfr_player_id[(S.offense_snaps > 0) | (S.defense_snaps > 0)])
                mm = missing(t, played)
            else:
                mm = {x: np.nan for x in GL}
            for x in GL: r[f'{s}_ina_{x}'] = mm[x]
            # regulars' shares (pre-game) for the injury matrix, stored compactly
            r[f'{s}_shares'] = json.dumps({pid: round(v[0] / PN[t], 6) for pid, v in PS[t].items() if PN[t] > 0 and v[0] / PN[t] >= CFG['min_share']})
        rows.append(r)
    # ---------------------------------------------------------- update with the day's results (adjust with pre-day ratings)
    pre = {}
    for g in dg.itertuples():
        for team in (g.home, g.away):
            pre[fr(team)] = team_rates(fr(team))
    lp_, lr_ = lrate('pe', 'pn'), lrate('re', 'rn')
    for g in dg.itertuples():
        for side, other in (('home', 'away'), ('away', 'home')):
            team, opp = getattr(g, side), getattr(g, other); t, o = fr(team), fr(opp)
            a = AGG.get((g.gid, t), {})
            po = pre[o]
            obs = {k: a.get(k, 0.0) for k in ('pn', 'rn', 'ps', 'sn', 'dpn', 'drn', 'dps', 'dsn', 'st', 'pl')}
            obs['pe'] = a.get('pe', 0.0) - a.get('pn', 0.0) * (po['dp'] - lp_)
            obs['re'] = a.get('re', 0.0) - a.get('rn', 0.0) * (po['dr'] - lr_)
            obs['dpe'] = a.get('dpe', 0.0) - a.get('dpn', 0.0) * (po['op'] - lp_)
            obs['dre'] = a.get('dre', 0.0) - a.get('drn', 0.0) * (po['or'] - lr_)
            obs['pf'] = float(getattr(g, side + '_score')); obs['pa'] = float(getattr(g, other + '_score')); obs['n'] = 1.0
            s = T[t]
            for k in TEAM_KEYS: s[k] = s[k] * dT + obs[k]
            for k in ('pe', 'pn', 're', 'rn', 'ps', 'sn', 'pf', 'pl', 'n'):
                L[k] += a.get(k, 0.0) if k not in ('pf', 'n') else obs[k]
            # QBs: decay per dropback, opponent-adjusted
            for pid in sorted(QBG.get((g.gid, t), {})):
                nall, n, e = QBG[(g.gid, t)][pid]
                if n <= 0: continue
                q = QB[pid]; d = 0.5 ** (n / CFG['hl_qb'])
                q[0] = q[0] * d + n; q[1] = q[1] * d + (e - n * (po['dp'] - lp_))
            st_ = starter_of(g.gid, t)
            if st_: starts[t].append(st_)
            last_game[t] = g.gameday
            # personnel shares
            S = SN.get((g.gid, t))
            if S is not None:
                for pid in PS[t]: PS[t][pid][0] *= dP
                PN[t] = PN[t] * dP + 1
                played = set()
                for x in S.itertuples(index=False):
                    grp = GROUPS.get(x.position)
                    if grp is None: continue
                    pct = float(x.offense_pct if grp in OFFG else x.defense_pct)
                    if not (pct == pct): pct = 0.0
                    if x.offense_snaps > 0 or x.defense_snaps > 0: played.add(x.pfr_player_id)
                    v = PS[t].get(x.pfr_player_id)
                    if v is None: PS[t][x.pfr_player_id] = [pct, grp]
                    else: v[0] += pct; v[1] = grp
                last_played[t] = played

F = games.rename(columns={'home_rest': 'nv_home_rest', 'away_rest': 'nv_away_rest'}).merge(pd.DataFrame(rows), on='gid')
if PARITY:
    os.makedirs('data/cache/parity', exist_ok=True)
    hist = {'games': [], 'plays': [], 'snaps': []}
    for g in F.itertuples():
        hist['games'].append({'gid': g.gid, 'season': int(g.season), 'week': int(g.week), 'day': g.gameday, 'time': g.gametime, 'home': g.home, 'away': g.away,
                              'homeScore': int(g.home_score), 'awayScore': int(g.away_score), 'neutral': g.location == 'Neutral', 'div': int(g.div_game), 'roof': g.roof})
    for r in plays.itertuples(index=False):
        hist['plays'].append([r.gid, r.off, r.dfn, r.kind, float(r.epa), int(r.succ), r.passer, None if r.wp != r.wp else float(r.wp)])
    for x in snaps.itertuples(index=False):
        hist['snaps'].append([x.gid, x.team, x.pfr_player_id, x.position, float(x.offense_pct) if x.offense_pct == x.offense_pct else 0.0,
                              float(x.defense_pct) if x.defense_pct == x.defense_pct else 0.0, int(x.offense_snaps > 0 or x.defense_snaps > 0)])
    json.dump(hist, open('data/cache/parity/history.json', 'w'))
    cols = ['gid'] + [c for c in F.columns if c.startswith(('d_', 's_')) or c in ('neutral', 'div', 'dome', 'away_tz', 'west_early', 'home_short', 'away_short', 'home_bye', 'away_bye')] + \
           [f'{s}_{k}' for s in ('home', 'away') for k in SIDE + ['proj']]
    F[list(dict.fromkeys(cols))].to_json('data/cache/parity/features_py.json', orient='records', double_precision=15)
    print('parity fixture written', len(hist['games']), 'games', len(hist['plays']), 'plays', len(hist['snaps']), 'snaps'); raise SystemExit

# ---------------------------------------------------------------- late-news: Friday injury report x expected share ("Injury Matrix")
inj = pd.read_parquet('data/cache/injuries.parquet')
pmap = snaps.dropna(subset=['gsis']).drop_duplicates('gsis').set_index('gsis').pfr_player_id
inj['pid'] = inj.gsis_id.map(pmap)
inj = inj[inj.report_status.isin(['Out', 'Doubtful', 'Questionable', 'Probable'])]
wk = games[['gid', 'season', 'week', 'home', 'away']]
IJ = defaultdict(list)
for x in inj.itertuples(index=False):
    IJ[(int(x.season), int(x.week), fr(x.team))].append((x.pid, x.report_status))
# P(miss | status) calibrated on 2013-2019 only (did the listed regular play? from snap counts)
cal = defaultdict(lambda: [0, 0])
snap_played = {(r.gid, r.pfr_player_id) for r in snaps[(snaps.offense_snaps > 0) | (snaps.defense_snaps > 0)].itertuples(index=False)}
for g in F.itertuples():
    if not (2013 <= g.season <= 2019): continue
    for s, team in (('home', g.home), ('away', g.away)):
        sh = json.loads(getattr(g, s + '_shares'))
        for pid, stt in IJ.get((g.season, g.week, fr(team)), []):
            if pid in sh: c = cal[stt]; c[0] += 1; c[1] += int((g.gid, pid) not in snap_played)
PMISS = {k: round(v[1] / v[0], 3) for k, v in cal.items() if v[0]}
print('P(miss | status), 2013-2019 regulars:', PMISS, {k: v[0] for k, v in cal.items()})
json.dump(PMISS, open('data/cache/pmiss.json', 'w'))
POS = snaps.drop_duplicates('pfr_player_id', keep='last').set_index('pfr_player_id').position.map(GROUPS).dropna().to_dict()
for s in ('home', 'away'):
    out = {x: [] for x in GL}
    for g in F.itertuples():
        sh = json.loads(getattr(g, s + '_shares')); team = getattr(g, s)
        m = {x: 0.0 for x in GL}; has = (g.season, g.week, fr(team)) in IJ
        for pid, stt in IJ.get((g.season, g.week, fr(team)), []):
            if pid in sh and POS.get(pid): m[POS[pid]] += sh[pid] * PMISS.get(stt, 0.0)
        for x in GL: out[x].append(m[x] if (has or g.season >= 2013) else np.nan)
    for x in GL: F[f'{s}_inj_{x}'] = out[x]
W = pd.read_parquet('data/cache/weather.parquet')
F = F.merge(W, on='gid', how='left')
F = F.drop(columns=['home_shares', 'away_shares'])
F['y_margin'] = F.home_score - F.away_score; F['y_total'] = F.home_score + F.away_score
F.to_parquet('data/cache/features.parquet')
print(F.shape)
print(F[[c for c in F.columns if c.startswith('d_')]].describe().T[['mean', 'std']].round(3).to_string())
