"""Shared loading + feature lists for the MLB research scripts."""
import os, warnings
os.environ.setdefault('KERAS_BACKEND', 'torch'); warnings.filterwarnings('ignore')
import numpy as np, pandas as pd
np.seterr(all='ignore')

SIDE = ['off', 'offh', 'rf', 'ra', 'win', 'bp', 'sp_fip', 'sp_k', 'sp_ip', 'sp_lbf', 'lu_exp', 'rest']
# moneyline stage 1 (open-safe): home-minus-away differences + a few one-sided context flags
ML_OPEN = [f'd_{k}' for k in SIDE] + ['home_sp_rest', 'away_sp_rest', 'home_sp_np', 'away_sp_np', 'home_dan', 'away_dan', 'night', 'park']
# totals stage 1 (open-safe): sums + park + league run environment
TOT_OPEN = [f's_{k}' for k in ['off', 'offh', 'rf', 'ra', 'bp', 'sp_fip', 'sp_k', 'sp_ip', 'lu_exp']] + ['park', 'park_x', 'night', 'lg_rpg', 'home_dan', 'away_dan']
LATE_ML = ['d_lu_delta', 'd_spc_fip', 'home_sp_chg', 'away_sp_chg', 'home_bp_np1', 'away_bp_np1', 'home_bp_np3', 'away_bp_np3']
LATE_TOT = ['s_lu_delta', 's_spc_fip', 's_bp_np1', 's_bp_np3', 'wx_temp', 'wx_out', 'wx_roof', 'ump']
FIRST_TRAIN = 2019          # 2018 is burn-in for the walk-forward state
TEST = [2024, 2025, 2026]   # holdout seasons with bettable single-book open + close

logit = lambda p: np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
sig = lambda z: 1 / (1 + np.exp(-z))
def ll(p, y):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6); y = np.asarray(y, float)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
def brier(p, y): return float(np.mean((np.asarray(p, float) - np.asarray(y, float)) ** 2))
def dec(a): return 1 + (a / 100 if a > 0 else 100 / -a)

def derive(F):
    """home-minus-away (d_) and sum (s_) columns + game-level extras; mirrored by flat() in mlb/lib/vas-engine.js"""
    for k in SIDE + ['sp_rest', 'sp_np', 'lu_conf', 'lu_delta', 'spc_fip', 'bp_np1', 'bp_np3', 'sp_chg', 'dan']:
        F['d_' + k] = F['home_' + k] - F['away_' + k]; F['s_' + k] = F['home_' + k] + F['away_' + k]
    F['night'] = F.home_night
    F['park_x'] = (F.park - 1) * F.lg_rpg * 2
    F['s_sp_lbf'] = F.home_sp_lbf + F.away_sp_lbf
    return F

def load(market=True):
    F = pd.read_parquet('data/cache/features.parquet')
    G = pd.read_parquet('data/cache/games.parquet')
    F = G.drop(columns=[c for c in G.columns if c.startswith('wx_')]).merge(F, on='pk')
    F = derive(F)
    F['rd'] = F.hs - F['as']
    if market:
        M = pd.read_parquet('data/cache/market.parquet').drop(columns=['season', 'y', 'total'])
        F = F.merge(M, on='pk', how='left')
    return F.sort_values(['day', 'start', 'pk']).reset_index(drop=True)
