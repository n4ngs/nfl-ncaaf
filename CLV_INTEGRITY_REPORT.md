# CLV Integrity v1 implementation report

Repository: `/Users/cmanlongat/Projects/nfl-ncaaf`
Safety branch: `clv-integrity-v1`
Pre-change revision: `054ece55d2fea410979ff93a144b7a91433c1458`
Pre-change Railway deployment: `13868ee5-ecb9-45e1-bccb-f157354fdc36`
Railway project/service: `nfl-ncaaf`, production, existing `/data` volume.

## Architecture discovered

The existing application is dependency-free Node.js >=18/CommonJS. `terminal.js` launches the NFL, NCAAF, and MLB engines and proxies their routes under one origin. The football engines serve plain JavaScript/CSS and stream updates using SSE. This implementation modifies only the merged repository's NFL/NCAAF engines and shared integrity code; MLB remains on its current behavior.

Persistence uses JSON files, not a SQL database: per-sport `bets.json`, `weeks/YYYY-T-WW.json`, manual quotes, identities and telemetry. The existing JSON helper uses temporary-file-plus-rename writes. The service has one replica and a persistent volume. No application test runner, lint configuration, type checker, or migration framework was configured before this work. Node's built-in test runner and a dependency-free syntax checker are now used.

Odds come from Action Network v2/v1, VSiN, Pinnacle, and ESPN. ESPN provides scheduled starts and game-state transitions, but the inspected adapter does not provide independently verified actual kickoff. Model estimates, market signals, Edge Finder, and VAS previously ran in the browser without a durable prediction ledger. BetMGM selection IDs were used for links, not canonical market identity.

## Original behavior and risks

- Compact history recorded number changes and certain price changes, capped each series at 500 points, and omitted the opposing spread/total price. It was insufficient for a complete quote audit.
- Opening values were mutable provider summaries, sometimes retrieved long after opening, without historical-observability evidence.
- NFL could freeze a merged quote within five minutes after scheduled kickoff; NCAAF froze the current merged quote on a state transition. Neither proved a valid, fresh, pregame close before actual kickoff.
- Browser `closeOf` fell back to current market values; missing timestamps could pass freshness checks. Some retained pregame prices were shown as closing lines during live games.
- Bets stored an unexplained legacy `clv.pts`/`clv.pct` object without an immutable entry snapshot. The `pct` measure represented closing-fair EV, not fair-probability movement. Historical metrics were included without eligibility checks.
- BetMGM links could retain changing option IDs, match only one team, or route a first-half selection to a full-game market.
- Actual upstream observations show that Action v2 and ESPN often omit trustworthy source timestamps. A successful poll does not make those quotes verified or fresh.

## Implementation and schema

`shared/clv-integrity.js` is the central authority for immutable snapshots, entries, signals, freshness, market resolution, and CLV. Per-sport `integrity/` journals append evidence alongside existing data; no SQL migration or destructive rewrite is used.

Snapshots retain canonical event and market identity; provider identity; sportsbook/source; market, period and selection; actual line and American odds; optional `fixtureId`, `optionMarketId`, `optionId`; source-observed and received times; scheduled/actual start evidence; market status/live flag; validation reason; paired-market identity; and a provenance fingerprint. All normalized timestamps are UTC. Deterministic identities deduplicate retries without treating option-ID changes as a new canonical market. The original provider lines remain available for transparent display even when they cannot support an edge.

Separate append-only journals retain bet entry captures, model signals, and close-resolution evidence. Bet entry captures bind the recorded wager time, actual typed price, sportsbook, and an existing observable matching snapshot when available. They do not create a historical quote. Changing a ticket's display book or stake does not rewrite its captured entry. Legacy CLV data remains in the raw ticket file but is excluded from the new qualified read projection.

Signals bind model/feature versions, creation and feature-as-of timestamps, prediction, direction, strength, and entry snapshot. A newer signal cannot replace a prior record. Predictions recorded during live play remain live predictions and cannot earn pregame CLV.

The canonical resolver returns earliest valid pregame open, context-appropriate current, and a close with snapshot ID, status, kickoff basis, resolver version, resolution time, and reason. A verified close requires explicit verified actual-start evidence. Scheduled-start fallback is provisional. Suspended, malformed, stale, live, post-kick, or contradictory evidence is excluded. An unavailable value stays null.

Freshness uses source observation time. Defaults are 10 minutes pregame, 30 seconds live, and 10 minutes maximum close age, with an aging threshold at half that budget. Configure with `CLV_PREGAME_MAX_AGE_MS`, `CLV_LIVE_MAX_AGE_MS`, `CLV_CLOSING_MAX_AGE_MS`, and `CLV_AGING_RATIO`. These thresholds are quality policy, not proof that a sportsbook will accept the displayed quote.

## Explicit measures

- Spread line CLV: `entry_selected_handicap - closing_selected_handicap`.
- Over line CLV: `close_total - entry_total`.
- Under line CLV: `entry_total - close_total`.
- Negative American odds implied probability: `(-odds) / ((-odds) + 100)`.
- Positive American odds implied probability: `100 / (odds + 100)`.
- No-vig probability: selected raw implied probability divided by the sum for the complete paired market.
- Fair-probability CLV, percentage points: `100 * (close_fair_probability - entry_fair_probability)`.
- Closing-fair EV at entry price: `100 * (close_fair_probability * entry_decimal_odds - 1)`.

Price measures require the same market number and complete comparable opposing sides. A changed number retains line CLV and gets `NOT_COMPARABLE` for price CLV. Missing opposing prices produce `INCOMPLETE_MARKET_FOR_DEVIG`; no silent estimation or line-to-price conversion is performed. Positive and negative zero are displayed as measured values only when eligible; missing values never become zero.

## Status meanings

| Status | Meaning |
| --- | --- |
| `VERIFIED_CLV` | Timestamped entry, valid observable snapshot, comparable market, verified actual-start close, no look-ahead. |
| `PROVISIONAL_CLV` | Qualified entry with a scheduled-start provisional close. |
| `RETROSPECTIVE_MARKET_MOVE` | Market movement with no legitimate bound entry; not earned model/wager CLV. |
| `MISSING_ENTRY_SNAPSHOT` | No immutable quote proves the recorded entry. |
| `MISSING_CLOSE` | No qualifying canonical close is available. |
| `STALE_ENTRY` / `STALE_CLOSE` | Relevant source observation exceeds its configured age budget. |
| `POST_KICK_CONTAMINATION` | Live or post-kick evidence cannot support pregame CLV. |
| `INCOMPLETE_MARKET_FOR_DEVIG` | Required contemporaneous opposing side is absent or invalid. |
| `UNMAPPED_MARKET` | Canonical market/selection mapping is not supported or valid. |
| `SOURCE_CONFLICT` | Identity, time, or source evidence contradicts the proposed comparison. |
| `NOT_COMPARABLE` | Price CLV cannot compare different spread/total numbers. |

Eligibility and price-comparability are separate fields: a valid line CLV may coexist with unavailable price CLV. Close statuses are `VERIFIED`, `PROVISIONAL`, `UNAVAILABLE`, or `CONFLICTED`; freshness is `FRESH`, `AGING`, `STALE`, `SUSPENDED`, or `UNVERIFIED`.

## Files changed

Football paths below apply to both `nfl/` and `ncaaf/`:

| Scope | Files |
| --- | --- |
| Provider/server integration | `server.js`, `lib/action.js`, `lib/betmgm.js`, `lib/bets.js`, `lib/espn.js`, `lib/pinnacle.js`, `lib/vsin.js` |
| Frontend | `public/index.html`, `public/clv.css`, `public/js/integrity.js`, `public/js/boot.js`, `public/js/clv.js`, `public/js/core.js`, `public/js/edge.js`, `public/js/group.js`, `public/js/hitlist.js`, `public/js/live.js`, `public/js/share.js`, `public/js/sheets.js`, `public/js/tmachine.js`, `public/js/vas.js`, `public/js/views.js` |
| Shared core | `shared/clv-integrity.js` |
| Tests | `tests/bets-regression.test.js`, `tests/clv-integrity.test.js`, `tests/clv-reclassify.test.js`, `tests/server-integrity.test.js`, `tests/ui-integrity.test.js` |
| Tooling/report | `package.json`, `tools/check-js.js`, `tools/clv-reclassify.js`, `CLV_INTEGRITY_REPORT.md` |

## Migration and historical reclassification

`tools/clv-reclassify.js` defaults to dry-run. It deterministically classifies historical bets and open/close-only records, reports counts/reasons, and writes only additive classification evidence when explicitly applied. It never invents observation times, creates entry quotes for old tickets, or rewrites original bets/history.

Production procedure:

1. Complete tests and inspect the full diff on the safety branch.
2. Verify the existing Railway project/service/volume and record the current successful deployment and commit.
3. Make and verify a timestamped backup on the existing volume before deploying. Do not print credentials or data contents.
4. Deploy through the existing GitHub `main` → Railway integration, preserving one replica and the existing volume/authentication settings.
5. New journal directories are additive. Run the reclassification command in dry-run first; review counts before any explicit additive apply.
6. Verify the deployed commit, football integrity health, board/live/bets/tools pages, labels, stale behavior, and responsive layout.

## Rollback

Restore application code by redeploying the recorded pre-change Railway revision or reverting the implementation commit through the existing GitHub deployment path. Leave the append-only integrity journals and classification records on disk; the old code ignores them. Existing bet and history schemas remain readable by the old app. Do not restore an entire pre-deploy data volume over newer wagers, users, devices, or telemetry. The backup is an emergency recovery source for individually assessed files, not a blanket restore instruction. Existing untracked `p-nfl.html`, `p-ncaaf.html`, and `p-mlb.html` are excluded from commits and deployment changes.

## Validation and deployment results

Final pre-deploy validation:

- `npm test`: **147 tests passed, 0 failed, 0 skipped**. This includes 32 grading/bet regressions, 53 integrity-core tests, 10 reclassification tests, 28 provider/server tests, and 24 frontend tests.
- `npm run check`: **113/113 JavaScript syntax checks passed**. No pre-existing linter or type-checker was configured.
- `git diff --check`: passed. The first staged-report check flagged Markdown hard-break whitespace; it was removed before commit. Reviewed tracked changes plus every new shared/test/tool/frontend file; original untracked `p-*.html` files remain excluded.
- Independent storage/migration and provider/server reviews completed. Review findings fixed: contradictory opposing quotes, source-clock/live-state confusion, no-price suspension, close disappearing when the current provider changes, SSE timestamp churn, half-market freshness bypass, and details expansion.
- Real HTTP smoke against the running existing terminal with isolated local data: NFL, NCAAF and unchanged MLB health returned 200; a local test ticket was created and immediately graded correctly; captured wager time remained immutable; missing entry CLV remained null; another owner could not see the ticket.
- Browser smoke in the user-authorized in-app browser: NFL Board, Live, My Bets, Tools/journal health, local Admin Center, completed-game provenance and provisional closing basis passed. Full-game and first-half stale/unverified prices remained visible with no action buttons. NCAAF Board loaded 71 games. The 390 × 844 responsive view had a 390-pixel body width with no page overflow and retained bottom navigation.
- Browser console errors: none observed in the local Tools check. No live football game was active during these checks; real-time grading transitions are covered by deterministic regressions and the running HTTP final-game test.
- Warm local health latency: five requests measured **2, 2, 2, 3, 2 ms** (median 2 ms, max 3 ms). This is a small local smoke measurement, not a load test or sportsbook execution benchmark.

The implementation was committed as `1b53e601b42db6322806b2aeffd71400e03767cf` and deployed successfully through the existing GitHub `main` integration. Railway deployment: `acb7ac37-df76-48c9-a44d-013e2ab5aa21` (SUCCESS), production instance `c886d9e7-670a-4f7b-b1a1-1dd603e2cbbf`. The safety branch was also pushed. Implementation diff: **54 files, 2,330 insertions, 527 deletions**. A documentation-only follow-up records these observed results; it does not alter application behavior.

Production migration at fixed as-of `2026-09-22T07:02:26Z`:

| Sport | Reviewed dry-run | Additive apply | Repeat dry-run |
| --- | --- | --- | --- |
| NFL | 64 retrospective records | 64 classifications appended | 0 new; 64 already classified |
| NCAAF | 145 retrospective records | 145 classifications appended | 0 new; 145 already classified |

The only reclassification destinations are `/data/nfl/integrity/reclassification-v1.jsonl` and `/data/ncaaf/integrity/reclassification-v1.jsonl`. Both runs reported **0 raw files modified**. New quote/entry/signal/resolution journals are additive. No synthetic production tickets were created.

Production smoke results:

- Root, NFL, NCAAF, and MLB health: HTTP 200. NFL/NCAAF report `clv-integrity-v1`, journal `ok:true`, and no journal errors.
- NFL Board loaded 16 games; Live, My Bets, and Tools worked. Tools showed Journal OK. My Bets showed unavailable verified CLV as an em dash, not zero.
- Completed-game details showed immutable-source timestamps, provisional closes, scheduled-start basis, and the actual-kickoff-unavailable reason. Raw stale/unverified prices remained visible without actionable full-game or first-half buttons.
- NCAAF Board loaded 71 games. Production college mobile view at **390 × 844** rendered with 390-pixel body width, no page overflow, and working bottom navigation. A 721-pixel intermediate tablet layout was also checked. Temporary viewport overrides were reset.
- Source health for ESPN, Action Network, VSiN, Pinnacle and Open-Meteo reported successful polls and no current errors for both sports. Connectivity does not establish quote freshness.
- No browser console errors were observed during the production college smoke.
- Production Admin correctly presented its sign-in boundary; the authorized in-app browser has no owner session. Authenticated production Admin functionality was therefore **not verified**. Local Admin Center was verified.
- No active football game or existing ticket was available for observing a production settlement transition. Grading is verified by the regression suite and actual local HTTP final-game settlement. A separate local college UI ticket was saved, then its disclosure expanded successfully to show frozen UTC wager time, actual entered line/price, `MISSING_ENTRY_SNAPSHOT`, and null CLV measures. This test stayed in isolated local data.

No application test failures occurred. A browser option-selection attempt needed the option’s exact value because its label contains a non-breaking space; the successful retry completed the UI smoke. An early local upstream Pinnacle poll failure was transient; production source health is recorded above.

A pre-migration backup was created on the existing production volume at `/data/clv-integrity-backups/2026-09-22T06-53-39-400Z`: **21 files, 2,227,562 bytes**, all copied bytes SHA-256 verified. The source files were not modified. This is a verified per-file live backup; append-only telemetry may advance during the copy. Baseline code remains the separately recorded rollback revision.

## Limitations and uncertainty

- Current inspected feeds lack verified actual kickoff. Today’s new closes can be provisional or unavailable; verified mode is supported and tested against explicit actual-start evidence.
- Historical snapshots/entry timestamps/opposing prices that were never captured cannot be recovered honestly.
- Action v2/ESPN observations without source timestamps remain unverified. This intentionally reduces actionable edge coverage.
- A displayed or API-provided sportsbook quote does not prove executable availability, stake limits, or acceptance. No sportsbook order placement is automated.
- Append-only journals and in-memory indexes grow over time; monitor disk and RSS and plan archival. Snapshot/entry/signal writes are durably flushed; reconstructible resolution records are appended without an individual fsync. Run reclassification serially with a fixed `--as-of` for reproducibility.
- File-based persistence remains single-replica. Multi-replica operation requires coordinated storage and locking before scaling.
- Chrome automation was unavailable. The user authorized the available in-app browser for testing; its session is separate from Chrome and does not have owner/Admin access in production.

## Recommended next work

1. **One My Bets view across THE.BOARD.** Keep the existing per-sport storage and ownership rules; aggregate authorized tickets behind a terminal route. Use All/NFL/NCAAF/MLB filters, Live/Upcoming/Settled groups, stable sport-qualified ticket IDs, and per-sport/book/market performance. Link the existing `ps_uid`, `hl_uid`, and `bbl_uid` ownership identities explicitly; the shared front-door login or telemetry device ID does not establish shared ticket ownership. Do not pool unlike CLV point measures into one average.
2. **Three opt-in alert categories.** Ticket events (start/halftime/settlement), integrity warnings (stale/suspended/missing close), and qualified market signals. Deduplicate, use cooldowns, show observation time and reason, and notify on meaningful state changes rather than every poll. Persist an alert lifecycle (watching → eligible → changed → expired/withdrawn) and authenticated replay with SSE event IDs; reconnects must not duplicate alerts. The [WHATWG SSE standard](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header) provides last-event resumption, while durable replay is application responsibility.
3. **Measure feed and book delays.** Record source-to-receipt lag and market-to-market changes using synchronized comparable observations. Distinguish feed transport delay from an actual lagging sportsbook; retain both distributions and coverage gaps. Provider cadence sets an upper bound on freshness: [The Odds API documents 60-second pregame and 40-second in-play featured-market intervals](https://the-odds-api.com/sports-odds-data/update-intervals.html); this example does not describe the app’s current feeds.
4. **Confirm prices before treating discrepancies as actionable.** Match exact event, period, line, selection and sportsbook; recheck availability, status, observation time and limits where legitimately available. A stale display or differing contract is not a realizable edge. [Sportradar explicitly documents that suspended markets can still carry odds](https://docs.sportradar.com/uof/data-and-features/markets-and-outcomes/market-status), reinforcing the need to gate action by status as well as price.
5. **Replay the information available at the time.** Evaluate frozen model versions against historical as-of snapshots, with out-of-sample periods, latency/price-movement assumptions, and uncertainty intervals. Track calibration and qualified CLV separately from short-term returns.
6. **Independent sharp references and disagreement.** Compare complete contemporaneous markets from multiple sources where available; expose disagreement and missing coverage instead of averaging incompatible contracts or interpreting vig as probability movement.
7. **Keep delivery fast.** Benchmark p50/p95 source-to-UI latency, use indexed history queries and event-driven SSE updates, and bound queueing during ingestion. Improve polling only within providers’ supported limits; faster receipt does not repair missing source timestamps.

These are product and validation improvements, not a guarantee of beating a sportsbook.
