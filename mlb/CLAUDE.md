# ⚾ BING BONG LIVE — MLB (baseball)

**You are in the MLB app.** Folder `~/bing-bong-live` · port **4747** · repo `n4ngs/bing-bong-live`
Live: https://bing-bong-live-production.up.railway.app

If the work in front of you is about football, you are in the wrong folder. Stop and say so.

## Boundary — this session edits ONLY this app

Three sibling sports apps share a parent folder and look alike. Each has its own repo, its own
Railway project, and its own Claude session.

| Sport | App | Folder | Port |
| --- | --- | --- | --- |
| **MLB — this one** | Bing Bong Live | `~/bing-bong-live` | 4747 |
| NCAAF | Hook & Ladder | `~/Projects/hook-and-ladder` | 4848 |
| NFL | Pick Six | `~/Projects/pick-six` | 4849 |

Rules:
- Never edit, read-and-copy-from, or `git` anything outside this folder.
- Asked for NCAAF or NFL work — a status, a fix, a deploy, "how's the other app?" — do not reach
  across. Answer: *that's Hook & Ladder / Pick Six, in `~/Projects/hook-and-ladder` / `~/Projects/pick-six`;
  open a session there.* Another session is often mid-edit in those folders.
- Never report on a sibling app's state. You cannot see it and it changes under you.

## Deploy — users are live, ship silently

- `git push` to `main` **auto-deploys to Railway.** There is no separate deploy step and no staging.
- Real people are on the site right now. No maintenance banners, no "we're updating" copy, no
  announcements in the UI. Ship quietly.
- **Before claiming anything shipped, run `git status`.** Uncommitted or unpushed work means the
  live site is BEHIND what is on disk. Say exactly which: on disk, committed, or live.
- Health check: `/api/health`. Start command: `node server.js`. Branch: `main`.

## Run it locally

```bash
node server.js          # http://localhost:4747
sports local mlb        # same thing via the launcher
```
Node 20+, zero dependencies — nothing to install.

## App-specific rules

- **No `ACCESS_CODE`.** The app is public on purpose. Do not set it, do not add a login wall, do
  not "secure" it unprompted.
- **`OWNER_CODE` lives in Railway vars only.** It claims unowned bets. Never hardcode it, never
  commit it, never print it.
- **Storage:** Railway volume at `/data`, `DATA_DIR=/data`. `lib/util.js` resolves `DATA_DIR` and
  falls back to `./data` locally. All writes are atomic JSON — keep them that way.
- **Five tabs:** Live, Homers, Games, Mine, Tools (`public/index.html` nav + `public/js/views.js`).
  Adding or renaming a tab touches both the top nav and the bottom bar.
- **Layout:** `lib/*.js` is server-side — odds, books, lines, bets, pinnacle, vsin, espn, weather.
  Front-end is `public/js/` — `odds.js`, `bets.js`, `mlbhome.js`, `mlbtools.js` plus core/live/views.
  `server.js` is one large file serving the API and the SSE stream; keep new logic in `lib/`.
- **Data sources are public MLB endpoints, no keys** (statsapi, baseballsavant). Don't add an
  API-key dependency without asking.
- Only MLB terminology belongs in this repo: homers, at-bats, Statcast, ballparks.
