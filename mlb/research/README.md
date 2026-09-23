# MLB VAS: closing-line research pipeline

Offline research for the MLB version of the VAS model. It follows the NHL pipeline (`nhl/research`) with the same checks.
Nothing here runs in the app. The Node port lives in `mlb/lib/vas-engine.js` and its tests in `tests/mlb-vas.test.js`.

**Bottom line (2026-09-23).** One moneyline rule beat the closing line on clean holdout data, and it held up in each season
separately. It fires when the open-safe model differs from the opening no-vig price by at least 0.30 logit. Result:
+1.45% CLV EV, n=482, Bonferroni p=0.004. The edge is small and has a caveat about when the opener is posted (see below).
**No totals rule beat the close.** Late news (confirmed lineups, weather) predicts line movement, but I could not show it
beats the close at a price you could actually take.

## Run (in order)
```sh
PY=../../nhl/research/.venv/bin/python   # numpy pandas pyarrow scikit-learn scipy torch keras3; export KERAS_BACKEND=torch
$PY fetch_statsapi.py    # schedules + compact boxscores 2018-2026 + pitcher/batter handedness (resumable, ~20 min)
$PY fetch_espn.py        # ESPN events + every book's odds + teamrankings line history 2019-2026 (resumable, ~60 min)
$PY build_games.py       # join -> data/cache/history.pkl, games.parquet
$PY portable.py          # walk-forward features (the exact Node algorithm) -> features.parquet
PARITY=2025 $PY portable.py   # Node parity fixture (history + Python features, 2025 on)
$PY market.py            # ESPN -> gamePk join, leak screen, open/close per source, NB total-runs model -> market.parquet
$PY nn.py                # Keras TowerNet + GRU SeqNet (rolling origin, 3 seeds) -> nn_preds.parquet (~1 h CPU)
$PY model.py             # stage-1 zoo vs market open/close -> stage1.parquet, model_report.json
$PY proof.py             # CLV proof, 12 pre-registered rules -> proof.json   (P1=p_nn for the Keras stage-1 variant)
$PY late.py              # late-news variants -> late.json
$PY ablate.py            # feature-group ablation, Node-portable math -> ablate.json
$PY export.py            # holdout of the SHIPPED model + PROVEN criterion + final fit -> mlb-vas-model.json, parity/preds_py.json
cd ../.. && node --test tests/mlb-vas.test.js
```
Everything under `data/` is git-ignored except `data/cache/mlb-vas-model.json`, the production model.
Long jobs can die silently if another session runs `pkill -f nn.py`. After a run, check that `nn_preds.parquet` has
predictions for every fold from 2021 to 2026.

## Data sources (free, no login, default urllib User-Agent)
| what | URL |
|---|---|
| schedule, probable starters, venue, day/night | `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&startDate=..&endDate=..&hydrate=probablePitcher,weather,officials` |
| boxscore (lines, batting order, weather/wind, HP umpire) | `https://statsapi.mlb.com/api/v1/game/{gamePk}/boxscore` |
| handedness | `https://statsapi.mlb.com/api/v1/people?personIds=a,b,c` (150 per call) |
| events | `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=YYYYMMDD&limit=50` |
| odds (open/close/current per book) | `https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/{id}/competitions/{id}/odds?limit=50` |
| timestamped line history (teamrankings, provider 1002) | `.../odds/1002/history/0/movement?limit=300` (moneyline), `.../history/2/movement` (total) |

Statcast/Savant was not needed. Boxscore-level ratings were enough to match the market's opening line on outcomes.

Coverage: 20,263 regular-season games (2018-2026, including 2026 through 2026-09-22). 99.5-99.9% of games per season
joined to ESPN, verified by matching scores. 2018 is warm-up for the walk-forward state only.

| season | open+close source | ML games | total games | log loss open | log loss close |
|---|---|---|---|---|---|
| 2019-2023 | teamrankings history (first line / last line before first pitch) | 2287 / 803 / 2298 / 2376 / 1771 | 2240 / 794 / 2281 / 2377 / 1765 | 0.664-0.677 | 0.662-0.677 |
| 2024 | ESPN BET open + close | 2380 | 1989 | 0.6760 | 0.6741 |
| 2025 | ESPN BET open + close | 2423 | 1673 | 0.6799 | 0.6760 |
| 2026 | DraftKings open + close | 2355 | 2340 | 0.6813 | 0.6794 |

## Data traps (do not reintroduce)
- **Open lines exist only from 2024** as a single book's own open and close (ESPN BET in 2024-25, DraftKings in 2026).
  ESPN BET 2023 has closes only. Before that, the only open is teamrankings' timestamped history. Its prices carry
  about 1.9% vig, so it is not a bettable book, and 2019-23 CLV is indicative only.
- **teamrankings history keeps running about 7 h past first pitch.** The close is the last line strictly before the
  scheduled first pitch. The first entry is sometimes a -110/-110 placeholder and is skipped.
- **"... - Live Odds" providers are in-game prices** (log loss 0.08-0.34). **"Caesars (New Jersey)" 2019 closes score
  0.613** (other books about 0.663), which means in-game updates. `market.py` screens every book and season and drops
  any book scoring 0.006 or more below the season median.
- **ESPN BET 2025 opens are erratic from July.** The spread of the open-to-close move doubles (logit SD 0.12 to 0.24), and
  moves like -150 to +120 appear. Every pooled 2025 number is inflated by this. Results are reported with and without
  2025-07-01+, a calendar-only split that never looks at outcomes.
- **ESPN BET "open totals" include alternate lines** (5.5 at -280/+200, 9.5 at +155/-210). Before filtering, they created
  a fake +10-21% totals "edge" in 2024. Totals are kept only when both open and close sides are priced within ±135.
  ESPN BET 2025 open totals differ from the close total by a run or more in 52% of games.
- The ESPN team name "Cleveland Indians" (2019-21) has to be aliased or 7% of those seasons fail to join.
  Doubleheaders are paired by start order within (home, away, local day), and each join is verified by the final score.
- The boxscore `battingOrder` array lists the **last** player in each slot. The starting nine is the batters whose `bo`
  code ends in "00".
- **Historical `probablePitcher` equals the actual starter 99.8% of the time.** Live, probables change more often, so the
  open-safe starter features are slightly optimistic historically.
- Standardizing a column that is constant in training (the source flag in the 2024 fold) with `std + 1e-9` sends test
  rows to -1e9. The std floor is 1 (same in the export and Node).
- Keras GRU on the torch backend needs `recurrent_initializer='glorot_uniform'` (the orthogonal init's QR fails).

## Features (`portable.py`, mirrored in Node)
Open-safe:
- Team: EW wOBA-proxy offense, overall and against the opposing probable starter's hand; runs for/against; win rate;
  bullpen FIP per batter faced. Half-life 40 games, 0.5 carried over between seasons.
- Probable starter: shrunk FIP and K per batter faced (decay by batters faced), outs per start, log batters faced, rest,
  pitches in last appearance.
- Expected lineup: the previous game's starting nine, using shrunk batter wOBA.
- Rest, night game, and day game after a night game.
- Park factor by venue.

Late news: confirmed-nine value minus expected nine; starter change; relievers' pitches yesterday and over the last 3
days; temperature, wind in/out and roof; home-plate umpire runs tendency.

## Results: stage 1 on the holdout (2024-2026, 7,158 games with open+close ML; every model fit only on earlier seasons)
| predictor | log loss | Brier |
|---|---|---|
| home rate only | 0.69115 | 0.24900 |
| logistic (Node-portable) | 0.67988 | 0.24351 |
| gradient boosting | 0.68152 | 0.24427 |
| Keras MLP | 0.68035 | 0.24373 |
| LR+GBM+MLP logit average (`agg3`, pre-registered stage 1) | 0.67986 | 0.24348 |
| Keras TowerNet (starter / lineup / bullpen / team towers, multi-task) | 0.67964 | 0.24337 |
| Keras GRU SeqNet (team last 20 games + starter last 10 starts, multi-task) | **0.67903** | 0.24310 |
| Keras average (tower + GRU) | 0.67899 | 0.24307 |
| stacker (fit on earlier seasons) | 0.67968 | 0.24340 |
| **market OPEN** (single book, no-vig) | 0.67904 | 0.24310 |
| **market CLOSE** | **0.67646** | **0.24185** |

Totals, MAE of total runs (6,002 games): ridge 3.513, GBM 3.517, Keras MLP 3.491, TowerNet 3.503, GRU 3.961 (its total
head is poorly calibrated), open 3.487, close 3.470.

The Keras GRU matches the opening line on outcomes. The portable logistic model does not, and nothing reaches the close.
**Which Keras models helped:** the GRU is the best stage-1 predictor of outcomes. None of the Keras models improved CLV.
With the Keras average as stage 1 (`proof_nn.json`), the gap≥0.30 rule gave 2026 +0.82% vs +1.05% with `agg3`, and the
move≥0.08 rule was worse. The Keras stage-2 regressors correlate with the line move about as well as ridge
(for example 2026: ridge 0.349, GBM 0.376, Keras 0.346).

## Stage 2 (open-to-close line move) prediction, corr(predicted, actual), holdout seasons
| | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|
| moneyline (ridge+GBM+Keras) | 0.49 | 0.53 | 0.42 | 0.66 | 0.36 |
| totals | 0.44 | 0.51 | 0.24 | 0.62 | 0.23 |

The model predicts which way the line will move very well: the bet side beats the close 70-86% of the time. That does
not mean it beats the vig. Scoring is CLV EV = p_close_novig(side) × decimal_open_price − 1. Totals are scored through a
negative binomial (size 8, fit on 2019-23) so an open total can be scored against a moved close.

## CLV proof (`proof.py`, 12 pre-registered rules, Bonferroni ×12)
Primary holdout: 2024-26 bets at the OPEN price of the same single book, scored against its no-vig close.
"excl H2" drops the erratic 2025-07-01+ ESPN BET opens.

| rule | n | CLV EV (all) | 2024 | 2025 | 2026 | excl H2 EV (p) |
|---|---|---|---|---|---|---|
| ML predicted move ≥ 0.05 | 2554 | +0.68% | -0.21% | +3.57% | -1.85% | -1.03% |
| ML predicted move ≥ 0.08 | 1075 | +3.46% | +1.77% (p=3e-4) | +7.27% | **-0.43%** | +0.82% (p=0.004) |
| ML model-vs-open gap ≥ 0.20 | 1842 | +1.27% | -0.60% | +4.04% | -1.18% | -0.84% |
| **ML model-vs-open gap ≥ 0.30** | 717 | +4.49% | +0.94% (p=0.08) | +7.60% | +1.05% (p=0.08) | **+1.11% (p=0.008)** |
| TOT predicted move ≥ 0.30 | 401 | +4.26% | +0.61% | +15.1% | -1.35% | -0.28% |
| TOT gap ≥ 0.80 | 1040 | +2.60% | -0.60% | +8.75% | -1.56% | -0.99% |

All pooled "p < 1e-20" rows in `proof.json` come from 2025 H2. **Totals: no rule is positive in 2026.**

### The shipped model (`export.py`: logistic + ridge only, which is exactly what Node runs)
The PROVEN criterion, fixed in `export.py` before its numbers were computed:

> On clean data (2024, 2025 before July, 2026): CLV EV > 0 with Bonferroni ×12 p < 0.05, **and** CLV EV > 0 in each part
> separately.

| rule | clean n | clean CLV EV | Bonferroni p | beat close | 2024 | 2025 pre-July | 2026 (DraftKings) |
|---|---|---|---|---|---|---|---|
| **ML gap ≥ 0.30 → DIAMOND, PROVEN** | 482 | **+1.45%** | **0.0037** | 82.2% | +1.20% (n=242, p=0.019) | +1.98% (n=103, p=0.045) | +1.50% (n=137, p=0.011) |
| ML gap ≥ 0.20 | 1390 | -0.66% | 1 | 73% | -0.27% | -1.03% | -0.92% |
| ML move ≥ 0.08 | 1253 | -0.12% | 1 | 78% | +0.77% | +0.47% | -1.12% |
| TOT gap ≥ 0.80 (best totals candidate, UNPROVEN) | 642 | -0.42% | 1 | 68% | +0.24% | +0.53% | -1.15% |
| TOT move ≥ 0.30 | 410 | -0.37% | 1 | 69% | +0.61% | +2.17% | -1.21% |

- Dose-response on the shipped ML rule is monotonic in every season. At thresholds 0.28 / 0.30 / 0.33 / 0.36 / 0.40, clean
  EV is +1.19 / +1.45 / +2.05 / +2.63 / +4.36%.
- The rule fires about 1.0 times per day. 61% of bets are underdogs; the median price is +109.
- Actual ROI on clean data is +9.7% (90% bootstrap CI +1.4% to +17.7%). That is noise-level and not the proof.
- Teamrankings seasons 2022-23 (not a real book) agree: gap ≥ 0.30 gave +2.12%, p=2e-11.

## Ablation (`ablate.py`, Node-portable). Moneyline gap ≥ 0.30, clean CLV EV
| feature set | log loss | clean EV | 2026 |
|---|---|---|---|
| all | 0.67988 | +1.45% | +1.50% |
| minus starter | 0.68163 | **-2.05%** | -2.68% |
| minus team form | 0.68091 | +0.61% | +0.12% |
| minus expected lineup | 0.68037 | +0.58% | +0.72% |
| minus bullpen | 0.67995 | +1.43% | +2.00% |
| minus schedule/park | 0.67958 | +1.90% | +2.00% |
| only starter / only team / only lineup | ≥0.6822 | all negative | |

The edge comes from **the probable starter's rating combined with team form and the expected lineup**. No single group
does it alone. Bullpen and schedule/park add nothing. In stage 2 the market keeps moving toward the model's starter and
lineup quality beyond the gap itself (coefficients `d_sp_fip` -0.037, `d_lu_exp` +0.019). For totals, removing starter
or park turns the best candidate clearly negative, but no set is positive in 2026.

## Late news (`late.py`, not open-safe)
- **Information:** confirmed lineups raise moneyline move-prediction corr (2026: 0.349 → 0.409; 2024: 0.427 → 0.470).
  Weather is the big one for totals (2026: 0.210 → 0.363; 2024: 0.235 → 0.330). Starter changes, bullpen fatigue and the
  umpire add nothing.
- **Realistic bet at T-2h** (teamrankings 2022-23): lines barely move after T-2h, and only 3-61 bets pass any threshold,
  so this is inconclusive. The market has mostly absorbed lineups by then.
- **Optimistic (at the open with late info, 2024-26):** weather on totals, move ≥ 0.3: 2024 +0.53%, 2025 +14.6% (junk
  opens), 2026 +0.51%. Weather *forecasts* are available at the open, so a forecast-based weather feature is the most
  promising next step for totals. It is untested: history here has observed weather only.

## Caveats
- **Opener timing.** ESPN does not timestamp the ESPN BET/DraftKings open. If a book posts its opener before probables are
  firm, some of this CLV is "knowing the starter first", the same caveat as NHL. It is only actionable if you bet the
  book's opening number soon after it posts.
- The clean/unclean split (2025-07-01) and the PROVEN criterion were written after seeing `proof.py`. The split was chosen
  from line-move variance, not outcomes. Bonferroni covers the 12 rules but not those two choices, or the several stage-1
  variants I looked at (2026 EV for the gap≥0.30 rule ranges +0.8% to +1.5% across them).
- Sample: 482 clean bets across 2.3 seasons, 137 of them on the only current book (DraftKings 2026).
- Historical probables are about equal to the actual starters (optimistic, see traps).
- The vig on a single book's moneyline is about 4-4.6%. The rule clears it only on the largest disagreements.

## Live runtime (`mlb/lib/vas-data.js` + `vas-engine.js` + `mlb/lib/mlb-vas-model.json`)
- **Loader parity:** `vas-data.js` rebuilds all 20,263 games from statsapi-shaped raw data and reproduces the Python
  2026 features to within 1e-8 (test `loader parity`).
- **Cache:** 18 MB on disk for 2018-2026. Finished seasons are sealed to `box/<season>.json.gz` (about 0.8 MB each); the
  current season is one JSON per game.
- **Speed and memory:** a warm boot (disk only) loads in about 0.3 s and builds the engine in about 0.15 s. Heap is about
  135 MB and RSS peaks around 350 MB.
- **First boot:** about 20.3k requests (9 season schedules, 20,263 boxscores, about 25 `/people` batches), made
  gradually at `maxFetch` per `history()` call with concurrency 3.
- **Warm-up vs full 2018+ history** (2026 games with a DraftKings open; the proven gap rule; 127 full-history bets):

  | history from | tiers identical (all games) | identical among bets |
  |---|---|---|
  | 2018 | 100% (exact) | 100% |
  | 2019 | 99.87% | 97.7% |
  | 2021 | 99.58% | 92.3% |
  | 2023 | 98.98% | 82.5% |
  | 2025 | 97.03% | 57.8% |

  Use 2018, or 2019 at minimum. A short warm-up changes which games get a DIAMOND.
- **Validity after the open** (teamrankings timestamps, 2022-23, 530 signals): priced at open + 0 / 1 / 2 / 4 / 8 / 12 h,
  CLV EV is +3.15 / +2.79 / +2.43 / +1.74 / +0.27 / -1.19% (at about 1.9% vig).
  At DraftKings' vig the edge at the open is +1.45%, so treat a signal as live for about 2 h after the opener posts. After
  that, only bet if the current price still gives a gap of at least 0.30 **and** is no worse than the opener.
