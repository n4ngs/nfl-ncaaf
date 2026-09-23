"""Keras neural networks (Keras 3, PyTorch backend), rolling origin by season.

TowerNet  multi-input MLP: shared per-side towers for STARTER / LINEUP+OFFENSE / BULLPEN / TEAM form, plus a
          game-context tower (park, night, league run level); heads: home win, run differential, total runs.
SeqNet    GRU encoders over each team's last 20 games and each PROBABLE starter's last 10 starts (shared weights for
          both sides) + the static towers; antisymmetric win/run-diff head (swap teams -> 1 - p), symmetric total head.
Predictions for season S come from nets trained on seasons < S-1 with season S-1 as the early-stopping set; 3 seeds.
Output: data/cache/nn_preds.parquet (p_tower, p_gru, mu_tower, mu_gru)
"""
from common import *
import sys, math, pickle, json, keras
from keras import layers, ops
import portable

G = pickle.load(open('data/cache/history.pkl', 'rb'))
F = load(market=False)
assert len(F) == len(G)
idx = {g['pk']: i for i, g in enumerate(G)}
F = F.set_index(F.pk.map(idx)).sort_index()
F = F.reset_index(drop=True)
assert (F.pk.values == np.array([g['pk'] for g in G])).all()
hands = portable.load()[1]

# ------------------------------------------------------------------ static towers
BLK = {'sp': ['sp_fip', 'sp_k', 'sp_ip', 'sp_lbf', 'sp_rest', 'sp_np', 'sp_L'], 'lu': ['lu_exp', 'off', 'offh'], 'bp': ['bp'],
       'tm': ['rf', 'ra', 'win', 'rest', 'dan']}
CTX = ['park', 'night', 'lg_rpg']
norm = (F.season <= 2020).values
static = {}
for k, names in BLK.items():
    H = F[[f'home_{n}' for n in names]].values.astype('float32'); A = F[[f'away_{n}' for n in names]].values.astype('float32')
    both = np.concatenate([H[norm], A[norm]]); mu, sd = both.mean(0), both.std(0) + 1e-6
    static[f'{k}_home'] = ((H - mu) / sd).astype('float32'); static[f'{k}_away'] = ((A - mu) / sd).astype('float32')
C = F[CTX].values.astype('float32'); static['ctx'] = ((C - C[norm].mean(0)) / (C[norm].std(0) + 1e-6)).astype('float32')

# ------------------------------------------------------------------ sequences (strictly before the game day)
NT, NP = 20, 10
day_o = np.array([portable.ordinal(g['day']) for g in G])
team_rows = {}; sp_rows = {}
for i, g in enumerate(G):
    for side, other in (('home', 'away'), ('away', 'home')):
        bx, ob = g['box'][side], g['box'][other]
        wn = wd = 0.0
        for b in bx['bat']:
            n_, d_ = portable.woba(b); wn += n_; wd += d_
        rel = bx['pit'][1:]; rbf = sum(p['bf'] for p in rel)
        sp = bx['pit'][0]; rs, ra = (g['hs'], g['as']) if side == 'home' else (g['as'], g['hs'])
        team_rows.setdefault(g[side], []).append((day_o[i], [rs, ra, float(rs > ra), wn / max(wd, 1), sum(portable.fipn(p) for p in rel) / max(rbf, 1),
                                                             portable.fipn(sp) / max(sp['bf'], 1), sp['outs'], float(side == 'home'), float(hands.get(ob['pit'][0]['id']) == 'L')]))
        sp_rows.setdefault(sp['id'], []).append((day_o[i], [sp['outs'], sp['bf'], sp['k'] / max(sp['bf'], 1), (sp['bb'] + sp['hbp']) / max(sp['bf'], 1),
                                                           sp['hr'] / max(sp['bf'], 1), sp['np'], sp['er'], float(side == 'home')]))
def seq_array(rows_of, key_of, N, width):
    out = {s: np.zeros((len(G), N, width + 1), 'float32') for s in ('home', 'away')}
    allr = np.array([r for v in rows_of.values() for d, r in v], 'float32'); mu, sd = allr.mean(0), allr.std(0) + 1e-6
    pos = {}
    for i, g in enumerate(G):
        for s in ('home', 'away'):
            k = key_of(g, s)
            if k is None or k not in rows_of: continue
            lst = rows_of[k]; p = pos.get(k, 0)
            while p < len(lst) and lst[p][0] < day_o[i]: p += 1
            pos[k] = p
            past = lst[max(0, p - N):p][::-1]
            for j, (d, r) in enumerate(past):
                out[s][i, j, :width] = (np.array(r, 'float32') - mu) / sd; out[s][i, j, width] = math.log1p(day_o[i] - d) - 2.0
    return out
seq_t = seq_array(team_rows, lambda g, s: g[s], NT, 9)
seq_p = seq_array(sp_rows, lambda g, s: g['prob'][s], NP, 8)
print('inputs ready', flush=True)

y_win = F.y.values.astype('float32'); y_rd = np.clip(F.rd.values, -8, 8).astype('float32'); y_tot = F.total.values.astype('float32')
INPUTS = {**static, 'seqt_home': seq_t['home'], 'seqt_away': seq_t['away'], 'seqp_home': seq_p['home'], 'seqp_away': seq_p['away']}

def towers():
    return {k: keras.Sequential([layers.Dense(16, activation='gelu'), layers.Dropout(0.1), layers.Dense(8, activation='gelu')], name=f'tower_{k}') for k in BLK}
def tower_net():
    ins = {f'{k}_{s}': keras.Input((len(BLK[k]),), name=f'{k}_{s}') for k in BLK for s in ('home', 'away')}; ins['ctx'] = keras.Input((len(CTX),), name='ctx')
    tw = towers(); feats = []
    for k in BLK:
        h, a = tw[k](ins[f'{k}_home']), tw[k](ins[f'{k}_away']); feats += [h, a, layers.Subtract()([h, a])]
    z = layers.Concatenate()(feats + [layers.Dense(8, activation='gelu')(ins['ctx'])]); z = layers.Dropout(0.25)(z)
    z = layers.Dense(32, activation='gelu', kernel_regularizer=keras.regularizers.l2(1e-4))(z); z = layers.Dropout(0.2)(z); z = layers.Dense(16, activation='gelu')(z)
    return keras.Model(ins, {'win': layers.Dense(1, activation='sigmoid', name='win')(z), 'rd': layers.Dense(1, name='rd')(z),
                             'tot': layers.Dense(1, activation='exponential', name='tot')(z)}, name='TowerNet')
def seq_net():
    ins = {f'{k}_{s}': keras.Input((len(BLK[k]),), name=f'{k}_{s}') for k in BLK for s in ('home', 'away')}; ins['ctx'] = keras.Input((len(CTX),), name='ctx')
    for s in ('home', 'away'):
        ins[f'seqt_{s}'] = keras.Input((NT, 10), name=f'seqt_{s}'); ins[f'seqp_{s}'] = keras.Input((NP, 9), name=f'seqp_{s}')
    def enc(n, w, units, name):
        x_in = keras.Input((n, w)); mask = ops.any(ops.not_equal(x_in, 0), axis=-1)
        x = layers.Dense(24, activation='gelu')(x_in); x = layers.GRU(units, recurrent_initializer='glorot_uniform')(x, mask=mask)
        return keras.Model(x_in, x, name=name)
    et, ep = enc(NT, 10, 32, 'enc_team'), enc(NP, 9, 24, 'enc_starter'); tw = towers()
    side = {s: layers.Concatenate()([et(ins[f'seqt_{s}']), ep(ins[f'seqp_{s}'])] + [tw[k](ins[f'{k}_{s}']) for k in BLK]) for s in ('home', 'away')}
    f = keras.Sequential([layers.Dropout(0.2), layers.Dense(32, activation='gelu'), layers.Dense(2)], name='matchup')
    g = keras.Sequential([layers.Dropout(0.2), layers.Dense(32, activation='gelu'), layers.Dense(1)], name='total')
    ha = layers.Concatenate()([side['home'], side['away']]); ah = layers.Concatenate()([side['away'], side['home']])
    diff = layers.Dense(2, name='bias')(layers.Subtract()([f(ha), f(ah)]))
    ctx = layers.Dense(1)(ins['ctx'])
    tot = layers.Activation('exponential', name='tot')(layers.Add()([g(ha), g(ah), ctx]))
    return keras.Model(ins, {'win': layers.Activation('sigmoid', name='win')(diff[:, 0:1]), 'rd': layers.Identity(name='rd')(diff[:, 1:2]), 'tot': tot}, name='SeqNet')

def fit_predict(build, tr, va, te, seed):
    keras.utils.set_random_seed(seed); m = build()
    m.compile(optimizer=keras.optimizers.AdamW(1e-3, weight_decay=1e-4), loss={'win': 'binary_crossentropy', 'rd': keras.losses.Huber(2.0), 'tot': 'poisson'},
              loss_weights={'win': 1.0, 'rd': 0.05, 'tot': 0.3})
    names = [t.name.split(':')[0] for t in m.inputs]
    pack = lambda ix: {n: INPUTS[n][ix] for n in names}; Y = lambda ix: {'win': y_win[ix], 'rd': y_rd[ix], 'tot': y_tot[ix]}
    m.fit(pack(tr), Y(tr), validation_data=(pack(va), Y(va)), epochs=60, batch_size=256, verbose=0,
          callbacks=[keras.callbacks.EarlyStopping(monitor='val_win_loss', patience=6, restore_best_weights=True, mode='min')])
    o = m.predict(pack(te), verbose=0, batch_size=2048); return o['win'][:, 0], o['tot'][:, 0]

MODELS = {'tower': tower_net, 'gru': seq_net}
only = sys.argv[1:] or list(MODELS)
out = pd.DataFrame({'pk': F.pk, 'season': F.season})
import os
if os.path.exists('data/cache/nn_preds.parquet'):
    prev = pd.read_parquet('data/cache/nn_preds.parquet').set_index('pk').reindex(F.pk)
    for c in prev.columns:
        if c != 'season' and c.split('_', 1)[1] not in only: out[c] = prev[c].values
for name in only:
    out['p_' + name] = np.nan; out['mu_' + name] = np.nan
    for S in range(2021, 2027):
        tr = np.where(((F.season >= FIRST_TRAIN) & (F.season < S - 1)).values)[0]; va = np.where((F.season == S - 1).values)[0]; te = np.where((F.season == S).values)[0]
        res = [fit_predict(MODELS[name], tr, va, te, sd) for sd in (1, 2, 3)]
        p = np.mean([r[0] for r in res], 0); mu = np.mean([r[1] for r in res], 0)
        out.loc[te, 'p_' + name] = p; out.loc[te, 'mu_' + name] = mu
        print(f'{name:6s} {S}: train {len(tr)} val {len(va)} logloss {ll(p, y_win[te]):.5f} total MAE {np.abs(mu - y_tot[te]).mean():.3f}', flush=True)
    out.to_parquet('data/cache/nn_preds.parquet')
print('saved')
