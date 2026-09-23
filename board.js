/*
 * THE.BOARD — the owner's Admin Center.
 *
 * Why this lives in the terminal and not in the engines. Every request to every sport passes through the
 * terminal, and the terminal is the one place that knows, at the door, whether a request carries the
 * owner's code or a guest's. The per-sport admin screens could only see their own sport, keyed each
 * device by a per-sport cookie, and decided "is this the owner" by "is this the device I am looking
 * from" — so the owner's own laptop showed up as an "Unnamed device" among the guests, and guests who
 * came in on the shared /g/ link were never listed at all. Here:
 *
 *   - one device id for the whole board (`tb_dev`, Path=/), so one phone is one row across NFL/NCAAF/MLB;
 *   - the role is stamped on every event at the door, and the owner can pin a device as "me" or "guest",
 *     so the owner's own traffic is a separate lane, never mixed into the guests;
 *   - the capture is the raw truth: full user agent, observed IP (owner-approved, owner-only), every page
 *     load, API call, screen view, tap and bet, with timestamps — readable, and downloadable as CSV/JSON.
 *
 * Capture is silent. Nobody is signed out, asked for a name or shown anything. Nothing here is visible
 * to a guest: every read and write is owner-only.
 *
 * Storage: DATA_DIR/board/events-YYYY-MM-DD.jsonl (append-only) + DATA_DIR/board/devices.json. Bets and
 * guest names are read straight from each engine's own files on the same volume (read-only).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveClientIp } = require('./shared/client-ip');
const { isSameOrigin } = require('./shared/admin-access');
const Activity = require('./shared/board-activity');

const RING_MAX = 80000;            // events held in memory for the views; the files keep everything
const WARM_DAYS = 21;              // how far back a boot re-reads into memory
const RETAIN_DAYS = 120;           // day-files older than this are removed
const LIVE_MS = 5 * 60e3;          // "here now" if anything happened this recently or a live feed is open
const DEV_RE = /^[a-f0-9]{24}$/;
const ENGINE_UID_RE = /^[a-f0-9]{32}$/;
// Files a page pulls in by itself. Recording them would bury the log in noise without saying anything.
const STATIC_RE = /\.(js|css|png|svg|ico|woff2?|ttf|webmanifest|map|jpe?g|gif|webp|txt|json)$/i;

module.exports = function createBoard({ dataDir, sports, ownerName = '', brand = 'THE.BOARD', logo = '', adminPath = '', onRevokeDevice = () => {} }) {
  if (adminPath !== '' && (typeof adminPath !== 'string' || !/^\/[a-z0-9][a-z0-9-]{23,79}$/.test(adminPath))) throw new Error('Invalid private admin path');
  const DIR = path.join(dataDir, 'board');
  fs.mkdirSync(DIR, { recursive: true });
  const DEV_FILE = path.join(DIR, 'devices.json');
  const SPORT_KEYS = Object.keys(sports);
  const SPORT_LABEL = Object.fromEntries(SPORT_KEYS.map((k) => [k, sports[k].label]));

  // ------------------------------------------------------------------ state
  let state = { v: 1, devices: {}, cleared: {}, blocked: {}, signout: {} };
  try { const s = JSON.parse(fs.readFileSync(DEV_FILE, 'utf8')); if (s && s.v === 1) state = { cleared: {}, blocked: {}, signout: {}, ...s }; } catch { /* first boot */ }
  let dirty = false;
  const save = () => {
    try { const tmp = `${DEV_FILE}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, DEV_FILE); dirty = false; } catch (e) { console.log('[board] save failed', e.message); }
  };
  setInterval(() => { if (dirty) save(); }, 10000).unref();

  const ring = [];                   // newest last
  const byDev = new Map();           // dev -> events (same objects as ring), oldest first
  const engineToDev = new Map();     // `${sport}:${engineUid}` -> dev
  const activityCache = new Map();
  const telemetryBudget = new Map();
  let globalTelemetry = { start: 0, n: 0 };
  const streams = new Map();         // dev -> open live-feed connections
  for (const [id, d] of Object.entries(state.devices)) for (const sp of SPORT_KEYS) for (const u of d.links?.[sp] || []) engineToDev.set(`${sp}:${u}`, id);

  // ------------------------------------------------------------------ the log
  let day = '', stream = null;
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  function out(ev) {
    const d = dayOf(ev.t);
    if (d !== day) { try { stream && stream.end(); } catch {} day = d; stream = fs.createWriteStream(path.join(DIR, `events-${d}.jsonl`), { flags: 'a' }); stream.on('error', () => {}); }
    try { stream.write(JSON.stringify(ev) + '\n'); } catch { /* the board never breaks over its own log */ }
  }
  function keep(ev) {
    activityCache.delete(ev.dev);
    ring.push(ev);
    let l = byDev.get(ev.dev); if (!l) byDev.set(ev.dev, (l = [])); l.push(ev);
    while (ring.length > RING_MAX) {
      const old = ring.shift();
      activityCache.delete(old.dev);
      const ol = byDev.get(old.dev);
      if (ol && ol[0] === old) ol.shift(); else if (ol) { const i = ol.indexOf(old); if (i >= 0) ol.splice(i, 1); }
    }
  }
  function record(ev) { if (!ev.dev) return; ev.receivedAt = Number.isFinite(ev.receivedAt) ? ev.receivedAt : Date.now(); ev.id = crypto.randomBytes(5).toString('hex'); out(ev); keep(ev); }

  // Boot: read recent day-files back into memory, skipping anything the owner cleared.
  (function warm() {
    let files = [];
    try { files = fs.readdirSync(DIR).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(); } catch {}
    const cutoff = dayOf(Date.now() - WARM_DAYS * 86400e3), drop = dayOf(Date.now() - RETAIN_DAYS * 86400e3);
    for (const f of files) {
      const d = f.slice(7, 17);
      if (d < drop) { try { fs.unlinkSync(path.join(DIR, f)); } catch {} continue; }
      if (d < cutoff) continue;
      let txt = ''; try { txt = fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { continue; }
      for (const line of txt.split('\n')) {
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || !ev.dev || isCleared(ev)) continue;
        keep(ev);
      }
    }
    ring.sort((a, b) => a.t - b.t);
    for (const l of byDev.values()) l.sort((a, b) => a.t - b.t);
    // Backfill the sticky owner mark for profiles that used the owner code before it existed.
    for (const [id, d] of Object.entries(state.devices)) {
      if (d.ownerAt) continue;
      const e = (byDev.get(id) || []).find((x) => x.role === 'owner');
      if (e || d.role === 'owner') { d.ownerAt = e ? e.t : d.last || Date.now(); dirty = true; }
    }
  })();
  function isCleared(ev) { const c = state.cleared[ev.dev]; return !!c && ev.t <= c; }

  // ------------------------------------------------------------------ who is this
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim()).filter(Boolean).map((c) => { const i = c.indexOf('='); return i < 0 ? [c, ''] : [c.slice(0, i), c.slice(i + 1)]; }));

  /* One id per browser for the whole board. A page loaded before this existed has no tb_dev yet but does
     carry the engines' own device cookies, so reuse the device those already map to — otherwise a burst of
     parallel requests from one phone would mint a row each. */
  function identify(req, isHttps) {
    const c = cookies(req);
    let dev = DEV_RE.test(c.tb_dev || '') ? c.tb_dev : '';
    let cookie = '';
    const engine = [];
    for (const sp of SPORT_KEYS) { const v = c[`${sports[sp].ck}_uid`]; if (ENGINE_UID_RE.test(v || '')) engine.push([sp, v]); }
    if (!dev) {
      for (const [sp, v] of engine) { const k = engineToDev.get(`${sp}:${v}`); if (k) { dev = k; break; } }
      if (!dev) dev = crypto.randomBytes(12).toString('hex');
      cookie = `tb_dev=${dev}; Path=/; Max-Age=63072000; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
    }
    for (const [sp, v] of engine) link(dev, sp, v);
    const ipInfo = resolveClientIp(req);
    return { dev, cookie, ip: ipInfo.ip, ipInfo, ua: String(req.headers['user-agent'] || '').slice(0, 400) };
  }
  function link(dev, sp, uid) {
    const k = `${sp}:${uid}`;
    if (engineToDev.get(k) === dev) return;
    engineToDev.set(k, dev);
    const d = state.devices[dev];
    if (d) { const l = ((d.links ||= {})[sp] ||= []); if (!l.includes(uid)) { l.push(uid); dirty = true; } }
    else pendingLinks.push([dev, sp, uid]);
  }
  const pendingLinks = [];

  function touch(who, role, sport) {
    const t = Date.now();
    let d = state.devices[who.dev];
    // With open boards, scanners and link-preview bots walk straight in. Let them, but never make them a row.
    if (!d && uaInfo(who.ua).bot) return null;
    if (!d) { d = state.devices[who.dev] = { first: t, last: t, role: role || null, roleSet: null, label: '', ua: '', ips: {}, links: {}, sports: {} }; dirty = true; }
    for (let i = pendingLinks.length - 1; i >= 0; i--) {
      const [dv, sp, u] = pendingLinks[i];
      if (dv === who.dev) { const l = (d.links[sp] ||= []); if (!l.includes(u)) l.push(u); pendingLinks.splice(i, 1); dirty = true; }
    }
    if (t - d.last > 30e3) dirty = true;
    d.last = t;
    if (role && d.role !== role) { d.role = role; dirty = true; }
    // Once a browser has come through the door with the owner code it stays yours, even if a later request
    // (a boards page opened before signing in again, an expired cookie) arrives as a guest.
    if (role === 'owner' && !d.ownerAt) { d.ownerAt = t; dirty = true; }
    if (who.ua) {
      if (d.ua !== who.ua) { d.ua = who.ua; dirty = true; }
      // Every distinct browser string this device id has arrived with: a change is worth seeing.
      const u = ((d.uas ||= {})[who.ua] ||= { first: t, last: t, n: 0 });
      u.last = t; u.n++;
      if (Object.keys(d.uas).length > 12) { const old = Object.entries(d.uas).sort((a, b) => a[1].last - b[1].last)[0][0]; delete d.uas[old]; }
    }
    // Keep old observations intact. Provenance belongs only to requests seen by this resolver.
    if (who.ipInfo) {
      dirty = true; // checkpoint the latest observation on the existing 10-second save cadence
      d.ipLast = who.ip;
      d.ipInfo = { ...who.ipInfo, observedAt: t };
    }
    if (who.ip) {
      d.ips ||= {};
      const h = Object.hasOwn(d.ips, who.ip) ? d.ips[who.ip] : (d.ips[who.ip] = { first: t, last: t, n: 0 });
      h.last = t; h.n++;
      if (who.ipInfo) h.ipInfo = { ...who.ipInfo, observedAt: t };
      if (d.ipLast !== who.ip) { d.ipLast = who.ip; dirty = true; }
    }
    if (sport) d.sports[sport] = t;
    return d;
  }

  // ------------------------------------------------------------------ capture (called by the terminal)
  function request(who, role, sport, method, p, status, ms) {
    p = typeof p === 'string' ? p.split(/[?#]/)[0] : '';
    if (!p || (adminPath && p.startsWith(adminPath)) || STATIC_RE.test(p) || p === '/api/telemetry' || p === '/api/health') return;
    if (!touch(who, role, sport)) return;
    record({ t: Date.now(), dev: who.dev, role: role || 'none', ip: who.ip, sp: sport, k: 'req', m: method, p: p.slice(0, 160), s: status, ms });
  }
  function entrance(who, role, how) {
    if (!touch(who, role, null)) return;
    record({ t: Date.now(), dev: who.dev, role: role || 'none', ip: who.ip, sp: '', k: 'enter', how });
  }
  function client(who, role, sport, body) {
    if (!Object.hasOwn(sports, sport) || typeof body !== 'string' || Buffer.byteLength(body) > 65536) return;
    let batch;
    try { batch = JSON.parse(body).events; } catch { return; }
    if (!Array.isArray(batch)) return;
    const now = Date.now();
    let budget = telemetryBudget.get(who.dev);
    if (!budget || now - budget.start >= 60000) {
      budget = { start: now, n: 0 }; telemetryBudget.set(who.dev, budget);
      if (telemetryBudget.size > 10000) telemetryBudget.delete(telemetryBudget.keys().next().value);
    }
    if (now - globalTelemetry.start >= 60000) globalTelemetry = { start: now, n: 0 };
    const allowance = Math.max(0, Math.min(50, 120 - budget.n, 6000 - globalTelemetry.n));
    if (!allowance) return;
    const items = batch.slice(0, allowance);
    const cost = Math.max(1, items.length); // Empty check-ins must consume the same bounded request budget.
    budget.n += cost; globalTelemetry.n += cost;
    const d = touch(who, role, sport);
    if (!d) return;
    const admitted = [];
    for (const it of items) {
      const event = Activity.sanitizeEvent(it, now);
      if (!event) continue;
      if (event.k === 'visit') { d.ctx = event.ctx; dirty = true; }
      // A page report is untrusted. Only identity, role, sport and receipt time come from the server.
      record({ ...event, dev: who.dev, role: role || 'none', ip: who.ip, sp: sport });
      admitted.push(Activity.legacyEvent(event));
    }
    return admitted;
  }
  const streamOpen = (dev) => streams.set(dev, (streams.get(dev) || 0) + 1);
  const streamClose = (dev) => { const n = (streams.get(dev) || 1) - 1; if (n > 0) streams.set(dev, n); else streams.delete(dev); };

  // ------------------------------------------------------------------ reading it back
  function uaInfo(raw, ctx) {
    const u = String(raw || '');
    let os = '', osVer = '', device = '', model = '', m;
    if ((m = /iPhone OS (\d+[_\d]*)/.exec(u))) { os = 'iOS'; osVer = m[1].replace(/_/g, '.'); device = 'iPhone'; }
    else if ((m = /iPad.*? OS (\d+[_\d]*)/.exec(u))) { os = 'iPadOS'; osVer = m[1].replace(/_/g, '.'); device = 'iPad'; }
    else if ((m = /Android (\d+(?:\.\d+)*)(?:; ([^;)]+))?/.exec(u))) {
      os = 'Android'; osVer = m[1]; device = 'Android phone';
      const md = (m[2] || '').replace(/ Build.*/, '').trim();
      if (md && !/^(K|wv|U|Linux|Mobile)$/.test(md)) model = md;
      if (!/Mobile/.test(u)) device = 'Android tablet';
    }
    else if ((m = /Mac OS X (\d+[_.\d]*)/.exec(u))) { os = 'macOS'; osVer = m[1].replace(/_/g, '.'); device = ctx && ctx.touch > 1 ? 'iPad (desktop mode)' : 'Mac'; }
    else if ((m = /Windows NT (\d+\.\d+)/.exec(u))) { os = 'Windows'; osVer = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' }[m[1]] || m[1]; device = 'Windows PC'; }
    else if (/CrOS/.test(u)) { os = 'ChromeOS'; device = 'Chromebook'; }
    else if (/Linux/.test(u)) { os = 'Linux'; device = 'Linux PC'; }
    let browser = '', bVer = '';
    const B = [[/EdgA?\/([\d.]+)|EdgiOS\/([\d.]+)/, 'Edge'], [/OPR\/([\d.]+)/, 'Opera'], [/SamsungBrowser\/([\d.]+)/, 'Samsung Internet'],
      [/CriOS\/([\d.]+)/, 'Chrome'], [/FxiOS\/([\d.]+)/, 'Firefox'], [/Firefox\/([\d.]+)/, 'Firefox'], [/Chrome\/([\d.]+)/, 'Chrome'],
      [/Version\/([\d.]+).*Safari/, 'Safari'], [/curl\/([\d.]+)/, 'curl'], [/python-requests\/([\d.]+)/, 'python']];
    for (const [re, n] of B) { const x = re.exec(u); if (x) { browser = n; bVer = String(x[1] || x[2] || '').split('.').slice(0, 2).join('.'); break; } }
    const inApp = /FBAN|FBAV/.test(u) ? 'Facebook' : /Instagram/.test(u) ? 'Instagram' : /\bGSA\//.test(u) ? 'Google app'
      : /Snapchat/.test(u) ? 'Snapchat' : /LinkedInApp/.test(u) ? 'LinkedIn' : /; wv\)/.test(u) ? 'in-app browser' : '';
    if (!browser && /iPhone|iPad/.test(u) && /AppleWebKit/.test(u)) browser = inApp || 'in-app browser';
    const bot = /bot|crawl|spider|curl|wget|python|headless|preview|monitor/i.test(u);
    return { os, osVer, device: device || (u ? 'Unknown device' : 'No user agent'), model, browser, bVer, inApp, bot };
  }

  const TAB = { live: 'Live', games: 'Games', bets: 'My bets', mine: 'Mine', following: 'Mine', tools: 'Tools', admin: 'Admin Center',
    security: 'Security Center', homers: 'Homers', edges: 'Edges', week: 'the slate', odds: 'Odds' };
  const tabName = (r) => Object.hasOwn(TAB, r) ? TAB[r] : (r ? r : 'the board');
  function describeReq(m, p) {
    const is = (x) => p === x;
    if (is('/') || is('/index.html')) return ['Loaded an app page', 1];
    if (is('/api/stream')) return ['Connected to live updates', 2];
    if (is('/api/betmgm/go')) return ['Requested BetMGM handoff', 1];
    if (is('/api/bets')) return m === 'POST' ? ['Logged a bet', 1] : ['Loaded their bets', 2];
    if (is('/api/bets.csv')) return ['Downloaded their bets (CSV)', 1];
    if (/^\/api\/bets\//.test(p)) return m === 'DELETE' ? ['Deleted a bet', 1] : ['Edited a bet', 1];
    if (/^\/api\/game\//.test(p)) return [`Opened a game (${p.split('/')[3] || ''})`, 1];
    if (/^\/api\/player\//.test(p)) return [`Opened a player (${p.split('/')[3] || ''})`, 1];
    if (is('/api/me/name')) return ['Set their name', 1];
    if (is('/api/me/link')) return ['Made a code to link another device', 1];
    if (is('/api/me/join')) return ['Linked this device to another', 1];
    if (is('/api/me/claim')) return ['Claimed old bets', 1];
    if (is('/api/manual')) return m === 'GET' ? ['Loaded their own numbers', 2] : ['Typed in their own number', 1];
    if (is('/api/matchup')) return ['Looked at a matchup', 1];
    if (is('/api/leaders')) return ['Looked at the leaders', 1];
    if (is('/api/group') || /^\/api\/group\//.test(p)) return ['Opened the per-sport admin view', 2];
    if (is('/api/invites') || /^\/api\/invites\//.test(p)) return [m === 'POST' ? 'Made a share link' : m === 'DELETE' ? 'Turned off a share link' : 'Loaded share links', m === 'GET' ? 2 : 1];
    if (/^\/api\/security\//.test(p)) return ['Security Center', 2];
    if (is('/api/me')) return ['Checked in (who am I)', 2];
    if (is('/api/week') || is('/api/day')) return ['Loaded the slate', 2];
    if (is('/api/odds') || /^\/api\/odds\//.test(p)) return ['Loaded odds', 2];
    if (is('/api/keys')) return ['Loaded key numbers', 2];
    if (is('/api/betmgm/map')) return ['Loaded BetMGM links', 2];
    if (is('/api/players/today') || is('/api/teams') || is('/api/lan')) return ['Loaded board data', 2];
    return [`${m} ${p}`, 2];
  }
  const ACT = { APP_FOREGROUND: 'Came back to the app', APP_BACKGROUND: 'Switched away from the app', PAGE_EXIT: 'Closed the page', ONLINE: 'Came back online', OFFLINE: 'Lost connection' };
  const ENTER = { code: 'Signed in with the admin code', 'guest-code': 'Signed in with the guest code', 'guest-link': 'Came in on the guest link',
    wrong: 'Typed a wrong code', gate: 'Saw the sign-in screen', logout: 'Signed out', 'bad-link': 'Tried a guest link that does not work',
    blocked: 'Turned away (blocked by you)', 'signed-out': 'Signed out by you (sent to the sign-in screen)', 'owner-block': 'You blocked this device',
    'owner-unblock': 'You unblocked this device', 'owner-signout': 'You signed this device out', open: 'Walked in (boards are open, no link needed)' };
  function describe(e) {
    if (e.k === 'req') { const [txt, lvl] = describeReq(e.m, e.p); return [e.s >= 400 ? `${txt} — failed (${e.s})` : txt, lvl]; }
    if (e.k === 'view') return [`Viewed ${tabName(e.r)}`, 1];
    if (e.k === 'click') {
      const l = e.l || '';
      if (Object.hasOwn(Activity.CLICK_LABELS, l)) return [Activity.CLICK_LABELS[l], 1];
      if (l.startsWith('tab:')) return [`Tapped the “${tabName(l.slice(4))}” tab`, 1];
      if (l === 'outbound') return [`Tapped a link out to ${e.href || 'another site'}`, 1];
      return [`Tapped “${l}”${e.r ? ` on ${tabName(e.r)}` : ''}`, 1];
    }
    if (e.k === 'act') return [ACT[e.a] || e.a, e.a === 'APP_BACKGROUND' || e.a === 'APP_FOREGROUND' || e.a === 'PAGE_EXIT' ? 1 : 2];
    if (e.k === 'err') return [typeof e.msg === 'string' && e.msg.trim() ? `App error: ${e.msg}` : 'Browser reported an application error', 2];
    if (e.k === 'visit') { const c = e.ctx || {}; return [`Opened on a ${c.sw || '?'}×${c.sh || '?'} screen${c.tz ? `, time zone ${c.tz}` : ''}${c.standalone ? ', from the home-screen icon' : ''}${e.ref ? `, from ${e.ref}` : ''}`, 1]; }
    if (e.k === 'enter') return [ENTER[e.how] || e.how, 1];
    return [e.k, 2];
  }
  const view = (e) => { const [text, lvl] = describe(e); return { ...e, text, lvl }; };

  function activityOf(id, events) {
    const cached = activityCache.get(id), first = events[0], last = events[events.length - 1];
    if (cached && cached.n === events.length && cached.first === first && cached.last === last) return cached;
    const data = Activity.sessionData(events, id);
    const history = Activity.browsingHistory(events, id, 500, data);
    const value = { n: events.length, first, last, data, history };
    activityCache.set(id, value);
    return value;
  }

  // Engine files: bets and the names guests gave themselves. Cached by mtime; the engines write atomically.
  const fileCache = new Map();
  function readEngine(sp, name) {
    const f = path.join(dataDir, sports[sp].dir, name);
    let st; try { st = fs.statSync(f); } catch { return null; }
    const c = fileCache.get(f);
    if (c && c.m === st.mtimeMs) return c.v;
    let v = null; try { v = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return c ? c.v : null; }
    fileCache.set(f, { m: st.mtimeMs, v });
    return v;
  }
  function engineName(d) {
    for (const sp of SPORT_KEYS) {
      const g = readEngine(sp, 'group.json');
      for (const u of d.links?.[sp] || []) { const n = g?.people?.[u]?.name; if (n) return n; }
    }
    return '';
  }
  function betText(b) {
    return (b.legs || []).map((l) => l.label || [l.matchup, l.team || l.side, l.line != null ? (l.line > 0 && !/t$/.test(l.mkt || '') ? `+${l.line}` : l.line) : '', l.odds != null ? (l.odds > 0 ? `+${l.odds}` : l.odds) : ''].filter((x) => x !== '' && x != null).join(' ')).join('  +  ') || 'Bet';
  }
  function betsOf(d) {
    const out = [];
    for (const sp of SPORT_KEYS) {
      const ids = new Set(d.links?.[sp] || []);
      if (!ids.size) continue;
      const B = readEngine(sp, 'bets.json');
      for (const b of B?.bets || []) {
        if (!ids.has(b.owner)) continue;
        out.push({ sp, id: b.id, placed: b.placed || null, created: b.created || null, settled: b.settled || null, status: b.status, stake: b.stake ?? null,
          odds: b.odds ?? null, book: b.book || '', net: b.net ?? null, note: b.note || '', text: betText(b), legs: (b.legs || []).length });
      }
    }
    return out.sort((a, b) => (Date.parse(b.placed) || b.created || 0) - (Date.parse(a.placed) || a.created || 0));
  }

  const canLookup = (ip) => resolveClientIp({ headers: {}, socket: { remoteAddress: ip } }, { mode: 'direct' }).kind === 'public';
  const roleOfDev = (d) => d.roleSet || (d.ownerAt ? 'owner' : d.role) || 'none';

  /* People, not browser profiles. A private/incognito window, a second browser or cleared cookies make a new
     tb_dev, so one person can be many rows. Grouping, in order of confidence:
       1. the owner: every profile that has used the owner code (sticky), or that you marked as yours;
       2. likely you: a profile with the SAME browser string (user agent) as one of your profiles, seen on the
          SAME network (same IPv4 address, or same IPv6 /64) within a day of your profile using it. Incognito
          keeps the user agent, so this is what an owner incognito visit looks like. Mark it "Not me" to undo;
       3. a name: every profile carrying the same name (the name a guest typed, or your label) is one person;
       4. the same same-browser-same-network rule joins unnamed profiles to each other and to a named one.
     Everything else is one unnamed person per profile. The result is an estimate and is labelled as one. */
  const DAY_MS = 86400e3;
  function netKey(ip) {
    if (!ip) return '';
    if (!ip.includes(':')) return ip;
    const [head, tail] = ip.split('::'); const l = head ? head.split(':') : [], r = tail !== undefined && tail ? tail.split(':') : [];
    const g = l.concat(Array(Math.max(0, 8 - l.length - r.length)).fill('0'), r);
    return g.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
  }
  const nameOf = (d) => (d.label || engineName(d) || '').trim();
  let peopleCache = null;
  function people() {
    const ids = Object.keys(state.devices);
    const sig = ids.length + ':' + ids.reduce((a, id) => Math.max(a, state.devices[id].last || 0), 0);
    if (peopleCache && peopleCache.sig === sig && Date.now() - peopleCache.at < 15e3) return peopleCache.v;
    const devs = state.devices;
    const owner = new Set(ids.filter((id) => roleOfDev(devs[id]) === 'owner'));
    // network windows: netKey -> [{id, ua, first, last}]
    const nets = new Map();
    for (const id of ids) for (const [ip, h] of Object.entries(devs[id].ips || {})) {
      const k = netKey(ip); if (!k) continue;
      let l = nets.get(k); if (!l) nets.set(k, (l = []));
      l.push({ id, ua: devs[id].ua || '', first: h.first, last: h.last });
    }
    const near = (a, b) => a.first <= b.last + DAY_MS && b.first <= a.last + DAY_MS;
    const twins = new Map();     // id -> Set of ids with same UA on the same network at about the same time
    for (const l of nets.values()) for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
      const a = l[i], b = l[j];
      if (a.id === b.id || !a.ua || a.ua !== b.ua || !near(a, b)) continue;
      (twins.get(a.id) || twins.set(a.id, new Set()).get(a.id)).add(b.id);
      (twins.get(b.id) || twins.set(b.id, new Set()).get(b.id)).add(a.id);
    }
    const likelyYou = new Set();
    for (const id of ids) {
      if (owner.has(id) || devs[id].roleSet === 'guest' || nameOf(devs[id])) continue;
      if ([...(twins.get(id) || [])].some((o) => owner.has(o))) likelyYou.add(id);
    }
    // union-find over the rest
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const join = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
    const rest = ids.filter((id) => !owner.has(id) && !likelyYou.has(id));
    const byName = new Map();
    for (const id of rest) { const n = nameOf(devs[id]).toLowerCase(); if (!n) continue; if (byName.has(n)) join(byName.get(n), id); else byName.set(n, id); }
    const restSet = new Set(rest);
    for (const id of rest) for (const o of twins.get(id) || []) {
      if (!restSet.has(o)) continue;
      const na = nameOf(devs[id]).toLowerCase(), nb = nameOf(devs[o]).toLowerCase();
      if (na && nb && na !== nb) continue;                     // two different names are two people
      join(id, o);
    }
    const groups = new Map();
    for (const id of rest) { const r = find(id); let g = groups.get(r); if (!g) groups.set(r, (g = [])); g.push(id); }
    const list = [...groups.values()].map((g) => {
      const name = g.map((id) => nameOf(devs[id])).find(Boolean) || '';
      const roles = new Set(g.map((id) => roleOfDev(devs[id])));
      return { devices: g, name, first: Math.min(...g.map((id) => devs[id].first)), last: Math.max(...g.map((id) => devs[id].last)),
        role: roles.has('guest') ? 'guest' : [...roles][0] || 'none', joined: g.length > 1 };
    }).sort((a, b) => a.first - b.first);
    let k = 0;
    for (const p of list) { p.key = 'p' + find(p.devices[0]).slice(0, 8); p.label = p.name || `Unnamed visitor ${++k}`; }
    const personOf = new Map();
    for (const p of list) for (const id of p.devices) personOf.set(id, p);
    const v = { owner, likelyYou, list, personOf };
    peopleCache = { sig, at: Date.now(), v };
    return v;
  }
  function summary(id) {
    const d = state.devices[id];
    const ev = byDev.get(id) || [];
    const info = uaInfo(d.ua, d.ctx);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let views = 0, clicks = 0, today_n = 0, lastDo = null, lastReal = 0;
    for (const e of ev) {
      if (e.k === 'view') views++;
      if (e.k === 'click') clicks++;
      if (e.t >= today.getTime() && (e.k === 'click' || e.k === 'view')) today_n++;
    }
    for (let i = ev.length - 1; i >= 0; i--) { const v = view(ev[i]); if (v.lvl === 1) { lastDo = { t: v.t, text: v.text, sp: v.sp }; break; } }
    // "Here now" means a board is actually open (live feed connected) or they did something real in the last
    // few minutes while signed in. Seeing the sign-in screen is not being here.
    for (let i = ev.length - 1; i >= 0; i--) { const e = ev[i]; if (e.role !== 'none' && (e.k === 'view' || e.k === 'click' || (e.k === 'req' && e.p === '/'))) { lastReal = e.t; break; } }
    const activity = activityOf(id, ev), ss = activity.data.sessions;
    const lastView = activity.history[0] || null;
    const interaction = [...activity.data.ordered].reverse().find(e => e.k === 'view' || e.k === 'click' || (e.k === 'act' && e.a === 'APP_FOREGROUND'));
    const lastInteractionAt = interaction ? Activity.eventTime(interaction) : null;
    const bets = betsOf(d);
    const done = bets.filter((b) => b.status === 'won' || b.status === 'lost' || b.status === 'push');
    const name = engineName(d);
    const P = people(), person = P.personOf.get(id) || null, likely = P.likelyYou.has(id);
    const who = d.label || name || (person && person.joined ? person.label : '') || '';
    const net = netKey(d.ipLast || '');
    return {
      id, role: likely ? 'owner' : roleOfDev(d), likelyYou: likely, ownerAt: d.ownerAt || null, roleSet: d.roleSet || null, roleSeen: d.role || null, label: d.label || '', name, who,
      person: person ? { key: person.key, label: person.label, named: !!person.name, devices: person.devices.length } : null,
      ipVersion: d.ipLast ? (d.ipLast.includes(':') ? 6 : 4) : null, network: net && net !== d.ipLast ? net : '',
      ua: d.ua || '', ...info, ctx: d.ctx || null,
      ipLast: d.ipLast || '', ipInfo: d.ipInfo || null, ipCount: Object.keys(d.ips || {}).length,
      first: d.first, last: d.last, live: streams.has(id) || (!!lastReal && Date.now() - lastReal < LIVE_MS), streaming: streams.get(id) || 0,
      feedOnly: !views && !clicks && ev.some((e) => e.k === 'req' && e.p === '/api/stream'),
      blocked: !!state.blocked[id], signoutPending: !!state.signout[id],
      sessions: ss.length, sessionsToday: ss.filter((s) => s.end >= today.getTime()).length, timeOn: ss.reduce((a, s) => a + s.dur, 0),
      views, pageViews: views, clicks, tapsToday: today_n, events: ev.length, lastView, lastInteractionAt,
      sports: Object.entries(d.sports || {}).sort((a, b) => b[1] - a[1]).map(([k]) => k), lastDo,
      bets: { n: bets.length, open: bets.filter((b) => b.status === 'open').length, won: done.filter((b) => b.status === 'won').length,
        lost: done.filter((b) => b.status === 'lost').length, net: done.reduce((a, b) => a + (b.net || 0), 0), staked: bets.reduce((a, b) => a + (b.stake || 0), 0) },
    };
  }

  function boardJSON() {
    const devices = Object.keys(state.devices).map(summary).sort((a, b) => b.last - a.last);
    const roleMap = Object.fromEntries(devices.map((d) => [d.id, d.role]));
    const feed = [], activity = [];
    for (let i = ring.length - 1; i >= 0 && (feed.length < 250 || activity.length < 500); i--) {
      const e = ring[i];
      if (!state.devices[e.dev]) continue;
      const v = { ...view(e), drole: roleMap[e.dev] };
      if (activity.length < 500) activity.push(v);
      if (v.lvl === 1 && feed.length < 250) feed.push(v);
    }
    const P = people(), WEEK = 7 * DAY_MS, now = Date.now();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const counts = {
      people: P.list.length, named: P.list.filter((p) => p.name).length, unnamed: P.list.filter((p) => !p.name).length,
      newWeek: P.list.filter((p) => now - p.first < WEEK).length, newToday: P.list.filter((p) => p.first >= today.getTime()).length,
      activeWeek: P.list.filter((p) => now - p.last < WEEK).length,
      yourProfiles: P.owner.size, likelyYou: P.likelyYou.size, profiles: devices.length,
    };
    const peopleList = P.list.map((p) => ({ key: p.key, label: p.label, named: !!p.name, first: p.first, last: p.last, role: p.role, devices: p.devices }))
      .sort((a, b) => b.last - a.last);
    return { now, owner: ownerName, devices, feed, activity, activityLimit: 500, counts, people: peopleList };
  }
  function deviceJSON(id) {
    const d = state.devices[id];
    if (!d) return null;
    const ev = byDev.get(id) || [];
    const activity = activityOf(id, ev);
    return {
      ...summary(id),
      links: d.links || {},
      uaHistory: Object.entries(d.uas || {}).map(([ua, h]) => ({ ua, ...h })).sort((a, b) => b.last - a.last),
      ipHistory: Object.entries(d.ips || {}).map(([ip, h]) => ({ ip, ...h, lookup: canLookup(ip) })).sort((a, b) => b.last - a.last),
      sessionList: activity.data.sessions.slice(0, 200),
      browsingHistory: activity.history,
      activityCoverage: { scope: 'in-app-only', identity: 'browser-cookie', deviceDetails: 'browser-reported', crossSiteHistory: false, retentionDays: RETAIN_DAYS, memoryWarmDays: WARM_DAYS, maxMemoryEvents: RING_MAX, historyLimit: 500, availableSince: ev.length ? Activity.eventTime(activity.data.ordered[0]) : null, hasLegacyEvents: ev.some(e => !Number.isFinite(e.receivedAt)), durationKind: 'observed_span' },
      timeline: activity.data.ordered.slice(-3000).map(e => ({ ...view(e), sessionId: activity.data.membership.get(e), visitId: Activity.visitId(e.visitId || e.vid) })).reverse(),
      betList: betsOf(d),
    };
  }

  /* The Security tab. Everything here is derived from the same log as the People tab, so it is the same truth
     seen from the door: who tried to get in and how, what changed about a device, which addresses are shared,
     and what failed. Each alert names the device, so every line opens the full detail. */
  function securityJSON() {
    const now = Date.now(), DAY = 86400e3, WEEK = 7 * DAY;
    const devs = state.devices;
    const label = (id) => { const d = devs[id]; if (!d) return { id, gone: true }; const i = uaInfo(d.ua, d.ctx); return { id, who: d.label || engineName(d), role: roleOfDev(d), device: i.device, os: `${i.os} ${i.osVer}`.trim(), browser: `${i.browser} ${i.bVer}`.trim() }; };
    const door = [], alerts = [], fails = [];
    const wrongByIp = new Map();
    for (let i = ring.length - 1; i >= 0; i--) {
      const e = ring[i];
      if (now - e.t > WEEK) break;
      if (!devs[e.dev]) continue;
      if (e.k === 'enter') {
        door.push({ t: e.t, dev: e.dev, how: e.how, text: describe(e)[0], ip: e.ip, role: e.role });
        if (e.how === 'wrong' && now - e.t < DAY) { const w = wrongByIp.get(e.ip) || { ip: e.ip, n: 0, devs: new Set(), first: e.t, last: e.t }; w.n++; w.devs.add(e.dev); w.first = Math.min(w.first, e.t); w.last = Math.max(w.last, e.t); wrongByIp.set(e.ip, w); }
      }
      if (e.k === 'req' && (e.s === 401 || e.s === 403 || e.s === 429 || e.s >= 500) && fails.length < 300) fails.push({ t: e.t, dev: e.dev, sp: e.sp, m: e.m, p: e.p, s: e.s, ip: e.ip, role: e.role, text: describe(e)[0] });
    }
    // Admin code used on a device the board had never seen before: the one that matters most.
    for (const x of door) if (x.how === 'code') { const d = devs[x.dev]; if (d && x.t - d.first < 5 * 60e3) alerts.push({ t: x.t, sev: 'high', kind: 'Admin code on a new device', dev: x.dev, ip: x.ip, text: 'Your admin code was used on a device this board had never seen. If this was not you, change ACCESS_CODE.' }); }
    for (const w of wrongByIp.values()) if (w.n >= 3) alerts.push({ t: w.last, sev: 'high', kind: 'Repeated wrong codes', dev: [...w.devs][0], ip: w.ip, text: `${w.n} wrong codes from ${w.ip} in the last day (after 10 the address is locked out for 15 minutes).` });
    for (const [id, d] of Object.entries(devs)) {
      const role = roleOfDev(d);
      if (now - d.first < WEEK && role !== 'owner' && !people().likelyYou.has(id)) alerts.push({ t: d.first, sev: role === 'guest' ? 'notice' : 'info', kind: role === 'guest' ? 'New guest device' : 'New signed-out visitor', dev: id, ip: Object.entries(d.ips || {}).sort((a, b) => a[1].first - b[1].first)[0]?.[0] || '', text: role === 'guest' ? 'A device came in as a guest for the first time.' : 'A device reached the sign-in screen and never got in.' });
      for (const [ua, h] of Object.entries(d.uas || {})) if (h.first - d.first > 60e3 && now - h.first < WEEK) {
        const a = uaInfo(ua);
        alerts.push({ t: h.first, sev: role === 'owner' ? 'info' : 'notice', kind: 'Different browser on the same device', dev: id, ip: d.ipLast, text: `This device's sign-in showed up in ${[`${a.browser} ${a.bVer}`.trim() || 'an unrecognised browser', `${a.os} ${a.osVer}`.trim()].filter(Boolean).join(' on ')}. Either the browser updated, or the sign-in was copied to another browser.` });
      }
      for (const [ip, h] of Object.entries(d.ips || {})) if (h.first - d.first > 60e3 && now - h.first < WEEK) alerts.push({ t: h.first, sev: 'info', kind: 'New IP address', dev: id, ip, text: `Now connecting from ${ip}${role === 'owner' ? ' (one of your devices; a VPN or a network change does this)' : ''}.` });
    }
    const groupFails = new Map();
    for (const f of fails) { const k = `${f.dev}|${f.s}|${f.p}`; const g = groupFails.get(k) || { ...f, n: 0, first: f.t }; g.n++; g.first = Math.min(g.first, f.t); groupFails.set(k, g); }
    for (const g of groupFails.values()) alerts.push({ t: g.t, sev: g.s === 403 || g.s >= 500 ? 'notice' : 'info', kind: g.s >= 500 ? 'Server error' : g.s === 429 ? 'Rate limited' : 'Refused request', dev: g.dev, ip: g.ip, text: `${g.text}${g.n > 1 ? ` · ${g.n} times` : ''} (${g.m} ${SPORT_LABEL[g.sp] || ''} ${g.p})` });
    alerts.sort((a, b) => b.t - a.t);
    // Every address, who used it. One address, many devices = a shared network, or one person on many browsers.
    const ipMap = new Map();
    for (const [id, d] of Object.entries(devs)) for (const [ip, h] of Object.entries(d.ips || {})) {
      const x = ipMap.get(ip) || { ip, first: h.first, last: h.last, n: 0, devs: [], roles: new Set() };
      x.first = Math.min(x.first, h.first); x.last = Math.max(x.last, h.last); x.n += h.n; x.devs.push(id); x.roles.add(roleOfDev(d)); ipMap.set(ip, x);
    }
    const ips = [...ipMap.values()].map((x) => ({ ...x, lookup: canLookup(x.ip), roles: [...x.roles], shared: x.devs.length > 1 })).sort((a, b) => b.last - a.last);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const T = today.getTime();
    const count = (fn) => door.filter(fn).length;
    const used = new Set(alerts.map((a) => a.dev).concat(door.map((x) => x.dev), ips.flatMap((x) => x.devs)));
    return {
      now,
      stats: {
        signinsToday: count((x) => x.t >= T && (x.how === 'code' || x.how === 'guest-code' || x.how === 'guest-link' || x.how === 'open')),
        wrongToday: count((x) => x.t >= T && x.how === 'wrong'), badLinksToday: count((x) => x.t >= T && x.how === 'bad-link'),
        newDevicesWeek: Object.values(devs).filter((d) => now - d.first < WEEK).length,
        high: alerts.filter((a) => a.sev === 'high').length, failsDay: fails.filter((f) => now - f.t < DAY).length,
        blocked: Object.keys(state.blocked).length, sharedIps: ips.filter((x) => x.shared).length,
      },
      alerts: alerts.slice(0, 300), door: door.slice(0, 400), ips: ips.slice(0, 300),
      blocked: Object.entries(state.blocked).map(([id, b]) => ({ id, at: b.at })),
      devices: Object.fromEntries([...used].map((id) => [id, label(id)])),
    };
  }

  // Everything on disk, filtered, as a download. Reads the day-files so it covers more than memory holds.
  function exportRows(dev) {
    const rows = [];
    let files = [];
    try { files = fs.readdirSync(DIR).filter((f) => /^events-.*\.jsonl$/.test(f)).sort(); } catch {}
    for (const f of files) {
      let txt = ''; try { txt = fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { continue; }
      for (const line of txt.split('\n')) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (!e.dev || isCleared(e) || !state.devices[e.dev]) continue;
        if (dev && e.dev !== dev) continue;
        rows.push(e);
      }
    }
    return rows.sort((a, b) => a.t - b.t);
  }
  const CSV_COLS = ['time_iso', 'device', 'who', 'role', 'sport', 'kind', 'what', 'ip', 'os', 'browser', 'method', 'path', 'status', 'ms', 'label', 'route', 'user_agent'];
  const csvCell = (v) => { let s = String(v == null ? '' : v); if (typeof v === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function exportCSV(dev) {
    const names = {};
    const lines = [CSV_COLS.join(',')];
    for (const e of exportRows(dev)) {
      const d = state.devices[e.dev];
      const s = names[e.dev] || (names[e.dev] = { who: d.label || engineName(d), role: roleOfDev(d), info: uaInfo(d.ua, d.ctx), ua: d.ua });
      const [what] = describe(e);
      lines.push([new Date(e.t).toISOString(), e.dev, s.who, s.role, e.sp || '', e.k, what, e.ip || '', `${s.info.os} ${s.info.osVer}`.trim(),
        `${s.info.browser} ${s.info.bVer}`.trim(), e.m || '', e.p || '', e.s ?? '', e.ms ?? '', e.l || e.a || e.how || '', e.r || '', s.ua].map(csvCell).join(','));
    }
    return lines.join('\n') + '\n';
  }

  // ------------------------------------------------------------------ owner actions
  function setDevice(id, body) {
    const d = state.devices[id];
    if (!d) return false;
    if (body.action) return act(id, d, body.action);
    if (typeof body.label === 'string') d.label = body.label.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
    if (body.role === 'owner' || body.role === 'guest' || body.role === null || body.role === 'auto') d.roleSet = body.role === 'auto' ? null : body.role;
    peopleCache = null;
    dirty = true; save();
    return true;
  }
  /* Block and sign-out act at the door, for all three sports at once. Both are silent: a blocked device just
     sees the ordinary sign-in screen, and a signed-out one is sent there once. Neither is ever announced.
     The owner's own devices can't be blocked from here, so this page can't lock its owner out. */
  function act(id, d, a) {
    if (a === 'block' || a === 'signout') { if (roleOfDev(d) === 'owner') return { error: 'That is one of your own devices.' }; }
    if (a === 'block') state.blocked[id] = { at: Date.now() };
    else if (a === 'unblock') delete state.blocked[id];
    else if (a === 'signout') state.signout[id] = Date.now();
    else return { error: 'Unknown action' };
    if (a === 'block' || a === 'signout') onRevokeDevice(id);
    record({ t: Date.now(), dev: id, role: roleOfDev(d), ip: '', sp: '', k: 'enter', how: `owner-${a}` });
    dirty = true; save();
    return true;
  }
  const lastBlockNote = new Map();
  // Called by the terminal on every request, before anything else answers. null = carry on.
  function gate(who) {
    if (state.blocked[who.dev]) {
      const t = Date.now();
      if (t - (lastBlockNote.get(who.dev) || 0) > 60e3 && state.devices[who.dev]) { lastBlockNote.set(who.dev, t); touch(who, null, null); record({ t, dev: who.dev, role: 'none', ip: who.ip, sp: '', k: 'enter', how: 'blocked' }); }
      return 'blocked';
    }
    if (state.signout[who.dev]) {
      delete state.signout[who.dev]; dirty = true;
      touch(who, null, null);
      record({ t: Date.now(), dev: who.dev, role: 'none', ip: who.ip, sp: '', k: 'enter', how: 'signed-out' });
      return 'signout';
    }
    return null;
  }

  // Clearing is the owner tidying their own view. The device is not told and not signed out; if it comes
  // back it simply starts a fresh row.
  function clearDevice(id) {
    const d = state.devices[id];
    if (!d) return false;
    state.cleared[id] = Date.now();
    peopleCache = null;
    for (const sp of SPORT_KEYS) for (const u of d.links?.[sp] || []) engineToDev.delete(`${sp}:${u}`);
    delete state.devices[id];
    const gone = new Set(byDev.get(id) || []);
    byDev.delete(id);
    activityCache.delete(id);
    telemetryBudget.delete(id);
    if (gone.size) for (let i = ring.length - 1; i >= 0; i--) if (gone.has(ring[i])) ring.splice(i, 1);
    dirty = true; save();
    return true;
  }

  // ------------------------------------------------------------------ http
  const sec = { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-content-type-options': 'nosniff' };
  function json(res, code, v) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...sec }); res.end(JSON.stringify(v)); }
  function readBody(req) {
    return new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 4000) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); req.on('error', () => ok({})); });
  }

  // Returns true if it answered. `role` is the terminal's door verdict for this request.
  function handle(req, res, pathname, qs, role) {
    if (!adminPath || (pathname !== adminPath && !pathname.startsWith(adminPath + '/'))) return false;
    const route = pathname.slice(adminPath.length);
    if (role !== 'owner') {
      if ((route === '' || route === '/') && req.method === 'GET') { res.writeHead(302, { location: adminPath + '/login', ...sec }); res.end(); }
      else json(res, 404, { error: 'Not found' });
      return true;
    }
    const M = req.method;
    if ((route === '' || route === '/') && M === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...sec }); res.end(PAGE); return true; }
    if (route === '/api/board' && M === 'GET') { json(res, 200, { ...boardJSON(), connection: resolveClientIp(req) }); return true; }
    if (route === '/api/security' && M === 'GET') { json(res, 200, securityJSON()); return true; }
    if (route === '/api/export' && M === 'GET') {
      const q = new URLSearchParams(qs.replace(/^\?/, ''));
      const dev = DEV_RE.test(q.get('dev') || '') ? q.get('dev') : '';
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const name = `board-${dev ? dev.slice(0, 8) : 'all'}-${stamp}`;
      if (q.get('fmt') === 'json') {
        const devs = dev ? { [dev]: state.devices[dev] } : state.devices;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${name}.json"`, ...sec });
        res.end(JSON.stringify({ exported: new Date().toISOString(), devices: devs, events: exportRows(dev) }, null, 1));
      } else {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, ...sec });
        res.end(exportCSV(dev));
      }
      return true;
    }
    const dm = /^\/api\/device\/([a-f0-9]{24})$/.exec(route);
    if (dm) {
      if (M === 'GET') { const d = deviceJSON(dm[1]); json(res, d ? 200 : 404, d || { error: 'Unknown device' }); return true; }
      // Keep both the explicit admin marker and same-origin browser evidence on privileged writes.
      if ((M === 'POST' || M === 'DELETE') && !isSameOrigin(req)) { json(res, 403, { error: 'Invalid origin' }); return true; }
      if (req.headers['x-board-admin'] !== '1') { json(res, 403, { error: 'Missing header' }); return true; }
      if (M === 'POST') { readBody(req).then((b) => { const r = setDevice(dm[1], b); json(res, r === true ? 200 : r ? 400 : 404, r === true ? { ok: true } : r || { error: 'Unknown device' }); }); return true; }
      if (M === 'DELETE') { json(res, clearDevice(dm[1]) ? 200 : 404, { ok: true }); return true; }
    }
    json(res, 404, { error: 'Not found' });
    return true;
  }

  function close() { if (dirty) save(); try { stream && stream.end(); } catch {} }

  const PAGE = adminPath ? require('./board-page')({ brand, logo, ownerName, adminPath, sports: SPORT_KEYS.map((k) => [k, sports[k].label]) }) : '';
  return { identify, gate, request, entrance, client, streamOpen, streamClose, handle, close, STATIC_RE };
};
