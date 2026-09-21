'use strict';
/* Numbers you type in yourself, standing at a sportsbook window. They're yours alone: stored against the
   device that entered them and merged into the board only for that viewer, so nobody else's screen moves.
   A typed number shows with a marker and the time you entered it. */

const { readJSON, writeJSON, num } = require('./util');
const { BETTABLE } = require('./books');

const store = readJSON('manual.json', { v: 1, by: {} });
const save = () => writeJSON('manual.json', store);
const MAX_GAMES = 60;

const clean = (v, lo, hi) => { const n = num(v); return n == null || n < lo || n > hi ? null : n; };
const odds = (v) => { const n = num(v); return n == null || Math.abs(n) < 100 || Math.abs(n) > 100000 ? null : n; };

function list(uid) {
  return (uid && store.by[uid]) || {};
}

// One book's numbers for one game. Anything left blank is simply not recorded.
function set(uid, pk, book, body) {
  if (!uid) throw new Error('No device id.');
  if (!BETTABLE.has(book)) throw new Error('Unknown book.');
  if (!/^\d+$/.test(String(pk))) throw new Error('Unknown game.');
  const ml = [odds(body.mlHome), odds(body.mlAway)];
  const t = clean(body.total, 0, 30);
  const L = {
    ml: ml[0] != null || ml[1] != null ? ml : null,
    rl: t == null && body.rlHome == null && body.rlAway == null ? null : (odds(body.rlHome) != null || odds(body.rlAway) != null ? { line: 1.5, odds: [odds(body.rlHome), odds(body.rlAway)] } : null),
    t: t == null ? null : { line: t, odds: [odds(body.over) ?? -110, odds(body.under) ?? -110] },
    seen: Date.now(),
    src: 'you',
  };
  if (!L.ml && !L.rl && !L.t) throw new Error('Enter a moneyline, a run line or a total.');
  const mine = (store.by[uid] ||= {});
  const g = (mine[pk] ||= {});
  g[book] = L;
  // Keep only the most recent games, so one device can't grow the file without bound.
  const pks = Object.keys(mine);
  if (pks.length > MAX_GAMES) {
    pks.sort((a, b) => Math.max(...Object.values(mine[a]).map((x) => x.seen || 0)) - Math.max(...Object.values(mine[b]).map((x) => x.seen || 0)));
    for (const old of pks.slice(0, pks.length - MAX_GAMES)) delete mine[old];
  }
  save();
  return L;
}

function clear(uid, pk, book) {
  const mine = store.by[uid];
  if (!mine?.[pk]?.[book]) return false;
  delete mine[pk][book];
  if (!Object.keys(mine[pk]).length) delete mine[pk];
  save();
  return true;
}

module.exports = { list, set, clear };
