# NHL model: executable baseline, gated deployment

The NHL app now has a versioned pregame model pipeline, not a fixed “inputs pending” response. It does **not** yet have a trained, real-world validated production model. The checked-in [validation report](validation/nhl-model-validation.json) records **zero supplied historical records**, `INSUFFICIENT_DATA`, and null metrics. No accuracy, confidence, expected value, ROI or CLV result is claimed. Synthetic tests validate the implementation only.

## What is connected

`server.js` sends the official boxscore responses it already fetches to `model-state.js`. This adds no network calls, provider sockets, scrape, training job or background historical download. Completed regular-season results and actual goalie shots/saves are accumulated in `nhl-model-observations.json` under the existing NHL `DATA_DIR`. A repeated unchanged final is not rewritten. Conflicting records are quarantined rather than silently selecting whichever result benefits the model.

The official source is `https://api-web.nhle.com/v1/gamecenter/{gameId}/boxscore`, already used by the app. The adapter preserves its game/team/player identities. The server's actual receipt time is the observation's `availableAt` with `clock: "receipt"`. It is **not** represented as an NHL publication timestamp. Retrospectively downloading a final cannot make that result or starter confirmation available before the download.

A goalie is confirmed only when an explicit `starter: true` is received from a pregame (`FUT`/`PRE`) boxscore **before puck drop**. Roster position, playing time, projected-goalie lists and postgame starter flags do not qualify. Explicit false/multiple starter flags produce an unconfirmed observation; newer withdrawals and contradictory simultaneous confirmations block the model. Confirmations older than 24 hours do not qualify. The existing request schedule means these observations currently accumulate when the game detail is requested; it is not a complete starting-goalie service.

## Remaining source requirements

1. An authorized historical result dataset with reliable availability times and goalie shots/saves.
2. Archived pregame starter confirmations, including replacements/withdrawals, timestamped when actually available. A postgame list of who started is insufficient.
3. Enough complete examples for chronological training, calibration and an untouched test set.
4. Separately licensed, timestamped 5v5 xG, high-danger chances and GSAA inputs if the original structural framework is to be built. The baseline does not invent or substitute these fields; they remain null.

The user-paid odds services are not assumed to include goalie/statistical history merely because they provide odds. Their relevant coverage and rights would need to be verified. No such historical dataset was available for this change.

MoneyPuck's [download page](https://moneypuck.com/data.htm) allows free non-commercial use and asks other users to inquire; this app does not ingest its data. The [NHL terms](https://www.nhl.com/info/terms-of-service) do not establish unrestricted commercial reuse of their website data. This change reuses the existing app's responses and makes no claim to grant a data license. A normal direct request to the NHL endpoint returned HTTP 403 in the implementation environment; no alternate origin, proxy or access-control workaround was attempted.

## Input contract

An authorized local import is `nhl-model-inputs.json` in the NHL `DATA_DIR`. It is read at startup and at most once per minute. The [empty template](model-inputs.example.json) contains no invented examples.

Top-level fields:

- `version`: 1.
- `results`: completed regular-season records, maximum 8,000 retained.
- `confirmations`: source-backed starter state changes, maximum 16,000 retained.

Each result has `id` (10-digit official NHL game ID), `gameType: 2`, `start` (ISO UTC), numeric `homeId`/`awayId`, integer `homeGoals`/`awayGoals`, `goalies: [{id, teamId, shots, saves}]`, and `source`. Scores are official final scoreboard values, including any awarded shootout goal, not an invented 5v5 scoring measure. Goalie entries must have real nonnegative integer shots/saves, with saves no larger than shots.

Each confirmation has `gameId`, `teamId`, `goalieId` (required for confirmed), `status` (`confirmed`, `unconfirmed`, `withdrawn`), optional `name`, and `source`. Keep state changes for historical as-of reconstruction. Do not rewrite an old confirmation when a replacement is announced; append the replacement with its true later availability.

Every `source` has:

- `url`: an HTTPS source reference without URL credentials.
- `availableAt`: ISO UTC when this observation became available to the system. A retrospective acquisition must not backdate it.
- `clock`: `receipt`, `provider-published`, or `authorized-import`. The latter two require actual provenance from the licensed dataset; these labels do not create it.

The import is an owner-controlled file, not a public upload/API. Its provenance is asserted by the importer. Schema validation cannot independently prove a third-party timestamp or a data license. Missing/invalid fields are rejected; unknown advanced statistics are not inferred. Save imports atomically.

## Model and evaluation

Version: `nhl-pregame-logit-v1`.

The logistic model estimates the **home team's full-game two-way moneyline probability** from prior team scoreboard differential, win rate, goalie save rate and rest. All features use only results whose availability timestamp is earlier than the prediction time; the target game's result is excluded. Team features use the latest 60 eligible games within 365 days, with at least 20 games per team. Goalies need at least 200 observed shots within that lookback. Rest measures elapsed time since the last observed game, capped at seven days; it is not an independently verified travel/injury measure.

All coefficients, including home advantage, are fitted on the training partition. Ridge strength (0.05) and the temperature grid (0.5–4.0 in 0.1 increments) are fixed implementation settings. Examples are ordered chronologically, divided approximately 60% / 20% / 20% by UTC date, with no date shared across partitions. Training outcomes must be available before calibration begins; calibration outcomes must be available before testing begins. Feature construction walks forward through available history. Model coefficients are then frozen, temperature is selected only on calibration games, and the final model is evaluated on untouched later games. This is one chronological holdout protocol, not repeated independent seasons or a profitability backtest.

Required minimums are 300 training, 150 calibration and 200 test examples **after** all input gates. The report gives log loss, Brier score, reliability bins and expected calibration error. Its control is the training-set home-win-rate baseline, not sportsbook prices. `VALIDATED_BASELINE` requires better test log loss, no worse Brier score and calibration error ≤0.08. These are conservative deployment-policy thresholds, not statistical proof of a betting edge. Sample confidence intervals, bookmaker comparison, player injuries, xG and market execution are not evaluated.

Run offline, without provider connections:

```sh
node nhl/tools/validate-model.js /absolute/path/authorized-inputs.json /absolute/path/output
```

The tool writes `nhl-model-validation.json`. If fitting is possible it also writes `nhl-model.json`, including coefficients, feature version, calibration temperature, timing bounds, data digest and the report. A failed-quality fitted model is marked `RESEARCH_ONLY`; the live predictor rejects it. Insufficient data removes an old model artifact in the same output folder so an obsolete success cannot be mistaken for this run's output. Use a dedicated output folder, review the report and provenance, then atomically copy an accepted artifact to the NHL `DATA_DIR`.

## Runtime behavior

A prediction requires a supported regular-season pregame, both current source-backed starter confirmations, sufficient strictly prior team/goalie observations and a matching validated artifact. Model training and validation must be earlier than the prediction; artifacts more than a year past validation are rejected. A starter change changes the features, and missing history for the replacement blocks the estimate.

`analysis` preserves the UI contract and adds `model`, `reasonCodes`, explicit `probabilitySide: "home"`, and model inputs. `fairProbability` remains null while any gate fails. Advanced xG/high-danger/PDO/GSAA fields stay null. `edge` remains null and `units` stays zero because this pipeline does not verify an executable sportsbook price or select a stake. No live, totals, puck-line, playoff or preseason estimate is emitted.

`health.model` exposes coverage counts and model readiness. It is not a confidence score. Per-game analysis is cached briefly and invalidated on input changes. No training runs in the odds-ingestion or publication path.

## Regression coverage

`tests/nhl-model.test.js` covers real-receipt handling; roster versus confirmed starters; withdrawals and same-time conflicts; persistent result quarantine; future/result and artifact leakage; phase and sample gates; chronological splits; metric arithmetic; stale artifact removal; cached state; dynamic UI gate labels; and a complete synthetic fit/calibrate/test run. Mutating held-out outcomes must not change trained coefficients or calibration. Those synthetic metrics are deliberately not published as evidence of real betting performance.
