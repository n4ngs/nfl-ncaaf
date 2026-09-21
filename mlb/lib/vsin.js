'use strict';
/* VSiN's Vegas line tracker for MLB (verified: https://data.vsin.com/vegas-odds-linetracker/?sportid=mlb, the same
   page layout hook-and-ladder reads for college football). The only free place that shows the Nevada windows side by
   side: Circa, Boomer's, BetMGM, Caesars, Westgate, Station, South Point and Wynn. It's an HTML table, not an API,
   so this reads the table, and only re-reads it when its "Odds updated" stamp changes. Full game only. */

const { getText, num, norm, etStampTime, pairGames, flipLine, cleanLine } = require('./util');
const { BOOKS } = require('./books');

const URL_ = 'https://data.vsin.com/vegas-odds-linetracker/?sportid=mlb';
const keyOf = Object.fromEntries(BOOKS.filter((b) => b.vsin).map((b) => [norm(b.vsin), b.key]));

const text = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const cells = (row) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
const pair = (html) => {
  const nn = /sp-s-num">([^<]*)</.exec(html || '')?.[1];
  const j = /sp-s-juice">(?:<span[^>]*>[ou]<\/span>)?([^<]*)</.exec(html || '')?.[1];
  return [num(String(nn || '').replace(/^pk$/i, '0')), num(String(j || '').replace(/^ev(en)?$/i, '100'))];
};
const plain = (html) => num(text(html).replace(/^PK$/i, '0').replace(/^EV(EN)?$/i, '100'));

function parse(html) {
  const stamp = /Odds updated:\s*([^<]+)</.exec(html)?.[1]?.trim() || null;
  const head = /<thead>([\s\S]*?)<\/thead>/.exec(html)?.[1] || '';
  const books = [...head.matchAll(/class="sp-book-group"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => keyOf[norm(text(m[1]))] || null);
  const byId = new Map();
  // The page carries two tables: the full game, then the first five innings.
  for (const [, cls, body] of html.matchAll(/<tbody class="(sp-tbody-(?:fg|1h))">([\s\S]*?)<\/tbody>/g)) {
    const five = cls.endsWith('1h');
    const rows = [...body.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)].map((m) => ({ open: /sp-row-open/.test(m[1]), td: cells(m[2]) }));
    for (let i = 0; i + 2 < rows.length; i++) {
      if (!rows[i].open || rows[i + 1].open || rows[i + 2].open) continue;
      const [o, r, h] = [rows[i], rows[i + 1], rows[i + 2]];
      const id = /openGameDetail\('(\d{8})MLB(\d+)'\)/.exec(o.td[0] || '');
      const road = text(r.td[0]), home = text(h.td[0]);
      if (!road || !home) continue;
      const key = id ? `${id[1]}${id[2]}` : `${road}|${home}|${i}`;
      const G = byId.get(key) || {
        id: key,
        date: id ? `${id[1].slice(0, 4)}-${id[1].slice(4, 6)}-${id[1].slice(6, 8)}` : null,
        rot: id ? num(id[2]) : null, road, home, books: {}, f5: {},
      };
      books.forEach((book, b) => {
        if (!book) return;
        const c = 1 + b * 3;
        const [rs, rj] = pair(r.td[c]), [hs, hj] = pair(h.td[c]);
        const [tot, oj] = pair(r.td[c + 2]), [tot2, uj] = pair(h.td[c + 2]);
        const line = hs ?? (rs == null ? null : -rs);
        const L = cleanLine({
          ml: [plain(h.td[c + 1]), plain(r.td[c + 1])],
          rl: line != null && Math.abs(line) === (five ? 0.5 : 1.5) ? { line, odds: [hj, rj] } : null,
          t: { line: tot ?? tot2, odds: [oj, uj] },
        });
        if (L) (five ? G.f5 : G.books)[book] = L;
      });
      byId.set(key, G);
    }
  }
  const games = [...byId.values()].filter((G) => Object.keys(G.books).length || Object.keys(G.f5).length);
  return { stamp, games };
}

let last = { stamp: null, games: [], at: 0 };
async function fetchVsin() {
  const html = await getText(URL_, { timeout: 25000 });
  const stamp = /Odds updated:\s*([^<]+)</.exec(html)?.[1]?.trim() || null;
  if (stamp && stamp === last.stamp) return { ...last, same: true };
  const p = parse(html);
  if (!p.games.length) throw new Error('VSiN MLB table not found (the page layout may have changed)');
  last = { ...p, at: Date.now(), t: etStampTime(p.stamp) || Date.now() };
  return last;
}

// Map VSiN games onto MLB gamePks for one baseball day. Returns Map pk -> { books, f5 }.
function matchVsin(vgames, games, date) {
  const feed = vgames.filter((v) => !v.date || v.date === date).map((v) => ({ key: v.id, home: v.home, away: v.road, order: v.rot, v }));
  const pairs = pairGames(feed, games);
  const out = new Map();
  for (const f of feed) {
    const m = pairs.get(f.key);
    if (!m) continue;
    const side = (o) => Object.fromEntries(Object.entries(o).map(([k, L]) => [k, m.swap ? flipLine(L) : L]));
    out.set(m.pk, { books: side(f.v.books), f5: side(f.v.f5 || {}) });
  }
  return out;
}

module.exports = { fetchVsin, matchVsin, parse };
