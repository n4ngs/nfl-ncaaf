'use strict';
// Compact, owner-only feed each engine hands the terminal's Edges page (edges.js) over loopback, once a minute.
// It is only a projection of views the engines already build for their boards (the model read is computed inside
// those views and cached there); nothing here recomputes a model. Only Nevada books' current lines are passed on.
const NEVADA = Object.freeze(['mgm', 'czr', 'circa', 'stn', 'wg', 'sp']);
const HORIZON = 8 * 86400e3;
const fin = (v) => (Number.isFinite(v) ? v : null);
const pair = (a) => (Array.isArray(a) ? [fin(a[0]), fin(a[1])] : null);
const usable = (L) => !!L && L.market_status !== 'suspended' && L.freshness !== 'STALE' && L.freshness !== 'SUSPENDED' && !L.is_live;
const team = (t) => (t ? { abbr: t.abbr || null, name: t.short || t.name || t.abbr || null } : null);

// Football (Pick Six / Hook & Ladder): weeks = tracked(); view(G, W) = the board's own (cached) game view.
function football({ weeks, view, now = Date.now() }) {
  const games = [], seen = new Set();
  for (const W of weeks) {
    for (const G of W.games.values()) {
      const t = Date.parse(G.start);
      if (seen.has(G.id) || G.state !== 'pre' || !(t > now) || t - now > HORIZON) continue;
      seen.add(G.id);
      let v; try { v = view(G, W); } catch { continue; }
      const m = v && v.model;
      if (!m || m.status !== 'OK') continue;
      const books = {};
      for (const k of NEVADA) {
        const L = v.books && v.books[k];
        if (usable(L)) books[k] = { s: fin(L.s), so: pair(L.so), t: fin(L.t), to: pair(L.to), ml: pair(L.ml), age: fin(L.age_ms) };
      }
      games.push({ id: String(G.id), start: G.start, home: team(G.home), away: team(G.away),
        model: { status: m.status, model: m.model || null, total: m.total || null, reads: m.reads || null, consensusOpen: fin(m.consensusOpen), books: fin(m.books) }, books });
    }
  }
  return { now, games };
}
module.exports = { NEVADA, football, usable };
