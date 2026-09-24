'use strict';
/*
 * League-wide injury reports, polled once by the terminal and relayed to the engines over IPC.
 *
 *  - NFL, MLB, NHL: ESPN's league injuries list (site.api.espn.com/apis/site/v2/sports/{path}/injuries). Every row
 *    is dated and the CDN caches it for seconds, so a 60-120 s poll sees a new status within about two minutes.
 *    It is the full report (hundreds of rows), not the five-name headline list in a game summary.
 *  - MLB also: statsapi.mlb.com transactions (injured-list placements, transfers and activations, with effective
 *    dates), the league's own record, polled every 5 minutes.
 *  - NCAAF: none. ESPN's college list is empty and conference availability reports are not an API; engines keep
 *    saying so rather than implying a clean bill of health.
 *
 * Display only. Nothing here feeds a price or a model probability.
 */
const SOURCES = {
  nfl: { url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries', everyMs: 60e3 },
  mlb: { url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/injuries', everyMs: 120e3 },
  nhl: { url: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries', everyMs: 120e3 },
};
const MLB_TX = (from, to) => `https://statsapi.mlb.com/api/v1/transactions?startDate=${from}&endDate=${to}`;
const norm = v => String(v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const iso = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const ymd = t => new Date(t).toISOString().slice(0, 10);

// ESPN league injuries -> { [teamKey]: { id, name, rows: [{name, pos, status, date, comment, type, returnDate}] } }
function parseEspn(payload) {
  const teams = {};
  for (const t of payload?.injuries || []) {
    const name = t.displayName; if (!name) continue;
    const rows = [];
    for (const r of t.injuries || []) {
      const player = r.athlete?.displayName; if (!player) continue;
      rows.push({ name: player, pos: r.athlete?.position?.abbreviation || null, status: r.status || null, date: iso(r.date),
        comment: r.shortComment || null, type: r.details?.type || null, returnDate: r.details?.returnDate || null });
    }
    rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    teams[norm(name)] = { id: String(t.id || ''), name, rows };
  }
  return teams;
}

// statsapi transactions -> injured-list moves, newest first: [{team, player, date, effective, text}]
function parseMlbTransactions(payload) {
  const out = [];
  for (const x of payload?.transactions || []) {
    const text = x.description || '';
    if (!/injured list/i.test(text)) continue;
    out.push({ team: x.toTeam?.name || x.fromTeam?.name || null, player: x.person?.fullName || null, date: x.date || null, effective: x.effectiveDate || null, text });
  }
  return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

function createInjuries(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
  const log = options.log || (() => {});
  const views = {}, signatures = {}, timers = new Set();
  const status = Object.fromEntries(['nfl', 'mlb', 'nhl'].map(s => [s, { lastAt: null, changedAt: null, rows: 0, errors: 0, lastError: null }]));
  status.mlbTransactions = { lastAt: null, moves: 0, errors: 0 };
  let running = false, mlbMoves = [];

  async function get(url) {
    const controller = new AbortController(); const t = later(() => controller.abort(), 15000); t?.unref?.();
    try {
      const r = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!r.ok) throw new Error(`http_${r.status}`);
      return await r.json();
    } finally { cancel(t); }
  }
  function publish(sport) {
    const view = { sport, at: now(), teams: views[sport] || {}, ...(sport === 'mlb' ? { ilMoves: mlbMoves.slice(0, 200) } : {}) };
    const signature = JSON.stringify([view.teams, view.ilMoves || null]);
    if (signatures[sport] === signature) return;
    signatures[sport] = signature; status[sport].changedAt = view.at;
    options.onUpdate?.(sport, view);
  }
  async function pollLeague(sport) {
    try {
      views[sport] = parseEspn(await get(SOURCES[sport].url));
      status[sport].lastAt = now(); status[sport].rows = Object.values(views[sport]).reduce((n, t) => n + t.rows.length, 0); status[sport].lastError = null;
      publish(sport);
    } catch (e) { status[sport].errors++; status[sport].lastError = String(e.message || e).slice(0, 80); log('injuries', sport, status[sport].lastError); }
  }
  async function pollMlbTransactions() {
    try {
      const t = now(); mlbMoves = parseMlbTransactions(await get(MLB_TX(ymd(t - 7 * 86400e3), ymd(t + 86400e3))));
      status.mlbTransactions.lastAt = t; status.mlbTransactions.moves = mlbMoves.length;
      publish('mlb');
    } catch (e) { status.mlbTransactions.errors++; log('injuries', 'mlb transactions', String(e.message || e).slice(0, 80)); }
  }
  function loop(fn, ms) {
    const run = async () => { if (!running) return; await fn(); if (!running) return; const id = later(run, ms); id?.unref?.(); timers.add(id); };
    void run();
  }
  return {
    start() {
      if (running) return; running = true;
      for (const sport of Object.keys(SOURCES)) loop(() => pollLeague(sport), options.everyMs ?? SOURCES[sport].everyMs);
      loop(pollMlbTransactions, options.mlbTxMs ?? 5 * 60e3);
    },
    stop() { running = false; for (const id of timers) cancel(id); timers.clear(); },
    snapshot(sport) { return { sport, at: now(), teams: views[sport] || {}, ...(sport === 'mlb' ? { ilMoves: mlbMoves.slice(0, 200) } : {}) }; },
    status: () => JSON.parse(JSON.stringify(status)),
    _pollLeague: pollLeague, _pollMlbTransactions: pollMlbTransactions,
  };
}

// Engine side. `forTeams(away, home)` returns {away, home} rows (players not listed as Active), or null.
function subscribe(sport, callback, peer = process) {
  let view = null;
  const listener = message => {
    if (!message || message.sport !== sport || message.type !== 'inj:update' || !message.view) return;
    view = message.view; callback?.(view);
  };
  if (typeof peer.send === 'function') { peer.on('message', listener); try { peer.send({ type: 'inj:ready', sport }, () => {}); } catch {} }
  const team = name => {
    if (!view || !name) return null;
    const k = norm(name); if (view.teams[k]) return view.teams[k];
    const hits = Object.entries(view.teams).filter(([key]) => key.includes(k) || k.includes(key));
    return hits.length === 1 ? hits[0][1] : null;
  };
  const listed = t => (t ? t.rows.filter(r => !/^active$/i.test(r.status || '')) : null);
  return {
    forTeams(away, home) {
      if (!view) return null;
      const a = team(away), h = team(home);
      if (!a && !h) return null;
      const moves = name => (view.ilMoves || []).filter(m => norm(m.team) === norm(name)).slice(0, 10);
      return { at: view.at, source: 'espn_league_injuries', away: listed(a) || [], home: listed(h) || [],
        ...(view.ilMoves ? { ilMoves: { away: moves(away), home: moves(home) } } : {}) };
    },
    view: () => view,
    close() { peer.removeListener?.('message', listener); },
  };
}

function relayToChild(child, sport, service) {
  let busy = false, pending = null, closed = false;
  function flush(message) {
    if (closed || !child.connected) return;
    if (busy) { pending = message; return; }
    busy = true;
    try { child.send(message, error => { busy = false; const next = pending; pending = null; if (!error && next) flush(next); }); }
    catch { busy = false; pending = null; }
  }
  const update = view => flush({ type: 'inj:update', sport, view });
  const ready = message => { if (message?.type === 'inj:ready' && message.sport === sport) update(service.snapshot(sport)); };
  child.on('message', ready);
  return { update, close() { closed = true; pending = null; child.removeListener('message', ready); } };
}

module.exports = { createInjuries, subscribe, relayToChild, parseEspn, parseMlbTransactions, SOURCES };
