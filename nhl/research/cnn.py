"""Shot-map CNN vector.

Per team, pregame, exponentially weighted 5v5 unblocked-shot location maps (offense = shots taken, defense = shots allowed),
count and xG-weighted, per 60 5v5 minutes, on a 15 x 17 grid of the attacking zone (5 ft cells).
Input per game: 8 channels [home off cnt, home off xg, away def cnt, away def xg, away off cnt, away off xg, home def cnt, home def xg].
Target: home share of the game's 5v5 score/venue-adjusted xG (dense, far less noisy than wins).
Rolling origin: the model for season S is trained only on seasons < S. Output: data/cache/cnn.parquet (gid, cnn_share).
"""
import os, numpy as np, pandas as pd, torch, torch.nn as nn
from collections import defaultdict
torch.manual_seed(7); np.random.seed(7)
HL = 30; D = 0.5 ** (1 / HL); CARRY = 0.5
XB = np.linspace(25, 100, 16); YB = np.linspace(-42.5, 42.5, 18)

games = pd.read_parquet('data/cache/games.parquet'); games['d'] = pd.to_datetime(games.date)
sh = pd.read_parquet('data/cache/shots.parquet')
sh = sh[(sh.homeSkatersOnIce == 5) & (sh.awaySkatersOnIce == 5) & (sh.shotOnEmptyNet != 1)]
tl = pd.read_parquet('data/cache/teamlog.parquet'); tl = tl[tl.situation == '5on5']
tl['side'] = np.where(tl.home_or_away == 'HOME', 'home', 'away')
toi = tl.set_index(['gameId', 'side']).iceTime
tgt = tl.set_index(['gameId', 'side'])[['flurryScoreVenueAdjustedxGoalsFor', 'flurryScoreVenueAdjustedxGoalsAgainst']]

def grids(df):
    out = {}
    for (gid, home), g in df.groupby(['gid', 'isHomeTeam']):
        c, _, _ = np.histogram2d(g.xCordAdjusted.abs(), g.yCordAdjusted, bins=[XB, YB])
        x, _, _ = np.histogram2d(g.xCordAdjusted.abs(), g.yCordAdjusted, bins=[XB, YB], weights=g.xGoal)
        out[(gid, 'home' if home == 1 else 'away')] = np.stack([c, x])
    return out
G = grids(sh)
print('grids built', len(G))

state = defaultdict(lambda: {'off': np.zeros((2, 15, 17)), 'def': np.zeros((2, 15, 17)), 'toi': 0.0})
season_of = {}
X = np.zeros((len(games), 8, 15, 17), np.float32); y = np.full(len(games), np.nan, np.float32); ok = np.zeros(len(games), bool)
idx = {gid: i for i, gid in enumerate(games.gid)}
league = {'off': np.zeros((2, 15, 17)), 'toi': 0.0}
for date, day in games.groupby('d', sort=True):
    for g in day.itertuples():
        i = idx[g.gid]; ch = []
        for side, opp in (('home', 'away'), ('away', 'home')):
            t, o = state[getattr(g, side)], state[getattr(g, opp)]
            if season_of.get(getattr(g, side)) not in (None, g.season):
                for k in ('off', 'def'): t[k] *= CARRY
                t['toi'] *= CARRY
            prior = league['off'] / max(league['toi'], 1) * 3600 * 1800   # 30 prior minutes at league average
            rate = lambda s, k: (s[k] + prior / 3600) / (s['toi'] + 1800) * 3600
            ch += [rate(t, 'off'), rate(o, 'def')]
        X[i] = np.concatenate(ch)   # [home off, away def, away off, home def] x [count, xg]
        ok[i] = state[g.home]['toi'] > 5 * 2700 and state[g.away]['toi'] > 5 * 2700
        try:
            a = tgt.loc[(g.gid, 'home')]; y[i] = a.iloc[0] / (a.iloc[0] + a.iloc[1])
        except KeyError:
            pass
    for g in day.itertuples():
        for side, opp in (('home', 'away'), ('away', 'home')):
            t = state[getattr(g, side)]; season_of[getattr(g, side)] = g.season
            tt = float(toi.get((g.gid, side), 0) or 0)
            f = G.get((g.gid, side), np.zeros((2, 15, 17))); a = G.get((g.gid, opp), np.zeros((2, 15, 17)))
            t['off'] = t['off'] * D + f; t['def'] = t['def'] * D + a; t['toi'] = t['toi'] * D + tt
            league['off'] += f; league['toi'] += tt
print('tensors built')

# normalise channels (log1p of per-60 rates) with train-agnostic fixed transform
X = np.log1p(X * 50).astype(np.float32)
np.save('data/cache/shotmaps.npy', X); np.save('data/cache/shotmaps_y.npy', y); np.save('data/cache/shotmaps_ok.npy', ok)
import os, sys
if os.environ.get('BUILD_ONLY'): sys.exit(0)

class Net(nn.Module):
    def __init__(s):
        super().__init__()
        s.enc = nn.Sequential(nn.Conv2d(4, 16, 3, padding=1), nn.GELU(), nn.Conv2d(16, 32, 3, padding=1), nn.GELU(),
                              nn.MaxPool2d(2), nn.Conv2d(32, 32, 3, padding=1), nn.GELU(), nn.AdaptiveAvgPool2d(1), nn.Flatten())
        s.head = nn.Sequential(nn.Linear(64, 32), nn.GELU(), nn.Dropout(0.2), nn.Linear(32, 1)); s.home = nn.Parameter(torch.zeros(1))
    def forward(s, x):
        # shared encoder reads "attack vs defense" pairs; antisymmetric by construction (swap sides -> 1 - share)
        a = s.enc(x[:, :4]); b = s.enc(x[:, 4:])
        return torch.sigmoid(s.home + s.head(torch.cat([a, b], 1)) - s.head(torch.cat([b, a], 1))).squeeze(1)

def fit(tr):
    net = Net(); opt = torch.optim.AdamW(net.parameters(), 2e-3, weight_decay=1e-3)
    Xt = torch.tensor(X[tr]); yt = torch.tensor(y[tr])
    n = len(tr); val = np.random.rand(n) < 0.1; best, bs, wait = 9, None, 0
    for ep in range(60):
        net.train(); perm = np.random.permutation(np.where(~val)[0])
        for b in range(0, len(perm), 256):
            j = perm[b:b + 256]; opt.zero_grad()
            loss = ((net(Xt[j]) - yt[j]) ** 2).mean(); loss.backward(); opt.step()
        net.eval()
        with torch.no_grad(): v = ((net(Xt[val]) - yt[val]) ** 2).mean().item()
        if v < best - 1e-6: best, bs, wait = v, {k: t.clone() for k, t in net.state_dict().items()}, 0
        else:
            wait += 1
            if wait >= 6: break
    net.load_state_dict(bs); return net, best

pred = np.full(len(games), np.nan)
for S in range(2017, 2026):
    tr = np.where((games.season < S).values & ok & ~np.isnan(y))[0]
    te = np.where((games.season == S).values)[0]
    net, v = fit(tr)
    with torch.no_grad(): pred[te] = net(torch.tensor(X[te])).numpy()
    m = ok[te] & ~np.isnan(y[te])
    base = ((y[tr].mean() - y[te][m]) ** 2).mean(); mse = ((pred[te][m] - y[te][m]) ** 2).mean()
    print(f'season {S}: train {len(tr)}  val mse {v:.5f}  test mse {mse:.5f} vs constant {base:.5f}  ({(1 - mse / base) * 100:+.1f}% R2)')
pd.DataFrame({'gid': games.gid, 'cnn_share': pred, 'cnn_ok': ok}).to_parquet('data/cache/cnn.parquet')
