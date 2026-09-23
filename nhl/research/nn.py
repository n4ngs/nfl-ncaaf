"""Keras neural networks for the NHL vector model (Keras 3, PyTorch backend).

VectorNet  multi-input: one dense tower per vector (team / goalie / personnel+schedule) + a conv branch on the
           8-channel shot maps; multi-task heads (win, goal differential, 5v5 xG share).
SeqNet     learns team form directly from each side's last 20 games (GRU and Transformer encoders, shared weights for
           both teams), plus tonight's goalie/lineup/rest context; antisymmetric matchup head (swap teams -> 1 - p).
Rolling origin: predictions for season S come from networks trained only on seasons < S; the last training season is
the early-stopping validation set. Three seeds are averaged. Output: data/cache/nn_preds.parquet
"""
import os, sys, json, warnings
os.environ.setdefault('KERAS_BACKEND', 'torch'); warnings.filterwarnings('ignore')
import numpy as np, pandas as pd, keras
from keras import layers, ops

SEQ = 20; SEEDS = tuple(int(x) for x in os.environ.get('SEEDS', '1,2,3').split(',')); FOLDS = range(int(os.environ.get('FOLD_FROM', 2021)), 2026)
F = pd.read_parquet('data/cache/features.parquet')
X_map = np.load('data/cache/shotmaps.npy').transpose(0, 2, 3, 1)       # (n, 15, 17, 8) channels_last
games = pd.read_parquet('data/cache/games.parquet')
assert (games.gid.values == F.gid.values).all()
F['d'] = pd.to_datetime(F.date)

# ------------------------------------------------------------------ targets
tl = pd.read_parquet('data/cache/teamlog.parquet'); tl['side'] = np.where(tl.home_or_away == 'HOME', 'home', 'away')
ev = tl[tl.situation == '5on5'].set_index(['gameId', 'side'])
hx = ev.flurryScoreVenueAdjustedxGoalsFor.reindex(list(zip(F.gid, ['home'] * len(F)))).values
ax = ev.flurryScoreVenueAdjustedxGoalsAgainst.reindex(list(zip(F.gid, ['home'] * len(F)))).values
y_win = F.y.values.astype('float32')
y_gd = np.clip(F.home_goals - F.away_goals, -5, 5).values.astype('float32')
y_xs = (hx / (hx + ax)); y_xs = np.where(np.isfinite(y_xs), y_xs, 0.5).astype('float32')
w_xs = np.isfinite(hx / (hx + ax)).astype('float32')

# ------------------------------------------------------------------ static vector inputs
def cols(side, names): return [f'{side}_{n}' for n in names]
TEAM = ['ev_xgf', 'ev_xga', 'ev_hdf', 'ev_hda', 'pp_xgf', 'pk_xga', 'pp_toi_pg', 'pk_toi_pg', 'ev_finish', 'ev_saves', 'win_pg', 'all_gf_pg', 'all_ga_pg']
GOAL = ['g_gsax100', 'g_share20', 'g_b2b', 'g_rest']
PERS = ['lineup', 'lineup_shock', 'rest', 'b2b']
F['home_g_logshots'] = np.log1p(F.home_g_shots); F['away_g_logshots'] = np.log1p(F.away_g_shots); GOAL.append('g_logshots')
blocks = {'team': TEAM, 'goalie': GOAL, 'pers': PERS}
norm_mask = (F.season <= 2020).values                                        # scaling fit on early seasons only
static = {}
for k, names in blocks.items():
    for side in ('home', 'away'):
        a = F[cols(side, names)].replace([np.inf, -np.inf], np.nan).values.astype('float32')
        static[(k, side)] = a
    both = np.concatenate([static[(k, 'home')][norm_mask], static[(k, 'away')][norm_mask]])
    mu, sd = np.nanmean(both, 0), np.nanstd(both, 0) + 1e-6
    for side in ('home', 'away'):
        a = (static[(k, side)] - mu) / sd; static[(k, side)] = np.nan_to_num(a).astype('float32')

# ------------------------------------------------------------------ sequences: last 20 games per team
al = tl[tl.situation == 'all'].set_index(['gameId', 'side'])
ev5 = tl[tl.situation == '5on5'].set_index(['gameId', 'side'])
pp = tl[tl.situation == '5on4'].set_index(['gameId', 'side']); pk = tl[tl.situation == '4on5'].set_index(['gameId', 'side'])
team_games = {}
for g in F.itertuples():
    for side in ('home', 'away'):
        k = (g.gid, side)
        try:
            e, a, p, q = ev5.loc[k], al.loc[k], pp.loc[k], pk.loc[k]
        except KeyError:
            continue
        t60 = max(e.iceTime, 1) / 3600
        row = [e.flurryScoreVenueAdjustedxGoalsFor / t60, e.flurryScoreVenueAdjustedxGoalsAgainst / t60,
               e.highDangerxGoalsFor / t60, e.highDangerxGoalsAgainst / t60, p.xGoalsFor, q.xGoalsAgainst,
               p.iceTime / 60, q.iceTime / 60, a.goalsFor, a.goalsAgainst, float(a.goalsFor > a.goalsAgainst),
               float(side == 'home'), a.xGoalsAgainst - a.goalsAgainst]
        team_games.setdefault(getattr(g, side), []).append((g.d, g.season, np.array(row, 'float32')))
NS = 13 + 2
allrows = np.stack([r for v in team_games.values() for (_, s, r) in v if s <= 2020])
smu, ssd = allrows.mean(0), allrows.std(0) + 1e-6
seq = {side: np.zeros((len(F), SEQ, NS), 'float32') for side in ('home', 'away')}
ptr = {t: 0 for t in team_games}
for i, g in enumerate(F.itertuples()):
    for side in ('home', 'away'):
        t = getattr(g, side); lst = team_games.get(t, [])
        while ptr[t] < len(lst) and lst[ptr[t]][0] < g.d: ptr[t] += 1
        past = lst[max(0, ptr[t] - SEQ):ptr[t]]
        for j, (d, s, r) in enumerate(past[::-1]):                           # most recent first
            seq[side][i, j, :13] = (r - smu) / ssd
            seq[side][i, j, 13] = np.log1p((g.d - d).days) - 2.0             # recency (acts as a time position)
            seq[side][i, j, 14] = float(s != g.season)                       # previous-season game flag
print('inputs ready', {k: v.shape for k, v in seq.items()}, flush=True)

# ------------------------------------------------------------------ models
def heads(z, prefix):
    return {prefix + 'win': layers.Dense(1, activation='sigmoid', name=prefix + 'win')(z),
            prefix + 'gd': layers.Dense(1, name=prefix + 'gd')(z),
            prefix + 'xs': layers.Dense(1, activation='sigmoid', name=prefix + 'xs')(z)}

def vector_net():
    ins, feats = {}, []
    for k, names in blocks.items():
        h = keras.Input((len(names),), name=f'{k}_home'); a = keras.Input((len(names),), name=f'{k}_away')
        ins[f'{k}_home'], ins[f'{k}_away'] = h, a
        tower = keras.Sequential([layers.Dense(24, activation='gelu'), layers.Dropout(0.15), layers.Dense(12, activation='gelu')], name=f'tower_{k}')
        feats += [tower(h), tower(a), layers.Subtract()([tower(h), tower(a)])]
    m = keras.Input((15, 17, 8), name='maps'); ins['maps'] = m
    c = layers.Conv2D(16, 3, padding='same', activation='gelu')(m)
    c = layers.Conv2D(32, 3, padding='same', activation='gelu')(c); c = layers.MaxPooling2D()(c)
    c = layers.Conv2D(32, 3, padding='same', activation='gelu')(c); c = layers.GlobalAveragePooling2D()(c)
    z = layers.Concatenate()(feats + [c]); z = layers.Dropout(0.25)(z)
    z = layers.Dense(48, activation='gelu', kernel_regularizer=keras.regularizers.l2(1e-4))(z); z = layers.Dropout(0.25)(z)
    z = layers.Dense(16, activation='gelu')(z)
    return keras.Model(ins, heads(z, ''), name='VectorNet')

class MaskedMean(layers.Layer):
    def call(self, x, mask):
        m = ops.cast(ops.expand_dims(mask, -1), x.dtype)
        return ops.sum(x * m, 1) / (ops.sum(m, 1) + 1e-6)

def seq_net(kind):
    sh = keras.Input((SEQ, NS), name='seq_home'); sa = keras.Input((SEQ, NS), name='seq_away')
    ins = {'seq_home': sh, 'seq_away': sa}
    ctx = {}
    for side in ('home', 'away'):
        for k in ('goalie', 'pers'):
            ctx[(k, side)] = ins[f'{k}_{side}'] = keras.Input((len(blocks[k]),), name=f'{k}_{side}')
    # shared sequence encoder
    s_in = keras.Input((SEQ, NS)); mask = ops.any(ops.not_equal(s_in, 0), axis=-1)
    x = layers.Dense(32, activation='gelu')(s_in)
    if kind == 'gru':
        x = layers.GRU(48, recurrent_initializer='glorot_uniform')(x, mask=mask)
    else:
        att = layers.MultiHeadAttention(num_heads=4, key_dim=8, dropout=0.1)(x, x, attention_mask=ops.logical_and(ops.expand_dims(mask, 1), ops.expand_dims(mask, 2)))
        x = layers.LayerNormalization()(x + att)
        x = layers.LayerNormalization()(x + layers.Dense(32)(layers.Dense(64, activation='gelu')(x)))
        x = MaskedMean()(x, mask)
    enc = keras.Model(s_in, x, name=f'encoder_{kind}')
    c_in = keras.Input((len(blocks['goalie']) + len(blocks['pers']),))
    cenc = keras.Sequential([layers.Dense(16, activation='gelu')], name='context')
    th = layers.Concatenate()([enc(sh), cenc(layers.Concatenate()([ctx[('goalie', 'home')], ctx[('pers', 'home')]]))])
    ta = layers.Concatenate()([enc(sa), cenc(layers.Concatenate()([ctx[('goalie', 'away')], ctx[('pers', 'away')]]))])
    f = keras.Sequential([layers.Dropout(0.2), layers.Dense(32, activation='gelu'), layers.Dense(3)], name='matchup')
    diff = layers.Subtract()([f(layers.Concatenate()([th, ta])), f(layers.Concatenate()([ta, th]))])   # antisymmetric
    diff = layers.Dense(3, name='bias')(diff)   # learns home advantage + per-task scale
    out = {'win': layers.Activation('sigmoid', name='win')(diff[:, 0:1]), 'gd': layers.Identity(name='gd')(diff[:, 1:2]),
           'xs': layers.Activation('sigmoid', name='xs')(diff[:, 2:3])}
    return keras.Model(ins, out, name=f'SeqNet_{kind}')

def fit_predict(build, tr, va, te, seed):
    keras.utils.set_random_seed(seed)
    m = build()
    m.compile(optimizer=keras.optimizers.AdamW(1e-3, weight_decay=1e-4),
              loss={'win': 'binary_crossentropy', 'gd': keras.losses.Huber(1.0), 'xs': 'mse'},
              loss_weights={'win': 1.0, 'gd': 0.05, 'xs': 4.0})
    names = [t.name.split(':')[0] for t in m.inputs]
    pack = lambda idx: {n: {**{f'{k}_{s}': static[(k, s)] for k in blocks for s in ('home', 'away')}, 'maps': X_map, 'seq_home': seq['home'], 'seq_away': seq['away']}[n][idx] for n in names}
    Y = lambda idx: {'win': y_win[idx], 'gd': y_gd[idx], 'xs': y_xs[idx]}
    m.fit(pack(tr), Y(tr), validation_data=(pack(va), Y(va)), epochs=80, batch_size=256, verbose=0,
          callbacks=[keras.callbacks.EarlyStopping(monitor='val_win_loss', patience=8, restore_best_weights=True, mode='min')])
    return m.predict(pack(te), verbose=0, batch_size=1024)['win'][:, 0]

MODELS = {'vectornet': vector_net, 'seq_gru': lambda: seq_net('gru'), 'seq_transformer': lambda: seq_net('transformer')}
only = sys.argv[1:] or list(MODELS)
out = pd.DataFrame({'gid': F.gid, 'season': F.season})
if os.path.exists('data/cache/nn_preds.parquet'):
    prev = pd.read_parquet('data/cache/nn_preds.parquet')
    for c in prev.columns:
        if c.startswith('p_') and c[2:] not in only: out[c] = prev[c].values
usable = (F.season >= 2016).values & (seq['home'][:, 4, :].any(1)) & (seq['away'][:, 4, :].any(1))
for name in only:
    out['p_' + name] = np.nan
    for S in FOLDS:
        tr = np.where(usable & (F.season < S - 1).values)[0]; va = np.where(usable & (F.season == S - 1).values)[0]
        te = np.where((F.season == S).values)[0]
        p = np.mean([fit_predict(MODELS[name], tr, va, te, sd) for sd in SEEDS], 0)
        out.loc[te, 'p_' + name] = p
        yy = y_win[te]; ll = -np.mean(yy * np.log(p) + (1 - yy) * np.log(1 - p))
        print(f'{name:16s} season {S}: train {len(tr)} val {len(va)} test logloss {ll:.5f}', flush=True)
    out.to_parquet('data/cache/nn_preds.parquet')
print('saved')
