# NFL VAS: closing-line research pipeline

This is offline research for the NFL VAS / Injury Matrix model. None of it runs in the app yet. It copies the NHL
pipeline (`nhl/research`): open-safe features, rolling origin by season, a stage-1 fundamentals model, a stage-2
line-movement model, and bets at the OPEN price scored against the no-vig CLOSE. The production model is linear, and
`nfl/lib/vas-engine.js` reproduces its features exactly (parity to 1e-15).

## Run (in order, from `nfl/research`)
```sh
python3 -m venv .venv && .venv/bin/pip install numpy pandas pyarrow scikit-learn scipy torch keras   # or reuse nhl/research/.venv
./fetch_nflverse.sh                              # nflverse pbp 2006-26, injuries 2009-26, snap counts 2012-26, players (gh CLI, resumable)
.venv/bin/python fetch_espn.py                   # ESPN core odds for every game 2006-26 (resumable, ~3 min, 6 threads)
.venv/bin/python prep.py                         # compact tables + market (open/close) + per-book leak check -> data/cache
.venv/bin/python tune.py                         # feature hyper-parameters, chosen on 2009-2013 ONLY -> cfg_override.json
.venv/bin/python features.py                     # walk-forward features (portable + late-news) -> features.parquet
.venv/bin/python proof.py                        # stage 1 (ridge+GBM+Keras MLP) + stage 2 + CLV proof -> proof.json
KERAS_BACKEND=torch .venv/bin/python nn.py tower & KERAS_BACKEND=torch .venv/bin/python nn.py seq_gru   # Keras TowerNet / GRU
.venv/bin/python nn_report.py                    # do the Keras nets help?
.venv/bin/python ablate.py                       # feature-group ablation + lag-1 sensitivity (portable math)
.venv/bin/python late.py                         # late-news variants (QB change, injury report, inactives, weather)
.venv/bin/python open_timing.py                  # when is the ESPN "open" posted? (diagnostic)
.venv/bin/python portable.py                     # the shipped linear model: holdout proof, tiers, final fit, export
.venv/bin/python sensitivity.py                  # robustness of the portable result
PARITY=2023 .venv/bin/python features.py         # Node parity fixture (history from 2023) -> data/cache/parity/
.venv/bin/python portable.py                     # re-run once so parity/model_py.json matches the fixture
cd ../.. && node --test tests/nfl-vas.test.js    # synthetic tests + exact parity (parity skips if the fixture is absent)
```
`data/` is git-ignored. The final model is `data/cache/nfl-vas-model.json`.

## Data sources (free, no login)
| what | where |
|---|---|
| games, scores, rest, roof, starting QBs, **closing** lines + juice | `https://github.com/nflverse/nfldata/raw/master/data/games.csv` (same as nflverse-data release `schedules/games.csv`) |
| play-by-play with EPA / success / wp | `gh release download pbp -R nflverse/nflverse-data` → `play_by_play_<yr>.parquet` (`.csv.gz` for Node) |
| snap counts (personnel) | release `snap_counts` → `snap_counts_<yr>` (2012 is a stub; full from 2013) |
| injury report designations | release `injuries` → `injuries_<yr>` (final weekly report status, 2009+) |
| pfr ↔ gsis ids | release `players` → `players.parquet` |
| **opening** lines | `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{id}/competitions/{id}/odds?limit=100` (the ESPN id is in games.csv) |

**Which line each file holds.** nflverse `spread_line` is home-favoured-positive (home covers if `result > spread_line`).
It is a closing consensus: it matches ESPN's "consensus" provider exactly in 63-72% of 2017-22 games, within 0.2 pts on
average, and its juice is real (only 4-37% of games at -110). The ESPN open coverage is uneven:

| seasons | ESPN open source | games with open |
|---|---|---|
| 2006-2013 | none | 0 |
| 2014-2016 | `Opening` provider (= `initialSpread`/`initialOverUnder` on every offshore book), its own juice | 267 / season |
| 2017-2022 | none (current = final numbers only) | 0 |
| 2023 | ESPN BET `open` block (partial) | 192 |
| 2024 | ESPN BET `open` | 284 |
| 2025 | ESPN BET, else DraftKings `open` | 285 |
| 2026 wk 1-2 | DraftKings `open` | 32 |

Other free open-line archives turned out to be unusable. SportsbookReviewsOnline's archive returns 404 everywhere.
AusSportsBetting's `nfl.xlsx` sits behind a Cloudflare browser challenge, and I did not impersonate a browser to get past it.

## Data traps found (do not reintroduce)
- **ESPN "... - Live Odds" providers are in-game prices.** Their spread MAE vs the final margin is 2.97-3.13, while every
  pregame book sits at about 9-10.5. `prep.py` scores every book (`books.json`) so a leak like this is caught. Only the
  `Opening` provider and the ESPN BET / DraftKings / MGM `open` blocks are used.
- **ESPN BET's `close` block is corrupt in 2022-23.** Its `pointSpread` holds the spread juice (e.g. -115), not the line.
  It is used from 2024 only, and only as a sensitivity check.
- **ESPN's 2012-16 "consensus" provider is the opener, not the close.** It differs from nflverse by 1.4-2.9 pts MAE.
- Some books' "current" numbers are post-kickoff captures. "Caesars Sportsbook" has a spread MAE of 5.07 in 2017 and
  8.50 in 2018, against 10.08 / 9.87 for the close in the same seasons. "current" is never used.
- ESPN sometimes stores 0 or decimal values in American-odds fields. `novig2` rejects |odds| < 100. A bad open juice is
  imputed as -110/-110 and flagged (1 spread game, 0 total games).
- **Team codes.** games.csv keeps STL/SD/OAK, while nflverse pbp uses LA/LAC/LV for every season, so 542 games
  mismatched until the franchise map. Snap counts and injuries follow games.csv (0 mismatches). ESPN rows join by event
  id, never by name. With the map: 5,463/5,463 games have plays, and 100% of 2013-26 games have snap counts.
- The nflverse `home_rest` column collides with the feature name and is renamed `nv_home_rest`.
- ESPN edge servers 403 some custom User-Agents. Python urllib's default UA works.
- Features that are constant in a training fold (for example short-week diffs in 2007-09, or snap shares before 2013)
  must not be divided by a ~0 std. That made the Keras MLP diverge (RMSE 8.5 million) until the std was floored.

## Method
- **Probability model for spreads and totals.** Chosen over a plain normal: a discrete normal around the market's fair
  mean, re-weighted by empirical integer frequencies, fit on 2006-2013 closes only (margin sd 13.66, w(3)=3.06,
  w(7)=1.91; total sd 13.50). The fair mean of a line is solved so that P(over)/(1-P(push)) equals the no-vig
  probability from that line's own juice. **CLV EV** = P_close(win at the open number)·decimal_open_price +
  P_close(push) − 1. Bets are priced at the book's actual open juice. As a sensitivity check, a plain normal gives the
  same conclusions.
- **Open-safe features** (`features.py`, mirrored by Node): exponentially weighted (half-life 16 games, 25% carried
  over the summer), shrunk, single-pass opponent-adjusted EPA/play for pass and rush on offense and defense; success
  rate; special-teams EPA; points; pace; pass rate. Garbage time (wp outside 0.05-0.95) is excluded. **QB**: the
  projected starter is last game's starter; his EPA/dropback is opponent-adjusted, decayed per dropback, and shrunk
  toward replacement level (league −0.15); plus experience and start share. **Personnel**: expected snap share of the
  regulars who did not play the team's last game, by group (QB, OL, WR, TE, RB, DL, LB, DB). **Schedule**: rest, bye,
  short week, time-zone shift, west-coast team in an early kick, neutral site, division game, dome.
  Hyper-parameters were tuned on 2009-2013 only (`tune.py`; the gain was small, 14.016 → 13.987 RMSE).
- **Rolling origin.** Stage 1 for season S is fit on 2007..S-1. Stage 2 is fit only on open-line seasons before S.
  Test seasons: 2016, 2023, 2024, 2025 (1,028 games with open and close). 2026 wk 1-2 is a forward peek. Neural nets
  early-stop on S-1, and their input scaling comes from ≤2012 only.

## Results

### Models vs the market (pooled holdout 2016+2023-25, 1,025 non-tie games)
| predictor | win log loss | win Brier | margin RMSE | ATS log loss (close line) | total RMSE |
|---|---|---|---|---|---|
| stage-1 ridge (portable) | 0.6301 | 0.2204 | 12.72 | – | – |
| stage-1 GBM | 0.6354 | 0.2224 | 12.89 | – | – |
| stage-1 Keras MLP | 0.6366 | 0.2227 | 12.81 | – | – |
| stage-1 aggregate | 0.6313 | 0.2206 | 12.74 | 0.7147 | 13.11 |
| market OPEN (fair) | 0.6158 | 0.2134 | 12.45 | 0.6983 | 12.98 |
| **market CLOSE (fair)** | **0.6115** | **0.2117** | **12.29** | **0.6938** | **12.92** |

The fundamentals do not beat the open or the close on outcomes, which is the same as in the NHL. Across 2009-2026 the
stage-1 margin RMSE runs 0.1-0.6 pts behind the close in every season.

### Closing-line proof: full models (`proof.py`, stage 2 = ridge + GBM + Keras MLP), 12 rules, Bonferroni ×12
| market | rule | thr | bets | CLV EV | p | Bonf. p | beat close (p) | CLV pts | ROI (90% CI) | 2016 / 2023 / 2024 / 2025 EV |
|---|---|---|---|---|---|---|---|---|---|---|
| spread | predicted move | 0.5 | 399 | −1.90% | 1 | 1 | 61.7% (2e-5) | +0.42 | −6.8% [−14.6, 1.0] | −0.6 / −3.2 / −2.3 / −1.9 |
| spread | predicted move | 0.75 | 226 | −1.08% | 0.94 | 1 | 65.0% (4e-5) | +0.52 | −1.7% [−12.3, 8.3] | +1.2 / −3.2 / −1.9 / −2.1 |
| spread | predicted move | 1.0 | 109 | −1.87% | 0.96 | 1 | 60.2% (0.035) | +0.45 | +4.1% [−10.6, 19.3] | +1.5 / −3.6 / −4.1 / −2.7 |
| spread | model−open gap | 2/3/4 | 468/280/163 | −2.17/−1.01/−1.38% | ≥0.94 | 1 | 61-66% | +0.3-0.5 | noise | only 2016 positive |
| total | predicted move | 0.75 | 322 | +1.31% | 0.0073 | 0.088 | 75.9% (8e-19) | +0.94 | −0.3% [−8.9, 8.7] | +4.2 / −0.4 / +0.4 / +2.1 |
| total | predicted move | 1.0 | 186 | +1.65% | 0.013 | 0.16 | 75.3% (2e-11) | +1.03 | −11.0% [−22.3, 0.2] | +6.1 / −0.6 / +1.5 / +1.4 |
| total | predicted move | 1.5 | 43 | **+4.76%** | 0.0020 | **0.024** | 89.7% (2e-7) | +1.41 | −19.8% [−46, 3] | +10.1 / +2.4 / +4.5 / +0.1 |
| total | model−open gap | 3/4/5 | 300/181/91 | −2.7/−2.1/−0.9% | ≥0.77 | 1 | 57-67% | +0.2-0.5 | noise | |

Stage-2 correlation between predicted and actual move: spread 0.24 / 0.03 / 0.15 / 0.09 (2016 / 2023 / 2024 / 2025),
total 0.47 / 0.27 / 0.29 / 0.31.

### The shipped portable model (`portable.py`, ridge only, exactly what Node runs), 20 rules in total, Bonferroni ×20
Pre-set criteria for PROVEN: Bonferroni p < 0.05, pooled EV > 0, EV > 0 in at least 3 of the 4 test seasons, and ≥ 100 bets.

| market | |pred move| ≥ | bets | CLV EV | p | Bonf. p | beat close | 2016 / 2023 / 2024 / 2025 | 2026 wk1-2 | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| spread | 0.25 / 0.5 / 0.75 / 1.0 | 694 / 439 / 284 / 164 | −2.8 / −2.1 / −1.7 / −2.1% | ≥0.99 | 1 | 58-65% | negative in every season | +1.5% n=18 | **UNPROVEN** |
| total | 0.5 | 578 | +0.63% | 0.064 | 1 | 72.4% | +3.3 / −0.6 / −0.3 / +0.0 | −2.4% n=19 | no |
| total | 0.75 | 378 | +1.16% | 0.014 | 0.28 | 74.7% | +3.8 / +0.2 / +0.2 / +0.4 | +0.4% n=10 | LEAN |
| total | **1.0** | **238** | **+1.96%** | **0.0018** | **0.036** | 77.4% | +3.9 / +1.2 / +0.4 / +2.9 | −0.3% n=6 | **PROVEN (pre-set criteria)** |
| total | 1.5 | 94 | +3.57% | 0.0006 | 0.012 | 83.3% | +6.8 / +1.0 / +4.4 / −0.4 | n=1 | (<100 bets) |

**Sensitivity of the one passing rule** (`sensitivity.py`, totals, |pred move| ≥ 1.0):
| check | bets | CLV EV | p |
|---|---|---|---|
| default (key-number distribution, consensus close) | 238 | +1.96% | 0.0018 |
| plain normal, no key numbers | 238 | +1.48% | 0.011 |
| every open priced at a flat -110 (recorded open juice ignored) | 238 | +1.82% | 0.0045 |
| 2016 offshore opener only | 67 | +3.94% | 0.0006 |
| **2023-25 book opens only (the live-relevant era)** | **171** | **+1.19%** | **0.070** |
| 2024-25 vs consensus close | 120 | +1.19% | 0.11 |
| 2024-25 vs the same book's own close | 120 | +1.05% | 0.14 |
| random sides on the same games (permutation) | – | −4.39% mean | perm. p < 0.002 |
| every feature lagged one game (`ablate.py`) | 119 | +0.91% | 0.17 |

How to read this: the totals rule clears the pre-set bar on the pooled holdout, but most of the evidence comes from
2016's offshore openers. On the 2023-25 book opens alone it is positive in every season and beats the close on direction
75% of the time, yet the EV is not significant (p = 0.07). **Treat it as a provisional, unconfirmed edge.** The spread
model predicts the direction of the line move (61-66% beat-close, p < 1e-4) but never clears the vig. That is the same
pattern as the NHL's looser thresholds.

### Which inputs carry it (`ablate.py`, portable ridge)
- **Totals.** No single group is essential: dropping team EPA, scoring/ST, style, QB or venue leaves ≥1.0 at
  +1.3-1.9%. The stage-2 context matters more than the gap. Gap only gives corr 0.24 and +1.76% (p = 0.046, negative
  in 2 seasons); the full set gives corr 0.33 and +1.96%. The largest standardized stage-2 weights are the open total
  itself (−0.74) and the teams' combined points (+0.44), pass defense (+0.44), dome (+0.30) and QB (+0.30). In words:
  the open total drifts toward what the teams' scoring profile implies.
- **Spreads.** Every variant is negative after vig. Team EPA alone does about as well as all groups.
- **Timing.** When every feature is lagged one game, the totals edge falls to +0.24% / +0.91% (not significant), so it
  depends on last game's information being newer than the open. `open_timing.py` shows the open→close move tracks the
  previous game's ATS surprise in both eras: slope +0.02 pts per point for spreads, +0.016 (2014-16) and +0.025
  (2023-25) for totals. That fits either a market that under-reacts at the open or opens posted before the previous
  game. The data here cannot separate the two, so **the live app must measure CLV from its own first-seen price after
  the previous game is final.**

### Late news (`late.py`, not open-safe; bets priced at the open = an upper bound, not actionable)
| added to stage 2 | spread corr | spread ≥1.0 EV (n) | total corr | total ≥1.0 EV (n) |
|---|---|---|---|---|
| open-safe only | 0.153 | −1.13% (168) | 0.315 | +1.44% (237) |
| confirmed QB / QB change | 0.382 | +2.13% (251) | 0.388 | +2.34% (286) |
| Friday injury report (Injury Matrix) | 0.364 | +2.07% (272) | 0.395 | +2.60% (282) |
| inactives proxy (this game's snaps) | 0.432 | +3.02% (281) | 0.414 | +3.02% (295) |
| weather (wind/temp/precip) | 0.151 | −0.99% (165) | 0.343 | +1.92% (258) |
| all late news | 0.506 | +3.58% (307) | 0.469 | +4.20% (302) |

News explains the move: QB news alone explains R² 0.09 of the spread move, injury news 0.13, inactives 0.11. But the
market reacts to the same news, and with free data there is no price between open and close, so these rows only say
"if you knew Friday's report on Sunday night". They are **not** evidence of beating the close. P(miss | status) is
calibrated on 2013-19 regulars: Out 1.00, Doubtful 0.99, Questionable 0.35, Probable 0.06. The Injury Matrix display
weights in points of margin per unit of missing expected snap share are QB 3.8, RB 2.3, LB 1.3, WR 1.1, DB 0.7,
DL 0.4, OL 0.4, TE −0.2. They are descriptive and noisy.

### Keras (`nn.py`, `nn_report.py`): do the networks help?
- **TowerNet**: shared dense towers for offense, defense, QB and personnel+schedule, applied to home and away and then
  differenced. **GRU SeqNet**: a shared GRU over each team's last 10 games (raw EPA, success, points, pace, ST, the
  opponent's pre-game ratings, recency), with QB and personnel context and an antisymmetric matchup head. Both are
  multi-task (margin, win, total, and ATS P(margin > line) with the line as input: trained on the close, scored at the
  open). Each averages 3 seeds, early-stops on S-1, and scales inputs on ≤2012 only.

| stage 1, 2014-2025 (3,284 games) | margin RMSE | win log loss | total RMSE |
|---|---|---|---|
| ridge (portable) | 13.262 | 0.6303 | 13.523 |
| GBM | 13.397 | 0.6391 | 13.645 |
| Keras MLP | 13.341 | 0.6366 | 13.548 |
| Keras TowerNet | 13.233 | 0.6323 (win head 0.6304) | 13.709 |
| Keras GRU SeqNet | 13.360 | 0.6389 (win head 0.6432) | 13.525 |
| ridge + GBM + MLP (proof aggregate) | 13.251 | 0.6320 | – |
| mean of all 5 | **13.207** | 0.6309 | **13.462** |
| ridge stacker fit on earlier seasons | 13.242 | 0.6307 | – |
| market close | 12.874 | 0.6118 | 13.239 |

- The networks are about as good as ridge, not better. Averaging all five helps a little (−0.05 RMSE). ATS at the open
  number: the TowerNet head reaches log loss 0.6951 and the GRU head 0.7135, against 0.6941 for the market open line
  itself. Neither beats the market.
- Downstream **spreads**: every stage-1 variant, including the Keras ones and the stacker, leaves stage-2 CLV EV at −1.4%
  to −2.3%. The nets do not help there.
- Downstream **totals** (|move| ≥ 1.0): ridge +1.96% (n=238, p=0.002), proof aggregate +1.72%, TowerNet +1.84%,
  mean-of-5 +1.97%, **GRU +2.39% (n=238, p<0.001; seasons +4.2/+1.8/+1.1/+3.0)**. The GRU is the only network that
  adds anything: it lifts the modern seasons. It is one more rule tried after the fact, and it cannot run in
  zero-dependency Node, so production stays ridge. It is a candidate for the next iteration.

### Loader (`nfl/lib/vas-data.js`)
`create({dir, fetchBuffer, now, log})` returns `history(season)` (games, plays and snaps for S-2..S in the engine's format,
plus `complete` and `info`), `upcoming(season)` (unplayed schedule rows for `featuresFor`) and `status()`. The season is
the calendar year from March onward.
- **Refresh:** past seasons are fetched once, and again only if the cached copy predates March of the following year. The
  current season's pbp, snaps and schedule are refreshed at most every 12 h. A failed URL is retried at most once an
  hour, and the cache is kept with `lastError` set.
- **Parsing:** the gzip is streamed, only the needed CSV fields are picked, and kept strings are interned as flat copies.
  Without that, V8 substrings pin every decoded 1 MB chunk. The filters are identical to prep.py (compactPlay).
- **Measured on 2023-25:**
  - Each 19 MB pbp gz parses in about 0.35-0.6 s, and all 3 seasons cold take about 1.3 s.
  - Compact cache: about 0.87 MB per pbp season, 0.42 MB per snaps season and 0.13 MB for the schedule. A warm start from
    the cache takes about 70 ms.
  - It runs under a 96 MB V8 heap cap (peak RSS 175 MB). Uncapped, lazy GC reaches about 264 MB.
- **Parity:** loader → engine matches the Python features on all 285 games of 2025 (max difference 4.4e-15).

## Node runtime (`nfl/lib/vas-engine.js`, zero dependencies)
- `build(history, cfg)`: history = `{games, plays, snaps}` (formats in the file header). `compactPlay(row)` converts an
  nflverse pbp CSV row. Returns `featured` (per game), `featuresFor(game)`, `players(team)` and `qb(id)`.
- `predict(f, model)` returns `{margin, total}`. `signal(f, pred, market, model)` returns the predicted open→close move
  and tier (`PROVEN` / `LEAN` / `PASS`) for spread and total. `market` is the first line seen after the teams' previous
  game (spread, home/away price, total, over/under price).
- `fairMean`, `clvEv` and `probs` give the same key-number CLV scoring as the research, for the live record.
  `injuryMatrix(state, team, report, model)` builds the display rows.
- Parity: `tests/nfl-vas.test.js` rebuilds 887 games (2023-26) from the fixture. Max feature difference is 1.8e-15, and
  stage-1, fair-mean and stage-2 outputs match below 1e-8.
- **History needed.** Start the walk at least 2 full seasons back. A 2023 start matches the full-history walk on 98.9%
  of 2025 total tiers (mean |Δ move| 0.03). A 1-season warm-up gives only 91%.
- **Feeds and refresh** (all public GitHub release assets, no key):
  - `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_<season>.csv.gz` (~19 MB/season,
    2.1 MB for 2026 so far; nflverse rebuilds it daily in season)
  - `.../download/snap_counts/snap_counts_<season>.csv.gz` (~0.5 MB/season; daily)
  - `.../download/schedules/games.csv.gz` (0.5 MB; several times a day), or `nflverse/nfldata/.../games.csv`
  - `.../download/injuries/injuries_<season>.csv.gz` (optional, Injury Matrix; daily. ESPN summary injuries are faster)
  - Refresh once after the last game of a slate is final and nflverse has rebuilt, usually Monday/Tuesday morning.
    Cache prior seasons forever and only re-pull the current season. Total volume is about 60 MB for 3 seasons, then
    about 2-3 MB a week.
- **Timing.** Compute the signal when the new week's line first appears after both teams' previous games are final
  (Sunday night / Monday). Log that price and the closing price for every PROVEN and LEAN call, and score them with
  `clvEv`. That live record is the only way to settle the open-timing caveat above. Injury designations arrive
  Wed-Fri (final report Friday), inactives 90 minutes before kickoff, and the model uses neither.
