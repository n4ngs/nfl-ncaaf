"""Shared math: odds conversion, no-vig, and the key-number-aware margin/total distribution used to turn a
spread or total into a probability (the CLV scoring model).

Choice (stated in README): a DISCRETE normal around the market's fair mean, re-weighted by empirical integer
frequencies so key numbers (3, 7, 10, 6, 14 for margins) carry their real mass:
    P(M = k | mu) ∝ phi((k - mu) / sd) * w_k            k integer
w_k and sd are fit on 2006-2013 games only (before any open-line season). The fair mean at the close is solved
so the model's cover probability at the closing number equals the closing no-vig probability (juice matters).
"""
import numpy as np
from scipy.stats import norm
from scipy.optimize import brentq

K = np.arange(-80, 121)                     # integer support (margins -80..120 covers totals 0..120 too)

def dec(a):
    a = float(a); return 1 + (a / 100 if a > 0 else 100 / -a)

def implied(a): return 1 / dec(a)

def novig2(a_home, a_away):
    """two-way no-vig probability of the first side; None if a price is missing or the pair is not a sane 2-way market"""
    if a_home is None or a_away is None or a_home != a_home or a_away != a_away: return None
    if abs(a_home) < 100 or abs(a_away) < 100: return None          # not an American price (ESPN sometimes stores 0 / decimals)
    p, q = implied(a_home), implied(a_away); s = p + q
    return p / s if 0.98 < s < 1.15 else None

logit = lambda p: np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
sig = lambda z: 1 / (1 + np.exp(-z))

class KeyDist:
    """discrete outcome distribution around a mean with fitted key-number weights"""
    def __init__(self, sd, w): self.sd = float(sd); self.w = np.asarray(w, float)
    @classmethod
    def fit(cls, outcome, line, lo=-80, hi=120, iters=3):
        outcome = np.asarray(outcome, float); line = np.asarray(line, float)
        sd = float(np.std(outcome - line))
        w = np.ones(len(K))
        for _ in range(iters):                                       # w_k = observed count / expected count
            dens = norm.pdf((K[None, :] - line[:, None]) / sd) * w[None, :]
            dens /= dens.sum(1, keepdims=True)
            exp_ = dens.sum(0); obs = np.array([(outcome == k).sum() for k in K], float)
            w = w * np.where(exp_ > 1e-9, (obs + 0.5) / (exp_ + 0.5), 1.0)
            w = np.clip(w, 0.02, 20)
        return cls(sd, w)
    def pmf(self, mu):
        d = norm.pdf((K - mu) / self.sd) * self.w; return d / d.sum()
    def probs(self, mu, line):
        """P(outcome > line), P(outcome == line)"""
        p = self.pmf(mu); return float(p[K > line].sum()), float(p[K == line].sum())
    def fair_mean(self, line, p_over_novig):
        """mean such that P(>line) / (P(>line)+P(<line)) == no-vig probability of the 'over' side (home cover / over)"""
        if p_over_novig is None: return float(line)
        f = lambda mu: (lambda a, b: a / max(1 - b, 1e-12))(*self.probs(mu, line)) - p_over_novig
        try: return brentq(f, line - 25, line + 25, xtol=1e-12)
        except ValueError: return float(line)
    def ev(self, mu_close, line_open, price_open, side_over):
        """expected ROI of a bet at line_open/price_open if the close's fair distribution is the truth (pushes refund)"""
        pw, pp = self.probs(mu_close, line_open)
        if not side_over: pw = 1 - pw - pp
        return pw * dec(price_open) + pp - 1
    def to_json(self): return {'sd': self.sd, 'k_min': int(K[0]), 'w': [round(float(x), 6) for x in self.w]}
