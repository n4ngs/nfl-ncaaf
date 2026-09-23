'use strict';
// Pregame timing capture for the goalie model.
//
// Records two append-only streams per game from 8 hours before puck drop until 5 minutes after:
//   type "ml"     every sportsbook moneyline, written only when some price changes (with each book's own
//                 source_observed_at, so book reaction time can be measured, not guessed)
//   type "goalie" the official NHL boxscore starter flags per team, written when they change
// Together they answer the question the research model raised: how long after a starter is known do the books
// move, and is there time to act. `t` is this server's receipt clock; it is never presented as NHL publish time.
// Files: <dir>/<YYYY-MM-DD UTC>.jsonl. Nothing here predicts, bets or changes any displayed price.
const fs = require('node:fs'), path = require('node:path');

const BEFORE = 8 * 3600e3, AFTER = 5 * 60e3;
const BOX_EVERY_FAR = 5 * 60e3, BOX_EVERY_NEAR = 45e3, NEAR = 90 * 60e3;
const KEEP_DAYS = 400;

function pricesOf(books) {
  const out = {};
  for (const [book, L] of Object.entries(books || {})) {
    const ml = L && L.integrity && L.integrity.ml;
    if (!ml) continue;
    const sides = {};
    for (const [side, q] of Object.entries(ml)) {
      const o = Number(q && q.american_odds);
      if (q && Number.isFinite(o) && o !== 0) sides[side] = { o, t: q.source_observed_at || null, s: q.source || null, f: q.freshness || null };
    }
    if (Object.keys(sides).length) out[book] = sides;
  }
  return out;
}

function startersOf(raw) {
  const out = {};
  for (const side of ['home', 'away']) {
    const team = raw && raw[side + 'Team'];
    const list = ((raw && raw.playerByGameStats && raw.playerByGameStats[side + 'Team']) || {}).goalies || [];
    out[side] = {
      teamId: team && team.id || null,
      starters: list.filter(g => g.starter === true).map(g => ({ id: g.playerId, name: g.name && g.name.default || null })),
      dressed: list.map(g => g.playerId),
    };
  }
  return out;
}

function create({ dir, fetchBox, now = Date.now }) {
  fs.mkdirSync(dir, { recursive: true });
  const lastPrice = new Map(), lastGoalie = new Map(), boxAt = new Map();
  const stats = { written: 0, errors: 0, lastWriteAt: null, lastError: null };

  // Seed from recent files so a restart/deploy does not re-log unchanged state as new events.
  for (const day of [0, 1].map(d => new Date(now() - d * 86400e3).toISOString().slice(0, 10))) {
    const f = path.join(dir, day + '.jsonl');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      try {
        const r = JSON.parse(line);
        if (r.type === 'ml') lastPrice.set(r.gid, priceKey(r.books));
        if (r.type === 'goalie') lastGoalie.set(r.gid + ':' + r.side, goalieKey(r));
      } catch {}
    }
  }
  prune();

  function priceKey(books) {
    return JSON.stringify(Object.keys(books).sort().map(b => [b, Object.keys(books[b]).sort().map(s => [s, books[b][s].o])]));
  }
  function goalieKey(r) { return JSON.stringify([r.starters.map(s => s.id).sort(), r.dressed.slice().sort()]); }
  function append(rec) {
    fs.appendFileSync(path.join(dir, rec.t.slice(0, 10) + '.jsonl'), JSON.stringify(rec) + '\n');
    stats.written++; stats.lastWriteAt = rec.t;
  }
  function prune() {
    const cutoff = new Date(now() - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
    for (const f of fs.readdirSync(dir)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < cutoff) fs.rmSync(path.join(dir, f));
  }
  const inWindow = (g, t) => {
    const s = Date.parse(g.start);
    return Number.isFinite(s) && !g.final && t >= s - BEFORE && t <= s + AFTER;
  };

  function recordPrices(g, books, t) {
    const p = pricesOf(books);
    if (!Object.keys(p).length) return;
    const key = priceKey(p);
    if (lastPrice.get(g.id) === key) return;
    lastPrice.set(g.id, key);
    append({ t: new Date(t).toISOString(), type: 'ml', gid: g.id, state: g.state || null, start: g.start, books: p });
  }

  async function pollBox(g, t) {
    const due = Date.parse(g.start) - t < NEAR ? BOX_EVERY_NEAR : BOX_EVERY_FAR;
    if (t - (boxAt.get(g.id) || 0) < due) return null;
    boxAt.set(g.id, t);
    let raw;
    try { raw = await fetchBox(g.id); } catch (e) { stats.errors++; stats.lastError = String(e && e.message || e).slice(0, 120); return null; }
    const got = new Date(now()).toISOString(), s = startersOf(raw);
    for (const side of ['home', 'away']) {
      const rec = { t: got, type: 'goalie', gid: g.id, side, gameState: raw && raw.gameState || null, start: g.start, ...s[side], source: 'nhl-boxscore' };
      const k = goalieKey(rec);
      if (lastGoalie.get(g.id + ':' + side) === k) continue;
      lastGoalie.set(g.id + ':' + side, k);
      append(rec);
    }
    return raw;
  }

  let running = false;
  return {
    // games: iterable of board games; booksFor(g) -> combined books object. Returns fetched boxscores.
    async tick(games, booksFor) {
      if (running) return [];
      running = true;
      const raws = [];
      try {
        const t = now();
        for (const g of games) {
          if (!inWindow(g, t)) continue;
          try { recordPrices(g, booksFor(g), t); } catch (e) { stats.errors++; stats.lastError = String(e && e.message || e).slice(0, 120); }
          const raw = await pollBox(g, t);
          if (raw) raws.push(raw);
        }
        if (t % 3600e3 < 5000) prune();
      } finally { running = false; }
      return raws;
    },
    status() { return { ...stats, gamesPriced: lastPrice.size, dir: path.basename(dir) }; },
    read(day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null;
      const f = path.join(dir, day + '.jsonl');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    },
  };
}

module.exports = { create, pricesOf, startersOf };
