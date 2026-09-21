'use strict';
/* Pinnacle, the offshore book sharp bettors treat as "the market". Its public guest feed (league 246 = MLB)
   needs no key, the same way hook-and-ladder reads it. Full game only: moneyline, the ±1.5 run line and the main
   total; props, alternates, team totals and innings markets are skipped. Pinnacle drops a game at first pitch. */

const { getJSON, num, pairGames, flipLine, cleanLine } = require('./util');

const BASE = 'https://guest.api.arcadia.pinnacle.com/0.1/leagues/246';

async function fetchPinnacle() {
  const [matchups, markets] = await Promise.all([
    getJSON(`${BASE}/matchups`, { timeout: 20000 }),
    getJSON(`${BASE}/markets/straight`, { timeout: 20000 }),
  ]);
  const games = new Map(); // matchupId -> { start, home, away, L }
  for (const m of matchups || []) {
    if (m.parentId || m.type !== 'matchup' || m.special || m.isLive) continue;
    if (m.units && m.units !== 'Regular') continue; // "Daily Total" and other specials
    const home = m.participants?.find((p) => p.alignment === 'home')?.name;
    const away = m.participants?.find((p) => p.alignment === 'away')?.name;
    if (!home || !away) continue;
    const blank = () => ({ ml: [null, null], rl: { line: null, odds: [null, null] }, t: { line: null, odds: [null, null] } });
    games.set(m.id, { id: m.id, start: m.startTime, home, away, L: blank(), F5: blank() });
  }
  for (const k of markets || []) {
    const g = games.get(k.matchupId);
    if (!g || k.isAlternate || (k.period !== 0 && k.period !== 1) || (k.status && k.status !== 'open')) continue;
    const five = k.period === 1;            // Pinnacle's period 1 is the first five innings
    const T = five ? g.F5 : g.L;
    const want = five ? 0.5 : 1.5;          // the run line over five innings is half a run
    const price = (d) => k.prices?.find((p) => p.designation === d);
    if (k.type === 'moneyline') {
      T.ml = [num(price('home')?.price), num(price('away')?.price)];
    } else if (k.type === 'spread') {
      const h = price('home'), a = price('away');
      if (Math.abs(num(h?.points) ?? 0) !== want) continue;
      T.rl = { line: num(h.points), odds: [num(h?.price), num(a?.price)] };
    } else if (k.type === 'total') {
      const o = price('over'), u = price('under');
      T.t = { line: num(o?.points), odds: [num(o?.price), num(u?.price)] };
    }
  }
  return [...games.values()].map((g) => ({ ...g, L: cleanLine(g.L), F5: cleanLine(g.F5) })).filter((g) => g.L || g.F5);
}

// Map Pinnacle games onto MLB gamePks. Returns Map pk -> { L, f5 } (home/away in MLB's orientation).
function matchPinnacle(pgames, games) {
  const feed = pgames.map((p) => ({ key: p.id, home: p.home, away: p.away, start: p.start, p }));
  const pairs = pairGames(feed, games);
  const out = new Map();
  for (const f of feed) {
    const m = pairs.get(f.key);
    if (m) out.set(m.pk, { L: f.p.L ? (m.swap ? flipLine(f.p.L) : f.p.L) : null, f5: f.p.F5 ? (m.swap ? flipLine(f.p.F5) : f.p.F5) : null });
  }
  return out;
}

module.exports = { fetchPinnacle, matchPinnacle };
