"""Keras networks for the NFL stage-1 model (Keras 3, PyTorch backend). Research only - production stays linear.

TowerNet  multi-input: one shared dense tower per vector (offense / defense / QB / personnel+schedule), applied to home and
          away, home-minus-away differences + game context -> multi-task heads: margin (Huber), home win, total points,
          and an ATS head P(home margin > L) that also takes the line L as input (trained on the nflverse CLOSE,
          evaluated at the OPEN).
SeqNet    GRU over each team's last N games (raw per-game EPA / success / points / pace / ST, the opponent's pre-game
          ratings, home flag, recency, previous-season flag), shared encoder for both teams, + QB / personnel / rest
          context, antisymmetric matchup head (swap teams -> -margin) and a symmetric total head; same four tasks.
Rolling origin: predictions for season S come from networks trained on seasons < S; season S-1 is the early-stopping
validation set; 3 seeds averaged. Input scaling is fit on seasons <= 2012 only. Output: data/cache/nn_preds.parquet
"""
import os, sys, warnings
os.environ.setdefault('KERAS_BACKEND', 'torch'); warnings.filterwarnings('ignore')
import numpy as np, pandas as pd, keras, torch
torch.set_num_threads(int(os.environ.get('TORCH_THREADS', 2)))
from keras import layers, ops
from collections import defaultdict

SEQ = 10; SEEDS = tuple(int(x) for x in os.environ.get('SEEDS', '1,2,3').split(','))
FOLDS = range(int(os.environ.get('FOLD_FROM', 2011)), 2027)
F = pd.read_parquet('data/cache/features.parquet')
M = pd.read_parquet('data/cache/market.parquet')[['gid', 'close_spread', 'open_spread']]
F = F.merge(M, on='gid', how='left').reset_index(drop=True)
F['d'] = pd.to_datetime(F.gameday)
norm_mask = (F.season <= 2012).values

y_margin = F.y_margin.values.astype('float32'); y_total = F.y_total.values.astype('float32')
y_win = (F.y_margin > 0).astype('float32').values; w_win = (F.y_margin != 0).astype('float32').values
line_close = F.close_spread.fillna(0).values.astype('float32')
y_cover = (F.y_margin > F.close_spread).astype('float32').values; w_cover = (F.y_margin != F.close_spread).astype('float32').values

# ------------------------------------------------------------------ static towers
BLOCKS = {'off': ['op', 'or', 'osr', 'pf', 'pace', 'prate', 'st'], 'def': ['dp', 'dr', 'dsr', 'pa'], 'qb': ['qb', 'qbx', 'qbshare'],
          'pers': ['m_QB', 'm_OL', 'm_WR', 'm_TE', 'm_RB', 'm_DL', 'm_LB', 'm_DB', 'rest', 'bye', 'short']}
CTX = ['neutral', 'div', 'away_tz', 'west_early', 'dome']
static = {}
for k, names in BLOCKS.items():
    a = {s: F[[f'{s}_{n}' for n in names]].astype(float).fillna(0).values.astype('float32') for s in ('home', 'away')}
    both = np.concatenate([a['home'][norm_mask], a['away'][norm_mask]]); mu, sd = both.mean(0), both.std(0)
    fixed = np.array([n.startswith('m_') for n in names]) | (sd < 1e-3)       # snap shares exist only from 2013: natural 0..1 scale
    mu, sd = np.where(fixed, 0.0, mu), np.where(fixed, 1.0, sd)
    for s in ('home', 'away'): static[f'{k}_{s}'] = ((a[s] - mu) / sd).astype('float32')
c = F[CTX].astype(float).values; csd = c[norm_mask].std(0); static['ctx'] = ((c - c[norm_mask].mean(0)) / np.where(csd < 1e-3, 1.0, csd)).astype('float32')
LSC = 7.0
static['line'] = (line_close / LSC)[:, None].astype('float32')

# ------------------------------------------------------------------ sequences: each team's last SEQ games
P = pd.read_parquet('data/cache/plays.parquet')
FR = {'STL': 'LA', 'SD': 'LAC', 'OAK': 'LV'}
P['off'] = P.off.map(lambda t: FR.get(t, t)); P['def'] = P['def'].map(lambda t: FR.get(t, t))
neutral = P.wp.isna() | P.wp.between(0.05, 0.95)
sc = P[(P.kind != 's') & neutral]
sc = sc.assign(pe=sc.epa.where(sc.kind == 'p'), re=sc.epa.where(sc.kind == 'r'), isp=(sc.kind == 'p').astype(float))
def agg(df, by, pre):
    g = df.groupby(['gid', by])
    out = pd.DataFrame({pre + 'pe': g.pe.mean(), pre + 're': g.re.mean(), pre + 'sr': g.succ.mean(), pre + 'prate': g.isp.mean()})
    out.index.names = ['gid', 'team']; return out
O = agg(sc, 'off', 'o_'); Dd = agg(sc, 'def', 'd_')
stp = P[P.kind == 's']; st = stp.groupby(['gid', 'off']).epa.sum().rename_axis(['gid', 'team']).sub(stp.groupby(['gid', 'def']).epa.sum().rename_axis(['gid', 'team']), fill_value=0)
pl = P[P.kind != 's'].groupby(['gid', 'off']).size().rename_axis(['gid', 'team'])
TG = O.join(Dd, how='outer').join(st.rename('st'), how='outer').join(pl.rename('plays'), how='outer').fillna(0.0)
team_games = defaultdict(list)
for g in F.itertuples():
    for side, other in (('home', 'away'), ('away', 'home')):
        t = FR.get(getattr(g, side), getattr(g, side))
        if (g.gid, t) not in TG.index: continue
        r = TG.loc[(g.gid, t)]
        opp = [getattr(g, f'{other}_{k}') for k in ('op', 'or', 'dp', 'dr')]
        vec = [r.o_pe, r.o_re, r.o_sr, r.o_prate, r.d_pe, r.d_re, r.d_sr, r.st, r.plays, getattr(g, f'{side}_score'), getattr(g, f'{other}_score')] + opp + [float(side == 'home')]
        team_games[t].append((g.d, g.season, np.array(vec, 'float32')))
NF = 16
allrows = np.stack([r for v in team_games.values() for (_, s, r) in v if s <= 2012]); smu, ssd = allrows.mean(0), allrows.std(0) + 1e-6
NS = NF + 2
seq = {s: np.zeros((len(F), SEQ, NS), 'float32') for s in ('home', 'away')}
ptr = defaultdict(int)
for i, g in enumerate(F.itertuples()):
    for side in ('home', 'away'):
        t = FR.get(getattr(g, side), getattr(g, side)); lst = team_games.get(t, [])
        while ptr[t] < len(lst) and lst[ptr[t]][0] < g.d: ptr[t] += 1
        past = lst[max(0, ptr[t] - SEQ):ptr[t]]
        for j, (d, s, r) in enumerate(past[::-1]):
            seq[side][i, j, :NF] = (r - smu) / ssd
            seq[side][i, j, NF] = np.log1p((g.d - d).days) - 2.0
            seq[side][i, j, NF + 1] = float(s != g.season)
print('inputs ready', {k: v.shape for k, v in seq.items()}, flush=True)

# ------------------------------------------------------------------ models
def ats_head(z_margin, line):
    """P(margin > line): logistic in (predicted margin - line) with a learned scale"""
    d = layers.Subtract()([z_margin, layers.Rescaling(LSC)(line)])
    return layers.Dense(1, activation='sigmoid', name='cover')(d)

def tower_net():
    ins, feats = {}, []
    for k, names in BLOCKS.items():
        h = keras.Input((len(names),), name=f'{k}_home'); a = keras.Input((len(names),), name=f'{k}_away'); ins[f'{k}_home'], ins[f'{k}_away'] = h, a
        tw = keras.Sequential([layers.Dense(16, activation='gelu'), layers.Dropout(0.15), layers.Dense(8, activation='gelu')], name=f'tower_{k}')
        th, ta = tw(h), tw(a)
        feats += [layers.Subtract()([th, ta]), layers.Add()([th, ta])]
    cx = keras.Input((len(CTX),), name='ctx'); ln = keras.Input((1,), name='line'); ins['ctx'], ins['line'] = cx, ln
    z = layers.Concatenate()(feats + [cx]); z = layers.Dropout(0.25)(z)
    z = layers.Dense(32, activation='gelu', kernel_regularizer=keras.regularizers.l2(1e-4))(z); z = layers.Dropout(0.25)(z)
    z = layers.Dense(16, activation='gelu')(z)
    margin = layers.Dense(1, name='margin')(z)
    out = {'margin': margin, 'win': layers.Dense(1, activation='sigmoid', name='win')(z), 'total': layers.Dense(1, name='total')(z), 'cover': ats_head(margin, ln)}
    return keras.Model(ins, out, name='TowerNet')

def seq_net():
    sh = keras.Input((SEQ, NS), name='seq_home'); sa = keras.Input((SEQ, NS), name='seq_away')
    ins = {'seq_home': sh, 'seq_away': sa}
    ctx = {}
    for side in ('home', 'away'):
        for k in ('qb', 'pers'): ctx[(k, side)] = ins[f'{k}_{side}'] = keras.Input((len(BLOCKS[k]),), name=f'{k}_{side}')
    cx = keras.Input((len(CTX),), name='ctx'); ln = keras.Input((1,), name='line'); ins['ctx'], ins['line'] = cx, ln
    s_in = keras.Input((SEQ, NS)); mask = ops.any(ops.not_equal(s_in, 0), axis=-1)
    x = layers.Dense(24, activation='gelu')(s_in)
    x = layers.GRU(32, recurrent_initializer='glorot_uniform', go_backwards=True)(x, mask=mask)   # oldest -> newest
    enc = keras.Model(s_in, x, name='encoder_gru')
    cenc = keras.Sequential([layers.Dense(12, activation='gelu')], name='context')
    th = layers.Concatenate()([enc(sh), cenc(layers.Concatenate()([ctx[('qb', 'home')], ctx[('pers', 'home')]]))])
    ta = layers.Concatenate()([enc(sa), cenc(layers.Concatenate()([ctx[('qb', 'away')], ctx[('pers', 'away')]]))])
    f = keras.Sequential([layers.Dropout(0.2), layers.Dense(24, activation='gelu'), layers.Dense(2)], name='matchup')
    anti = layers.Subtract()([f(layers.Concatenate()([th, ta])), f(layers.Concatenate()([ta, th]))])      # antisymmetric part
    tot = keras.Sequential([layers.Dense(16, activation='gelu'), layers.Dense(1)], name='total_head')
    total = layers.Add(name='total')([tot(th), tot(ta), layers.Dense(1, use_bias=True)(cx)])
    z = layers.Concatenate()([anti, cx])
    margin = layers.Dense(1, name='margin')(z)
    win = layers.Dense(1, activation='sigmoid', name='win')(z)
    return keras.Model(ins, {'margin': margin, 'win': win, 'total': total, 'cover': ats_head(margin, ln)}, name='SeqNet')

ALL_IN = {**static, 'seq_home': seq['home'], 'seq_away': seq['away']}
def fit_predict(build, tr, va, te, seed):
    keras.utils.set_random_seed(seed)
    m = build()
    m.compile(optimizer=keras.optimizers.AdamW(1e-3, weight_decay=1e-4),
              loss={'margin': keras.losses.Huber(10.0), 'win': 'binary_crossentropy', 'total': keras.losses.Huber(10.0), 'cover': 'binary_crossentropy'},
              loss_weights={'margin': 0.01, 'win': 1.0, 'total': 0.005, 'cover': 1.0})
    names = [t.name.split(':')[0] for t in m.inputs]
    pack = lambda idx: {n: ALL_IN[n][idx] for n in names}
    Y = lambda idx: {'margin': y_margin[idx], 'win': y_win[idx], 'total': y_total[idx], 'cover': y_cover[idx]}
    W = lambda idx: {'margin': np.ones(len(idx), 'float32'), 'win': w_win[idx], 'total': np.ones(len(idx), 'float32'), 'cover': w_cover[idx]}
    m.fit(pack(tr), Y(tr), sample_weight=W(tr), validation_data=(pack(va), Y(va), W(va)), epochs=100, batch_size=256, verbose=0,
          callbacks=[keras.callbacks.EarlyStopping(monitor='val_loss', patience=10, restore_best_weights=True)])
    p = m.predict(pack(te), verbose=0, batch_size=1024)
    # ATS at the OPEN line (open-safe input); fall back to NaN where there is no open
    lo = F.open_spread.values[te]; has = ~np.isnan(lo)
    inp = pack(te); inp['line'] = (np.nan_to_num(lo) / LSC)[:, None].astype('float32')
    pc = m.predict(inp, verbose=0, batch_size=1024)['cover'][:, 0]
    return p['margin'][:, 0], p['win'][:, 0], p['total'][:, 0], np.where(has, pc, np.nan)

MODELS = {'tower': tower_net, 'seq_gru': seq_net}
only = sys.argv[1:] or list(MODELS)
out = pd.DataFrame({'gid': F.gid, 'season': F.season})
usable = (F.season >= 2007).values & F.close_spread.notna().values
for name in only:
    for k in ('margin', 'win', 'total', 'cover_open'): out[f'{name}__{k}'] = np.nan
    for S in FOLDS:
        tr = np.where(usable & (F.season < S - 1).values)[0]; va = np.where(usable & (F.season == S - 1).values)[0]; te = np.where((F.season == S).values)[0]
        preds = [fit_predict(MODELS[name], tr, va, te, sd) for sd in SEEDS]
        for j, k in enumerate(('margin', 'win', 'total', 'cover_open')): out.loc[te, f'{name}__{k}'] = np.mean([p[j] for p in preds], 0)
        yy = y_margin[te]; rm = np.sqrt(np.mean((out.loc[te, f'{name}__margin'] - yy) ** 2))
        print(f'{name:8s} season {S}: train {len(tr)} val {len(va)} test margin rmse {rm:.2f}', flush=True)
    out[['gid', 'season'] + [c_ for c_ in out.columns if c_.startswith(name + '__')]].to_parquet(f'data/cache/nn_preds_{name}.parquet')
# merge every model's predictions that exist
parts = [pd.read_parquet(f'data/cache/nn_preds_{k}.parquet') for k in MODELS if os.path.exists(f'data/cache/nn_preds_{k}.parquet')]
m = parts[0]
for p in parts[1:]: m = m.merge(p.drop(columns='season'), on='gid')
m.to_parquet('data/cache/nn_preds.parquet')
print('saved', [c_ for c_ in m.columns])
