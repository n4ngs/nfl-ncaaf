'use strict';
/* A single book's full-game spread or total that sits far from every other book is almost never a real
   market: it is an alternate-ladder rung, a team total, a half number or a mismatched event that a feed
   labelled as the main line (BetMGM's total of 45.5 at -525 on a 58.5 game). Such a number is dropped
   from the book (not shown, never recorded as a move, never fed to steam/key-number detection) and the
   reported value is kept under `outliers` for inspection.

   Cheap by design: one median per market over the handful of books on a game, no history. The opener
   is never judged or used as a reference; it can legitimately be far from the current number. */
const LIMITS = Object.freeze({ s: 7, t: 7 });
const MIN_PEERS = 3;
const SKIP = new Set(['open']);

function median(values) {
  const v = values.slice().sort((a, b) => a - b), mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/* A genuine off-market number is priced near even at its own line (that is the edge worth showing). An
   alternate rung is priced at the real market's value, so the side the off number makes easy carries the
   heavy juice: 48.5 at +135/-175 when the market is 44.5. That shape, 3+ points off, is dropped too. */
const ALT_GAP = 3, ALT_PROB = 0.56;
const implied = (o) => (o < 0 ? -o / (100 - o) : 100 / (100 + o));
function altPriced(market, value, ref, prices) {
  const [a, b] = prices || [];
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) < 100 || Math.abs(b) < 100) return false;
  const pa = implied(a) / (implied(a) + implied(b));
  // Totals [over, under]: a low total makes the over easy. Spreads [home, away] on the home line: more points
  // for home makes home easy.
  const firstEasy = market === 't' ? value < ref : value > ref;
  return (firstEasy ? pa : 1 - pa) >= ALT_PROB;
}

function dropOutliers(books, limits = LIMITS) {
  if (!books) return books;
  for (const market of Object.keys(limits)) {
    const rows = [];
    for (const [book, line] of Object.entries(books)) {
      if (!SKIP.has(book) && line && Number.isFinite(line[market])) rows.push([book, line[market]]);
    }
    if (rows.length < MIN_PEERS + 1) continue;
    for (const [book, value] of rows) {
      // Judge each book against the others, so the outlier cannot pull its own reference.
      const ref = median(rows.filter(([b]) => b !== book).map(([, v]) => v));
      const line = books[book], gap = Math.abs(value - ref);
      if (gap <= limits[market] && !(gap >= ALT_GAP && altPriced(market, value, ref, line[`${market}o`]))) continue;
      (line.outliers ||= {})[market] = { line: value, prices: line[`${market}o`] || null, consensus: ref, src: line.market_sources?.[market] || line.src || null };
      line[market] = null;
      line[`${market}o`] = [null, null];
      if (line.integrity) delete line.integrity[market];
      if (line.snapshot_ids) delete line.snapshot_ids[market];
      if (line.market_sources) delete line.market_sources[market];
    }
  }
  return books;
}

module.exports = { dropOutliers, LIMITS };
