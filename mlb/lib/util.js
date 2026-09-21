'use strict';
/* Shared helpers for the odds and bets modules: fetch with timeout and per-host backoff, Eastern-time dates,
   atomic JSON files under DATA_DIR, and matching another feed's team names onto MLB games. */

const fs = require('node:fs');
const path = require('node:path');

const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

// ---------------------------------------------------------------- fetch
// Each host has its own health record, so one flaky source never slows the others.
const hosts = new Map(); // host -> { ok, fail, lastOk, lastErr, until }
const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
function health() {
  return Object.fromEntries([...hosts].map(([h, v]) => [h, { lastOk: v.lastOk, lastErr: v.lastErr, fails: v.fail, pausedFor: Math.max(0, v.until - Date.now()) }]));
}

async function getJSON(url, { timeout = 15000, headers = {}, text = false } = {}) {
  const host = hostOf(url);
  const h = hosts.get(host) || { ok: 0, fail: 0, lastOk: 0, lastErr: null, until: 0 };
  hosts.set(host, h);
  if (h.until > Date.now()) throw new Error(`${host} paused after errors`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: text ? 'text/html' : 'application/json', 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...headers } });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
    const body = text ? await r.text() : await r.json();
    h.ok++; h.fail = 0; h.lastOk = Date.now(); h.lastErr = null; h.until = 0;
    return body;
  } catch (e) {
    h.fail++;
    h.lastErr = `${new Date().toISOString()} ${e.name === 'AbortError' ? 'timeout' : e.message}`;
    // Back off a host that keeps failing: 5 s, 10 s, 20 s … up to 5 min.
    if (h.fail >= 2) h.until = Date.now() + Math.min(300e3, 5000 * 2 ** (h.fail - 2));
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
const getText = (url, opts) => getJSON(url, { ...opts, text: true });

// ---------------------------------------------------------------- dates
function etParts(d = new Date()) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
}
const etDate = (d = new Date()) => { const p = etParts(d); return `${p.year}-${p.month}-${p.day}`; };

// "9/19/2026 3:00 PM ET" -> epoch ms
function etStampTime(s) {
  const m = /(\d+)\/(\d+)\/(\d{4})\s+(\d+):(\d+)\s*(AM|PM)/i.exec(s || '');
  if (!m) return null;
  let hh = Number(m[4]) % 12;
  if (/pm/i.test(m[6])) hh += 12;
  const guess = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hh + 4, Number(m[5]));
  // Eastern is UTC-4 in summer and UTC-5 in winter.
  const est = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).format(new Date(guess)).includes('EST');
  return guess + (est ? 3600e3 : 0);
}

// ---------------------------------------------------------------- files
fs.mkdirSync(DATA, { recursive: true });
function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return fallback; }
}
// Write to a temp file and rename, so a crash mid-write never leaves a half file behind.
function writeJSON(name, value) {
  const file = path.join(DATA, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
// The same, off the event loop. Writes to one file are serialized so an older one never lands last.
const chains = new Map();
function writeJSONAsync(name, value) {
  const file = path.join(DATA, name);
  const body = JSON.stringify(value);
  const prev = chains.get(file) || Promise.resolve();
  const next = prev.then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, file);
  }).catch((e) => log('write', name, e.message));
  chains.set(file, next);
  return next;
}

// ---------------------------------------------------------------- teams
// How well a team name from another feed matches one side of an MLB game: 3 full name, 2 nickname, 1 abbreviation.
// MLB nicknames are unique, so "ST Louis Cardinals", "Chicago White Sox" and "White Sox" all land on the right team.
const ABBR = { CHW: 'CWS', ARI: 'AZ', WAS: 'WSH', KCR: 'KC', SDP: 'SD', SFG: 'SF', TBR: 'TB', OAK: 'ATH', LA: 'LAD' };
function teamScore(name, side, abbr) {
  if (!side) return 0;
  const n = norm(name), full = norm(side.full), nick = norm(side.name);
  if (n && full && n === full) return 3;
  if (n && nick && (n === nick || n.endsWith(nick))) return 2;
  if (abbr && side.abbr) {
    const a = String(abbr).toUpperCase();
    if (a === side.abbr.toUpperCase() || ABBR[a] === side.abbr.toUpperCase()) return 1;
  }
  return 0;
}

// Pair feed games with MLB games (from the day model). Each feed game: { key, home, away, homeAbbr?, awayAbbr?, start? , order? }.
// Returns Map key -> { pk, swap } where swap means the feed's home team is the MLB away team.
// Doubleheaders: the same two teams twice; the closest start time wins, then feed order vs game order.
function pairGames(feed, games) {
  const cands = [];
  for (const f of feed) {
    for (const g of games) {
      const straight = Math.min(teamScore(f.home, g.home, f.homeAbbr), teamScore(f.away, g.away, f.awayAbbr));
      const swapped = Math.min(teamScore(f.home, g.away, f.homeAbbr), teamScore(f.away, g.home, f.awayAbbr));
      const s = Math.max(straight, swapped);
      if (s < 1) continue;
      const dt = f.start && g.start ? Math.abs(Date.parse(f.start) - Date.parse(g.start)) : 0;
      if (dt > 12 * 3600e3) continue; // the same series tomorrow is 16 h+ away
      cands.push({ f, g, s, dt, swap: swapped > straight });
    }
  }
  // Best team match first, then the closest start time.
  cands.sort((a, b) => b.s - a.s || a.dt - b.dt || (a.f.order ?? 0) - (b.f.order ?? 0) || Date.parse(a.g.start || 0) - Date.parse(b.g.start || 0));
  const out = new Map(), usedPk = new Set();
  for (const c of cands) {
    if (out.has(c.f.key) || usedPk.has(c.g.pk)) continue;
    out.set(c.f.key, { pk: c.g.pk, swap: c.swap });
    usedPk.add(c.g.pk);
  }
  return out;
}

// Swap a book line's sides (the feed had home and away the other way round).
function flipLine(L) {
  if (!L) return L;
  return {
    ...L,
    ml: L.ml ? [L.ml[1], L.ml[0]] : null,
    rl: L.rl ? { line: L.rl.line == null ? null : -L.rl.line, odds: [L.rl.odds[1], L.rl.odds[0]] } : null,
  };
}

// A book line is only worth keeping if it has at least one full two-sided market.
function cleanLine(L) {
  const two = (a) => Array.isArray(a) && a[0] != null && a[1] != null;
  const out = {
    ml: two(L.ml) ? L.ml : null,
    rl: L.rl && L.rl.line != null && two(L.rl.odds) ? L.rl : null,
    t: L.t && L.t.line != null && two(L.t.odds) ? L.t : null,
  };
  return out.ml || out.rl || out.t ? out : null;
}

module.exports = { DATA, log, num, norm, getJSON, getText, health, etDate, etStampTime, readJSON, writeJSON, writeJSONAsync, teamScore, pairGames, flipLine, cleanLine };
