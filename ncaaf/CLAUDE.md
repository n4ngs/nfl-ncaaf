# 🏈 HOOK & LADDER — NCAAF (college football)

**You are in the college football app.** Not MLB, not NFL. Everything in this folder is NCAAF.

| | |
| --- | --- |
| App | Hook & Ladder — FBS college football lines |
| Folder | `~/Projects/hook-and-ladder` |
| Local port | **4848** |
| Live | https://hook-and-ladder-production.up.railway.app |
| GitHub | `n4ngs/hook-and-ladder` (branch `main`) |
| Stack | One Node 18 server (`server.js`, no dependencies) + static `public/` |

## Boundary — edit only this app

This session edits **only Hook & Ladder**. The siblings are separate repos with their own sessions:

- **Bing Bong Live** — MLB home runs + betting — `~/bing-bong-live`, port 4747
- **Pick Six** — NFL — `~/Projects/pick-six`, port 4849

If asked for work on a sibling, say which app it belongs to and point at that folder. Do **not** open,
edit, or `cd` into it from here — another session may be mid-edit there. Same rule for status questions:
report only what is true of this repo. If a request is ambiguous ("add the CLV chart"), ask which app.

## Deploy — push is production

- Pushing `main` auto-deploys to Railway. There is no staging. `railway.json`: start `node server.js`,
  health check `/api/health`, 1 replica (bets + line history live on one volume).
- **Before claiming anything shipped, run `git status` and `git log origin/main..HEAD`.** Uncommitted or
  unpushed work means the live site is BEHIND what is on disk. Say so plainly instead of saying it's live.
- Users are on the site during games. **Ship silently**: no maintenance banners, no forced re-login, no
  version prompts. Never change `ACCESS_CODE` casually — changing it signs every device out.
- Never break `/api/health` or the `/api/stream` SSE contract; a failed health check restarts the app.

## Run it locally

```bash
cd ~/Projects/hook-and-ladder && node server.js   # http://localhost:4848
sports local ncaaf                              # same thing via the launcher
```

Nothing to install. `DATA_DIR` (default `./data`) holds `bets.json`, `manual.json`, `weeks/`.
`ACCESS_CODE` gates every page and API, rate-limited to 5 wrong codes per 15 min per address.

## App rules (non-negotiable)

1. **Informational, never prescriptive.** Describe what the market is doing; never tell the user what to
   bet. No "edge" alerts, no pick-of-the-day, no default or suggested stake amounts.
2. **Confidence labels are Solid / Thin / Weak**, always with the caveat that says why (sample size, feed
   lag, stale price). No percentages dressed up as certainty. Estimates stay labeled as estimates.
3. **Sportsbook links go to NEVADA books only**: BetMGM NV, Caesars NV, Circa, STN, Westgate SuperBook,
   South Point (plus Boomer's, Wynn). The book list lives in `lib/books.js` — add links there, and never
   add an out-of-state or offshore link. Pinnacle is a reference line, not a link target.
4. Keep the tone: plain English, one typeface, one live red. 21+ / 1-800-GAMBLER stays on the page.

## Layout

```
server.js      Routes: /api/week, /api/bets, /api/stream (SSE), /api/manual, /api/me, /api/health
lib/           action.js vsin.js pinnacle.js espn.js weather.js · lines.js books.js bets.js margins.js
public/        index.html, app.css, js/ (core, live, views, sheets, boot)
data/weeks/    Self-recorded line history — the source for charts and steam. Do not delete.
```

Feeds are unofficial public endpoints (ESPN, Action Network, VSiN, Pinnacle, Open-Meteo). Poll gently,
keep the cache intervals at or above their floors, and never republish the data.
