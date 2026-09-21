# Bing Bong Live — changelog

Newest first. Dates are when the change went live on Railway.

## 2026-09-20

### Sharing
- **Share links and a group screen**, the same as the football apps: one link per person, no code to
  type, and a Group tab for whoever runs the board. (`0825bb8`)

### Betting
- **Edges: push chances measured, not assumed.** (`4e02cf2`)
- **Where to bet** — each Nevada book's own page and its app in the App Store, from the board's opening
  line and from any bet slip. The copy is explicit that you sign in at the book: this app never asks for
  a sportsbook login, never stores one, and never places a bet. (`bfd6f7f`)

### Housekeeping
- **Removed the stale `moonshot/` copy from the repo.** (`47690d0`)

  It was a full snapshot of the app committed inside the repo on 2026-09-19 that had drifted 500 diff
  lines behind the real one — its `server.js` was 1177 lines against the live 1485. Nothing imported it,
  and it shipped to Railway on every deploy. The repo went 31M to 17M.

  The only "moonshot" left in live code is the `localStorage` fallback in `public/js/core.js`, which
  stays: it carries every user's follows, theme and alert settings over from the old name.
