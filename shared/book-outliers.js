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

/* A 0 (PK) spread is only a real PK when the book's own moneyline agrees and the market is near 0; otherwise it is
   BetMGM's upstream "0 handicap" failure. A book whose moneyline favorite is the other team, by a wide margin,
   or with 2+ bad markets at once, is quoting a different event or a stale row: the whole row is quarantined. */
const PK_FAV = 0.60, PK_MARKET = 2.5, FLIP_GAP = 0.12;
const homeProb = (ml) => {
  const [h, a] = ml || [];
  if (!Number.isFinite(h) || !Number.isFinite(a) || Math.abs(h) < 100 || Math.abs(a) < 100) return null;
  return implied(h) / (implied(h) + implied(a));
};
const favImplied = (ml) => {
  const v = (ml || []).filter((o) => Number.isFinite(o) && Math.abs(o) >= 100);
  return v.length === 2 ? implied(Math.min(...v)) : null;
};

function dropOutliers(books, limits = LIMITS) {
  if (!books) return books;
  // Decide against the untouched numbers first, then apply, so one drop never shifts another's reference.
  const found = new Map();
  const flag = (book, market, entry) => { const m = found.get(book) || {}; m[market] ||= entry; found.set(book, m); };
  const entries = Object.entries(books).filter(([book, line]) => !SKIP.has(book) && line);
  for (const market of Object.keys(limits)) {
    const rows = entries.filter(([, line]) => Number.isFinite(line[market])).map(([book, line]) => [book, line[market]]);
    for (const [book, value] of rows) {
      const line = books[book], prices = line[`${market}o`] || null, src = line.market_sources?.[market] || line.src || null;
      const peers = rows.filter(([b]) => b !== book).map(([, v]) => v);
      // Judge each book against the others, so the outlier cannot pull its own reference.
      const ref = peers.length >= MIN_PEERS ? median(peers) : null;
      let reason = null;
      if (ref !== null) {
        const gap = Math.abs(value - ref);
        if (gap > limits[market]) reason = 'off_consensus';
        else if (gap >= ALT_GAP && altPriced(market, value, ref, prices)) reason = 'alt_price';
      }
      if (!reason && market === 's' && value === 0) {
        if ((favImplied(line.ml) ?? 0) >= PK_FAV) reason = 'pk_vs_moneyline';
        else if (ref !== null && Math.abs(ref) >= PK_MARKET) reason = 'pk_vs_market';
      }
      if (reason) flag(book, market, { line: value, prices, consensus: ref, src, reason });
    }
  }
  const mlRows = entries.map(([book, line]) => [book, homeProb(line.ml)]).filter(([, p]) => p !== null);
  if (mlRows.length >= MIN_PEERS + 1) for (const [book, p] of mlRows) {
    const ref = median(mlRows.filter(([b]) => b !== book).map(([, v]) => v));
    if ((p - 0.5) * (ref - 0.5) < 0 && Math.abs(p - ref) >= FLIP_GAP) flag(book, 'ml', { line: null, prices: books[book].ml, consensus: Math.round(ref * 1000) / 1000, src: books[book].market_sources?.ml || books[book].src || null, reason: 'ml_flip' });
  }
  for (const [book, markets] of found) {
    const line = books[book];
    if (markets.ml || Object.keys(markets).length >= 2) {
      line.quarantined = true;
      for (const market of ['s', 't', 'ml']) if (!markets[market] && (market === 'ml' ? homeProb(line.ml) !== null : Number.isFinite(line[market])))
        markets[market] = { line: market === 'ml' ? null : line[market], prices: market === 'ml' ? line.ml : line[`${market}o`] || null, consensus: null, src: line.market_sources?.[market] || line.src || null, reason: 'row_mismatch' };
    }
    for (const [market, entry] of Object.entries(markets)) {
      (line.outliers ||= {})[market] = entry;
      if (market === 'ml') line.ml = [null, null];
      else { line[market] = null; line[`${market}o`] = [null, null]; }
      if (line.integrity) delete line.integrity[market];
      if (line.snapshot_ids) delete line.snapshot_ids[market];
      if (line.market_sources) delete line.market_sources[market];
    }
  }
  return books;
}

module.exports = { dropOutliers, LIMITS };
