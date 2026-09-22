'use strict';

const { nameScore } = require('./util');

// Provider identities are local to Owls. Only an unambiguous pair of teams at a
// nearby scheduled start may acquire an ESPN identity used by tickets and CLV.
function matchAll(events, games, score = nameScore) {
  const out = new Map(), duplicate = new Set();
  for (const event of events || []) {
    const start = Date.parse(event.start);
    if (!Number.isFinite(start) || !event.home || !event.away) continue;
    const matches = [];
    for (const game of games) {
      const at = Date.parse(game.start);
      if (!Number.isFinite(at) || Math.abs(start - at) > 6 * 3600e3) continue;
      const straight = Math.min(score(event.home, game.home), score(event.away, game.away));
      const reverse = Math.min(score(event.home, game.away), score(event.away, game.home));
      if (Math.max(straight, reverse) < 3 || straight === reverse) continue;
      matches.push({ game, score: Math.max(straight, reverse), swap: reverse > straight });
    }
    matches.sort((a, b) => b.score - a.score);
    if (!matches.length || matches[1]?.score === matches[0].score) continue;
    const { game, swap } = matches[0];
    if (duplicate.has(game.id)) continue;
    if (out.has(game.id)) { out.delete(game.id); duplicate.add(game.id); continue; }
    const lines = (books) => Object.fromEntries(Object.entries(books || {}).map(([key, raw]) => {
      const line = structuredClone(raw);
      line.provider_event_id ??= event.id;
      if (swap) {
        line.s = line.s == null ? null : -line.s;
        if (line.so) line.so = [line.so[1], line.so[0]];
        if (line.ml) line.ml = [line.ml[1], line.ml[0]];
        for (const market of ['s', 'h1s', 'ml']) {
          const sides = line.integrityMeta?.[market];
          if (sides) line.integrityMeta[market] = {
            ...(sides.away ? { home: sides.away } : {}),
            ...(sides.home ? { away: sides.home } : {}),
          };
        }
      }
      return [key, line];
    }));
    out.set(game.id, { id: event.id, books: lines(event.books), live: lines(event.live), h1: lines(event.h1) });
  }
  return out;
}

// An authoritative snapshot can withdraw a market without sending a new price.
// Keep that absence explicit and untimed; receipt time is never a quote clock.
function reconcileBooks(previous, incoming, receivedAt, isLive, source = 'owls') {
  const out = structuredClone(incoming || {});
  for (const [book, prior] of Object.entries(previous || {})) {
    for (const [market, sides] of Object.entries(prior.integrity || {})) {
      const rawMarket = market.replace(/^h1/, '');
      for (const [selection, snapshot] of Object.entries(sides)) {
        if (!snapshot || snapshot.market_status === 'removed' || snapshot.is_live !== isLive) continue;
        if (out[book]?.integrityMeta?.[market]?.[selection] || out[book]?.integrityMeta?.[rawMarket]?.[selection]) continue;
        const line = out[book] ||= { s: null, so: [null, null], t: null, to: [null, null], ml: [null, null], is_live: isLive };
        line.integrityMeta ||= {};
        (line.integrityMeta[rawMarket] ||= {})[selection] = {
          source_observed_at: null, market_status: 'removed', is_live: isLive,
          line_value: null, american_odds: null,
          provider_event_id: snapshot.provider_event_id,
          optionMarketId: snapshot.optionMarketId,
          optionId: snapshot.optionId,
          observation_id: `${source}-withdrawal:${receivedAt}:${snapshot.snapshot_id}`,
        };
      }
    }
  }
  return out;
}

module.exports = { matchAll, reconcileBooks };
