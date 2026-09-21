# NFL.NCAAF — production cutover runbook

Goal: one Railway service serving the merged app, with **both apps' existing bet/line history
preserved**, then retire the two old URLs (301 → the merged app). The two live services keep running
until the merged app is verified. Nothing here is destructive until the final 301/retire step.

Live today (unchanged):
- NFL   — Pick Six       — https://pick-six-production-1051.up.railway.app   (repo n4ngs/pick-six)
- NCAAF — Hook & Ladder  — https://hook-and-ladder-production.up.railway.app (repo n4ngs/hook-and-ladder)

## 1. Repo
```bash
gh repo create n4ngs/nfl-ncaaf --private --source=. --remote=origin --push
```

## 2. Railway service + volume
- New project/service from `n4ncs/nfl-ncaaf`. Start `node terminal.js`, health `/health`, 1 replica.
- Add ONE volume mounted at `/data` (the engines write `/data/nfl` and `/data/ncaaf`).

## 3. Env (owner runs — the assistant is blocked from Railway secret writes)
Set on the merged service:
```
ACCESS_CODE=<the code>            # or NFL_ACCESS_CODE / NCAAF_ACCESS_CODE for different codes per sport
OWNER_NAME=<name>
OWNER_CODE=<claim code, if used>
# optional; auto-generated per boot if unset (peer is localhost-only here):
TELEMETRY_PEER_SECRET=<64 hex>
```

## 4. Migrate data (preserve bets/lines/telemetry)
Each old service holds its state on its own volume. Move it into the merged volume's subdirs:
- Pick Six volume  → `/data/nfl`
- Hook & Ladder    → `/data/ncaaf`

Practical path (assistant can write the export/import scripts when ready):
1. In each old service, `railway run` a tar of its `/data` (e.g. `tar czf - -C /data .`) to a file.
2. Upload/restore into the merged volume under the matching subdir before first real traffic.
(If a clean start is acceptable, skip this — but guests lose their bet history, so migrate.)

## 5. Deploy + verify
- Deploy; wait ~90s. Verify:
  - `/health` → 200; `/` → 302 to `/nfl/`; `/nfl/` and `/ncaaf/` load with the switcher.
  - Owner login on each tab; place a test bet on each → lands in the right sport's volume.
  - Live SSE ticks on both; Security Center "All apps" shows both engines.

## 6. Retire the old URLs (only after verification)
- Point the desired custom domain at the merged service.
- In each old service, replace the app with a 301 to the merged URL's sport path
  (`/nfl/` or `/ncaaf/`) so existing links and installed icons keep working.
- Keep the old volumes (backup) for a while before deleting.

## Rollback
The old services are untouched until step 6; if anything is wrong, keep using them and iterate on
the merged app. No data is deleted at any point in this runbook.
