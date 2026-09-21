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
  return sel.fixtureGuid
    ? [sel.fixtureId, sel.fixtureGuid, sel.marketId, sel.optionId, 'false'].join('_')
    : [sel.fixtureId, sel.marketId, sel.optionId].join('-');
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

/* ---------- the one call the server makes ---------- */
async function linkFor(G, market, side, stake) {
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

module.exports = { linkFor, searchLink, slipLink, status };
