# 🏈 NFL.NCAAF — the merged terminal

This repo is **one app** that serves two sports under one origin with a top switcher:

- `/nfl/*`   → the **Pick Six** engine (NFL)      — `nfl/`
- `/ncaaf/*` → the **Hook & Ladder** engine (NCAAF) — `ncaaf/`

`terminal.js` spawns both engines as children on internal ports and reverse-proxies to them,
stripping the sport prefix before forwarding. Each engine runs exactly as it does standalone and
only stamps its prefix onto OUTPUT urls via `BASE_PATH` (cookies, redirects, manifest, the injected
`<base href>`, the sport switcher). Same origin ⇒ auth, cookies, SSE and bet-writing work per sport.

## Boundaries
- `nfl/` and `ncaaf/` are **vendored copies** of the two apps. Fix sport logic in the matching subdir.
- Only OUTPUT-url handling is merge-specific (guarded by `BASE_PATH`; empty = standalone root behaviour).
- Data is per sport: `data/nfl/`, `data/ncaaf/` (own volumes-worth of bets, lines, telemetry).

## Run locally
```bash
node terminal.js        # http://localhost:4000 → /nfl/ and /ncaaf/
```
`PORT` (4000), `DATA_DIR` (./data), `ACCESS_CODE` (or `NFL_ACCESS_CODE` / `NCAAF_ACCESS_CODE`),
`OWNER_NAME`, `OWNER_CODE`. The Security Center "All apps" toggle aggregates the two engines over
localhost (a shared `TELEMETRY_PEER_SECRET` is auto-generated per boot if unset).

## Admin Center (`/admin`, owner only)
`board.js` + `board-page.js`, run inside the terminal. The terminal is the one place every request passes
through and the one place that knows owner vs guest at the door, so capture lives here, not in the engines:
one `tb_dev` device id across all three sports, role stamped on every event (owner can pin a device as
"me"/"guest"), full UA + observed client IP with source/type metadata (`shared/client-ip.js`), page loads/API calls, and the boards' own
screen/tap log (`js/tel.js` POSTs to `/<sport>/api/telemetry`, teed by the terminal, then passed on; MLB's
is answered by the terminal). Log: `DATA_DIR/board/events-*.jsonl` + `devices.json`. Bets and guest names
are read from each engine's own files. Capture is silent — never sign anyone out or prompt for a name.

## Deploy
One Railway service, `node terminal.js`, health `/health`, `numReplicas: 1`, one volume at `/data`
holding `nfl/` and `ncaaf/`. See `CUTOVER.md`.

### Client IP trust boundary
On Railway, the terminal prefers a validated single `X-Real-IP`, with the rightmost valid
`X-Forwarded-For` hop as fallback. Direct/local requests use the socket and ignore forwarded headers.
The terminal forwards a sanitized HMAC-signed observation to loopback-only child engines using the
existing per-boot peer secret; child engines reject unsigned or tampered identity assertions.
Admin shows the address the app observes, including provenance and private/local classification.
Historical observations without provenance remain labeled as such. VPN/Private Relay exit addresses
cannot reveal a hidden originating address. No authentication code or peer secret belongs in reports.
