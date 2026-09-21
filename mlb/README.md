# Bing Bong Live

A live MLB home run tracker. Every homer shows up within seconds, with the Statcast
numbers, the ballpark it landed in, a plain-English read for people who don't
follow baseball, and the video once MLB posts it.

## Live link

**https://bing-bong-live-production.up.railway.app**

It runs 24/7 on Railway (project `bing-bong-live`), so your Mac doesn't need to be on.

- **iPhone:** open the link in Safari, tap Share, then Add to Home Screen.
- **Android:** open the link in Chrome, tap ⋮, then **Install app** (or Add to Home screen).

### Update the live version

```bash
git push && railway up --detach
```

### Make it private

Set an access code, and visitors enter it once:

```bash
railway variables --set ACCESS_CODE=your-code
```

A one-tap link that includes the code also works: `https://…up.railway.app/?code=your-code`. Remove the variable to open it up again.

## Run it on your Mac

```bash
node server.js
```

Then open http://localhost:4747. On a Mac you can also double-click **Start Bing Bong Live.command**.

It needs Node 18 or newer and has no dependencies, so there's nothing to install.

## What's on the page

- **In the air.** As soon as Statcast measures a ball in play, Bing Bong Live compares its
  distance to that park's wall in that direction and calls it: *Looks gone*, *Could be gone*
  or *Deep drive*. That usually lands 5–35 seconds before MLB posts the official result.
- **Latest home run.** Distance, exit velocity, launch angle, and how many of the 30
  parks it would have cleared. It also draws the park's real wall with the landing spot,
  plus a side view of the flight path.
- **Home runs / All hits.** Every hit of the day, live, sortable by newest, longest or hardest.
- **Statcast.** Hardest-hit balls, longest drives, *almost homers* (caught here, gone
  elsewhere), fastest pitches and fastest swings.
- **Season race.** HR, hits, RBI and stolen-base leaders. Tap anyone for a season HR chart.
- **Replay any day** with the date arrows.
- **Alerts.** A sound and desktop notification for every homer, or only for players you follow.
- **Plain English** (on by default) turns stats into everyday comparisons: football
  fields, highway speed, how many parks it clears.

## Where the data comes from

All of these are public endpoints and need no key:

| Source | What it gives | How often |
| --- | --- | --- |
| `statsapi.mlb.com/api/v1.1/game/{pk}/feed/live` | Plays, Statcast hit data (exit velo, angle, distance, landing spot) | Every 3 s per live game, trimmed to about 15 KB |
| `baseballsavant.mlb.com/gf?game_pk={pk}` | xBA, barrels, bat speed, HR-in-N-of-30-parks, pitch speeds | Every 25 s, and again 7 s after each new ball in play |
| `statsapi.mlb.com/api/v1/game/{pk}/content` | Highlight video for each play | Every 45 s until each homer has its clip |
| `statsapi.mlb.com/api/v1/stats/leaders` | Season leaderboards | Cached for 3 min |

The server pushes changes to the browser over Server-Sent Events, so nothing waits on a page refresh.

## Sharing it with friends

You hold the access code; everyone else gets a link. In **Tools → The group**, make a link (one per person, or
one for a whole crew), send it, and opening it lets that phone in for good — nothing to type. Turning a link
off locks out exactly the phones that used it.

- **The code makes you the owner.** Set `ACCESS_CODE`; it's the only way to the group screen. If you've ever
  shared the code itself, change it and hand out links instead.
- **A link makes a guest.** Guests see the whole board and their own log: bets, counter numbers and CSV are
  scoped to a random device id in a secure cookie, so no guest sees another guest's, or yours.
- **The group screen** shows each person's open tickets, record and net, and their full log on tap, read-only.
  The guest's own Tools card says in one line that whoever runs the board can see their tickets — leave it
  there; people are entitled to know what happens to their own records.
- `OWNER_NAME` (optional) puts your name on the welcome a guest sees ("Chris's board").

## Settings

| Env var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4747` | Port to serve on |
| `FEED_MS` | `3000` | How often each live game is polled, in ms (minimum 1500) |

## Notes

- Flight-path height and hang time are estimates. They come from a physics model fitted
  to the measured exit velocity, angle and distance, and they're labeled "est." in the app.
- "In the air" calls are made before MLB rules on the play. Now and then a ball that
  *looks gone* gets caught at the wall, and the app says so when the result comes in.
- MLB data is © MLB Advanced Media. This project is for personal use.
