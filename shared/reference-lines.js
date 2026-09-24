'use strict';
/*
 * Reference lines: per-book OPENERS (Owls Insight line history) and per-book CLOSES (SharpAPI closing
 * snapshots), owned by the terminal because only the terminal holds the provider credentials.
 *
 *  - Opener: GET api.owlsinsight.com/api/odds/history?eventId&book&market&side (MVP tier). Its openingLine is
 *    the first price Owls observed for that book, with Owls' own timestamp. It is fetched once per
 *    event/book/market/side and never changes afterwards, so the quota cost is one-time.
 *  - Close: GET api.sharpapi.io/api/v1/odds/closing?event_id=… (Pro tier and up). Sharp freezes each book's
 *    last pregame prices at the pre->live transition (or when the book pulls the market) and reports
 *    captured_at, seconds_before_kickoff and capture_trigger. Fetched once shortly after the scheduled start.
 *
 * Nothing here is a quote clock for the live board: these are reference observations with their provider
 * timestamps. Engines receive them over IPC (see subscribe) and never see a credential.
 */
const fs = require('node:fs');
const path = require('node:path');

const SPORTS = ['nfl', 'ncaaf', 'mlb', 'nhl'];
const OWLS_ORIGIN = 'https://api.owlsinsight.com';
const SHARP_ORIGIN = 'https://api.sharpapi.io';
// Board book key -> Owls v1 book key. Only books the board shows; each costs 6 calls per event once.
const OWLS_BOOKS = { pin: 'pinnacle', dk: 'draftkings', fd: 'fanduel', mgm: 'betmgm', czr: 'caesars', circa: 'circa', sp: 'south_point', wg: 'westgate', wynn: 'wynn', stn: 'stations' };
// Board market -> [Owls market, sides]. Spread/ML sides are home/away; totals over/under.
const OWLS_MARKETS = { s: ['spreads', ['home', 'away']], t: ['totals', ['over', 'under']], ml: ['h2h', ['home', 'away']] };
// Sharp full-game main markets per sport -> board market.
const SHARP_MARKETS = {
  nfl: { point_spread: 's', total_points: 't', moneyline: 'ml' },
  ncaaf: { point_spread: 's', total_points: 't', moneyline: 'ml' },
  mlb: { run_line: 's', total_runs: 't', moneyline: 'ml' },
  nhl: { puck_line: 's', total_goals: 't', moneyline: 'ml' },
};
const SHARP_BOOKS = { pinnacle: 'pin', draftkings: 'dk', fanduel: 'fd', betmgm: 'mgm', caesars: 'czr', circa: 'circa', bovada: 'bovada', betonline: 'betonline', betrivers: 'betrivers', fanatics: 'fanatics', hardrock: 'hardrock', thescorebet: 'thescore' };

const norm = v => String(v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const iso = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
// The canonical game key every engine can compute from its own game: sport, teams, UTC start minute.
const gameKey = (sport, away, home, start) => { const at = iso(start); return at ? `${sport}:${norm(away)}@${norm(home)}:${at.slice(0, 16)}` : null; };
// Owls eventId: "sport:Away Team@Home Team-YYYYMMDD" (UTC date of commence_time).
const owlsEventId = (sport, away, home, start) => { const at = iso(start); return at ? `${sport}:${away}@${home}-${at.slice(0, 10).replace(/-/g, '')}` : null; };

// Main line from a set of closing rows for one book and market: the line whose two sides are both
// present and priced closest to a balanced pair (alternates carry lopsided prices).
function mainPair(rows, market) {
  const sides = market === 't' ? ['over', 'under'] : ['home', 'away'];
  const byLine = new Map();
  for (const r of rows) {
    const side = r.selection_type;
    if (!sides.includes(side)) continue;
    const odds = num(r.odds_american); if (odds === null || Math.abs(odds) < 100) continue;
    const line = market === 'ml' ? null : num(r.line);
    if (market !== 'ml' && line === null) continue;
    const key = market === 'ml' ? 'ml' : market === 's' ? String(side === 'away' ? -line : line) : String(line);
    const pair = byLine.get(key) || {}; pair[side] = { ...r, odds, line }; byLine.set(key, pair);
  }
  const prob = a => (a < 0 ? -a / (100 - a) : 100 / (100 + a));
  let best = null, bestScore = Infinity;
  for (const pair of byLine.values()) {
    if (!pair[sides[0]] || !pair[sides[1]]) continue;
    const score = market === 'ml' ? 0 : Math.abs(prob(pair[sides[0]].odds) - prob(pair[sides[1]].odds));
    if (score < bestScore) { best = pair; bestScore = score; }
  }
  if (!best) return null;
  const a = best[sides[0]], b = best[sides[1]];
  const out = { prices: [a.odds, b.odds], observed_at: [iso(a.source_updated_at), iso(b.source_updated_at)] };
  if (market === 's') out.line = a.line; else if (market === 't') out.line = a.line;
  return out;
}

function parseClosing(payload, sport) {
  const books = payload?.data?.books;
  if (!books || typeof books !== 'object') return null;
  const markets = SHARP_MARKETS[sport] || {};
  const out = {};
  for (const [sharpBook, entry] of Object.entries(books)) {
    const book = SHARP_BOOKS[sharpBook]; if (!book || !Array.isArray(entry?.odds)) continue;
    const L = {};
    for (const [sharpMarket, market] of Object.entries(markets)) {
      const pair = mainPair(entry.odds.filter(r => r.market_type === sharpMarket), market);
      if (pair) L[market] = pair;
    }
    if (!Object.keys(L).length) continue;
    out[book] = { ...L, captured_at: iso(entry.captured_at), seconds_before_kickoff: num(entry.seconds_before_kickoff),
      capture_trigger: typeof entry.capture_trigger === 'string' ? entry.capture_trigger : null, is_final: entry.is_final === true, source: 'sharp_close' };
  }
  return Object.keys(out).length ? out : null;
}

// Line history for one book/market (home side, or over for totals): changes only, oldest first, capped.
function compactHistory(payload) {
  const out = [];
  for (const h of payload?.data?.history || []) {
    const t = Date.parse(h.timestamp), price = num(h.price), point = num(h.point);
    if (!Number.isFinite(t) || price === null || Math.abs(price) < 100) continue;
    const last = out[out.length - 1];
    if (last && last[1] === point && last[2] === price) continue;
    out.push([t, point, price]);
  }
  return out.slice(-500);
}
const safeName = k => String(k).replace(/[^a-z0-9@._-]/gi, '_');
function historyPath(dir, sport, key) { return path.join(dir, sport, safeName(key) + '.json'); }
function readHistory(dir, sport, key) { try { return JSON.parse(fs.readFileSync(historyPath(dir, sport, key), 'utf8')); } catch { return null; } }

function parseHistory(payload) {
  const o = payload?.data?.openingLine;
  const at = iso(o?.timestamp), price = num(o?.price);
  if (!at || price === null || Math.abs(price) < 100) return null;
  return { price, point: num(o.point), observed_at: at };
}

// Openers with one side still missing are withheld, and so is a football spread opening at 0 with lopsided
// prices: the known upstream BetMGM zero-handicap fault (see owls-schema suspectZeroSpreads).
const probOf = a => (a < 0 ? -a / (100 - a) : 100 / (100 + a));
function cleanOpen(sport, open) {
  const out = {};
  for (const [book, L] of Object.entries(open || {})) for (const [market, M] of Object.entries(L || {})) {
    if (!M?.prices || M.prices.some(p => p == null)) continue;
    if (market !== 'ml' && M.line == null) continue;
    if (market === 's' && M.line === 0 && ['nfl', 'ncaaf'].includes(sport) && Math.abs(probOf(M.prices[0]) - probOf(M.prices[1])) >= 0.08) continue;
    (out[book] ||= {})[market] = M;
  }
  return out;
}

function createReferenceLines(options = {}) {
  const owlsKey = String(options.owlsKey || '').trim(), sharpKey = String(options.sharpKey || '').trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
  const file = options.file || null;
  const histDir = options.histDir || null;
  const log = options.log || (() => {});
  const owlsGapMs = options.owlsGapMs ?? 400;          // ~2.5 history calls/s; the MVP plan allows 3 concurrent
  const closeDelayMs = options.closeDelayMs ?? 5 * 60e3; // Sharp captures at the pre->live transition
  const closeGiveUpMs = options.closeGiveUpMs ?? 6 * 3600e3;
  const openHorizonMs = options.openHorizonMs ?? 10 * 86400e3;
  // store[sport][gameKey] = { away, home, start, owlsId, sharpId, open: {book: {s,t,ml}}, openTried: {k: at}, close, closeTried }
  const store = Object.fromEntries(SPORTS.map(s => [s, {}]));
  const status = { enabled: !!(owlsKey || sharpKey), owls: { requests: 0, errors: 0, remainingMonth: null, lastAt: null, blockedUntil: 0 },
    sharp: { requests: 0, errors: 0, lastAt: null, blockedUntil: 0 }, openers: 0, closes: 0 };
  const queued = new Set();
  let running = false, timer = null, dirty = false, saveTimer = null;

  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const s of SPORTS) if (saved?.[s] && typeof saved[s] === 'object') store[s] = saved[s];
    } catch {}
  }
  const count = () => { status.openers = 0; status.closes = 0; for (const s of SPORTS) for (const g of Object.values(store[s])) { if (g.open && Object.keys(g.open).length) status.openers++; if (g.close) status.closes++; } };
  count();
  function persist() {
    if (!file) return; dirty = true; if (saveTimer) return;
    saveTimer = later(() => {
      saveTimer = null; if (!dirty) return; dirty = false;
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(store)); fs.renameSync(tmp, file); } catch (e) { log('reference save', e.message); }
    }, 2000);
    saveTimer?.unref?.();
  }
  // Drop games more than 30 days old so the file stays small.
  function prune() {
    const cutoff = now() - 30 * 86400e3;
    for (const s of SPORTS) for (const [k, g] of Object.entries(store[s])) if (Date.parse(g.start) < cutoff) delete store[s][k];
  }

  function changed(sport) { persist(); count(); options.onUpdate?.(sport, snapshot(sport)); }
  function snapshot(sport) {
    const games = {};
    for (const [k, g] of Object.entries(store[sport] || {})) {
      const open = cleanOpen(sport, g.open);
      if (Object.keys(open).length || g.close) games[k] = { open, close: g.close || null };
    }
    return { sport, games, at: now() };
  }

  async function get(url, headers) {
    const controller = new AbortController();
    const t = later(() => controller.abort(), 15000); t?.unref?.();
    try { return await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'THE.BOARD/1.0', ...headers }, signal: controller.signal, redirect: 'error' }); }
    finally { cancel(t); }
  }

  async function fetchOpen(sport, key, book, market, side) {
    const g = store[sport][key]; if (!g?.owlsId) return;
    const [owlsMarket] = OWLS_MARKETS[market];
    const q = new URLSearchParams({ eventId: g.owlsId, book: OWLS_BOOKS[book], market: owlsMarket, side });
    status.owls.requests++; status.owls.lastAt = now();
    const r = await get(`${OWLS_ORIGIN}/api/odds/history?${q}`, { Authorization: `Bearer ${owlsKey}` });
    const month = r.headers?.get?.('x-ratelimit-remaining-month'); if (month != null && Number.isFinite(Number(month))) status.owls.remainingMonth = Number(month);
    if (r.status === 429) { const s = Number(r.headers?.get?.('retry-after')); status.owls.blockedUntil = now() + (Number.isFinite(s) && s > 0 ? s * 1000 : 60000); throw Object.assign(new Error('owls_429'), { retry: true }); }
    if (r.status === 401 || r.status === 403) { status.owls.blockedUntil = now() + 3600e3; throw new Error(`owls_${r.status}`); }
    g.openTried ||= {}; g.openTried[`${book}:${market}:${side}`] = now();
    if (!r.ok) { if (r.status >= 500) throw Object.assign(new Error('owls_5xx'), { retry: true }); return; }
    const body = await r.json();
    if (OWLS_MARKETS[market][1].indexOf(side) === 0) { saveHistory(sport, key, book, market, compactHistory(body)); (g.histDone ||= {})[`open:${book}:${market}`] = now(); }
    const opening = parseHistory(body);
    if (!opening) return;
    const L = ((g.open ||= {})[book] ||= {});
    const M = (L[market] ||= { prices: [null, null], observed_at: [null, null], source: 'owls_history' });
    const i = OWLS_MARKETS[market][1].indexOf(side);
    M.prices[i] = opening.price; M.observed_at[i] = opening.observed_at;
    if (market !== 'ml' && i === 0) M.line = opening.point;
    changed(sport);
  }

  function saveHistory(sport, key, book, market, rows) {
    if (!histDir || !rows.length) return;
    try {
      const f = historyPath(histDir, sport, key), H = readHistory(histDir, sport, key) || {};
      (H[book] ||= {})[market] = rows;
      fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(H)); fs.renameSync(tmp, f);
    } catch (e) { log('reference history', e.message); }
  }
  // After kickoff: one more history read per book/market so the saved timeline runs from the opener to the close.
  async function fetchHist(sport, key, book, market, phase = 'final') {
    const g = store[sport][key]; if (!g?.owlsId) return;
    const [owlsMarket, sides] = OWLS_MARKETS[market];
    const q = new URLSearchParams({ eventId: g.owlsId, book: OWLS_BOOKS[book], market: owlsMarket, side: sides[0] });
    status.owls.requests++; status.owls.lastAt = now();
    const r = await get(`${OWLS_ORIGIN}/api/odds/history?${q}`, { Authorization: `Bearer ${owlsKey}` });
    if (r.status === 429) { const s = Number(r.headers?.get?.('retry-after')); status.owls.blockedUntil = now() + (Number.isFinite(s) && s > 0 ? s * 1000 : 60000); throw Object.assign(new Error('owls_429'), { retry: true }); }
    (g.histDone ||= {})[`${phase}:${book}:${market}`] = now();
    if (!r.ok) return;
    const start = Date.parse(g.start);
    saveHistory(sport, key, book, market, compactHistory(await r.json()).filter(p => p[0] < start));
    persist();
  }

  async function fetchClose(sport, key) {
    const g = store[sport][key]; if (!g?.sharpId || g.close) return;
    const q = new URLSearchParams({ event_id: g.sharpId, sportsbook: Object.keys(SHARP_BOOKS).join(','), market: Object.keys(SHARP_MARKETS[sport]).join(',') });
    status.sharp.requests++; status.sharp.lastAt = now();
    const r = await get(`${SHARP_ORIGIN}/api/v1/odds/closing?${q}`, { 'X-API-Key': sharpKey });
    if (r.status === 429) { const s = Number(r.headers?.get?.('retry-after')); status.sharp.blockedUntil = now() + (Number.isFinite(s) && s > 0 ? s * 1000 : 60000); throw Object.assign(new Error('sharp_429'), { retry: true }); }
    if (r.status === 401 || r.status === 403) { status.sharp.blockedUntil = now() + 3600e3; throw new Error(`sharp_${r.status}`); }
    g.closeTried = now();
    if (!r.ok) return;
    const close = parseClosing(await r.json(), sport);
    // An empty answer before Sharp has frozen the book is retried by the next sweep until closeGiveUpMs.
    if (!close) return;
    g.close = close; changed(sport);
  }

  // Openers and closes drain independently, so a long opener backlog never delays a close.
  const queues = { open: [], close: [], hist: [] }, draining = { open: false, close: false, hist: false };
  function enqueue(job) { if (queued.has(job.id)) return; queued.add(job.id); queues[job.kind].push(job); }
  async function drain(kind) {
    if (!kind) return Promise.all([drain('open'), drain('close'), drain('hist')]);
    if (draining[kind] || !running) return; draining[kind] = true;
    const queue = queues[kind], limits = kind === 'close' ? status.sharp : status.owls;
    try {
      while (queue.length && running) {
        if (now() < limits.blockedUntil) break;
        const job = queue.shift();
        let retry = false;
        try { await (kind === 'open' ? fetchOpen(...job.args) : kind === 'hist' ? fetchHist(...job.args) : fetchClose(...job.args)); }
        catch (e) { limits.errors++; if (e.retry) { retry = true; queue.push(job); } else log('reference', e.message); }
        finally { if (!retry) queued.delete(job.id); }
        if (kind !== 'close') await new Promise(res => { const t = later(res, owlsGapMs); t?.unref?.(); });
      }
    } finally { draining[kind] = false; }
  }

  // Engines' odds frames tell us which games exist and their provider ids. Called by the terminal for every
  // normalized Owls/Sharp frame; cheap (no network) — it only records identities and schedules work.
  function observe(provider, sport, events) {
    if (!SPORTS.includes(sport) || !Array.isArray(events)) return;
    for (const e of events) {
      const key = gameKey(sport, e.away, e.home, e.start); if (!key) continue;
      const g = (store[sport][key] ||= { away: e.away, home: e.home, start: iso(e.start) });
      if (provider === 'owls' && !g.owlsId) { g.owlsId = owlsEventId(sport, e.away, e.home, e.start); g.owlsBooks = Object.keys(e.books || {}); }
      if (provider === 'owls') g.owlsBooks = [...new Set([...(g.owlsBooks || []), ...Object.keys(e.books || {})])];
      if (provider === 'sharp' && !g.sharpId) {
        const line = [...Object.values(e.books || {}), ...Object.values(e.live || {})].find(L => L?.provider_event_id);
        if (line) g.sharpId = String(line.provider_event_id);
      }
    }
  }

  function sweep() {
    if (!running) return;
    prune();
    const t = now();
    // Soonest games first: their openers matter now, next week's can wait for the backlog.
    const games = SPORTS.flatMap(sport => Object.entries(store[sport]).map(([key, g]) => [sport, key, g])).sort((a, b) => Date.parse(a[2].start) - Date.parse(b[2].start));
    for (const [sport, key, g] of games) {
      const start = Date.parse(g.start);
      if (owlsKey && g.owlsId && start > t && start - t < openHorizonMs) {
        for (const book of Object.keys(OWLS_BOOKS)) {
          if (!(g.owlsBooks || []).includes(book)) continue;
          for (const [market, [, sides]] of Object.entries(OWLS_MARKETS)) for (const side of sides) {
            const done = g.open?.[book]?.[market]?.prices?.[sides.indexOf(side)] != null;
            const tried = g.openTried?.[`${book}:${market}:${side}`];
            // A market with no opener yet (book has not posted) is retried every 6 hours, not every sweep.
            if (!done && (!tried || t - tried > 6 * 3600e3)) enqueue({ id: `o|${sport}|${key}|${book}|${market}|${side}`, kind: 'open', args: [sport, key, book, market, side] });
          }
        }
      }
      // Line history: once after kickoff (opener to close), and for games inside three days that were read before
      // history was kept, one read now so the timeline is there before kickoff.
      if (owlsKey && histDir && g.owlsId && g.open) {
        const phase = t - start > closeDelayMs && t - start < closeGiveUpMs ? 'final' : start > t && start - t < 3 * 86400e3 ? 'seed' : null;
        if (phase) for (const [book, L] of Object.entries(g.open)) for (const market of Object.keys(L || {})) {
          const done = g.histDone?.[`${phase}:${book}:${market}`] || (phase === 'seed' && g.histDone?.[`open:${book}:${market}`]);
          if (!done) enqueue({ id: `h|${phase}|${sport}|${key}|${book}|${market}`, kind: 'hist', args: [sport, key, book, market, phase] });
        }
      }
      if (sharpKey && g.sharpId && !g.close && t - start > closeDelayMs && t - start < closeGiveUpMs && (!g.closeTried || t - g.closeTried > 10 * 60e3)) {
        enqueue({ id: `c|${sport}|${key}`, kind: 'close', args: [sport, key] });
      }
    }
    void drain();
  }

  return {
    start() { if (running || !status.enabled) return; running = true; const loop = () => { sweep(); timer = later(loop, options.sweepMs ?? 60000); timer?.unref?.(); }; timer = later(loop, options.firstSweepMs ?? 15000); timer?.unref?.(); },
    stop() { running = false; if (timer) cancel(timer); if (saveTimer) cancel(saveTimer); queues.open.length = 0; queues.close.length = 0; queues.hist.length = 0; queued.clear(); },
    observe, sweep, snapshot,
    status: () => ({ ...status, owls: { ...status.owls }, sharp: { ...status.sharp }, queued: { open: queues.open.length, close: queues.close.length, hist: queues.hist.length } }),
    _store: store, _drain: drain,
  };
}

// Engine side: receive reference lines over IPC. `lookup(away, home, start)` returns {open, close} or null.
function subscribe(sport, callback, peer = process) {
  let games = {};
  const listener = message => {
    if (!message || message.sport !== sport || message.type !== 'ref:update' || !message.games) return;
    games = message.games; callback?.(games);
  };
  if (typeof peer.send === 'function') { peer.on('message', listener); try { peer.send({ type: 'ref:ready', sport }, () => {}); } catch {} }
  return {
    // Exact canonical key first; otherwise the same start minute with team names that contain one another
    // (providers spell college teams differently: "Miami (OH) RedHawks" vs "Miami OH").
    lookup(away, home, start) { const k = keyFor(away, home, start); return k ? games[k] : null; },
    // The saved line history (terminal writes it under REFERENCE_HISTORY_DIR): {book: {s|t|ml: [[t, point, price]...]}}.
    history(away, home, start) {
      const dir = peer.env?.REFERENCE_HISTORY_DIR, k = keyFor(away, home, start);
      return dir && k ? readHistory(dir, sport, k) : null;
    },
    all: () => games,
    close() { peer.removeListener?.('message', listener); },
  };
  function keyFor(away, home, start) {
      const k = gameKey(sport, away, home, start); if (!k) return null;
      if (games[k]) return k;
      const minute = k.slice(k.lastIndexOf(':', k.length - 4) + 1), a = norm(away), h = norm(home);
      const near = (x, y) => x && y && (x.includes(y) || y.includes(x));
      const hits = Object.entries(games).filter(([key]) => key.endsWith(minute)).filter(([key]) => {
        const [teams] = key.slice(sport.length + 1).split(':'); const [ka, kh] = teams.split('@'); return near(ka, a) && near(kh, h);
      });
      return hits.length === 1 ? hits[0][0] : null;
  }
}

// Terminal side: forward the latest snapshot to one engine; one in flight, the newest waiting.
function relayToChild(child, sport, service) {
  let busy = false, pending = null, closed = false;
  function flush(message) {
    if (closed || !child.connected) return;
    if (busy) { pending = message; return; }
    busy = true;
    try { child.send(message, error => { busy = false; const next = pending; pending = null; if (!error && next) flush(next); }); }
    catch { busy = false; pending = null; }
  }
  const update = snap => flush({ type: 'ref:update', sport, games: snap.games, at: snap.at });
  const ready = message => { if (message?.type === 'ref:ready' && message.sport === sport) update(service.snapshot(sport)); };
  child.on('message', ready);
  return { update, close() { closed = true; pending = null; child.removeListener('message', ready); } };
}

module.exports = { createReferenceLines, subscribe, relayToChild, parseClosing, parseHistory, compactHistory, readHistory, historyPath, mainPair, gameKey, owlsEventId, SPORTS };
