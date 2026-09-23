"""Keras 3 (PyTorch backend) networks for stage 1, rolling origin by season.

VectorNet  multi-input: one shared dense tower applied to the home and away team vectors (opponent-adjusted
           off/def ratings, market rating, QB, talent, returning production, rest), plus a context input;
           multi-task heads: margin (Huber), home win (BCE), total points (Huber).
SeqNet     GRU and Transformer encoders over each team's last 12 games (raw per-game off/def stats, points, the
           opponent's pre-game market rating, home flag, recency, previous-season flag), shared weights for both
           teams, antisymmetric matchup head (swap teams -> negated margin), plus context; same three heads.
Predictions for season S come only from networks trained on seasons < S; season S-1 is the early-stopping
validation set; 3 seeds averaged. Normalization stats come from 2014-2016 only. Output data/cache/nn_preds.parquet
"""
import os, sys, warnings
os.environ.setdefault('KERAS_BACKEND', 'torch'); warnings.filterwarnings('ignore')
import numpy as np, pandas as pd, keras
from keras import layers, ops
from features import walk, CFG, STATS
SEQ = 12; SEEDS = tuple(int(x) for x in os.environ.get('SEEDS', '1,2,3').split(','))
FOLDS = [int(x) for x in os.environ.get('FOLDS', '2018,2019,2020,2021,2022,2023,2024,2025').split(',')]
G = pd.read_parquet('data/cache/games.parquet'); Mk = pd.read_parquet('data/cache/market.parquet')
G = G[G.season <= 2025].merge(Mk[['gid', 'close']], on='gid', how='left').reset_index(drop=True)
cols = ['gid', 'season', 'start', 'neutral', 'conf_game', 'home_id', 'away_id', 'home_pts', 'away_pts', 'home_fbs', 'away_fbs', 'home_qb', 'away_qb', 'close'] + [f'{s}_{k}' for s in ('home', 'away') for k in STATS if k != 'pts']
recs = G[cols].to_dict('records')
for r in recs:
    if r['close'] != r['close']: r['close'] = None
feats, _ = walk(recs, CFG, keep_sides=True)
Fp = pd.read_parquet('data/cache/features.parquet').set_index('gid')
SIDE = [f'{s}_{k}' for k in STATS for s in ('o', 'd')] + ['mkt', 'rest', 'n', 'qb_starts', 'qb_pepa']
def side_mat(side):
    a = np.array([[feats[g]['_' + side][k] for k in SIDE] for g in G.gid], 'float32')
    extra = np.c_[Fp.loc[G.gid, side + '_tz'].values, Fp.loc[G.gid, side + '_ret_off'].fillna(0.5).values, Fp.loc[G.gid, side + '_ret_def'].fillna(0.5).values, G[side + '_fbs'].values]
    return np.c_[a, extra].astype('float32')
H, A = side_mat('home'), side_mat('away')
norm = (G.season <= 2016).values
mu = np.nanmean(np.r_[H[norm], A[norm]], 0); sd = np.nanstd(np.r_[H[norm], A[norm]], 0)
# columns that do not vary in 2014-16 (returning production / QB history not yet populated) take 2014-17 stats
n2 = (G.season <= 2017).values; flat = sd < 1e-3
mu[flat] = np.nanmean(np.r_[H[n2], A[n2]], 0)[flat]; sd[flat] = np.nanstd(np.r_[H[n2], A[n2]], 0)[flat]; sd = np.maximum(sd, 1e-3)
H = np.clip(np.nan_to_num((H - mu) / sd), -6, 6).astype('float32'); A = np.clip(np.nan_to_num((A - mu) / sd), -6, 6).astype('float32')
CTX = np.c_[1 - G.neutral, G.conf_game, (G.week <= 4) & (G.stype == 2), G.stype == 3, np.minimum(G.week, 16) / 16].astype('float32')
y_m = (G.home_pts - G.away_pts).values.astype('float32') / 14.0
y_w = ((G.home_pts - G.away_pts) > 0).values.astype('float32')
y_t = ((G.home_pts + G.away_pts).values.astype('float32') - 55.0) / 15.0

# ---------------- sequences: each team's last SEQ games before this one
PG = ['pts'] + [k for k in STATS if k != 'pts']
tg = {}
dates = pd.to_datetime(G.start).dt.tz_localize(None).values
for i, g in enumerate(G.itertuples()):
    f = feats[g.gid]
    for side, other in (('home', 'away'), ('away', 'home')):
        t = getattr(g, side + '_id')
        row = [getattr(g, side + '_pts')] + [getattr(g, f'{side}_{k}') for k in PG[1:]] + [getattr(g, other + '_pts')] + [getattr(g, f'{other}_{k}') for k in PG[1:]]
        row += [f['_' + other]['mkt'], float(side == 'home' and not g.neutral)]
        tg.setdefault(t, []).append((dates[i], g.season, np.array(row, 'float32')))
NRAW = 2 * len(PG) + 2; NS = NRAW + 2
allrows = np.stack([r for v in tg.values() for (d, s, r) in v if s <= 2016])
smu, ssd = np.nanmean(allrows, 0), np.nanstd(allrows, 0) + 1e-6
seq = {s: np.zeros((len(G), SEQ, NS), 'float32') for s in ('home', 'away')}
ptr = {t: 0 for t in tg}
for i, g in enumerate(G.itertuples()):
    for side in ('home', 'away'):
        t = getattr(g, side + '_id'); lst = tg[t]
        while ptr[t] < len(lst) and lst[ptr[t]][0] < dates[i]: ptr[t] += 1
        past = lst[max(0, ptr[t] - SEQ):ptr[t]]
        for j, (d, s, r) in enumerate(past[::-1]):
            seq[side][i, j, :NRAW] = np.clip(np.nan_to_num((r - smu) / ssd), -6, 6)
            seq[side][i, j, NRAW] = np.log1p((dates[i] - d) / np.timedelta64(1, 'D')) - 3.0
            seq[side][i, j, NRAW + 1] = float(s != g.season)
print('inputs ready', H.shape, seq['home'].shape, flush=True)

def heads(z):
    return {'margin': layers.Dense(1, name='margin')(z), 'win': layers.Dense(1, activation='sigmoid', name='win')(z), 'total': layers.Dense(1, name='total')(z)}
def vector_net():
    h = keras.Input((H.shape[1],), name='home'); a = keras.Input((A.shape[1],), name='away'); c = keras.Input((CTX.shape[1],), name='ctx')
    tower = keras.Sequential([layers.Dense(32, activation='gelu'), layers.Dropout(0.2), layers.Dense(16, activation='gelu')], name='team_tower')
    th, ta = tower(h), tower(a)
    z = layers.Concatenate()([th, ta, layers.Subtract()([th, ta]), c]); z = layers.Dropout(0.25)(z)
    z = layers.Dense(32, activation='gelu', kernel_regularizer=keras.regularizers.l2(1e-4))(z); z = layers.Dense(16, activation='gelu')(z)
    return keras.Model({'home': h, 'away': a, 'ctx': c}, heads(z), name='VectorNet')
class MaskedMean(layers.Layer):
    def call(self, x, mask):
        m = ops.cast(ops.expand_dims(mask, -1), x.dtype); return ops.sum(x * m, 1) / (ops.sum(m, 1) + 1e-6)
def seq_net(kind):
    sh = keras.Input((SEQ, NS), name='seq_home'); sa = keras.Input((SEQ, NS), name='seq_away')
    h = keras.Input((H.shape[1],), name='home'); a = keras.Input((A.shape[1],), name='away'); c = keras.Input((CTX.shape[1],), name='ctx')
    s_in = keras.Input((SEQ, NS)); mask = ops.any(ops.not_equal(s_in, 0), axis=-1)
    x = layers.Dense(32, activation='gelu')(s_in)
    if kind == 'gru':
        x = layers.GRU(32, recurrent_initializer='glorot_uniform')(x, mask=mask)   # orthogonal init needs QR, not on MPS
    else:
        att = layers.MultiHeadAttention(num_heads=4, key_dim=8, dropout=0.1)(x, x, attention_mask=ops.logical_and(ops.expand_dims(mask, 1), ops.expand_dims(mask, 2)))
        x = layers.LayerNormalization()(x + att); x = layers.LayerNormalization()(x + layers.Dense(32)(layers.Dense(64, activation='gelu')(x))); x = MaskedMean()(x, mask)
    enc = keras.Model(s_in, x, name='encoder_' + kind)
    vt = keras.Sequential([layers.Dense(16, activation='gelu')], name='vec')
    th = layers.Concatenate()([enc(sh), vt(h)]); ta = layers.Concatenate()([enc(sa), vt(a)])
    f = keras.Sequential([layers.Dropout(0.2), layers.Dense(32, activation='gelu'), layers.Dense(3)], name='matchup')
    diff = layers.Subtract()([f(layers.Concatenate()([th, ta])), f(layers.Concatenate()([ta, th]))])   # antisymmetric in the teams
    z = layers.Concatenate()([diff, layers.Dense(8, activation='gelu')(c)])
    return keras.Model({'seq_home': sh, 'seq_away': sa, 'home': h, 'away': a, 'ctx': c}, heads(z), name='SeqNet_' + kind)
DATA = {'home': H, 'away': A, 'ctx': CTX, 'seq_home': seq['home'], 'seq_away': seq['away']}
def fit_predict(build, tr, va, te, seed):
    keras.utils.set_random_seed(seed); m = build()
    m.compile(optimizer=keras.optimizers.AdamW(1e-3, weight_decay=1e-4), loss={'margin': keras.losses.Huber(1.0), 'win': 'binary_crossentropy', 'total': keras.losses.Huber(1.0)},
              loss_weights={'margin': 1.0, 'win': 0.5, 'total': 0.3})
    names = [t.name.split(':')[0] for t in m.inputs] if not isinstance(m.input, dict) else list(m.input.keys())
    pack = lambda idx: {n: DATA[n][idx] for n in names}
    Y = lambda idx: {'margin': y_m[idx], 'win': y_w[idx], 'total': y_t[idx]}
    m.fit(pack(tr), Y(tr), validation_data=(pack(va), Y(va)), epochs=80, batch_size=128, verbose=0,
          callbacks=[keras.callbacks.EarlyStopping(monitor='val_margin_loss', patience=8, restore_best_weights=True, mode='min')])
    p = m.predict(pack(te), verbose=0, batch_size=1024)
    return p['margin'][:, 0] * 14.0, p['win'][:, 0]
MODELS = {'vectornet': vector_net, 'seq_gru': lambda: seq_net('gru'), 'seq_transformer': lambda: seq_net('transformer')}
only = sys.argv[1:] or list(MODELS)
out = pd.DataFrame({'gid': G.gid, 'season': G.season})
if os.path.exists('data/cache/nn_preds.parquet'):
    prev = pd.read_parquet('data/cache/nn_preds.parquet')
    for c in prev.columns:
        if c not in ('gid', 'season') and c.split('_', 1)[1] not in only: out[c] = prev[c].values
usable = (G.season >= 2015).values
for name in only:
    out['m_' + name] = np.nan; out['p_' + name] = np.nan
    for S in FOLDS:
        va_s = S - 1 if S - 1 != 2020 else 2019
        tr = np.where(usable & (G.season < S).values & (G.season != va_s).values)[0]; va = np.where((G.season == va_s).values)[0]; te = np.where((G.season == S).values)[0]
        ps = [fit_predict(MODELS[name], tr, va, te, sd) for sd in SEEDS]
        out.loc[te, 'm_' + name] = np.mean([p[0] for p in ps], 0); out.loc[te, 'p_' + name] = np.mean([p[1] for p in ps], 0)
        yy = y_m[te] * 14
        print(f'{name:16s} season {S}: train {len(tr)} val {len(va)} test margin RMSE {np.sqrt(np.mean((yy - out.loc[te, "m_" + name]) ** 2)):.3f}', flush=True)
    out.to_parquet('data/cache/nn_preds.parquet')
print('saved')
