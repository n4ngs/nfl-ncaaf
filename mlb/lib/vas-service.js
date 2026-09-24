'use strict';
// Bing Bong Live VAS: the MLB research model (mlb/research; parity-tested port in lib/vas-engine.js) run live.
//
// Proven rule (2024-26 holdout, every model fit only on earlier seasons): bet the side where the model's win
// probability and DRAFTKINGS' OPENING moneyline differ by >= 0.30 logit. +1.45% CLV EV vs the no-vig close over 482
// bets (Bonferroni p = 0.004), positive in each season incl. DraftKings 2026 (+1.50%). Totals: nothing proven.
// Live recipe (research): the opener is DraftKings' own `open` price in ESPN's odds feed, valid for about 2 hours after
// this app first sees it post; after that only if DraftKings' CURRENT price still gives a >= 0.30 gap and is no worse
// than the opener. Every DIAMOND is logged and scored at first pitch against the DraftKings no-vig close.
// Network: its own fetch (not lib/util getJSON), so the one-time history backfill can never pause the live feed's host.
const path = require('node:path'), fs = require('node:fs');
const E = require('./vas-engine'), Data = require('./vas-data'), Record = require('../../shared/vas-record');
let MODEL;
try { MODEL = require('./mlb-vas-model.json'); } catch { MODEL = null; }
const HOUR = 3600e3, VALID_MS = 2 * HOUR;
const dec = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
const novig = (h, a) => { if (!Number.isFinite(h) || !Number.isFinite(a)) return null; const p = 1 / dec(h), q = 1 / dec(a), s = p + q; return s > 1 && s < 1.15 ? p / s : null; };
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

function create({ dir, now = Date.now, log = () => {}, ua = 'THE.BOARD/1.0', fetchJSON }) {
  const get = fetchJSON || (async url => {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': ua }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw Error('HTTP ' + r.status); return r.json();
  });
  // ESPN's edge rejects some custom agents; its odds calls go out with the runtime default.
  const getEspn = async url => { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw Error('HTTP ' + r.status); return r.json(); };
  const data = Data.create({ dir, now, log, fetchJSON: url => (/espn\.com/.test(url) ? getEspn(url) : get(url)) });
  const record = Record.create({ file: path.join(dir, 'signals.json'), now, tiers: ['DIAMOND'] });
  const seenFile = path.join(dir, 'openers.json');
  let seen = {}; try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch {}
  const saveSeen = () => { try { const t = seenFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(seen)); fs.renameSync(t, seenFile); } catch {} };
  let state = null, hist = null, builtAt = null, building = false, lastError = null, info = null;
  const reads = new Map();   // pk -> read

  async function refreshHistory() {
    if (building || !MODEL) return; building = true;
    try {
      hist = await data.history({ maxFetch: 600, concurrency: 3 });
      state = E.build(hist, MODEL.config || E.DEFAULT_CFG);
      builtAt = new Date(now()).toISOString(); info = { games: hist.games.length, complete: hist.complete, ...(hist.info || {}) }; lastError = null;
    } catch (e) { lastError = String(e.message || e).slice(0, 160); log('[mlb-vas] history failed: ' + lastError); }
    finally { building = false; }
  }

  // Today's and tomorrow's games: probable starters, DraftKings opener/current, read, live record.
  async function refreshSlate() {
    if (!state || !MODEL || !(info && info.complete)) return;   // no reads from a partial history
    const t = new Date(now()), days = [ymd(t), ymd(new Date(now() + 86400e3))];
    for (const day of days) {
      let games, events;
      try { games = await data.upcoming(day); events = await data.espnEvents(day); } catch (e) { lastError = 'slate: ' + String(e.message || e).slice(0, 120); continue; }
      const map = data.mapEspn(games, events);
      for (const g of games) {
        const espn = map.get(g.pk);
        const read = { pk: g.pk, day: g.day, start: g.start, status: 'OK', matchup: `${g.names?.away || g.away} @ ${g.names?.home || g.home}`, names: g.names || null, prob: g.prob };
        if (!g.prob || !g.prob.home || !g.prob.away) { reads.set(g.pk, { ...read, status: 'WAIT', note: 'Waiting for both probable starters.' }); continue; }
        const f = state.featuresFor(g), p = E.predict(f, MODEL);
        read.pHome = p;
        // The model's own expected total runs (fundamentals stage), carried for the board's Model column. Totals are
        // not a proven signal, so it is shown there as an estimate only; nothing here tiers or records it.
        if (MODEL.tot) { const t = E.predictTotal(f, MODEL); read.total = Number.isFinite(t) ? Math.round(t * 100) / 100 : null; }
        if (!espn) { reads.set(g.pk, { ...read, note: 'No sportsbook listing matched yet.' }); continue; }
        let books; try { books = await data.openers(espn); } catch { books = null; }
        const dk = (books || []).find(b => /draft\s*kings/i.test(b.book));
        const oh = dk && dk.home.open, oa = dk && dk.away.open, ch = dk && dk.home.current, ca = dk && dk.away.current;
        const pOpen = novig(oh, oa), pNow = novig(ch, ca);
        if (pOpen == null) { reads.set(g.pk, { ...read, note: 'DraftKings has not posted an opener yet.' }); continue; }
        const key = String(g.pk);
        if (!seen[key] || seen[key].oh !== oh || seen[key].oa !== oa) { seen[key] = { at: new Date(now()).toISOString(), oh, oa }; saveSeen(); }
        const sig = E.signal(f, p, { prob: pOpen }, MODEL);
        const age = now() - Date.parse(seen[key].at);
        const started = Date.parse(g.start) <= now();
        let tier = sig.tier, why = null;
        if (tier === 'DIAMOND' && age > VALID_MS) {
          // past the tested window: only while DraftKings' current price still clears the gap and is no worse
          const curSig = pNow == null ? null : E.signal(f, p, { prob: pNow }, MODEL);
          const priceNow = sig.side === 'home' ? ch : ca, priceOpen = sig.side === 'home' ? oh : oa;
          if (!curSig || curSig.tier !== 'DIAMOND' || curSig.side !== sig.side || dec(priceNow) < dec(priceOpen)) { tier = 'PASS'; why = 'The opener window has passed and DraftKings has moved.'; }
        }
        Object.assign(read, { tier, side: sig.side, gap: sig.gap, dk: { open: { home: oh, away: oa }, current: { home: ch, away: ca } }, openerSeenAt: seen[key].at,
          price: sig.side === 'home' ? (age > VALID_MS ? ch : oh) : (age > VALID_MS ? ca : oa), market: pNow ?? pOpen, note: why });
        reads.set(g.pk, read);
        // live record: entry = DraftKings opener price for the side; close = last DraftKings no-vig before first pitch
        const rk = key + ':ml', sideP = q => (sig.side === 'home' ? q : 1 - q);
        if (started) { record.close(rk); continue; }
        if (sig.tier === 'DIAMOND' && !record.get(rk)) record.observe(rk, { tier: 'DIAMOND', side: sig.side, market: 'ml', entryOdds: sig.side === 'home' ? oh : oa, entryBook: 'DraftKings', sideProb: sideP(pOpen), matchup: read.matchup, start: g.start });
        if (record.get(rk) && pNow != null) record.mark(rk, record.get(rk).side === 'home' ? pNow : 1 - pNow);
      }
    }
  }
  // settle finished games from the history (runs after each history refresh)
  function settle() {
    if (!hist) return;
    const byPk = new Map(hist.games.map(g => [String(g.pk), g]));
    for (const r of record.summary().signals) {
      const g = byPk.get(r.gid.split(':')[0]); if (!g) continue;
      record.close(r.gid);
      record.settle(r.gid, (g.hs > g.as ? 'home' : 'away') === r.side ? 'won' : 'lost');
    }
  }

  // Proof page: the live rule family (model vs DraftKings opener gap), clean holdout (2024, 2025 pre-July, 2026)
  const provenRows = () => {
    const h = MODEL && MODEL.holdout_report && MODEL.holdout_report.ML; if (!h) return null;
    const out = {};
    for (const [k, v] of Object.entries(h)) if (v && v.rule === 'x_gap') out['model vs DraftKings opener ≥ ' + v.threshold + ' logit'] =
      { bets: v.n_clean, clv_ev_pct: v.ev_clean_pct, p: v.bonferroni_clean, beat_close: v.beat_close_clean,
        by_season: Object.fromEntries(Object.entries(v.parts || {}).map(([s, x]) => [s, x.ev_pct])) };
    return Object.keys(out).length ? out : null;
  };

  return {
    refreshHistory: async () => { await refreshHistory(); settle(); }, refreshSlate,
    read: pk => reads.get(Number(pk)) || null,
    forDate: date => [...reads.values()].filter(r => !date || r.day === date),
    summary: () => record.summary(),
    status: () => ({ model: MODEL && MODEL.version, builtAt, building, history: info, data: data.status(), lastError, reads: reads.size, proven: provenRows(), tiers: MODEL && MODEL.ml && MODEL.ml.tiers }),
  };
}
module.exports = { create };
