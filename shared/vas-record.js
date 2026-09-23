'use strict';
// Live closing-line record for any sport's VAS signals. One scoring rule everywhere:
//   entry  = first time a game reaches a scored tier (upgrades replace a lower tier before puck drop/kickoff)
//   close  = the last market probability for the bet side observed before the game started
//   CLV EV = close_prob(side) * entry_decimal_price - 1     (expected return if the close is the truth)
// Probabilities passed in must already be comparable (same side, same number/line); the caller converts.
// Stored as one JSON file per sport on the volume. Nothing here places or suggests stakes.
const fs = require('node:fs'), path = require('node:path');

const dec = a => 1 + (a > 0 ? a / 100 : 100 / -a);
const RANK = { WEAK: 1, GOLD: 1, LEAN: 1, THIN: 2, SOLID: 3, DIAMOND: 2, PROVEN: 2 };

function create({ file, now = Date.now, tiers = ['GOLD', 'DIAMOND', 'LEAN', 'PROVEN'] }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let rec = {};
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let dirty = false, timer = null;
  const save = () => { dirty = false; const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(rec)); fs.renameSync(t, file); };
  const soon = () => { dirty = true; if (!timer) timer = setTimeout(() => { timer = null; if (dirty) save(); }, 2000), timer.unref && timer.unref(); };
  const iso = () => new Date(now()).toISOString();

  return {
    // v: {tier, side, market, line, entryOdds, entryBook, sideProb, move, matchup, start}
    // Callers key by `${gameId}:${market}` so one game can carry a total read and a side read independently.
    observe(gid, v) {
      const id = String(gid), r = rec[id];
      if (r && r.closeProb != null) return r;
      if (tiers.includes(v.tier) && Number.isFinite(v.entryOdds) && Number.isFinite(v.sideProb) && (!r || (RANK[v.tier] > RANK[r.tier]))) {
        rec[id] = { gid: id, start: v.start, matchup: v.matchup, market: v.market || 'ml', line: v.line ?? null, tier: v.tier, side: v.side, move: v.move ?? null,
          entryAt: iso(), entryOdds: v.entryOdds, entryBook: v.entryBook || null, entryProb: v.sideProb, lastProb: v.sideProb, lastAt: iso(), closeProb: null, result: null };
        save(); return rec[id];
      }
      if (r && r.side === v.side && Number.isFinite(v.sideProb)) { r.lastProb = v.sideProb; r.lastAt = iso(); soon(); }
      return r || null;
    },
    // Latest comparable probability of the RECORDED side (use when the model's current side differs).
    mark(gid, sideProb) { const r = rec[String(gid)]; if (r && r.closeProb == null && Number.isFinite(sideProb)) { r.lastProb = sideProb; r.lastAt = iso(); soon(); } },
    close(gid) { const r = rec[String(gid)]; if (r && r.closeProb == null && r.lastProb != null) { r.closeProb = r.lastProb; r.closedAt = iso(); save(); } },
    settle(gid, result) { const r = rec[String(gid)]; if (r && r.result == null && ['won', 'lost', 'push'].includes(result)) { r.result = result; save(); } },
    get: gid => rec[String(gid)] || null,
    summary() {
      const by = {};
      for (const r of Object.values(rec)) {
        if (r.closeProb == null || !Number.isFinite(r.entryOdds)) continue;
        const ev = r.closeProb * dec(r.entryOdds) - 1, moved = r.closeProb - r.entryProb;
        for (const k of [r.tier, 'ALL']) {
          const b = by[k] || (by[k] = { bets: 0, evSum: 0, evSq: 0, beat: 0, settled: 0, won: 0, profit: 0 });
          b.bets++; b.evSum += ev; b.evSq += ev * ev; b.beat += moved > 0 ? 1 : 0;
          if (r.result === 'won' || r.result === 'lost') { b.settled++; if (r.result === 'won') { b.won++; b.profit += dec(r.entryOdds) - 1; } else b.profit -= 1; }
        }
      }
      for (const b of Object.values(by)) {
        const m = b.evSum / b.bets, sd = b.bets > 1 ? Math.sqrt(Math.max(0, (b.evSq - b.bets * m * m) / (b.bets - 1))) : null;
        Object.assign(b, { clvEvPct: m * 100, tStat: sd ? m / (sd / Math.sqrt(b.bets)) : null, beatCloseRate: b.beat / b.bets, roiPct: b.settled ? b.profit / b.settled * 100 : null });
        delete b.evSum; delete b.evSq; delete b.beat; delete b.profit;
      }
      const all = Object.values(rec);
      return { tiers: by, pending: all.filter(r => r.closeProb == null).length, signals: all.sort((a, b) => b.entryAt.localeCompare(a.entryAt)).slice(0, 300) };
    },
  };
}
module.exports = { create, dec };
