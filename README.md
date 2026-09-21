# NFL.NCAAF

One app, two sports. A thin terminal (`terminal.js`) serves the **Pick Six** (NFL) and
**Hook & Ladder** (NCAAF) engines under one origin with a sport switcher:

- `/nfl/*`   → the NFL engine   (`nfl/`,   `BASE_PATH=/nfl`,   `DATA_DIR=data/nfl`)
- `/ncaaf/*` → the NCAAF engine (`ncaaf/`, `BASE_PATH=/ncaaf`, `DATA_DIR=data/ncaaf`)

The proxy strips the sport prefix before forwarding, so each engine runs exactly as it does
standalone and only stamps its prefix onto output URLs (cookies, redirects, manifest, the
injected `<base href>` and the top switcher). Same origin ⇒ auth, cookies, the SSE live feed and
bet-writing all work per sport with no cross-origin plumbing.

## Run locally
```bash
node terminal.js          # http://localhost:4000  → /nfl/ and /ncaaf/
```
`PORT` (default 4000), `DATA_DIR` (default ./data). Set `ACCESS_CODE` (or `NFL_ACCESS_CODE` /
`NCAAF_ACCESS_CODE`) to gate the boards. Node 18+, zero dependencies.

## Layout
```
terminal.js   front router: spawns both engines, reverse-proxies /nfl and /ncaaf, SSE-aware
nfl/          Pick Six engine (vendored)   — server.js + lib/ + public/
ncaaf/        Hook & Ladder engine (vendored)
data/         runtime state per sport: data/nfl/, data/ncaaf/  (not source)
```
The two engines are vendored copies; this repo is the canonical merged app.
