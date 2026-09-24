# NCAAF VAS — closing-line research pipeline (FBS college football)

Offline research for THE.BOARD's college football signal. Nothing here runs in the app. Same rigor as `nhl/research`:
rolling origin by season, open-safe features, bets priced at the OPEN and scored against the no-vig CLOSE (CLV),
per-season results, Bonferroni over every rule tried, Node-portable linear production model with exact parity.

## Run (in order)
Python env: `~/Projects/nfl-ncaaf/nhl/research/.venv/bin/python` (numpy, pandas, pyarrow, scikit-learn, scipy, torch,
keras 3). Set `KERAS_BACKEND=torch`. Run from this folder. `data/` holds caches only (owner handles .gitignore).
```sh
PY=../../nhl/research/.venv/bin/python; export KERAS_BACKEND=torch
$PY fetch_data.py         # sportsdataverse GitHub release files -> data/sdv (resumable)
$PY fetch_espn.py 2016 2017 2018 2019 2021 2022 2023 2024 2025   # ESPN core odds per game -> data/espn/odds.jsonl (resumable, ~6 min)
$PY fetch_pbp.py          # cfbfastR pbp -> first passer per game (late-news test only), data/pbp (resumable)
$PY build_games.py        # games.parquet (FBS games 2014-2026) + per-book lines books_sdv.parquet
$PY market.py             # leak check per book, consensus open/close, open bet price -> market.parquet
$PY tune.py               # feature-engine config grid, PRE-holdout seasons only (2017-2022) -> tune.json (~15 min)
$PY build_features.py     # walk-forward features -> features.parquet     (PARITY=2023 ... writes the Node fixture)
$PY model.py              # stage-1 ridge / GBM / logistic, rolling origin, vs market -> stage1_preds, model_report.json
$PY -m nn                 # Keras VectorNet + GRU + Transformer, rolling origin, 3 seeds (~1.5 h) -> nn_preds.parquet
$PY nn_report.py          # which stage-1 models help
$PY -m proof              # THE PROOF: stage 2 + CLV tables, spreads + totals -> proof.json
$PY ablate.py             # which inputs carry the signal (portable math)
$PY keyplayers.py         # lead back / lead receiver and whether he played (late news) -> keyplayers.parquet
$PY move.py               # can the model EXPLAIN the open->close move? recency + QB + key players -> move.json
$PY portable.py           # portable re-check + export data/cache/ncaaf-vas-model.json
PARITY=2023 $PY build_features.py && (cd ../.. && node --test tests/ncaaf-vas.test.js)
```
(`python -m nn` / `-m proof` instead of `nn.py` keeps the command line from matching a sibling agent's `pkill -f nn.py`.)

## Data sources (free, no key, no browser impersonation)
| what | URL |
|---|---|
| per team-game EPA/rush/pass/first-down/explosive/special-teams/plays | `https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_cfb_adv_team_gamelog/adv_team_gamelog_{S}.csv` |
| schedule, scores, neutral, conference game | `.../releases/download/espn_cfb_schedules/cfb_schedule_{S}.csv` |
| division (fbs/fcs) + conference per season | `.../releases/download/espn_cfb_team_summaries/cfb_team_summaries_{S}.parquet` (also `.csv`) |
| player box (QB = most pass attempts) | `.../releases/download/espn_cfb_player_box/player_box_{S}.parquet` (also `.csv`) |
| talent composite / returning production (preseason) | `.../cfb_team_talent/cfb_team_talent_{S}.parquet`, `.../cfb_returning_production/cfb_returning_production_{S}.parquet` |
| lines per book, OPEN + latest (spread/total/ML), 2014-2025 | `https://github.com/sportsdataverse/cfbfastR-data/raw/main/betting/parquet/cfb_line_odds.parquet` |
| ESPN core odds (all providers, open/close/current) | `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/{id}/competitions/{id}/odds?limit=50` |
| play-by-play (first passer = actual starter; late test only) | `.../releases/download/cfbfastR_cfb_pbp/play_by_play_{S}.parquet` |

Feature stat mapping (gamelog column -> engine key): `EPA_per_play`->epa, `EPA_rushing_per_play`->repa,
`EPA_passing_per_play`->pepa, `first_downs_created_rate`->fdr, `EPA_explosive_rate`->expl, `yards_per_play`->ypp,
`EPA_special_teams`->st, `scrimmage_plays`->plays, points from the schedule. Defense = the opponent's offense in the same game.
collegefootballdata.com was NOT used (needs a key).

## Data traps found (do not reintroduce)
- `cfbfastR-data` repo releases are empty; the files live in `sportsdataverse/sportsdataverse-data` releases. The repo's
  own `pbp/parquet` stops at 2021.
- `cfb_line_odds.parquet` has exact duplicate rows (dedupe) and labels team rows with a book abbreviation, not an id.
  Mapped abbr -> ESPN team id as the one team common to every game the abbr appears in (per season), then the
  other row of the same game/book: 99.3 % of spread rows mapped; 105,214 home/away pairs; 85 pairs with home != -away dropped.
- Opening lines: 2014-2019 only 5Dimes (with open juice); 2020 none; 2021-22 Bovada (no open juice); 2023 Bovada / DK /
  ESPN BET; 2024-25 ESPN core ESPN BET (real open juice). ESPN core has open lines only for 2016 (`initialSpread`,
  many books) and 2023+ (ESPN BET). Where the open juice is unknown the bet is priced at -110 (share reported per rule).
- The same book's "open" differs between feeds (ESPN core ESPN BET vs the line file's ESPN Bet: equal only 47 %).
  Open timestamps are not published anywhere, so "open" is feed-defined. An open more than 14 pts (spread) / 20 pts
  (total) from that book's own close is treated as a data error (dropped).
- ESPN 2022-23 rows: `close.pointSpread` sometimes holds the JUICE ("+110"). Use the top-level `spread` for the close.
- ESPN "... - Live Odds" providers are in-game prices: spread MAE vs final margin 3.9 pts and ML log loss 0.25
  (every real book: 11.5-13.0 pts / 0.48-0.64). Excluded. Every other book's close was scored (data/cache/book_leak_check.json).
- numberfire / teamrankings / accuscore / consensus / SportsInsights / "Opening" are not books; excluded from consensus.
- Player box: pass attempts are in `completions/passingAttempts`; `stat_1` is empty in most seasons (a first pass at
  this produced a fake 44 % QB-change rate). The "most attempts" QB is partly an in-game outcome (injury, blowout),
  so the late-news test uses the FIRST passer from play-by-play instead (93-99 % coverage, = most-attempts QB 93-95 %).
- `adv_team_gamelog` misses ~5 % of 2021 games (839 / 887 with both sides' stats); other seasons 97-100 %.
- Keras on Apple MPS: GRU's orthogonal initializer needs QR (not implemented on MPS) -> `recurrent_initializer='glorot_uniform'`.
- Normalizing NN inputs on 2014-16 only: returning production / QB history are constant there (sd 0 -> 500,000x inputs);
  those columns use 2014-17 stats, inputs clipped to +-6.
- Win log loss must be compared on the SAME games as the moneyline (FCS blowouts without a moneyline flatter a model).

## Method
- Games: every completed game with at least one FBS team, 2014-2025 (10,370; 2026 to date for the live walk).
  Tiers: P5 (both SEC/Big Ten/Big 12/ACC/Pac-12/Notre Dame), G5 (both FBS, neither P5), MIX, FCS (one side not FBS).
- Features (`features.py`, ported line-for-line to `ncaaf/lib/vas-engine.js`): exponentially weighted (half-life 9 games),
  opponent-adjusted offense and defense ratings for points, EPA/play, rush EPA, pass EPA, first-down rate, explosive
  rate, yards/play, special-teams EPA, plays; shrunk (1 pseudo-game) to the league mean of the team's division;
  season carry 0.7. Market rating: online update from past CLOSING spreads (lr 0.4, carry 0.95, hfa 2). Projected QB =
  last game's most-attempts QB, his starts and shrunk pass EPA for this team. Rest days. Preseason: talent z (within
  season, FBS), returning production. Config chosen on 2017-2022 only (a coarse grid, then a pass at the grid edges).
  The final merged `tune.py` grid prefers half-life 6 (pre-holdout RMSE 16.797 vs 16.807 for the shipped 9): immaterial,
  not re-run. Market-rating config (0.4 / 0.95 / 2.0) and k_qb 2 are its best.
- Stage 1: predicted home margin (ridge, GBM, Keras) — rolling origin, predictions for S fit on seasons < S.
- Stage 2: target = bet-book OPEN line - consensus CLOSE (points; > 0 = market moved toward the home side), inputs =
  stage-1 gap vs the open + context; trained only on earlier seasons with opens (2017-19, 2021-22 for 2023, ...).
- Pricing (stated choice): margin M ~ discretized Normal(mu, SD) with SD = 15.80 (sd of margin + close, 2015-2022),
  mu = -close shifted by the median no-vig close juice. Bet at open line L with the book's open juice:
  CLV EV = P(win)(dec-1) - P(lose), push returns the stake. Totals: same, SD 16.57. Model-free checks alongside:
  beat-close rate (binomial, ties excluded) and mean CLV in points.
- Holdout: 2023, 2024, 2025 (2,696 spread bets possible, 2,763 games).

## Results

### Stage 1 vs the market (holdout 2023-25; `model_report.json`, `nn_report.json`)
| predictor | margin RMSE | win log loss (ML games) | corr(gap vs open, open->close move) |
|---|---|---|---|
| ridge (linear, portable) | 15.671 | 0.5131 (via logistic on margin) | 0.135 |
| gradient boosting | 15.760 | | 0.118 |
| Keras VectorNet (towers, multi-task) | 15.826 | 0.5163 | 0.120 |
| Keras SeqNet GRU (last 12 games) | 15.779 | 0.5156 | 0.152 |
| Keras SeqNet Transformer | 15.768 | 0.5156 | 0.156 |
| average ridge + GBM | 15.642 | | 0.133 |
| average of all five | **15.617** | | 0.152 |
| MARKET open (median, -spread) | 15.279 | | |
| MARKET close (median, -spread) | **15.145** | **0.4990** (no-vig ML) | |

No model comes near the market: 0.34 pts RMSE behind the OPEN and 0.47 behind the close. The Keras nets are each
worse than ridge on RMSE; averaging all five helps a little (15.617) and the sequence nets' gaps correlate slightly more
with the line move (0.15 vs 0.135). They did not help the CLV proof (below). Per-group ridge (holdout RMSE): market
rating 15.78, team box/EPA 15.93, preseason 18.45, QB 20.44, context 19.78.

### THE PROOF — bets at the OPEN, scored against the no-vig CLOSE (holdout 2023-25)
Baseline: betting every home (away) side at the open = CLV EV -4.48 % (-4.42 %): the vig. Break-even needs ~+1 pt of CLV.
Bonferroni factor = **123** (every rule ever scored on the holdout, incl. two earlier exploratory proof runs + ablation).
Portable ridge stage 2 (`portable.py`, the exported model):

| variant | rule (\|pred CLV\| >=) | bets | CLV EV | p (1-sided t) | p x 123 | beat / lost close | mean CLV | 2023 | 2024 | 2025 | ROI (noise) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **A open-safe** | 0.5 | 558 | -1.48 % | 0.998 | 1 | 54.7 / 34.1 % | +0.63 | -2.67 % | -2.01 % | +0.06 % | -1.5 % |
| A open-safe | 1.0 | 134 | +1.24 % | 0.156 | 1 | 57.5 / 31.3 % | +1.23 | -1.42 % | -1.55 % | +5.15 % | +6.7 % |
| A open-safe | 1.5 | 24 | +3.82 % | 0.133 | 1 | 70.8 / 20.8 % | +1.77 | +4.62 % (5) | -4.70 % (7) | +8.46 % (12) | +41.5 % |
| **B + cross-book opens** | 1.0 | 424 | +1.88 % | 0.0017 | 0.20 | 66.3 / 26.4 % | +1.40 | +0.66 % | +2.83 % | +2.68 % | +0.1 % |
| B + cross-book opens | **1.5** | **178** | **+4.93 %** | **5.9e-6** | **0.0007** | **70.2 / 21.9 %** | **+2.03** | **+4.47 %** (70) | **+8.10 %** (35) | **+3.84 %** (73) | +7.2 % [-4.1, 19.1] |
| **C late news (first-snap QB)** | 1.0 | 224 | +2.18 % | 0.012 | 1 | 62.9 / 28.1 % | +1.46 | +1.26 % | +1.02 % | +3.72 % | +8.4 % |
| C late news | **1.5** | **54** | **+6.55 %** | **2.3e-5** | **0.0029** | **77.8 / 14.8 %** | **+2.18** | +9.68 % (9) | +2.16 % (14) | +7.63 % (31) | +41.6 % |
| totals A open-safe | 1.0 | 116 | +1.82 % | 0.043 | 1 | 72.4 / 20.7 % | +1.50 | +0.02 % | +2.65 % | +1.83 % | +6.1 % |
| totals B + cross-book | 1.5 | 188 | +1.03 % | 0.13 | 1 | 68.6 / 23.9 % | +1.33 | -8.49 % | +4.98 % | +1.79 % | +2.0 % |

Aggregate stage 2 (`proof.py`, ridge + GBM + Keras MLP, stage 1 = all five models):
A >= 1.0: 102 bets, +1.45 %, p 0.15 (2023 +1.34, 2024 -2.07, 2025 +4.24). B >= 1.5: 110 bets, +1.03 %, p 0.25 —
the GBM / Keras members broke in 2023 (Keras corr -0.24) and dragged the aggregate down; ridge alone held
(corr 0.32 / 0.37 / 0.35). C >= 1.0: 185 bets, +3.46 %, p 0.0005, positive every season. Model-vs-open gap rules
(3-10 pts) never beat the close after the vig. Tier cuts of A (P5 / G5 / MIX / FCS) and "fade the side with a new
QB" (653 bets, -1.77 %) did not either. Picking ridge over the aggregate for B after seeing both is a forking path
(counted in the 123).

Verdict:
- **Open-safe fundamentals (A) do NOT beat the closing line** — spreads or totals. The direction is right (55-72 % of
  bets beat the close) but the CLV is ~+0.6-1.2 pts, not enough to clear -110 juice, and 2 of 3 seasons are negative.
- **B beats the close with significance in every season** (70 % beat / 22 % lost, +2.0 pts, +4.9 % EV, Bonferroni
  p 0.0007). 91 % of those bets side with the direction of the bet book's gap to the other books' openers: it is
  "an off-consensus opener converges to consensus", sharpened by the model gap. Caveat: the historical "opens" come
  from feeds without timestamps, so whether the other books' openers were visible before the bet book moved is
  NOT verified. Real-time use needs the app to record several books' openers itself; forward-test it first.
- **C (late news) beats the close** (+6.6 %, Bonferroni p 0.003) but n = 54 and 39 of them are FBS-vs-FCS games
  in the first weeks; it is only actionable if the starting QB is known before the books adjust.

### Ablation (`ablate.py`, portable ridge, predicted CLV >= 1.0)
| set | corr (all / 2023 / 2024 / 2025) | bets | CLV EV | p |
|---|---|---|---|---|
| full open-safe | 0.174 / 0.125 / 0.131 / 0.264 | 134 | +1.24 % | 0.16 |
| - team box/EPA | 0.150 | 95 | +0.93 % | 0.27 |
| - market rating | 0.181 | 133 | +1.09 % | 0.19 |
| - preseason (talent, returning) | 0.162 | 124 | -0.03 % | 0.51 |
| - QB | 0.167 | 132 | +1.08 % | 0.19 |
| - context | 0.173 | 114 | +0.87 % | 0.26 |
| no stage-1 gap (open + context only) | 0.140 | 99 | -0.71 % | 0.70 |
| + cross-book opens | **0.333** / 0.31 / 0.37 / 0.34 | 424 | +1.88 % | 0.0017 |
| + late QB (first-snap starter) | 0.257 | 227 | +1.49 % | 0.049 |
| + late QB + cross-book | **0.358** | 382 | +2.91 % | 1.0e-5 |

What carries it: the cross-book opener gap (x_open_vs_cons, standardized coef 0.40) and the late starter's experience
(L_d_qb_starts 0.38). Within the open-safe set, the stage-1 gap (0.35), FBS-vs-FCS games (0.36: those lines move toward the home side,
almost always the FBS team), preseason talent and the team box ratings each add a little; the market rating adds nothing to
stage 2.

## Production model (`data/cache/ncaaf-vas-model.json`)
Fit on all seasons after the holdout test (stage 1 on 2015-2025, stage 2 on out-of-sample stage-1 gaps 2017-2025):
config, stage1 (32 features), stage2 A/B/C, totals stage1 + stage2 A/B, SDs, tiers with `proven` flags (A: unproven,
B: proven at 1.5 with the timing caveat, C: proven at 1.5 as late news; totals unproven), 2026 preseason tables
(talent z, returning production per ESPN team id), variant notes, full holdout report.
Node port: `ncaaf/lib/vas-engine.js`; parity on 3,023 real games (2023-2026, 232,771 values): max |diff| 6.7e-16.

## What the Node runtime needs
`vas-engine.js` is pure: the caller passes history + the model JSON. To run it live:
- History (walk >= 3 seasons back, e.g. 2023 -> now): per season `adv_team_gamelog_{S}.csv` (~1.2 MB/season, 330 KB for
  2026 so far), `cfb_schedule_{S}.csv` (~150 KB), `cfb_team_summaries_{S}.csv` (~550 KB, division/conference) and the
  most-attempts QB per team-game (`player_box_{S}.csv`, ~9 MB/season, or the app's own ESPN summary box scores).
  sportsdataverse rebuilds these daily (~16:00 UTC); refresh once a day in season, and on Sunday before openers post.
- Closing spreads for the market rating: consensus close per completed game (ESPN core odds, one request per game,
  ~60-70 FBS games a week; one-time backfill ~2,800 games for 2023-2025, or seed from `market.parquet`).
- Per upcoming game: the bet book's OPEN home spread (ESPN core odds `homeTeamOdds.open.pointSpread`, captured when
  it first appears), week / season type / P5 flags (the app's scoreboard). Variant B also needs the median opener
  across several books captured at the same time; variant C needs the confirmed starting QB id.
- Preseason tables (2026 talent z, returning production) ship inside the model JSON.
Engine cost: the walk over ~3,000 games takes ~0.1 s.

## Live loader (`ncaaf/lib/vas-data.js`)
`create({dir, fetchBuffer, fetchJSON, now, log})` -> `history(season)`, `closeSpreads(gids, {max})`, `upcoming(season, {week, seasonType})`,
`status()`; plus `crossBook(openers, {asOf})`. It builds exactly what build_games.py + market.py build: FBS filter from the team table,
first duplicate gamelog row kept, NA -> null, QB = most attempts (`completions/passingAttempts`, `stat_1` fallback, ties -> larger id),
closes = median ESPN top-level `spread` over real books (no Live Odds / non-books). Caches: `season_{S}.json.gz` (~82 KB per full season),
`closes.json` (~17 B per game). Past seasons fetched once, current season every 12 h, a failed URL at most hourly.
Measured: cold download-parse of 3 seasons ~110-150 ms (player box CSV is 9 MB/season), warm cache 4 ms; transient RSS +~115 MB
while parsing, +5 MB heap retained. Parity: loader -> engine on 2023-25 raw files vs Python (ESPN-only closes,
`CLOSE_SRC=espn PARITY=2023 build_features.py`): 934 games of 2025, 71,918 values, max |diff| 3.6e-15.
ESPN-only closes vs the research consensus (which also used the sportsdataverse line file): equal 70 %, mean |diff| 0.14 pt.

Variant B live: record every book's OPENER (spread + prices + firstSeenAt; include reference books you see, e.g. Pinnacle / DK,
not only Nevada books, as the research consensus mixed ESPN BET, DraftKings, Bovada). For each Nevada book b:
`cb = crossBook(openers, {asOf: now})`, then `signal(f, margin, {open: cb.books[b].open, openCons: cb.openCons}, model, 'B')`,
priced at b's own opener prices, valid only while b still shows that opener. With one book, x_open_vs_cons = 0 (B ~= A).

## Explaining line moves (`move.py`, variant E)
Question: when a line moves between the open and kickoff, how much of it can the model account for? Inputs added to
stage 2 (ridge, rolling origin, holdout 2023-25):
- recency (open-safe, in the feature walk and the Node port): last game's result vs its own closing spread (ATS
  margin, clipped +-28), won as an underdog, won by 21+;
- late news (known by kickoff): first-snap QB change (C), lead back / lead receiver absent, weighted by his share of
  the team's carries / catches over the previous 3 games (`keyplayers.py`; absence read from the box score).

| stage 2 inputs | move variance explained (R2) | corr (2023 / 2024 / 2025) | pred >= 1.5: bets, CLV EV, seasons |
|---|---|---|---|
| A open-safe (shipped) | 2.9 % | 0.125 / 0.131 / 0.264 | 24, +3.8 %, mixed |
| A + recency | 4.4 % | 0.171 / 0.185 / 0.282 | 45, +5.2 %, 2024 negative |
| + first-snap QB (C) | 6.5 % | 0.231 / 0.242 / 0.297 | 54, +6.6 % |
| + QB + lead RB/WR | 6.6 % | 0.240 / 0.239 / 0.299 | 61, +6.9 % |
| **E = + QB + lead RB/WR + recency** | **8.2 %** | 0.266 / 0.277 / 0.318 | 76, +6.5 % (p 4.9e-5, Bonferroni x136 = 0.007), +10.4 / +6.0 / +5.2 % |

Sizes (raw units, points of line move): lead back ruled out ~ -0.55 x his carry share (a 60 % back is ~0.3 pt),
lead receiver ~ -0.94 x his catch share, a covered-by-14 last week ~ +0.2 pt toward that team, an upset win last week
~ -0.13 pt (letdown). Most of any move (~92 % of the variance) is information the model does not have (injury reports,
weather, large bets). The app shows, per game, the actual move, the part each input explains, the unexplained
remainder, and for each team's lead back / receiver what a ruled-out report would add (college football has no
official injury feed, so availability is never assumed). Variant E is exported for explanation; it is late news.
