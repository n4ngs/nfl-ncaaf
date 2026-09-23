# NHL vector model — research pipeline

Offline research for the NHL Goalie Matrix / VAS model. Nothing here runs in the app yet.

## Run (in order)
```sh
python3 -m venv .venv && .venv/bin/pip install numpy pandas pyarrow scikit-learn torch
.venv/bin/python prep.py            # MoneyPuck shots + team logs -> data/cache
.venv/bin/python fetch_nhlbox.py    # official NHL boxscores (starters, lineups, results), resumable
.venv/bin/python build_games.py     # games + lineups
.venv/bin/python fetch_espn.py      # sportsbook moneylines (open/close) 2021-22..2025-26, resumable
.venv/bin/python features.py        # walk-forward TEAM / GOALIE / PERSONNEL / SCHEDULE vectors
.venv/bin/python cnn.py             # shot-map CNN vector, rolling origin by season
.venv/bin/python model.py           # vector models, market stack, VAS tiers, report -> data/cache/report.json
```
`data/` is git-ignored. Raw sources: MoneyPuck season shot files (2015-16..2025-26; 2015-2024 files came from a
MoneyPuck mirror because moneypuck.com rate-limits, the 2025-26 file was verified byte-identical to moneypuck.com),
MoneyPuck `all_teams.csv`, api-web.nhle.com boxscores, ESPN public odds.

## Data traps found (do not reintroduce)
- MoneyPuck shot `game_id` already contains the `02` type code: NHL id = season*1e6 + game_id.
- sportsdataverse box files miss ~20% of games; use the official NHL boxscores.
- ESPN "... - Live Odds" providers are in-game prices (log loss 0.20). Exclude.
- ESPN DraftKings/Unibet/Bet365/Titanbets/Holland rows before 2025-26 are 60-minute 3-way lines. Exclude.
- ESPN's edge 403s some User-Agent strings; the library default is accepted.

## Result (test = 2024-25 + 2025-26, 2,624 games, every model fit only on earlier seasons)
| predictor | log loss |
|---|---|
| home-ice rate only | 0.6897 |
| goalie vector | 0.6889 |
| team vector | 0.6754 |
| CNN shot-map vector | 0.6756 |
| all vectors (logistic) | 0.6717 |
| market close, no-vig median | **0.6700** |
| model + market stack | 0.6710 |

- The model does not beat the closing line on outcomes.
- It does predict line movement: model edge vs the OPEN correlates 0.52 with the open->close move; on 2-pt+
  edges the market moved toward the model 74.5% of the time (+2.2 prob pts mean CLV).
- Caveat: features assume starters and lineups are known; the open is posted before they are, so part of that
  CLV is "knowing the confirmation first". Actionable only if bets are placed right after confirmations, before books move.
- The CNN is as good as the whole team vector on its own but adds nothing on top of it (redundant signal).

## Closing-line proof, open-safe (`proof.py`, 2026-09-23)
Only open-time information: projected starter (recent starts + back-to-back rule, right ~65% of the time), last
game's lineup, team vectors, CNN. Stage 1 logistic + GBM + Keras MLP; stage 2 line-movement aggregate (ridge + GBM +
Keras) predicting open->close move (corr 0.43 in 2024-25, 0.36 in 2025-26). Bets at one book's OPEN price:
- predicted move >= 0.08: 182 bets, CLV EV +1.63% vs no-vig close (t=2.93, p=0.002; Bonferroni over 6 rules p~0.011),
  line moved toward the bet 77.5%, positive in both seasons (+3.19%, +0.90%). Actual ROI -3.1%, CI -14.6..+8.3 (noise).
- looser thresholds beat the close on direction (70-74%) but not after the vig.
