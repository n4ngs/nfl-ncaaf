'use strict';
/* BetMGM Nevada — one tap from a line on the board to BetMGM, with the bet already in the slip.
 *
 * BetMGM's betslip deep link, as the live NV site actually builds it (their published docs show an
 * older hyphen form; this was confirmed from a link their own Affiliate Helper generated):
 *     /en/sports?options={fixtureId}_{fixtureGuid}_{marketId}_{optionId}_false&type=Single
 * Those ids are BetMGM's own. Only their Sports API hands them out, and it answers
 * "AccessId is not provided" without a partner access id, so:
 *
 *     BETMGM_ACCESS_ID set  ->  resolve the ids and build a prefilled betslip link (the true one tap)
 *     not set               ->  fall back to a search deep link for that matchup, which still lands on
 *                               the game in one tap instead of hunting the site
 *
 * Either way the app never places a bet: BetMGM does, after the person confirms it there. Nevada only —
 * this is the only book we deep-link into, by design.
 */
const https = require('node:https');

const BASE = (process.env.BETMGM_BASE || 'https://www.nv.betmgm.com').replace(/\/$/, '');
const API = (process.env.BETMGM_API || 'https://sportsapi.nv.betmgm.com').replace(/\/$/, '');
const ACCESS_ID = (process.env.BETMGM_ACCESS_ID || '').trim();
const WM = (process.env.BETMGM_WM || '').trim();                 // affiliate / campaign tag, optional
const SPORT_ID = Number(process.env.BETMGM_SPORT_ID) || 11;      // 11 = American Football
const TTL = 60e3;                                                // their fixtures refresh ~2s; 60s is gentle

const nameOf = (t) => String(t?.name || t?.short || t?.abbr || '').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ---------- links ---------- */
function searchLink(G) {
  const q = [nameOf(G?.away), nameOf(G?.home)].filter(Boolean).join(' ');
  return q ? `${BASE}/en/sports/search?query=${encodeURIComponent(q)}` : `${BASE}/en/sports`;
}
/* The real shape, confirmed from a link BetMGM's own Affiliate Helper generated while signed in:
     options={fixtureId}_{fixtureGuid}_{marketId}_{optionId}_{isClassicBetBuilder}
   Legs of the SAME game join with "~" (a same-game parlay); different games join with ",".
   A single Giants moneyline looks like:
     ?options=6:43394_62f4f181-585f-44b6-9941-be7783302469_3594950_5692112_false&type=Single
   Note this is NOT the "{fixtureId}-{marketId}-{optionId}" hyphen form in their published docs: the live
   site uses underscores and carries the fixture GUID. Built by hand rather than with URLSearchParams,
   because that would percent-encode the ":" and "~" their format depends on. */
function selToken(sel) {
  // Outlier's production hand-off uses the short documented form: fixtureId-marketId-optionId, no GUID.
  // The Affiliate Helper's longer fixtureId_guid_marketId_optionId_false form also works, so use that
  // only when a guid is actually on hand. Both were seen working in a signed-in NV slip.
  // BetMGM's betslip POST calls it optionMarketId; their deep-link docs call it marketId. Same number,
  // so accept either name rather than silently emitting "fixture--option" with the market missing.
  const mk = sel.optionMarketId != null ? sel.optionMarketId : sel.marketId;
  return sel.fixtureGuid
    ? [sel.fixtureId, sel.fixtureGuid, mk, sel.optionId, 'false'].join('_')
    : [sel.fixtureId, mk, sel.optionId].join('-');
}
function slipLink(sels, stake) {
  const list = (Array.isArray(sels) ? sels : [sels]).filter(Boolean);
  if (!list.length) return `${BASE}/en/sports`;
  const anyGuid = list.some((s) => s.fixtureGuid);
  const sameGame = list.length > 1 && list.every((s) => s.fixtureId === list[0].fixtureId);
  // Same-game legs of the long form chain with "~"; everything else with ",".
  const sep = anyGuid && sameGame ? '~' : ',';
  // Land on the event page for a single, the way Outlier's hand-off does, so the slip opens in context.
  const path = list.length === 1 ? `/en/sports/events/${list[0].fixtureId}` : '/en/sports';
  const q = [`options=${list.map(selToken).join(sep)}`];
  if (list.length > 1) q.push('type=COMBO');
  if (stake > 0) q.push(`stake=${encodeURIComponent(stake)}`);
  if (WM) q.push(`wm=${encodeURIComponent(WM)}`);
  return `${BASE}${path}?${q.join('&')}`;
}

/* ---------- their Sports API (only used when an access id is configured) ---------- */
let cache = { at: 0, rows: null, err: null };
function getJSON(u) {
  return new Promise((resolve) => {
    const r = https.get(u, {
      timeout: 9000,
      headers: { accept: 'application/json', 'x-bwin-accessid': ACCESS_ID, 'user-agent': 'pick-six/1.0' },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; if (b.length > 8e6) res.destroy(); });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(b) : null); } catch { resolve(null); } });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
async function fixtures() {
  if (!ACCESS_ID) return null;
  if (cache.rows && Date.now() - cache.at < TTL) return cache.rows;
  const u = `${API}/offer/api/${SPORT_ID}/US/fixtures?accessId=${encodeURIComponent(ACCESS_ID)}`;
  const j = await getJSON(u);
  const rows = Array.isArray(j) ? j : (j?.fixtures || j?.items || j?.data || null);
  cache = { at: Date.now(), rows: rows || null, err: rows ? null : 'no fixtures' };
  return cache.rows;
}

// Their market naming varies by feed version, so match loosely on what the market is called.
const MARKET_RE = { s: /spread|handicap/i, h1s: /spread|handicap/i, t: /total|over.?under/i, ml: /money\s*line|winner|match result/i };

function pickFixture(rows, G) {
  const home = norm(nameOf(G?.home)), away = norm(nameOf(G?.away));
  if (!home || !away || !Array.isArray(rows)) return null;
  const hit = (s) => { const n = norm(s); return n && (n.includes(home) || home.includes(n) || n.includes(away) || away.includes(n)); };
  return rows.find((f) => {
    const parts = f?.participants || f?.competitors || [];
    const names = parts.map((p) => p?.name?.value || p?.name || p?.shortName || '').filter(Boolean);
    const blob = names.join(' | ') || f?.name?.value || f?.name || '';
    const nb = norm(blob);
    return (nb.includes(home) && nb.includes(away)) || (names.length >= 2 && names.every(hit));
  }) || null;
}
function pickOption(fx, market, side, G) {
  const re = MARKET_RE[market] || MARKET_RE.s;
  const markets = fx?.games || fx?.markets || [];
  const mk = markets.find((m) => re.test(String(m?.name?.value || m?.name || '')));
  if (!mk) return null;
  const opts = mk?.results || mk?.options || [];
  const want = market === 't'
    ? (side === 'over' ? /over/i : /under/i)
    : new RegExp(norm(nameOf(G?.[side])).split(' ').filter(Boolean).slice(-1)[0] || '.^', 'i');
  const op = opts.find((o) => want.test(String(o?.name?.value || o?.name || ''))) || null;
  if (!op) return null;
  const fixtureId = fx.id ?? fx.fixtureId;
  const fixtureGuid = fx.guid ?? fx.fixtureGuid ?? fx.eventGuid ?? null;
  const marketId = mk.id ?? mk.marketId;
  const optionId = op.id ?? op.optionId;
  return (fixtureId && marketId && optionId) ? { fixtureId, fixtureGuid, marketId, optionId } : null;
}


/* ---------- owner-pasted links ----------------------------------------------
   Until BetMGM issues an AccessId we cannot look ids up, but we do not have to: the owner can paste a
   BetMGM link for a selection and we keep the triple. That line then opens a真 prefilled slip. Stored
   per sport beside the rest of the app's state, so it survives restarts and deploys. */
const { readJSON, writeJSON } = require('./util');
let store = readJSON('betmgm.json', { v: 1, picks: {} });
const save = () => writeJSON('betmgm.json', store);
const mapKey = (gid, market, side) => `${gid}|${market}|${side}`;

// Accept anything BetMGM hands out: a whole url, just the options value, hyphen or underscore form,
// and multi-leg links (we take the leg that matches, or the first). Ids stay strings/ints as given.
function parseLink(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let opts = s;
  const m = /[?&]options=([^&#\s]+)/.exec(s);
  if (m) opts = decodeURIComponent(m[1]);
  const leg = opts.split(/[,~]/)[0].trim();
  if (!leg) return null;
  // underscore form: fixtureId_guid_optionMarketId_optionId_false
  if (leg.includes('_')) {
    const p = leg.split('_').filter(Boolean);
    if (p.length >= 4) {
      const fixtureId = p[0];
      const optionMarketId = Number(p[p.length - 2]);
      const optionId = Number(p[p.length - 1]);
      if (fixtureId && optionMarketId && optionId) return { fixtureId, optionMarketId, optionId };
      // trailing "false" variant
      const a = Number(p[p.length - 3]), b = Number(p[p.length - 2]);
      if (fixtureId && a && b) return { fixtureId, optionMarketId: a, optionId: b };
    }
    return null;
  }
  // hyphen form: fixtureId-optionMarketId-optionId, where fixtureId itself carries a colon (6:43394)
  const parts = leg.split('-');
  if (parts.length < 3) return null;
  const optionId = Number(parts.pop());
  const optionMarketId = Number(parts.pop());
  const fixtureId = parts.join('-');
  if (!fixtureId || !optionMarketId || !optionId) return null;
  return { fixtureId, optionMarketId, optionId };
}

function setMap(gid, market, side, input, label) {
  const sel = parseLink(input);
  if (!sel) throw new Error('That does not look like a BetMGM link. Paste the whole url, or just the options value.');
  store.picks[mapKey(gid, market, side)] = { ...sel, label: String(label || '').slice(0, 80), at: Date.now() };
  save();
  return sel;
}
function delMap(gid, market, side) {
  const k = mapKey(gid, market, side);
  if (!store.picks[k]) return false;
  delete store.picks[k]; save(); return true;
}
const getMap = (gid, market, side) => store.picks[mapKey(gid, market, side)] || null;
const listMap = () => Object.entries(store.picks).map(([k, v]) => {
  const [gid, market, side] = k.split('|');
  return { gid, market, side, ...v };
}).sort((a, b) => b.at - a.at);

/* ---------- the one call the server makes ---------- */
async function linkFor(G, market, side, stake, gid) {
  // An owner-pasted link wins: it is a real selection, confirmed by hand. Checked FIRST and off the raw
  // id, so it still works for a game this process has not loaded (a past week, a restart mid-slate).
  const id = (G && G.id) || gid || '';
  const pasted = id && getMap(id, market, side);
  if (pasted) return slipLink(pasted, stake);
  if (!G) return `${BASE}/en/sports`;
  try {
    const rows = await fixtures();
    if (rows) {
      const fx = pickFixture(rows, G);
      const sel = fx && pickOption(fx, market, side, G);
      if (sel) return slipLink(sel, stake);
    }
  } catch { /* any trouble at their end falls back below */ }
  return searchLink(G);
}
const status = () => ({ base: BASE, configured: !!ACCESS_ID, cachedFixtures: cache.rows?.length ?? 0, err: cache.err });

module.exports = { linkFor, searchLink, slipLink, status, parseLink, setMap, delMap, getMap, listMap };
