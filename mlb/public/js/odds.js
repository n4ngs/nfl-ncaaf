'use strict';
/* Bing Bong Live — odds: the Games tab "Odds" view (a board per game, line moves), the game odds sheet
   (line history chart, every book, Nevada links) and Edge Finder MLB.

   Informational by design: no alerts, no stakes, no urgency. Every model number is labeled an estimate.
   Data comes from the stream (bbl:snapshot, bbl:odds, bbl:move) and /api/odds?date= for other days.
   Every top-level name here starts with odds / ODDS_. */

// ------------------------------------------------------------ books
// Names and types for every book key in the spec. The server's list can rename them; links never come from it.
const ODDS_BOOKS = [
  { key: 'circa', name: 'Circa Sports', short: 'Circa', code: 'CIR', nv: true, sharp: true },
  { key: 'pin', name: 'Pinnacle', short: 'Pinnacle', code: 'PIN', sharp: true },
  { key: 'stn', name: 'Station Casinos', short: 'Station', code: 'STN', nv: true },
  { key: 'boom', name: "Boomer's", short: "Boomer's", code: 'BMR', nv: true },
  { key: 'czr', name: 'Caesars', short: 'Caesars', code: 'CZR', nv: true },
  { key: 'mgm', name: 'BetMGM', short: 'BetMGM', code: 'MGM', nv: true },
  { key: 'sp', name: 'South Point', short: 'S. Point', code: 'SP', nv: true },
  { key: 'wg', name: 'Westgate SuperBook', short: 'Westgate', code: 'WG', nv: true },
  { key: 'wynn', name: 'Wynn', short: 'Wynn', code: 'WYN', nv: true },
  { key: 'dk', name: 'DraftKings', short: 'DK', code: 'DK' },
  { key: 'fd', name: 'FanDuel', short: 'FanDuel', code: 'FD' },
];
// Verified Nevada pages. Boomer's and Wynn have no betting website, only their Nevada iPhone apps.
const ODDS_NV_LINK = {
  boom: 'https://apps.apple.com/us/app/boomers-sportsbook-nevada/id6749002754',
  wynn: 'https://apps.apple.com/us/app/wynn-sports-nevada/id6476514610',
  mgm: 'https://www.nv.betmgm.com/en/sports',
  czr: 'https://sportsbook.caesars.com/us/nv/bet',
  circa: 'https://www.circasports.com/',
  stn: 'https://stnsports.com/',
  wg: 'https://www.superbook.com/',
  sp: 'https://southpointcasino.com/',
};
const ODDS_NOT_BETTABLE = new Set(['cons', 'open']);
const ODDS_FLASH_MS = 2400;
const ODDS_MINUS = '−';

// ------------------------------------------------------------ state
const ODDS = {
  games: new Map(),     // pk -> O
  books: [],            // server book list, merged over ODDS_BOOKS
  moves: new Map(),     // id -> Move
  fetched: new Map(),   // date -> { at, ok }
  next: null,           // { date, games, priced }: the next day's slate, from today's odds
  flashed: new Map(),   // cell key -> ms it changed
  view: store.get('gamesView', 'odds'),
  sheetPk: null, sheetHist: null, sheetPaint: 0, sheetTimer: 0,
  chartMkt: store.get('oddsChart', 'ml'), chartBook: 'cons', chartAt: null,
  phoneBook: store.get('oddsBook', 'cons'), status: new Map(),
  mkt: store.get('oddsMkt', 'ml'),   // which market the board shows
  manual: {},           // pk -> book -> L: numbers you typed in at a window, yours alone
  keys: null,           // last season's run margins and totals
  filter: store.get('oddsFilter', 'all'), query: '',
  edgePaint: 0, edgeTimer: 0, edgeMkt: 'all',
  raf: 0, flashTimer: 0,
};

// ------------------------------------------------------------ small helpers
const oddsBook = (k) => ODDS.books.find((b) => b.key === k) || ODDS_BOOKS.find((b) => b.key === k) || { key: k, name: k, short: k, code: String(k).toUpperCase() };
const oddsBookName = (k) => ({ cons: 'Market', open: 'Open' }[k] || oddsBook(k).short);
const oddsBookFull = (k) => ({ cons: 'Market consensus', open: 'Opening line' }[k] || oddsBook(k).name);
const oddsBookCode = (k) => oddsBook(k).code || String(k).toUpperCase();
const oddsBookType = (k) => { const b = oddsBook(k); return b.nv ? 'NV' : b.sharp ? 'Sharp' : ['dk', 'fd'].includes(k) ? 'Online' : ''; };
const oddsTrim = (v) => String(Math.round(v * 100) / 100);
const oddsFmt = (o) => (o == null ? '—' : o > 0 ? `+${o}` : `${ODDS_MINUS}${Math.abs(o)}`);
const oddsFmtLine = (v) => (v == null ? '—' : v === 0 ? 'PK' : `${v > 0 ? '+' : ODDS_MINUS}${oddsTrim(Math.abs(v))}`);
const oddsSpoken = (s) => String(s).replace(new RegExp(ODDS_MINUS, 'g'), 'minus ').replace(/\+/g, 'plus ');
const oddsDec = (o) => (o == null ? null : o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o));
const oddsImp = (o) => (o == null ? null : o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100));
const oddsProbToAm = (p) => (p <= 0 || p >= 1 ? null : p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p));
// American odds on one continuous "how favored" scale: -145 -> 145, +110 -> 90. Differences are cents.
const oddsScale = (o) => (o == null ? null : o < 0 ? -o : 200 - o);
const oddsUnscale = (y) => (y >= 100 ? -Math.round(y) : Math.round(200 - y));
const oddsAgeMin = (ms) => (ms == null ? null : Math.max(0, Math.round((serverNow() - ms) / 60e3)));
function oddsAgo(ms) {
  const m = oddsAgeMin(ms);
  if (m == null) return '';
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  if (m < 360) return `${Math.floor(m / 60)} hr ago`;
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
const oddsOther = (side) => ({ home: 'away', away: 'home', over: 'under', under: 'over' }[side]);
const oddsIsPre = (g) => !!g && g.state === 'Preview' && !isOff(g);
// The game's prices, with any number you typed in at a window layered on top. Yours holds until that
// book's feed reports a fresher one, and it never leaves this device.
const oddsGame = (pk) => {
  const O = ODDS.games.get(Number(pk));
  const mine = ODDS.manual[Number(pk)];
  if (!O || !mine) return O || null;
  const books = { ...O.books };
  for (const [k, L] of Object.entries(mine)) {
    const fed = books[k];
    if (!fed || (L.seen || 0) >= (fed.seen || 0)) books[k] = { ...L, m: true };
  }
  return { ...O, books };
};
async function oddsLoadManual() {
  try { ODDS.manual = (await (await fetch('api/manual')).json()) || {}; } catch { /* offline */ }
}
async function oddsLoadKeys() {
  if (ODDS.keys) return ODDS.keys;
  try { ODDS.keys = await (await fetch('api/keys')).json(); } catch { ODDS.keys = null; }
  return ODDS.keys;
}

// One side of a book line: { line, odds }. Run lines are stored from the home side.
function oddsSide(L, mkt, side) {
  if (!L) return null;
  if (mkt === 'ml') { const o = L.ml?.[side === 'home' ? 0 : 1]; return o == null ? null : { line: null, odds: o }; }
  if (mkt === 'rl') { if (!L.rl || L.rl.line == null) return null; return side === 'home' ? { line: L.rl.line, odds: L.rl.odds?.[0] ?? null } : { line: -L.rl.line, odds: L.rl.odds?.[1] ?? null }; }
  if (mkt === 't') { if (!L.t || L.t.line == null) return null; return { line: L.t.line, odds: (side === 'over' ? L.t.odds?.[0] : L.t.odds?.[1]) ?? null }; }
  return null;
}
// Live display is a separate projection. Never feed it into opening/closing history or pregame models.
const oddsIsLive = (g) => !!g && g.state === 'Live' && !isOff(g) && !/suspend/i.test(g.detail || '');
function oddsLiveQuote(g, O, book, mkt, side) {
  if (!['ml', 'rl', 't'].includes(mkt) || !(mkt === 't' ? ['over', 'under'] : ['home', 'away']).includes(side)) return null;
  const L = O?.live?.[book], q = L?.quote_meta?.[mkt]?.[side];
  if (!q) return null;
  const stamp = (value) => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
  const sourceAt = stamp(q.source_observed_at), receivedAt = stamp(q.received_at);
  const age = serverNow() - sourceAt;
  let freshness = 'FRESH';
  if (q.conflicted || q.freshness === 'CONFLICTED' || (Number.isFinite(sourceAt) && (sourceAt > serverNow() || sourceAt > receivedAt))) freshness = 'CONFLICTED';
  else if (['suspended', 'removed'].includes(q.market_status) || (g?.state === 'Live' && !oddsIsLive(g))) freshness = 'SUSPENDED';
  else if (!oddsIsLive(g) || L.is_live !== true || q.is_live !== true || q.market_status !== 'active' || !Number.isFinite(sourceAt) || !Number.isFinite(receivedAt) || !Number.isFinite(q.max_age_ms) || q.max_age_ms <= 0 || !Number.isFinite(q.american_odds) || Math.abs(q.american_odds) < 100 || (mkt !== 'ml' && !Number.isFinite(q.line_value))) freshness = 'UNVERIFIED';
  else if (age > q.max_age_ms || q.freshness === 'STALE') freshness = 'STALE';
  else if (q.actionable !== true || q.freshness !== 'FRESH') freshness = 'UNVERIFIED';
  return { line: mkt === 'ml' ? null : q.line_value ?? null, odds: q.american_odds ?? null, book,
    freshness, actionable: freshness === 'FRESH', seen: Number.isFinite(sourceAt) ? sourceAt : null,
    source_observed_at: q.source_observed_at, source: q.source || L.source || L.src || null, provider_received_at:q.provider_received_at || null,
    feedOnly:freshness==='UNVERIFIED' && (q.source || q.src)==='sharp' && q.timestamp_kind==='FEED_DELIVERY' && q.market_status==='active' && q.is_live===true && q.reason_code==='MISSING_SOURCE_TIMESTAMP' };
}
function oddsLiveBest(g, O, mkt, side) {
  let best = null;
  for (const book of Object.keys(O?.live || {})) {
    if (ODDS_NOT_BETTABLE.has(book)) continue;
    const p = oddsLiveQuote(g, O, book, mkt, side);
    if (p?.actionable && (!best || oddsBetter(mkt, side, p, best))) best = p;
  }
  return best;
}
function oddsLiveCell(g, O, mkt, side, book, best = null, actionable = true) {
  const p = oddsLiveQuote(g, O, book, mkt, side);
  if (!p) return '<span class="odds-px na">—<small>Live unavailable</small></span>';
  const { main, sub } = oddsTwoLine(mkt, side, p);
  const state = p.feedOnly ? 'Feed quote' : p.actionable ? 'Live' : p.freshness.charAt(0) + p.freshness.slice(1).toLowerCase();
  const isBest = !!(p.actionable && best && (best.book === book || (p.odds === best.odds && (mkt === 'ml' || p.line === best.line))));
  const label = `${oddsBookFull(book)}, ${oddsWho(g, mkt, side)} ${oddsSpokenPrice(mkt, side, p)}, live ${state.toLowerCase()}`;
  const inner = `<span class="num">${esc(main)}</span>${sub ? `<small class="num">${esc(sub)}</small>` : ''}<small>${esc(state)}${isBest ? ' · Best' : ''}</small>`;
  if (!actionable || !p.actionable || ODDS_NOT_BETTABLE.has(book)) return oddsHandoff(g,O?.live?.[book],mkt,side,book,label,`<span class="odds-px na${p.actionable ? '' : ' old'}" aria-label="${esc(label)}">${inner}</span>`);
  return oddsHandoff(g,O?.live?.[book],mkt,side,book,label,`<button type="button" class="odds-px${isBest ? ' best' : ''}" data-odds-bet="${g.pk}|${mkt}|${side}|${book}" aria-label="${esc(label + '. Opens a bet slip.')}" data-fk="live${g.pk}${book}${mkt}${side}">${inner}</button>`);
}
// Better for the bettor: the better number first, then the better price.
function oddsBetter(mkt, side, a, b) {
  if (!b) return true;
  if (!a) return false;
  if (mkt !== 'ml' && a.line !== b.line) return mkt === 't' ? (side === 'over' ? a.line < b.line : a.line > b.line) : a.line > b.line;
  return oddsDec(a.odds) > oddsDec(b.odds);
}
// Receipt proves delivery; only a valid upstream quote clock proves quote freshness.
const oddsStamp = (v) => typeof v === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(v) ? Date.parse(v) : NaN;
function oddsQuote(L, mkt, side) {
  const p = oddsSide(L, mkt, side);
  if (!p) return null;
  const q = L?.quote_meta?.[mkt]?.[side], at = oddsStamp(q?.source_observed_at), received = oddsStamp(q?.received_at);
  let freshness = 'FRESH';
  if (q?.conflicted || q?.freshness === 'CONFLICTED' || (Number.isFinite(at) && (at > serverNow() || at > received))) freshness = 'CONFLICTED';
  else if (['suspended', 'removed'].includes(q?.market_status)) freshness = 'SUSPENDED';
  else if (!q || L.m || q.is_live !== false || q.market_status !== 'active' || !Number.isFinite(at) || !Number.isFinite(received) || !Number.isFinite(q.max_age_ms) || q.max_age_ms <= 0 || !Number.isFinite(q.american_odds) || Math.abs(q.american_odds) < 100 || q.american_odds !== p.odds || (mkt !== 'ml' && (!Number.isFinite(q.line_value) || q.line_value !== p.line))) freshness = 'UNVERIFIED';
  else if (serverNow() - at > q.max_age_ms || q.freshness === 'STALE') freshness = 'STALE';
  else if (q.freshness === 'AGING' || (Number.isFinite(q.fresh_for_ms) && q.fresh_for_ms > 0 && serverNow() - at > q.fresh_for_ms)) freshness = 'AGING';
  else if (q.freshness !== 'FRESH' || q.actionable !== true) freshness = 'UNVERIFIED';
  return { ...p, freshness, actionable: freshness === 'FRESH' || freshness === 'AGING', seen: Number.isFinite(at) ? at : null,   // Aging is usable, labelled, as on NFL/NCAAF
    source: q?.source || q?.src || L?.market_sources?.[mkt] || L?.src || null,
    provider_received_at:q?.provider_received_at || null, feedOnly:freshness==='UNVERIFIED' && (q?.source || q?.src)==='sharp' && q?.timestamp_kind==='FEED_DELIVERY' && q?.market_status==='active' && q?.is_live===false && q?.reason_code==='MISSING_SOURCE_TIMESTAMP',
    source_observed_at: q?.source_observed_at || null, reason_code: q?.reason_code || (Number.isFinite(at) ? freshness : 'SOURCE_TIME_UNAVAILABLE') };
}
function oddsPairFresh(L, mkt) {
  const sides = mkt === 't' ? ['over', 'under'] : ['home', 'away'];
  const a = oddsQuote(L, mkt, sides[0]), b = oddsQuote(L, mkt, sides[1]);
  return !!(a?.actionable && b?.actionable && a.source && a.source === b.source && a.source_observed_at === b.source_observed_at && (mkt === 'ml' || (mkt === 't' ? a.line === b.line : a.line === -b.line)));
}
const oddsStale = (L) => !['ml', 'rl', 't'].some((m) => (m === 't' ? ['over', 'under'] : ['home', 'away']).some((sd) => oddsQuote(L, m, sd)?.actionable));
const oddsStateLabel = (p) => p?.feedOnly ? 'Feed quote' : ({ FRESH: 'Fresh', AGING: 'Aging', STALE: 'Stale', UNVERIFIED: 'Unverified', SUSPENDED: 'Suspended', CONFLICTED: 'Conflict' }[p?.freshness] || 'Unavailable');
function oddsQuoteNote(p) {
  if(p?.feedOnly) return `WebSocket feed quote · delivered ${oddsAgo(oddsStamp(p.provider_received_at))} · sportsbook observation time unavailable`;
  return p ? `${oddsStateLabel(p)} · ${p.source || 'Source unavailable'} · ${p.seen ? 'source ' + oddsAgo(p.seen) : 'source time unavailable'}` : 'No quote supplied';
}
// The bettable books with a price, in the display order.
function oddsBookKeys(O) {
  const have = Object.keys(O?.books || {}).filter((k) => !ODDS_NOT_BETTABLE.has(k));
  const order = [...ODDS.books.map((b) => b.key), ...ODDS_BOOKS.map((b) => b.key)];
  return have.sort((a, b) => ((order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)));
}
// Best price for one side, at the market's number when any book hangs it (same-number comparisons), else anywhere.
function oddsBest(O, mkt, side) {
  const want = mkt === 'ml' ? null : oddsSide(oddsMarket(O).L, mkt, side)?.line ?? null;
  let best = null, bestAt = null;
  for (const k of oddsBookKeys(O)) {
    const L = O.books[k];
    if (oddsStale(L)) continue;
    const p = oddsQuote(L, mkt, side);
    if (!p?.actionable) continue;
    if (!best || oddsBetter(mkt, side, p, best)) best = { ...p, book: k };
    if (want != null && p.line === want && (!bestAt || oddsDec(p.odds) > oddsDec(bestAt.odds))) bestAt = { ...p, book: k };
  }
  return bestAt || best;
}
// The market line on the board: consensus, else Pinnacle, else Circa.
function oddsMarket(O) {
  const b = O?.books || {};
  if (b.cons) return { L: b.cons, key: 'cons' };
  for (const k of ['pin', 'circa']) if (b[k]) return { L: b[k], key: k };
  const k = oddsBookKeys(O)[0];
  return k ? { L: b[k], key: k } : { L: null, key: null };
}
// Exposed for the bet slip: one book's current price for one side.
function oddsPriceAt(pk, mkt, side, book) {
  const O = oddsGame(pk), g = S.games.get(Number(pk));
  if (!oddsIsPre(g)) { const p = oddsLiveQuote(g, O, book, mkt, side); return p?.actionable ? p : null; }
  const f5 = String(mkt).startsWith('f5');
  const L = (f5 ? O?.f5 : O?.books)?.[book];
  const p = oddsQuote(L, f5 ? mkt.slice(2) || 'ml' : mkt, side);
  return !ODDS_NOT_BETTABLE.has(book) && p?.actionable ? { ...p, book } : null;
}

// ------------------------------------------------------------ data in
function oddsSetBooks(list) {
  if (!Array.isArray(list) || !list.length) return;
  ODDS.books = list.map((b) => {
    const d = ODDS_BOOKS.find((x) => x.key === b.key) || {};
    return { ...d, ...b, code: d.code || String(b.short || b.key).slice(0, 4).toUpperCase() };
  });
}
// Every price the screen can show, as text, so a change can flash exactly the cell that moved.
function oddsCells(O) {
  const out = {};
  if (!O) return out;
  const m = oddsMarket(O).L;
  const sides = { ml: ['home', 'away'], rl: ['home', 'away'], t: ['over', 'under'] };
  for (const [mkt, ss] of Object.entries(sides)) {
    for (const s of ss) {
      const p = oddsSide(m, mkt, s);
      out[`m|${mkt}|${s}`] = p ? `${p.line}|${p.odds}` : '';
      const b = oddsBest(O, mkt, s);
      out[`b|${mkt}|${s}`] = b ? `${b.line}|${b.odds}|${b.book}` : '';
      for (const k of Object.keys(O.books || {})) {
        const q = oddsSide(O.books[k], mkt, s);
        out[`k|${k}|${mkt}|${s}`] = q ? `${q.line}|${q.odds}` : '';
      }
    }
  }
  return out;
}
function oddsPut(O, flash) {
  if (!O || O.pk == null) return;
  const pk = Number(O.pk);
  const prev = ODDS.games.get(pk);
  if (flash && prev) {
    const a = oddsCells(prev), b = oddsCells(O), now = Date.now();
    let any = false;
    for (const k of Object.keys(b)) if (a[k] !== undefined && a[k] !== b[k] && b[k] !== '') { ODDS.flashed.set(`${pk}|${k}`, now); any = true; }
    if (any) { clearTimeout(ODDS.flashTimer); ODDS.flashTimer = setTimeout(oddsRepaint, ODDS_FLASH_MS + 60); }
  }
  ODDS.games.set(pk, O);
  for (const mv of O.moves || []) if (mv?.id != null) ODDS.moves.set(mv.id, mv);
  if (ODDS.sheetPk === pk && ODDS.sheetHist) oddsHistAppend(ODDS.sheetHist, O);
}
function oddsLoad(d, flash) {
  if (!d) return;
  if (d.sources || d.coverage || d.refresh) ODDS.status.set(d.date || S.date, { sources: d.sources, coverage: d.coverage, refresh: d.refresh });
  if ('next' in d) ODDS.next = d.next || null; // only today's odds carry it: the next day's slate and how much of it is priced
  oddsSetBooks(d.books);
  const games = d.games || {};
  for (const O of Array.isArray(games) ? games : Object.values(games)) oddsPut(O, flash);
  for (const mv of d.moves || []) if (mv?.id != null) ODDS.moves.set(mv.id, mv);
}
// Class, inline delay and spoken note for a flashing cell. Redraws resume the animation instead of restarting it.
function oddsFlash(pk, ...keys) {
  let at = null;
  for (const k of keys) { const t = ODDS.flashed.get(`${pk}|${k}`); if (t != null && (at == null || t > at)) at = t; }
  const age = at == null ? Infinity : Date.now() - at;
  if (age >= ODDS_FLASH_MS) { for (const k of keys) ODDS.flashed.delete(`${pk}|${k}`); return { cls: '', style: '', label: '' }; }
  return { cls: ' tick', style: ` style="animation-delay:-${Math.round(age)}ms"`, label: ' Just moved.' };
}

oddsLoadManual();
document.addEventListener('bbl:snapshot', (ev) => {
  const d = ev.detail;
  if (!d?.odds) return;
  oddsLoad(d.odds, true);
  if (d.date) ODDS.fetched.set(d.date, { at: Date.now(), ok: true });
  oddsRepaint();
});
document.addEventListener('bbl:odds', (ev) => {
  oddsPut(ev.detail, true);
  oddsRepaint();
  if (ev.detail && Number(ev.detail.pk) === ODDS.sheetPk) oddsSheetRefresh();
});
document.addEventListener('bbl:move', (ev) => {
  const mv = ev.detail;
  if (mv?.id == null) return;
  ODDS.moves.set(mv.id, mv);
  const O = ODDS.games.get(Number(mv.pk));
  if (O) O.moves = [...(O.moves || []).filter((x) => x.id !== mv.id), mv];
  oddsRepaint();
});

// Other days (and today, if the snapshot came without odds): fetch once, retry a failure after a minute.
async function oddsFetchDay(date, force = false) {
  const f = ODDS.fetched.get(date);
  if (!date || f?.busy || (!force && f && (f.ok || Date.now() - f.at < 60e3))) return;
  ODDS.fetched.set(date, { at: Date.now(), busy: true, ok: !!f?.ok });
  oddsRepaint();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 18000);
  try {
    const r = await fetch(`api/odds?date=${encodeURIComponent(date)}${force ? '&refresh=1' : ''}`, { signal: controller.signal });
    if (!r.ok) throw new Error('Refresh unavailable');
    oddsLoad(await r.json(), !!force);
    ODDS.fetched.set(date, { at: Date.now(), ok: true });
  } catch {
    ODDS.fetched.set(date, { at: Date.now(), ok: !!f?.ok, error: 'Refresh unavailable. Existing quote status is unchanged.' });
  } finally { clearTimeout(timer); oddsRepaint(); }
}

// ------------------------------------------------------------ repaint scheduling
function oddsRepaint() {
  if (ODDS.raf) return;
  ODDS.raf = requestAnimationFrame(() => {
    ODDS.raf = 0;
    if (S.tab === 'odds') oddsGamesHook();
    if (S.tab === 'live') oddsStripRender();
    if (S.dlgKind === 'edges') oddsEdgeRefresh();
    if (S.dlgKind === 'odds') oddsSheetRefresh();
  });
}
// Replace a container's HTML only when it changed, keeping keyboard focus on the same control.
function oddsSwap(el, html) {
  if (!el || el.dataset.key === html) return;
  const f = document.activeElement;
  const fk = f && el.contains(f) ? f.dataset.fk : null;
  const selection = fk && typeof f.selectionStart === 'number' ? [f.selectionStart, f.selectionEnd] : null;
  const scrolls = [...el.querySelectorAll('.odds-btwrap')].map((box) => box.scrollLeft);
  // update in place (BoardMorph, design/linesboard.js): unchanged prices and rows are left untouched
  if (typeof BoardMorph === 'function' && el.firstChild) BoardMorph(el, html); else el.innerHTML = html;
  el.dataset.key = html;
  if (fk) { const next = el.querySelector(`[data-fk="${CSS.escape(fk)}"]`); next?.focus({ preventScroll: true }); if (selection && next?.setSelectionRange) try { next.setSelectionRange(...selection); } catch {} }
  el.querySelectorAll('.odds-btwrap').forEach((box, i) => { box.scrollLeft = scrolls[i] || 0; });
}

// ------------------------------------------------------------ Games tab: Scores | Odds
function oddsGamesHook() {
  const host = $('#oddsHost');
  if (!host) return;
  const day = S.loading || S.date;
  if (day && !S.loading) oddsFetchDay(day);
  // The Odds tab is its own view now (it used to be a Scores | Odds switch inside Games).
  if (!host.dataset.ready) { host.dataset.ready = '1'; host.innerHTML = '<div id="oddsView" class="odds-view"></div>'; }
  oddsSwap($('#oddsView'), oddsViewHTML());
}

function oddsDayGames() {
  return [...S.games.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.pk - b.pk);
}
function oddsViewHTML() {
  const games = oddsDayGames(), f = ODDS.fetched.get(S.date), mkt = ODDS.mkt;
  const refresh = ODDS.status.get(S.date)?.refresh, busy = f?.busy || refresh?.in_progress;
  const dayPending = !!S.loading || !S.date; // No selected day exists before the initial snapshot.
  const cooldown = Number.isFinite(refresh?.next_allowed_at) && refresh.next_allowed_at > serverNow();
  const head = `<div class="odds-workspace-head"><div><p class="odds-kicker">MLB · Prices & movement</p><h1>MLB market board</h1></div>${S.me?.role === 'owner' ? `<button type="button" class="odds-refresh" data-odds-refresh data-fk="refresh" ${busy || dayPending ? 'disabled aria-busy="true"' : cooldown ? 'disabled' : ''}>${busy ? 'Refreshing…' : cooldown ? `Refresh in ${Math.ceil((refresh.next_allowed_at - serverNow()) / 1000)}s` : 'Refresh odds'}</button>` : '<span class="odds-auto-note">Updates automatically</span>'}</div>`;
  if (dayPending) return `${head}<div class="card empty" role="status"><b>Loading this day’s games…</b></div>`;
  if (!games.length) return `${head}<div class="card empty"><b>No games ${S.isToday ? 'today' : 'on this day'}</b>Choose another day above.</div>${oddsNextHTML([])}`;
  const shown = games.filter((g) => oddsPasses(g) && oddsMatches(g));
  const live = shown.filter((g) => g.state === 'Live' && !isOff(g));
  const soon = shown.filter(oddsIsPre);
  const done = shown.filter((g) => g.state === 'Final' || isOff(g));
  const block = (list) => { const best = list.some((g) => oddsIsPre(g) || (oddsIsLive(g) && mkt !== 'f5')); return `<div class="card odds-brd">${oddsRowHead(mkt, best)}${list.map((g) => oddsRow(g, mkt, best)).join('')}</div>${oddsBoardTable(list, mkt)}`; };
  const section = (title, list) => list.length ? `<div class="odds-grp"><h2>${esc(title)}</h2><span>${list.length} game${list.length === 1 ? '' : 's'}</span></div>${block(list)}` : '';
  const wasOpen = document.getElementById('oddsDone')?.open;
  const contextOpen = document.getElementById('oddsContext')?.open;
  return `${head}${oddsOverview(games, mkt)}<div class="odds-toolbar">${oddsMktSeg(mkt)}${oddsFilterBar(games)}</div>${typeof mlbVasBlock === 'function' ? mlbVasBlock(games) : ''}
    ${f?.error ? `<p class="odds-health" role="status">${esc(f.error)} <button type="button" class="odds-link" data-odds-refresh>Retry</button></p>` : oddsRefreshFeedback(refresh)}
    <div class="odds-lay"><div class="odds-boards">${typeof MyBooks !== 'undefined' && MyBooks.viewBarHTML ? `<div class="odds-bkv">${MyBooks.viewBarHTML([...ODDS.books, ...ODDS_BOOKS].filter((b, i, a) => a.findIndex((x) => x.key === b.key) === i))}</div>` : ''}
      ${section('Live', live)}${section(S.isToday ? 'Up next' : 'Scheduled', soon)}${oddsNextHTML(soon)}
      ${done.length ? `<details class="odds-done" id="oddsDone"${wasOpen || (!live.length && !soon.length) ? ' open' : ''}><summary class="odds-grp"><h2>Final & off board</h2><span>${done.length} · recorded prices ${ICON.chev}</span></summary>${block(done)}</details>` : ''}
      ${!shown.length ? `<div class="card empty"><b>No matching games</b>${ODDS.query ? `No team matches “${esc(ODDS.query)}”.` : 'This filter has no games on this day.'}<button type="button" class="lbtn" data-odds-reset>Clear filters</button></div>` : ''}
    </div></div>
    <p class="odds-board-guide">${mkt === 'f5' ? 'First five innings moneyline. ' : ''}Fresh and aging book prices open a ticket (aging ones are labelled). Stale and unverified prices are reference only.<span class="odds-wide-guide"> Scroll across for every book →</span></p>
    ${oddsSourceStatus()}<details class="odds-context" id="oddsContext"${contextOpen ? ' open' : ''}><summary>Market analysis <span>Recorded moves · price comparisons ${ICON.chev}</span></summary><div>${S.isToday || (ODDS.next?.date && S.date === ODDS.next.date) ? oddsEdgeEntry() : ''}${oddsMovesHTML(games)}<button type="button" class="odds-link" data-bets-books>Sportsbook links ↗</button></div></details>`;
}
/* Once today has nothing left to bet pregame (every game under way or final, or no games at all), point at the next
   day's board: its lines are priced ahead, as soon as books post them. */
function oddsNextHTML(soon) {
  const n = ODDS.next;
  if (!S.isToday || soon.length || !n?.date || !n.games) return '';
  const count = `${n.games} game${n.games === 1 ? '' : 's'}`;
  const sub = n.priced ? `${n.priced === n.games ? count : `${n.priced} of ${count}`} priced` : `${count} · lines not posted yet`;
  const label = typeof dayLabel === 'function' ? dayLabel(n.date, true) : n.date;
  return `<div class="card odds-next"><div><b>Next up · ${esc(label)}</b><span>${esc(sub)}</span></div><button type="button" class="lbtn" data-day="${esc(n.date)}" data-to="odds" data-fk="next-day">See the board</button></div>`;
}
const ODDS_FILTERS = [['all', 'All games'], ['moving', 'Moving'], ['public', 'Public heavy'], ['mine', 'My bets']];

function oddsPasses(g) {
  const f = ODDS.filter;
  if (f === 'all') return true;
  const O = oddsGame(g.pk);
  if (f === 'moving') {
    const open = O?.open, now = oddsMarket(O).L;
    if (!open || !now) return false;
    const ml = open.ml?.[0] != null && now.ml?.[0] != null ? Math.abs(oddsScale(now.ml[0]) - oddsScale(open.ml[0])) : 0;
    const t = open.t?.line != null && now.t?.line != null ? Math.abs(now.t.line - open.t.line) : 0;
    return ml >= 15 || t >= 0.5 || (O?.moves || []).length > 0;
  }
  if (f === 'public') {
    const sp = O?.splits?.[ODDS.mkt] || O?.splits?.ml;
    return !!sp && (sp.tix >= 65 || sp.tix <= 35);
  }
  if (f === 'mine') return typeof BETS !== 'undefined' && (BETS.list || []).some((b) => b.status === 'open' && (b.legs || []).some((l) => Number(l.pk) === Number(g.pk)));
  return true;
}
function oddsMatches(g) {
  const q = ODDS.query.trim().toLowerCase();
  if (!q) return true;
  return ['home', 'away'].some((s) => { const t = oddsTeam(g, s); return [t.name, t.abbr, t.short].some((x) => String(x || '').toLowerCase().includes(q)); });
}
function oddsFilterBar(games) {
  const opts = ODDS_FILTERS.map(([f, label]) => `<option value="${f}"${ODDS.filter === f ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const keys = [...new Set([...ODDS.books, ...ODDS_BOOKS].map((b) => b.key))].filter((k) => !ODDS_NOT_BETTABLE.has(k));
  return `<div class="odds-ctrl"><label class="odds-select-label"><span class="odds-control-label">Show</span><select id="oddsGameFilter" data-fk="filter">${opts}</select></label><label class="odds-select-label odds-book-select"><span class="odds-control-label">Book</span><select id="oddsBookPick" data-fk="book"><option value="cons"${ODDS.phoneBook === 'cons' ? ' selected' : ''}>Market</option>${keys.map((k) => `<option value="${esc(k)}"${ODDS.phoneBook === k ? ' selected' : ''}>${oddsMy(k) ? '★ ' : ''}${esc(oddsBookName(k))}</option>`).join('')}</select></label><button type="button" class="odds-link mybk-open" data-bets-books data-fk="mybooks"><span class="mybk-star" aria-hidden="true">★</span>My books</button><input class="odds-find" id="oddsFind" data-fk="find" type="search" placeholder="Find a team" autocomplete="off" aria-label="Find a team" value="${esc(ODDS.query)}"></div>`;
}
function oddsCoverage(games, mkt) {
  const counts = { FRESH: 0, AGING: 0, STALE: 0, UNVERIFIED: 0, SUSPENDED: 0, CONFLICTED: 0 }, books = new Set();
  for (const g of games) {
    if (!oddsIsPre(g) && !oddsIsLive(g)) continue;
    const O = oddsGame(g.pk), set = oddsIsLive(g) ? O?.live : oddsBooksFor(O, mkt);
    for (const [k, L] of Object.entries(set || {})) {
      if (ODDS_NOT_BETTABLE.has(k)) continue;
      for (const side of oddsSides(mkt)) {
        const q = oddsIsLive(g) ? oddsLiveQuote(g, O, k, mkt, side) : oddsQuote(L, oddsBaseMkt(mkt), side);
        if (q) { counts[q.freshness] = (counts[q.freshness] || 0) + 1; books.add(k); }
      }
    }
  }
  return { ...counts, books: books.size };
}
function oddsOverview(games, mkt) {
  const c = oddsCoverage(games, mkt), unknown = c.UNVERIFIED + c.SUSPENDED + c.CONFLICTED;
  return `<div class="odds-overview" aria-label="Selected market quote coverage"><span class="odds-health" data-state="FRESH"><b>${c.FRESH}</b> current prices</span><span class="odds-health" data-state="AGING"><b>${c.AGING}</b> aging</span><span class="odds-health" data-state="STALE"><b>${c.STALE}</b> stale</span><span class="odds-health"><b>${unknown}</b> unverified / unavailable</span><span class="odds-coverage-books">${c.books} books · ${games.length} games</span></div>`;
}
function oddsRefreshFeedback(refresh) {
  if (!refresh || refresh.in_progress) return '';
  const text = {
    error: 'Feeds could not refresh. Existing prices keep their source status.',
    partial: 'Some feeds could not refresh. Check feed coverage below.',
    scheduled: 'No feed was due yet. Scheduled polling continues.',
    historical: 'Recorded prices reloaded. Historical days do not request new quotes.',
  }[refresh.result];
  return text ? `<p class="odds-health odds-refresh-feedback" role="status">${text}</p>` : '';
}
function oddsSourceStatus() {
  const status = ODDS.status.get(S.date);
  if (!status?.sources) return '';
  const open = document.getElementById('oddsSourceStatus')?.open;
  const names = { sharp: 'WebSocket API', owls: 'Additional Coverage', an: 'Action', an1: 'Action v1', espn: 'ESPN', pin: 'Pinnacle', vsin: 'VSiN' };
  const rows = Object.entries(status.sources).map(([key, source]) => {
    const at = oddsStamp(source.source_observed_at), receipt = oddsStamp(source.received_at);
    const state = ['sharp','owls'].includes(key) ? (source.streamHealthy ? 'Streaming' : source.enabled ? (source.connection === 'polling' ? 'Polling' : 'Connecting') : 'Not connected') : { loading: 'Checking', ok: 'Responding', error: 'Unavailable', waiting: 'Waiting', idle: 'Idle' }[source.state] || 'Unavailable';
    return `<div class="odds-source-row"><strong>${esc(names[key] || key)}</strong><span>${state}</span><small>Last check: ${Number.isFinite(receipt) ? esc(oddsAgo(receipt)) : 'not recorded'}<br>Newest source quote: ${Number.isFinite(at) ? esc(oddsAgo(at)) : 'time unavailable'}</small></div>`;
  }).join('');
  const missing = status.coverage?.missing?.length;
  return `<details class="odds-source-status" id="oddsSourceStatus"${open ? ' open' : ''}><summary>Feed coverage <span>${Number.isFinite(missing) ? `${missing} incomplete book markets · ` : ''}Source checks ${ICON.chev}</span></summary><div>${rows}</div><p>A responding feed can contain old quotes. Source clocks determine each price’s status; a refresh never resets that clock.</p></details>`;
}
function oddsFreshText(games) { const c = oddsCoverage(games, ODDS.mkt); return `${c.FRESH} current prices · ${c.STALE} stale · source timestamps required`; }

function oddsMktSeg(mkt) {
  const one = ([k, label]) => `<button type="button" data-odds-mkt="${k}" aria-pressed="${mkt === k}">${esc(label)}</button>`;
  return `<div class="seg odds-mseg" role="group" aria-label="Which market to show">${ODDS_MKT_TABS.map(one).join('')}</div>`;
}


// ------------------------------------------------------------ Live page: today's odds strip
/* One compact card per game, directly under the date strip: each side's moneyline and the total. In play it shows
   only a fresh live price; with no live price it falls back to the pregame close, labelled "Close", never passed off
   as current. A final game shows its close. Tapping a card opens that game's odds (every book, line history). */
function oddsStripQuote(g, O, mkt, side) {
  if (oddsIsLive(g)) {
    for (const k of [...new Set(['cons', 'pin', 'circa', ...Object.keys(O?.live || {})])]) { const q = oddsLiveQuote(g, O, k, mkt, side); if (q?.actionable) return { p: q, tag: 'Live' }; }
    // no fresh live price: the pregame close (or, before it is recorded, the last pregame market), labelled as such
    const c = oddsSide(O?.close || oddsMarket(O).L, mkt, side);
    return c && c.odds != null ? { p: c, tag: O?.close ? 'Close' : 'Pregame' } : null;
  }
  if (g.state === 'Final' || isOff(g)) { const c = oddsSide(O?.close || oddsMarket(O).L, mkt, side); return c && c.odds != null ? { p: c, tag: O?.close ? 'Close' : 'Last' } : null; }
  const p = oddsSide(oddsMarket(O).L, mkt, side);
  return p && p.odds != null ? { p, tag: '' } : null;
}
function oddsStripCard(g) {
  const O = oddsGame(g.pk), live = oddsIsLive(g) || (g.state === 'Live' && !isOff(g)), fin = g.state === 'Final' || isOff(g);
  const a = oddsStripQuote(g, O, 'ml', 'away'), h = oddsStripQuote(g, O, 'ml', 'home'), t = oddsStripQuote(g, O, 't', 'over');
  const tag = [a, h, t].map((x) => x?.tag).find(Boolean) || '';
  const team = (side, q) => { const tm = oddsTeam(g, side); return `<span class="ostrip-tm${!oddsIsPre(g) && g[side]?.score != null ? '' : ''}">${logo(tm.id)}<span class="ostrip-ab">${esc(tm.abbr)}</span>${!oddsIsPre(g) && g[side]?.score != null ? `<span class="ostrip-sc num">${g[side].score}</span>` : ''}<b class="num">${q ? esc(oddsFmt(q.p.odds)) : '—'}</b></span>`; };
  const status = oddsIsPre(g) ? timeLabel(g.start) : gameStatus(g);
  const spoken = `${oddsTeam(g, 'away').name} ${a ? oddsSpoken(oddsFmt(a.p.odds)) : 'no price'}, ${oddsTeam(g, 'home').name} ${h ? oddsSpoken(oddsFmt(h.p.odds)) : 'no price'}${t ? `, total ${oddsTrim(t.p.line)}` : ''}${tag ? `, ${tag.toLowerCase()} prices` : ''}. Opens every book and the line history.`;
  return `<button type="button" class="ostrip-card${live ? ' live' : ''}${fin ? ' fin' : ''}" data-odds-open="${g.pk}" data-fk="strip${g.pk}" aria-label="${esc(spoken)}">
    <span class="ostrip-st">${live ? '<span class="dot"></span>' : ''}<span>${esc(status)}</span>${tag ? `<small class="ostrip-tag${tag === 'Live' ? ' on' : ''}">${esc(tag)}</small>` : ''}</span>
    ${team('away', a)}${team('home', h)}
    <span class="ostrip-tot"><span>Total</span><b class="num">${t ? esc(oddsTrim(t.p.line)) : '—'}</b></span></button>`;
}
function oddsStripRender() {
  const sec = $('#oddsStripSec'), el = $('#oddsStrip');
  if (!sec || !el) return;
  const day = S.loading || S.date;
  if (day && !S.loading) oddsFetchDay(day);
  const rank = (g) => (oddsIsLive(g) || (g.state === 'Live' && !isOff(g)) ? 0 : oddsIsPre(g) ? 1 : 2);
  const games = oddsDayGames().sort((x, y) => rank(x) - rank(y) || Date.parse(x.start) - Date.parse(y.start));
  sec.hidden = !games.length;
  if (!games.length) return;
  const keep = el.scrollLeft;
  oddsSwap(el, games.map(oddsStripCard).join(''));
  el.scrollLeft = keep;
}

// ------------------------------------------------------------ the Model column and My books
/* The model's number per side, from the cached model read (server lib/vas-service.js, refreshed every 10 minutes and
   fetched by js/vas.js; nothing is computed per request). The MLB model predicts the winner (win probability) and its
   own expected total runs. It has no run-margin stage and is fitted on full games only, so the run line and the
   first five show a dash. Estimates, not picks. */
const ODDS_MODEL_TIP = {
  ml: "The model's fair moneyline: its win chance for each side (team, lineup and starting-pitcher fundamentals) with no vig. An estimate, not a pick.",
  rl: "The model's fair run line, derived from its win chance and expected total runs (runs as two Poisson scores that reproduce both). Derived, not fitted on run lines. An estimate, not a pick.",
  t: "The model's own expected total runs (fundamentals). Its totals have not beaten the closing line in testing. An estimate, not a pick.",
  f5: "The model's fair first-five moneyline (a tie pushes), derived from its win chance and total scaled to five innings. Derived, not fitted on first fives. An estimate, not a pick.",
};
let oddsModelIdx = { at: -1, map: new Map() };
function oddsModelRead(g) {
  // Before first pitch and on finished games (the pregame number); hidden while a game is in play.
  if (!g || !(oddsIsPre(g) || g.state === 'Final') || typeof MLBVAS === 'undefined') return null;
  if (typeof mlbVasWantDate === 'function' && typeof S !== 'undefined' && S.date) mlbVasWantDate(S.date);
  if (oddsModelIdx.at !== MLBVAS.at) oddsModelIdx = { at: MLBVAS.at, map: new Map((MLBVAS.reads || []).map((r) => [Number(r.pk), r])) };
  const r = oddsModelIdx.map.get(Number(g.pk));
  return r && Number.isFinite(r.pHome) && r.pHome > 0 && r.pHome < 1 ? r : null;
}
function oddsFairAm(p) {
  if (!(p > 0 && p < 1)) return null;
  if (typeof BoardFair !== 'undefined') return BoardFair.american(p);
  const v = p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p;
  return Math.abs(v) > 2500 ? null : Math.round(v);
}
/* Run line and first five from the model's two numbers. Home and away runs as negative-binomial scores (runs are
   over-dispersed: variance about 2.2x the mean in MLB) whose means add up to the model's total and reproduce its win
   chance (a tie after nine goes to extras, split by the means); the run line is then P(margin >= 2) for the -1.5 side,
   and the first five uses 5/9 of each mean with a tie pushing. Derived, labelled so. Without the model's total, a
   typical 8.6 runs is used.
   Run line recalibration: the raw score model reads the favourite's -1.5 about 2.4 points off the books' no-vig run
   lines (home teams skip the bottom of the ninth when ahead, which a two-score model cannot see). A three-number
   logistic map, fitted to 700 book quotes on 45 games (Sep 21-24 2026) against the same books' moneyline and total,
   brings that to about 1.0 point on each held-out day. It maps the model's inputs the way the market does. */
const ODDS_MLB_TOTAL = 8.6, ODDS_RUN_DISP = 1.2;   // variance = mean + mean^2 / r with r = mean / 1.2  ->  2.2x the mean
function oddsPois(l, n = 30) {
  const r = l / ODDS_RUN_DISP, q = r / (r + l), p = [Math.pow(q, r)];
  for (let k = 1; k <= n; k++) p.push(p[k - 1] * (k - 1 + r) / k * (1 - q));
  return p;
}
function oddsMargin(lh, la) {       // [P(home - away = d)] as a map d -> p, d in -30..30
  const ph = oddsPois(lh), pa = oddsPois(la), out = new Map();
  for (let h = 0; h < ph.length; h++) for (let a = 0; a < pa.length; a++) out.set(h - a, (out.get(h - a) || 0) + ph[h] * pa[a]);
  return out;
}
const oddsWinOf = (lh, la) => { const m = oddsMargin(lh, la); let w = 0, t = m.get(0) || 0; for (const [d, p] of m) if (d > 0) w += p; return w + t * (lh / (lh + la)); };
function oddsRates(pHome, total) {
  let lo = 0.02, hi = 0.98;
  for (let i = 0; i < 50; i++) { const s = (lo + hi) / 2; if (oddsWinOf(total * s, total * (1 - s)) < pHome) lo = s; else hi = s; }
  const s = (lo + hi) / 2; return [total * s, total * (1 - s)];
}
const oddsDerivedMemo = new Map();
function oddsDerived(r) {
  const T = Number.isFinite(r.total) && r.total > 3 ? r.total : ODDS_MLB_TOTAL, key = `${r.pHome.toFixed(4)}|${T}`;
  if (oddsDerivedMemo.has(key)) return oddsDerivedMemo.get(key);
  const [lh, la] = oddsRates(r.pHome, T);
  const m = oddsMargin(lh, la); let home2 = 0, away2 = 0; for (const [d, p] of m) { if (d >= 2) home2 += p; if (d <= -2) away2 += p; }
  const f = oddsMargin(lh * 5 / 9, la * 5 / 9); let fw = 0, fl = 0; for (const [d, p] of f) { if (d > 0) fw += p; else if (d < 0) fl += p; }
  // favourite's -1.5 cover chance, recalibrated: logit(p) = 0.14 + 0.96 * logit(raw) - 0.20 * [home is the favourite]
  const favHome = r.pHome >= 0.5, raw = favHome ? home2 : away2, lg = Math.log(raw / (1 - raw));
  const cal = 1 / (1 + Math.exp(-(0.14 + 0.96 * lg - 0.20 * (favHome ? 1 : 0))));
  const out = { homeRl: favHome ? cal : home2, awayRl: favHome ? away2 : cal, f5Home: fw / (fw + fl) };
  if (oddsDerivedMemo.size > 500) oddsDerivedMemo.clear();
  oddsDerivedMemo.set(key, out); return out;
}
function oddsModelSide(g, mkt, side) {
  const r = oddsModelRead(g);
  if (!r) return '';
  if (mkt === 'ml') { const v = oddsFairAm(side === 'home' ? r.pHome : 1 - r.pHome); return v == null ? '' : oddsFmt(v); }
  if (mkt === 't') return Number.isFinite(r.total) ? `${side === 'over' ? 'o' : 'u'}${r.total.toFixed(1)}` : '';
  const D = oddsDerived(r);
  if (mkt === 'rl') {
    // the model's favourite lays 1.5: P(it wins by 2+); the other side +1.5 is everything else
    const favHome = r.pHome >= 0.5, fav = favHome ? D.homeRl : D.awayRl, isFav = (side === 'home') === favHome;
    const v = oddsFairAm(isFav ? fav : 1 - fav); return v == null ? '' : `${isFav ? '−1.5' : '+1.5'} ${oddsFmt(v)}`;
  }
  if (mkt === 'f5') { const v = oddsFairAm(side === 'home' ? D.f5Home : 1 - D.f5Home); return v == null ? '' : oddsFmt(v); }
  return '';
}
function oddsModelFair(g, mkt) {
  const r = oddsModelRead(g);
  if (!r) return '';
  if (mkt === 'ml') { const fav = r.pHome >= 0.5 ? 'home' : 'away'; const v = oddsFairAm(fav === 'home' ? r.pHome : 1 - r.pHome); return v == null ? '' : `${oddsTeam(g, fav).abbr} ${oddsFmt(v)}`; }
  if (mkt === 't') return Number.isFinite(r.total) ? `o/u ${r.total.toFixed(1)}` : '';
  if (mkt === 'rl' || mkt === 'f5') {
    const fav = r.pHome >= 0.5 ? 'home' : 'away', t = oddsModelSide(g, mkt, fav);
    return t ? `${oddsTeam(g, fav).abbr} ${t}` : '';
  }
  return '';
}
// My books (design/mybooks.js): the books this user starred; nothing is highlighted until they pick some.
const oddsMy = (k) => typeof MyBooks !== 'undefined' && MyBooks.has(k);
const oddsMyCls = (k) => (oddsMy(k) ? ' my-bk' : '');
const oddsMyStar = (k) => (oddsMy(k) ? '<span class="my-bk-star" aria-hidden="true">★</span>' : '');
function oddsMyBooksPicker() {
  if (typeof MyBooks === 'undefined') return '';
  const seen = new Set();
  const list = [...ODDS.books, ...ODDS_BOOKS].filter((b) => b && !ODDS_NOT_BETTABLE.has(b.key) && !seen.has(b.key) && seen.add(b.key));
  return MyBooks.pickerHTML(list);
}
if (typeof MyBooks !== 'undefined') MyBooks.subscribe(() => { ODDS.sheetPaint = 0; oddsRepaint(); });

// ------------------------------------------------------------ the board
function oddsTeam(g, side) { return g?.[side] || { abbr: side === 'home' ? 'Home' : 'Away', name: side === 'home' ? 'Home' : 'Away' }; }
function oddsPick(g, mkt, side, line) {
  if (mkt === 't') return `${side === 'over' ? 'Over' : 'Under'} ${oddsTrim(line)}`;
  const t = oddsTeam(g, side).abbr;
  return mkt === 'ml' ? `${t} ML` : `${t} ${oddsFmtLine(line)}`;
}
function oddsMainTxt(mkt, side, p) {
  if (!p) return '—';
  if (mkt === 'ml') return oddsFmt(p.odds);
  if (mkt === 'rl') return `${oddsFmtLine(p.line)} ${oddsFmt(p.odds)}`;
  return `${side === 'over' ? 'o' : 'u'}${oddsTrim(p.line)} ${oddsFmt(p.odds)}`;
}
// Split for narrow columns: the number on top, the juice underneath.
function oddsTwoLine(mkt, side, p) {
  if (!p) return { main: '—', sub: '' };
  if (mkt === 'ml') return { main: oddsFmt(p.odds), sub: '' };
  if (mkt === 'rl') return { main: oddsFmtLine(p.line), sub: oddsFmt(p.odds) };
  return { main: `${side === 'over' ? 'o' : 'u'}${oddsTrim(p.line)}`, sub: oddsFmt(p.odds) };
}
function oddsSpokenPrice(mkt, side, p) {
  if (!p) return 'no price';
  if (mkt === 'ml') return oddsSpoken(oddsFmt(p.odds));
  if (mkt === 'rl') return `${oddsSpoken(oddsFmtLine(p.line))} at ${oddsSpoken(oddsFmt(p.odds))}`;
  return `${side === 'over' ? 'over' : 'under'} ${oddsTrim(p.line)} at ${oddsSpoken(oddsFmt(p.odds))}`;
}
const ODDS_MKT_WORD = { ml: 'moneyline', rl: 'run line', t: 'total', f5: 'first five innings moneyline' };
const ODDS_MKT_TABS = [['ml', 'Moneyline'], ['rl', 'Run line'], ['t', 'Total'], ['f5', 'First 5']];
// The first five innings is its own set of prices; everything else reads the full-game book.
const oddsBooksFor = (O, mkt) => (mkt === 'f5' ? O?.f5 : O?.books) || {};
const oddsBaseMkt = (mkt) => (mkt === 'f5' ? 'ml' : mkt);
const oddsIsF5 = (mkt) => mkt === 'f5';
// What the bet slip should call this market.
const oddsBetMkt = (mkt) => (mkt === 'f5' ? 'f5ml' : mkt);
// The best price for one side within a given set of books.
function oddsBestIn(books, mkt, side) {
  let best = null;
  for (const [k, L] of Object.entries(books || {})) {
    if (k === 'cons' || k === 'open' || oddsStale(L)) continue;
    const p = oddsQuote(L, mkt, side);
    if (!p?.actionable) continue;
    if (!best || oddsBetter(mkt, side, p, best)) best = { ...p, book: k };
  }
  return best;
}
const oddsWho = (g, mkt, side) => (mkt === 't' ? (side === 'over' ? 'Over' : 'Under') : oddsTeam(g, side).name || oddsTeam(g, side).abbr);
const oddsSides = (mkt) => (mkt === 't' ? ['over', 'under'] : ['away', 'home']);
// The number the market is at: the live consensus before first pitch, the closing price afterwards.
function oddsMktLine(O, pre) {
  return pre ? oddsMarket(O) : { L: O?.close || oddsMarket(O).L, key: O?.close ? 'close' : 'last' };
}
// The market cell. Not a price you can take, so it isn't a button.
function oddsMktCell(g, O, mkt, side, pre) {
  if (g?.state === 'Live') {
    const candidates = [...new Set(['cons', 'pin', 'circa', ...Object.keys(O?.live || {})])];
    const book = candidates.find((k) => oddsLiveQuote(g, O, k, mkt, side)?.actionable) || candidates.find((k) => oddsLiveQuote(g, O, k, mkt, side));
    return oddsLiveCell(g, O, mkt, side, book, null, false);
  }
  const base = oddsBaseMkt(mkt);
  const books = oddsBooksFor(O, mkt);
  const mk = oddsIsF5(mkt) ? { L: books.cons || books.pin || Object.values(books)[0] || null, key: 'market' } : oddsMktLine(O, pre);
  const p = oddsSide(mk.L, base, side);
  const { main, sub } = oddsTwoLine(base, side, p);
  const word = oddsIsF5(mkt) || pre ? 'market' : mk.key === 'close' ? 'close' : 'last price';
  const fl = oddsFlash(g.pk, `m|${mkt}|${side}`);
  const state = pre ? oddsStateLabel(oddsQuote(mk.L, base, side)) : 'Recorded';
  const label = `${oddsWho(g, base, side)} ${ODDS_MKT_WORD[mkt]}, ${word} ${oddsSpokenPrice(base, side, p)}, ${state}. ${pre ? oddsQuoteNote(oddsQuote(mk.L, base, side)) : 'Historical context'}`;
  return `<span class="odds-px na${fl.cls}"${fl.style} data-fk="m${g.pk}${mkt}${side}" title="${esc(label)}" aria-label="${esc(label)}"><span class="num">${esc(main)}</span>${sub ? `<small class="num">${esc(sub)}</small>` : ''}<small>${state}</small></span>`;
}
// The best price anywhere, with the book underneath. Tapping it opens the slip at that book.
function oddsBestCell(g, O, mkt, side, pre) {
  const base = oddsBaseMkt(mkt);
  const best = g?.state === 'Live' ? oddsLiveBest(g, O, mkt, side) : pre ? (oddsIsF5(mkt) ? oddsBestIn(O?.f5, base, side) : oddsBest(O, mkt, side)) : null;
  if (!best) return '<span class="odds-px na">—<small>No fresh price</small></span>';
  const { main } = oddsTwoLine(base, side, best);
  const sub = `${base === 'ml' ? '' : `${oddsFmt(best.odds)} `}${oddsMy(best.book) ? '★' : ''}${oddsBookCode(best.book)}`;
  const fl = oddsFlash(g.pk, `b|${mkt}|${side}`);
  const label = `${oddsWho(g, base, side)} ${ODDS_MKT_WORD[mkt]}, best price ${oddsSpokenPrice(base, side, best)} at ${oddsBookFull(best.book)}.${fl.label} Opens a bet slip.`;
  return oddsHandoff(g,(g.state==='Live'?O.live:oddsBooksFor(O,mkt))?.[best.book],oddsBetMkt(mkt),side,best.book,label,`<button type="button" class="odds-px best${fl.cls}${oddsMyCls(best.book)}"${fl.style} data-fk="b${g.pk}${mkt}${side}" data-odds-bet="${g.pk}|${oddsBetMkt(mkt)}|${side}|${best.book}" aria-label="${esc(label)}"><span class="num">${esc(main)}</span><small class="num">${esc(sub)}</small></button>`);
}
// One book's own price, for the wide table.
function oddsBookCell(g, O, mkt, side, book, best, pre) {
  if (g?.state === 'Live') return oddsLiveCell(g, O, mkt, side, book, best);
  const base = oddsBaseMkt(mkt);
  const L = oddsBooksFor(O, mkt)[book];
  const p = oddsSide(L, base, side);
  if (!p || p.odds == null) return '<span class="odds-px na" aria-hidden="true">—</span>';
  const { main, sub } = oddsTwoLine(base, side, p);
  const q = oddsQuote(L, base, side), canAct = pre && q?.actionable && !ODDS_NOT_BETTABLE.has(book);
  const isBest = !!(canAct && best && (best.book === book || (p.odds === best.odds && (base === 'ml' || p.line === best.line))));   // ties count
  const old = !q?.actionable;
  const fl = oddsFlash(g.pk, `k|${book}|${mkt}|${side}`);
  const label = `${oddsBookFull(book)}, ${oddsWho(g, base, side)} ${oddsSpokenPrice(base, side, p)}${isBest ? ', best price' : ''}${L.m ? `, typed in ${oddsAgo(L.seen)}` : old ? `, last seen ${oddsAgo(L.seen)}` : ''}.${fl.label}${canAct ? ' Opens a bet slip.' : ''} ${pre ? oddsQuoteNote(q) : 'Recorded pregame price.'}`;
  const cls = `odds-px${isBest ? ' best' : ''}${old ? ' old' : ''}${L.m ? ' mine' : ''}${fl.cls}${oddsMyCls(book)}`;
  const inner = `<span class="num">${esc(main)}</span>${sub ? `<small class="num">${esc(sub)}</small>` : ''}<small class="odds-px-state" data-state="${q?.freshness || 'UNVERIFIED'}">${pre ? oddsStateLabel(q) : 'Recorded'}</small>`;
  if (!canAct) return oddsHandoff(g,L,oddsBetMkt(mkt),side,book,label,`<span class="${cls}"${fl.style} title="${esc(label)}" aria-label="${esc(label)}">${inner}</span>`);
  // BetMGM Nevada is the one book this board links into: a real anchor, so one tap goes straight to a
  // prefilled slip. It carries data-mgmbet rather than data-odds-bet, because the odds click handler
  // calls preventDefault on everything it matches, which would kill the navigation.
  if (book === 'mgm') return oddsHandoff(g,L,oddsBetMkt(mkt),side,book,label,`<a class="${cls}"${fl.style} href="api/betmgm/go?g=${encodeURIComponent(g.pk)}&m=${encodeURIComponent(mkt)}&s=${encodeURIComponent(side)}" target="_blank" rel="noopener" data-fk="k${g.pk}${book}${mkt}${side}" data-mgmbet="${g.pk}|${oddsBetMkt(mkt)}|${side}|${book}" aria-label="${esc(label)}, bet at BetMGM">${inner}</a>`);
  return oddsHandoff(g,L,oddsBetMkt(mkt),side,book,label,`<button type="button" class="${cls}"${fl.style} data-fk="k${g.pk}${book}${mkt}${side}" data-odds-bet="${g.pk}|${oddsBetMkt(mkt)}|${side}|${book}" aria-label="${esc(label)}">${inner}</button>`);
}

function oddsSpark(O, g) {
  const pts = (O?.spark?.ml || []).filter((x) => x && x[1] != null);
  if (pts.length < 2) return '';
  const W = 56, H = 18;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
  const ys = pts.map((x) => oddsScale(x[1]));
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
  const X = (t) => (2 + ((t - t0) / (t1 - t0 || 1)) * (W - 4)).toFixed(1);
  const Y = (y) => (hi === lo ? H / 2 : 2 + (1 - (y - lo) / span) * (H - 4)).toFixed(1);
  const d = pts.map((x, i) => `${X(x[0])},${Y(ys[i])}`).join(' ');
  const first = pts[0][1], last = pts[pts.length - 1][1];
  const label = `${oddsTeam(g, 'home').abbr} moneyline since open: ${oddsSpoken(oddsFmt(first))} to ${oddsSpoken(oddsFmt(last))}`;
  return `<svg class="odds-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}"><polyline points="${d}"/><circle cx="${X(pts[pts.length - 1][0])}" cy="${Y(ys[ys.length - 1])}" r="2"/></svg>`;
}
// "Open → now": the favorite's moneyline and the total, with an arrow and a sign so it doesn't lean on color.
function oddsMovement(g, O, pre) {
  const open = O?.open || O?.books?.open || null;
  const now = pre ? oddsMarket(O).L : O?.close || oddsMarket(O).L;
  if (!open || !now) return '';
  const parts = [], spoken = [];
  const hNow = oddsSide(now, 'ml', 'home')?.odds, aNow = oddsSide(now, 'ml', 'away')?.odds;
  if (hNow != null && aNow != null) {
    const side = oddsScale(hNow) >= oddsScale(aNow) ? 'home' : 'away';
    const o = oddsSide(open, 'ml', side)?.odds, n = oddsSide(now, 'ml', side)?.odds;
    if (o != null && n != null) {
      const c = oddsScale(n) - oddsScale(o);
      const arrow = c > 0 ? '▲' : c < 0 ? '▼' : '';
      const t = oddsTeam(g, side).abbr;
      parts.push(`<span>ML ${esc(t)} <span class="num">${esc(oddsFmt(o))} → ${esc(oddsFmt(n))}</span>${c ? ` <span class="odds-mv-d num">${arrow} ${c > 0 ? '+' : ODDS_MINUS}${Math.abs(c)}¢</span>` : ' <span class="odds-mv-d">no change</span>'}</span>`);
      spoken.push(`${t} moneyline ${oddsSpoken(oddsFmt(o))} at open, ${oddsSpoken(oddsFmt(n))} ${pre ? 'now' : 'at the close'}${c ? `, ${Math.abs(c)} cents ${c > 0 ? 'more' : 'less'} favored` : ''}`);
    }
  }
  const to = open.t?.line, tn = now.t?.line;
  if (to != null && tn != null) {
    const c = tn - to;
    parts.push(`<span>Total <span class="num">${oddsTrim(to)} → ${oddsTrim(tn)}</span>${c ? ` <span class="odds-mv-d num">${c > 0 ? '▲ +' : `▼ ${ODDS_MINUS}`}${oddsTrim(Math.abs(c))}</span>` : ' <span class="odds-mv-d">no change</span>'}</span>`);
    spoken.push(`total ${oddsTrim(to)} at open, ${oddsTrim(tn)} ${pre ? 'now' : 'at the close'}`);
  }
  if (!parts.length) return '';
  return `<div class="odds-open" aria-label="${esc(`${pre ? 'Open to now' : 'Open to close'}: ${spoken.join('; ')}.`)}"><span class="odds-open-k" aria-hidden="true">${pre ? 'Open → now' : 'Open → close'}</span><span class="odds-open-v" aria-hidden="true">${parts.join('')}</span></div>`;
}
// Tickets over money, as two thin bars, from the first side's point of view.
function oddsSplitCell(g, O, mkt) {
  const sp = O?.splits?.[mkt];
  if (!sp || (sp.tix == null && sp.money == null)) return '<span class="faint">—</span>';
  const over = mkt === 't';
  const left = over ? 'O' : oddsTeam(g, 'away').abbr, right = over ? 'U' : oddsTeam(g, 'home').abbr;
  // splits are home/over-first; the board reads away/over-first, so flip the team markets
  const v = (x) => (x == null ? null : over ? x : 100 - x);
  const bar = (x, cls) => (x == null ? '' : `<div class="odds-bar2 ${cls}"><i style="width:${Math.max(x, 18)}%">${x}%</i><i>${100 - x}%</i></div>`);
  return `<div class="odds-spl" role="img" aria-label="${esc(`Tickets ${left} ${v(sp.tix)} percent, ${right} ${100 - v(sp.tix)} percent`)}">${bar(v(sp.tix), 'tix')}${bar(v(sp.money), 'mny')}</div>`;
}
function oddsWxCell(O, pre) {
  const w = O?.wx;
  if (!w || !pre) return '<span class="faint">—</span>';
  if (w.roof === 'Dome') return '<span class="odds-wxc">Dome</span>';
  return `<span class="odds-wxc"><b class="${w.wind >= 18 ? 'odds-hot' : ''}">${w.wind}</b> mph${w.dir ? `<br>${esc(w.dir)}` : ''}</span>`;
}

function oddsRowHead(mkt, showBest) {
  const name = { ml: 'Moneyline', rl: 'Run line', t: 'Total', f5: 'First 5 moneyline' }[mkt];
  const mid = showBest ? oddsBookName(ODDS.phoneBook) : 'Recorded';
  return `<div class="odds-brhd${showBest ? '' : ' nb'}" aria-hidden="true"><span>${esc(name)}</span><span>${showBest ? oddsMyStar(ODDS.phoneBook) : ''}${mid}</span>${showBest ? '<span>Best fresh</span>' : ''}</div>`;
}
// One game on a phone: a row per side, then a line of context.
function oddsRow(g, mkt, showBest = true) {
  const O = oddsGame(g.pk);
  const pre = oddsIsPre(g);
  const live = g.state === 'Live' && !isOff(g);
  const [s1, s2] = oddsSides(mkt);
  const lead = g.home?.score > g.away?.score ? 'home' : g.away?.score > g.home?.score ? 'away' : null;
  const side = (tSide, pSide) => {
    const t = oddsTeam(g, tSide);
    const trail = !pre && lead && lead !== tSide;
    return `<div class="odds-br-t${trail ? ' trail' : ''}">${logo(t.id)}<span class="odds-br-n">${esc(t.abbr)}${mkt === 't' ? `<small>${pSide === 'over' ? 'Over' : 'Under'}</small>` : ''}</span><span class="odds-br-s num">${!pre && g[tSide]?.score != null ? g[tSide].score : ''}</span>${showBest && ODDS.phoneBook !== 'cons' ? oddsBookCell(g, O, mkt, pSide, ODDS.phoneBook, null, pre) : oddsMktCell(g, O, mkt, pSide, pre)}${showBest ? oddsBestCell(g, O, mkt, pSide, pre) : ''}</div>`;
  };
  const move = oddsMoveBits(g, O, pre);
  const extra = pre ? oddsRowExtras(g, O) : '';
  const status = pre ? `First pitch ${timeLabel(g.start)}` : gameStatus(g);
  const mf = oddsModelFair(g, mkt);
  const foot = `<button type="button" class="odds-br-f" data-odds-open="${g.pk}" data-fk="o${g.pk}" aria-label="${esc(`${oddsTeam(g, 'away').name} at ${oddsTeam(g, 'home').name}: every book and line history`)}">
    ${mf ? `<span class="mdl-b" title="${esc(ODDS_MODEL_TIP[mkt] || '')}"><i>Model</i><b class="num">${esc(mf)}</b></span><span class="odds-sep"></span>` : ''}<span class="${live ? 'odds-br-live' : ''}">${live ? '<span class="dot"></span>' : ''}${esc(status)}</span>${move ? `<span class="odds-sep"></span>${move}` : ''}${extra}<span class="odds-br-spk">${O && !oddsIsF5(mkt) ? oddsSpark(O, g) : ''}${ICON.chev}</span></button>`;
  return `<div class="odds-br${showBest ? '' : ' nb'}">${side('away', s1)}${side('home', s2)}${foot}</div>`;
}
// "Opened −140 ▲12¢" for the row footer: how far this market has come since it opened.
function oddsMoveBits(g, O, pre) {
  if (g?.state === 'Live') return '<span>Live prices · closing history in details</span>';
  const open = O?.open || O?.books?.open;
  const now = oddsMktLine(O, pre).L;
  if (!open || !now) return '';
  const mkt = ODDS.mkt;
  if (mkt === 'f5') return '';   // the first five has no opener to compare against
  if (mkt === 't') {
    const o = open.t?.line, n = now.t?.line;
    if (o == null || n == null) return '';
    const c = Math.round((n - o) * 10) / 10;
    return `<span>Opened <span class="num">${oddsTrim(o)}</span>${c ? ` <span class="odds-mv-d num">${c > 0 ? '▲ +' : `▼ ${ODDS_MINUS}`}${oddsTrim(Math.abs(c))}</span>` : ''}</span>`;
  }
  const hNow = oddsSide(now, 'ml', 'home')?.odds, aNow = oddsSide(now, 'ml', 'away')?.odds;
  if (hNow == null || aNow == null) return '';
  const fav = oddsScale(hNow) >= oddsScale(aNow) ? 'home' : 'away';
  const o = oddsSide(open, mkt, fav), n = oddsSide(now, mkt, fav);
  if (!o || !n) return '';
  const c = Math.round(oddsScale(n.odds) - oddsScale(o.odds));
  const num = mkt === 'rl' ? `${oddsFmtLine(o.line)} ${oddsFmt(o.odds)}` : oddsFmt(o.odds);
  return `<span>${esc(oddsTeam(g, fav).abbr)} opened <span class="num">${esc(num)}</span>${c ? ` <span class="odds-mv-d num">${c > 0 ? '▲ +' : `▼ ${ODDS_MINUS}`}${Math.abs(c)}¢</span>` : ''}</span>`;
}

// The public count and the wind, where they're worth a glance on a phone.
function oddsRowExtras(g, O) {
  const out = [];
  const sp = O?.splits?.[ODDS.mkt === 'rl' ? 'rl' : ODDS.mkt === 't' ? 't' : 'ml'];
  if (sp?.tix != null) {
    const over = ODDS.mkt === 't';
    const side = sp.tix >= 50 ? (over ? 'Over' : oddsTeam(g, 'home').abbr) : (over ? 'Under' : oddsTeam(g, 'away').abbr);
    out.push(`<span>${Math.max(sp.tix, 100 - sp.tix)}% of tickets on ${esc(side)}</span>`);
  }
  const w = O?.wx;
  if (w?.roof === 'Dome') out.push('<span>Dome</span>');
  else if (w?.wind >= 12) out.push(`<span class="${w.wind >= 18 ? 'odds-hot' : ''}">Wind ${w.wind}${w.dir ? ` ${esc(w.dir)}` : ''}</span>`);
  return out.map((x) => `<span class="odds-sep"></span>${x}`).join('');
}

// The wide board: every book as a column, the way the college football app shows it. Desktop only (CSS).
function oddsBoardTable(games, mkt) {
  if (!games.length) return '';
  const keys = [...new Set(games.flatMap((g) => Object.keys(oddsBooksFor(oddsGame(g.pk), mkt))))].filter((k) => k !== 'cons' && k !== 'open');
  // Every book, always (owner: "all books everywhere"); an unpriced book shows dashes instead of vanishing.
  const all = [...ODDS.books, ...ODDS_BOOKS].map((b) => b.key).filter((k, i, a) => a.indexOf(k) === i && k !== 'cons' && k !== 'open');
  // My books (design/mybooks.js): "My books only" filters the columns; the order is yours, or your books first.
  const books = typeof MyBooks !== 'undefined' && MyBooks.arrange ? MyBooks.arrange(all.map((key) => ({ key }))).map((b) => b.key) : all;
  const [s1, s2] = oddsSides(mkt);
  const head = `<tr><th class="l stk">Matchup</th><th class="mdl-th" title="${esc(ODDS_MODEL_TIP[mkt] || ODDS_MODEL_TIP.ml)}">Model</th><th>Open</th><th>Market</th><th>Move</th>${books.map((k) => `<th data-bk="${esc(k)}" data-bk-move tabindex="0"${oddsMy(k) ? ' class="my-bk"' : ''} title="${esc(oddsBookFull(k))}${oddsMy(k) ? ' · one of my books' : ''} · drag, or Alt+Arrow, to move this column"><span class="odds-bt-bk">${oddsMyStar(k)}${esc(oddsBookName(k))}</span>${oddsBook(k).sharp ? '<span class="odds-sharp" aria-hidden="true">S</span>' : ''}</th>`).join('')}<th>Tickets · money</th><th>Wind</th></tr>`;
  const rows = games.map((g) => {
    const O = oddsGame(g.pk);
    const pre = oddsIsPre(g);
    const live = g.state === 'Live' && !isOff(g);
    const lead = g.home?.score > g.away?.score ? 'home' : g.away?.score > g.home?.score ? 'away' : null;
    const open = (pSide) => {
      const src = oddsIsF5(mkt) ? O?.f5?.open : O?.open || O?.books?.open;
      const p = oddsSide(src, oddsBaseMkt(mkt), pSide);
      const { main } = oddsTwoLine(oddsBaseMkt(mkt), pSide, p);
      return `<span class="odds-px na">${esc(main)}</span>`;
    };
    const tm = (tSide, pSide) => {
      const t = oddsTeam(g, tSide);
      const trail = !pre && lead && lead !== tSide;
      return `<div class="${trail ? 'trail' : ''}">${logo(t.id)}<span class="odds-bt-n">${esc(t.name || t.abbr)}${mkt === 't' ? `<small>${pSide === 'over' ? 'Over' : 'Under'}</small>` : ''}</span><span class="odds-bt-s num">${!pre && g[tSide]?.score != null ? g[tSide].score : ''}</span></div>`;
    };
    const bestOf = (side) => (oddsIsF5(mkt) ? oddsBestIn(O?.f5, 'ml', side) : oddsBest(O, mkt, side));
    const best1 = live ? oddsLiveBest(g, O, mkt, s1) : pre ? bestOf(s1) : null, best2 = live ? oddsLiveBest(g, O, mkt, s2) : pre ? bestOf(s2) : null;
    const move = oddsMoveBits(g, O, pre);
    return `<tr data-odds-open="${g.pk}">
      <td class="l stk"><button type="button" class="odds-bt-mu" data-odds-open="${g.pk}" data-fk="match${g.pk}" aria-label="${esc(oddsTeam(g, 'away').name + ' at ' + oddsTeam(g, 'home').name + ', line history and every book')}"><div class="odds-bt-st">${live ? '<span class="dot"></span>' : ''}<b>${esc(pre ? timeLabel(g.start) : gameStatus(g))}</b></div><div class="odds-bt-tms">${tm('away', s1)}${tm('home', s2)}</div></button></td>
      <td class="mdl-td">${oddsModelRead(g) ? `<div class="odds-st2"><span class="odds-px mdl"><span class="num">${esc(oddsModelSide(g, mkt, s1) || '—')}</span></span><span class="odds-px mdl"><span class="num">${esc(oddsModelSide(g, mkt, s2) || '—')}</span></span></div>` : '<span class="odds-px na" aria-hidden="true">—</span>'}</td>
      <td><div class="odds-st2">${open(s1)}${open(s2)}</div></td>
      <td><div class="odds-st2">${oddsMktCell(g, O, mkt, s1, pre)}${oddsMktCell(g, O, mkt, s2, pre)}</div></td>
      <td><div class="odds-bt-mv">${O && !oddsIsF5(mkt) ? oddsSpark(O, g) : ''}${move || (oddsIsF5(mkt) ? '<span class="faint">—</span>' : '<span class="faint">steady</span>')}</div></td>
      ${books.map((k) => `<td${oddsMy(k) ? ' class="my-bk"' : ''}><div class="odds-st2">${oddsBookCell(g, O, mkt, s1, k, best1, pre)}${oddsBookCell(g, O, mkt, s2, k, best2, pre)}</div></td>`).join('')}
      <td>${oddsSplitCell(g, O, mkt)}</td>
      <td>${oddsWxCell(O, pre)}</td>
    </tr>`;
  }).join('');
  return `<div class="odds-btwrap" tabindex="0" role="region" aria-label="Every sportsbook. Scroll horizontally to compare prices."><table class="odds-bt has-model"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

// ------------------------------------------------------------ line moves, in plain words
function oddsMoveText(mv, g) {
  const tn = (s) => oddsTeam(g, s).name || oddsTeam(g, s).abbr;
  const isOdds = (v) => v != null && Math.abs(v) >= 100;
  const teamSide = mv.dir === 'home' || mv.dir === 'away';
  // Whose numbers are these? The side that got more favored if they moved up, the other side if down.
  let whose = teamSide ? mv.dir : null;
  if (teamSide && isOdds(mv.from) && isOdds(mv.to)) whose = oddsScale(mv.to) >= oddsScale(mv.from) ? mv.dir : oddsOther(mv.dir);
  const num = (v) => (isOdds(v) ? oddsFmt(v) : mv.mkt === 'rl' ? oddsFmtLine(v) : oddsTrim(v));
  const range = mv.from != null && mv.to != null ? ` (${whose ? `${oddsTeam(g, whose).abbr} ` : ''}${num(mv.from)} → ${num(mv.to)})` : '';
  const toward = teamSide ? `the ${tn(mv.dir)}` : `the ${mv.dir}`;
  const n = mv.books?.length >= 3 ? `${mv.books.length} books` : 'Several books';
  const word = ODDS_MKT_WORD[mv.mkt] || 'line';
  if (mv.kind === 'flip') return `New favorite: the ${tn(teamSide ? mv.dir : 'home')}${range}.`;
  if (mv.mkt === 't' && mv.from != null && mv.to != null && !isOdds(mv.from) && !isOdds(mv.to)) {
    const s = `total ${mv.to > mv.from ? 'up' : 'down'} to ${oddsTrim(mv.to)} from ${oddsTrim(mv.from)}`;
    return mv.kind === 'steam' ? `${n} moved the ${s} within 10 minutes.` : `The ${s}.`;
  }
  if (mv.kind === 'steam') return `Steam toward ${toward}: ${n.toLowerCase()} moved the ${word} within 10 minutes${range}.`;
  return `The ${word} moved toward ${toward}${range}.`;
}
const ODDS_KIND = { steam: 'Steam', flip: 'Flip', move: 'Move' };
function oddsMovesHTML(games, limit = isDesk() ? 8 : 4) {
  const onDay = new Map(games.map((g) => [g.pk, g]));
  const list = [...ODDS.moves.values()].filter((m) => onDay.has(Number(m.pk))).sort((a, b) => b.t - a.t);
  const rows = list.slice(0, limit).map((mv) => {
    const g = onDay.get(Number(mv.pk));
    const txt = oddsMoveText(mv, g);
    const who = `${g.away.abbr} @ ${g.home.abbr}`;
    return `<li><button type="button" class="odds-mv" data-odds-open="${g.pk}" data-fk="mv${esc(mv.id)}" aria-label="${esc(`${ODDS_KIND[mv.kind] || 'Move'}, ${who}, ${oddsAgo(mv.t)}: ${oddsSpoken(txt)} Opens every book for this game.`)}">
      <span class="odds-mv-h"><b>${esc(ODDS_KIND[mv.kind] || 'Move')}</b> · ${esc(who)}<span class="faint"> · ${esc(oddsAgo(mv.t))}</span></span>
      <span class="odds-mv-t">${esc(txt)}</span></button></li>`;
  }).join('');
  return `<section class="card odds-moves" aria-label="Line moves">
    <h3 class="sub-h">Line moves<span>${list.length ? `${list.length} today` : ''}</span></h3>
    ${rows ? `<ul>${rows}</ul>${list.length > limit ? `<button type="button" class="odds-more" data-odds-moves>All ${list.length} moves</button>` : ''}` : '<p class="odds-none">No notable moves yet. Steam, favorite flips and big moves show up here.</p>'}
  </section>`;
}
function oddsMovesSheet() {
  const games = oddsDayGames();
  openSheet(`<h2 id="dlgTitle">Line moves</h2><p class="odds-lede">Steam is three or more books moving the same way within 10 minutes. A flip is a new favorite. A move is the market moneyline moving 20 cents or the total moving half a run.</p>${oddsMovesHTML(games, 200)}`, 'odds-moves');
}

// ------------------------------------------------------------ game odds sheet
function oddsOpenSheet(pk) {
  oddsLoadKeys().then((k) => { if (k && ODDS.sheetPk === Number(pk)) oddsSheetPaint(); });
  pk = Number(pk);
  ODDS.sheetPk = pk;
  ODDS.sheetHist = null; ODDS.chartAt = null;
  openSheet(oddsSheetHTML(pk), 'odds');
  ODDS.sheetPaint = Date.now();
  oddsLoadHist(pk);
}
async function oddsLoadHist(pk) {
  try {
    const r = await fetch(`api/odds/${pk}`);
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    if (ODDS.sheetPk !== pk || S.dlgKind !== 'odds') return;
    if (d.odds) oddsPut(d.odds, false);
    ODDS.sheetHist = d.hist || { b: {} };
    ODDS.sheetExtra = { pk, reference: d.reference || null, injuryReport: d.injuryReport || null };
    const x = document.getElementById('oddsExtra'); if (x) x.innerHTML = oddsExtraHTML(pk);
  } catch {
    if (ODDS.sheetPk !== pk) return;
    ODDS.sheetHist = { b: {}, failed: true };
  }
  oddsSheetPaint();
}
// Keep the chart live: add the newest price per book when it differs from the last point.
function oddsHistAppend(h, O) {
  if (!h?.b || !O?.books) return;
  const t = O.at;
  if (!Number.isFinite(t) || t <= 0 || t > serverNow()) return;
  for (const [k, L] of Object.entries(O.books)) {
    const b = h.b[k] || (h.b[k] = {});
    const add = (m, row) => { const a = b[m] || (b[m] = []); const last = a[a.length - 1]; if (!last || last.slice(1).join() !== row.join()) a.push([t, ...row]); };
    if (L.ml) add('ml', [L.ml[0], L.ml[1]]);
    if (L.rl) add('rl', [L.rl.line, L.rl.odds?.[0], L.rl.odds?.[1]]);
    if (L.t) add('t', [L.t.line, L.t.odds?.[0], L.t.odds?.[1]]);
  }
}
function oddsSheetRefresh() {
  if (S.dlgKind !== 'odds' || ODDS.sheetPk == null) return;
  const wait = 50 - (Date.now() - ODDS.sheetPaint);
  if (wait > 0) { if (!ODDS.sheetTimer) ODDS.sheetTimer = setTimeout(() => { ODDS.sheetTimer = 0; oddsSheetRefresh(); }, wait); return; }
  oddsSheetPaint();
}
function oddsSheetPaint() {
  if (S.dlgKind !== 'odds' || ODDS.sheetPk == null) return;
  ODDS.sheetPaint = Date.now();
  const pk = ODDS.sheetPk;
  if (document.activeElement?.id !== 'oddsHistoryCursor') oddsSwap($('#oddsChart'), oddsChartBlock(pk));
  oddsSwap($('#oddsTable'), oddsTableHTML(pk));
  oddsSwap($('#oddsSheetMove'), oddsSheetMoveHTML(pk));
}

// ------------------------------------------------------------ where the money is, weather, key numbers
// Tickets are how many bets; money is how much of the cash. When they disagree, the bigger bets are on the
// side with more money than tickets. Nothing here is a tip; it's what the public count says.
function oddsSplitsHTML(pk) {
  const O = oddsGame(pk), g = S.games.get(pk);
  const sp = O?.splits;
  if (!sp || (!sp.ml && !sp.rl && !sp.t)) return '';
  const bar = (label, leftName, rightName, home) => {
    if (home == null) return '';
    const a = Math.round(home), b = 100 - a;
    return `<div class="odds-sp-row"><span>${esc(label)}</span><div class="odds-bar2" role="img" aria-label="${esc(`${label}: ${leftName} ${a} percent, ${rightName} ${b} percent`)}"><i style="width:${Math.max(a, 16)}%">${esc(leftName)} ${a}%</i><i>${b}% ${esc(rightName)}</i></div></div>`;
  };
  const part = (title, one, leftName, rightName) => (!one ? '' : `<div class="odds-sp"><div class="odds-sp-h">${esc(title)}</div>${bar('Tickets', leftName, rightName, one.tix)}${bar('Money', leftName, rightName, one.money)}</div>`);
  const home = oddsTeam(g, 'home').abbr, away = oddsTeam(g, 'away').abbr;
  const sig = oddsSignals(pk).map((x) => `<p class="odds-signal">${x}</p>`).join('');
  return `<section class="dlg-sec" aria-label="Where the money is"><h3 class="sub-h">Where the money is<span>Public count</span></h3>
    <div class="card odds-splits">${part('Moneyline', sp.ml, home, away)}${part('Run line', sp.rl, home, away)}${part('Total', sp.t, 'Over', 'Under')}
    ${sig || '<p class="odds-signal muted">Tickets and money are saying the same thing here.</p>'}</div></section>`;
}
// Reverse moves and big-bet sides, in plain words.
function oddsSignals(pk) {
  const O = oddsGame(pk), g = S.games.get(pk);
  const sp = O?.splits;
  if (!sp || !g) return [];
  const out = [];
  const name = (side) => oddsTeam(g, side).name || oddsTeam(g, side).abbr;
  const open = O.open, now = oddsMarket(O).L;
  if (sp.ml && open?.ml && now?.ml) {
    const moved = oddsScale(now.ml[0]) - oddsScale(open.ml[0]); // + = home got more favored
    const pub = sp.ml.tix >= 60 ? 'home' : sp.ml.tix <= 40 ? 'away' : null;
    if (pub && Math.abs(moved) >= 10 && ((pub === 'home' && moved < 0) || (pub === 'away' && moved > 0))) {
      const other = pub === 'home' ? 'away' : 'home';
      out.push(`<b>The price is moving against the public.</b> ${pub === 'home' ? sp.ml.tix : 100 - sp.ml.tix}% of tickets are on the ${esc(name(pub))}, yet the ${esc(name(other))} got ${Math.abs(moved)} cents shorter since it opened. That's usually bigger money on the other side.`);
    }
    if (sp.ml.money != null) {
      const gap = sp.ml.money - sp.ml.tix;
      if (Math.abs(gap) >= 12) {
        const side = gap > 0 ? 'home' : 'away';
        out.push(`<b>Bigger bets on the ${esc(name(side))}.</b> ${gap > 0 ? sp.ml.tix : 100 - sp.ml.tix}% of tickets but ${gap > 0 ? sp.ml.money : 100 - sp.ml.money}% of the money.`);
      }
    }
  }
  if (sp.t && open?.t?.line != null && now?.t?.line != null) {
    const d = now.t.line - open.t.line;
    if (sp.t.tix >= 60 && d <= -0.5) out.push(`<b>The total is falling against the public.</b> ${sp.t.tix}% of tickets are on the over, but the number is down ${oddsTrim(Math.abs(d))} from ${oddsTrim(open.t.line)}.`);
    if (sp.t.tix <= 40 && d >= 0.5) out.push(`<b>The total is rising against the public.</b> ${100 - sp.t.tix}% of tickets are on the under, but the number is up ${oddsTrim(d)} from ${oddsTrim(open.t.line)}.`);
  }
  return out;
}
// Wind is the weather that moves a baseball total.
function oddsWxHTML(pk) {
  const O = oddsGame(pk), g = S.games.get(pk);
  const w = O?.wx;
  if (!w || !oddsIsPre(g)) return '';
  if (w.roof === 'Dome') return `<section class="dlg-sec" aria-label="Weather"><h3 class="sub-h">First pitch weather</h3><div class="card odds-wx"><div class="odds-wx-v">Dome</div><p>Indoors: no wind, no rain, nothing to price in.</p></div></section>`;
  const note = w.wind >= 15
    ? `Wind around ${w.wind} mph, gusting to ${w.gust}. Strong wind is the weather that moves a total most; which way depends on whether it's blowing out or in at this park.`
    : w.wind <= 6 ? 'Close to still. Wind isn’t a factor tonight.' : `A light ${w.wind} mph breeze out of the ${esc(w.dir || '')}.`;
  return `<section class="dlg-sec" aria-label="Weather"><h3 class="sub-h">First pitch weather<span>${esc(w.roof === 'Retractable' ? 'Retractable roof' : 'Open air')}</span></h3>
    <div class="card odds-wx"><div class="odds-wx-v"><span class="num">${w.wind}</span><small>mph ${esc(w.dir || '')}</small></div>
    <div class="odds-wx-k">${w.temp != null ? `${w.temp}°` : ''}${w.gust ? ` · gusts ${w.gust}` : ''}${w.pop != null ? ` · ${w.pop}% rain` : ''}</div>
    <p>${note}</p></div></section>`;
}
// Key numbers, measured from last season's finals.
function oddsKeysHTML(pk) {
  const k = ODDS.keys;
  const O = oddsGame(pk);
  if (!k?.n) return '';
  const total = oddsMarket(O).L?.t?.line ?? null;
  const pct = (o, x) => ((o[x] || 0) / k.n) * 100;
  const mx = (o, list) => Math.max(...list.map((x) => o[x] || 0), 1);
  const margins = [1, 2, 3, 4, 5, 6, 7, 8];
  const mMax = mx(k.margin, margins);
  const around = total == null ? [6, 7, 8, 9, 10, 11] : [-2, -1, 0, 1, 2, 3].map((d) => Math.round(total + d - 0.5)).filter((x) => x > 0);
  const tMax = mx(k.total, around);
  const bars = (list, src, max, on) => `<div class="odds-hist">${list.map((x) => `<div class="${on(x) ? 'on' : ''}" title="${x}: ${pct(src, x).toFixed(1)}%"><i style="height:${((src[x] || 0) / max) * 100}%"></i><span>${x}</span></div>`).join('')}</div>`;
  const oneRun = pct(k.margin, 1).toFixed(1);
  const whole = total != null && Number.isInteger(total);
  const lands = total == null ? ''
    : whole ? ` This total sits on ${oddsTrim(total)}, which came up in ${pct(k.total, total).toFixed(1)}% of games last season — those are the pushes.`
    : ` ${oddsTrim(Math.floor(total))} came up in ${pct(k.total, Math.floor(total)).toFixed(1)}% of games and ${oddsTrim(Math.ceil(total))} in ${pct(k.total, Math.ceil(total)).toFixed(1)}%, so the hook here is worth shopping.`;
  return `<section class="dlg-sec" aria-label="Key numbers"><h3 class="sub-h">Key numbers<span>${k.season} finals</span></h3>
    <div class="card odds-keys">
      <div class="odds-keys-h">Winning margin</div>${bars(margins, k.margin, mMax, (x) => x === 1)}
      <p><b>${oneRun}% of games were decided by one run</b> last season, out of ${k.n.toLocaleString()}. That's why the run line sits at 1.5: the favourite laying it has to win by two.</p>
      <div class="odds-keys-h">Combined runs</div>${bars(around, k.total, tMax, (x) => total != null && (x === Math.floor(total) || x === Math.ceil(total)))}
      <p>Odd totals land more often than the even ones beside them, because an odd total means an odd winning margin, and one-run games are the most common result of all.${lands}</p>
    </div></section>`;
}
// The first five innings, book by book, and what each team is priced to score on its own.
function oddsFiveHTML(pk) {
  const O = oddsGame(pk), g = S.games.get(pk);
  const f5 = O?.f5, tt = O?.tt;
  if (!f5 && !tt) return '';
  const home = oddsTeam(g, 'home'), away = oddsTeam(g, 'away');
  const order = [...ODDS.books, ...ODDS_BOOKS].map((b) => b.key).filter((k, i, a) => a.indexOf(k) === i);
  const keys = f5 ? ['cons', ...order.filter((k) => k !== 'cons' && k !== 'open' && f5[k])].filter((k) => f5[k]) : [];
  const best = (m, side) => oddsBestIn(f5, m, side);
  const cell = (k, m, side) => {
    const p = oddsSide(f5[k], m, side);
    if (!p || p.odds == null) return '<span class="odds-px na" aria-hidden="true">—</span>';
    const { main, sub } = oddsTwoLine(m, side, p);
    const b = best(m, side);
    const isBest = oddsIsPre(g) && k !== 'cons' && !!b && (b.book === k || (p.odds === b.odds && (m === 'ml' || p.line === b.line)) && !!oddsQuote(f5[k], m, side)?.actionable);
    const who = m === 't' ? (side === 'over' ? 'Over' : 'Under') : oddsTeam(g, side).name;
    const label = `${oddsBookFull(k)}, first five innings, ${who} ${oddsSpokenPrice(m, side, p)}${isBest ? ', best price' : ''}. Opens a bet slip.`;
    const q = oddsQuote(f5[k], m, side);
    if (!oddsIsPre(g) || !q?.actionable || ODDS_NOT_BETTABLE.has(k)) return `<span class="odds-px na" title="${esc(oddsQuoteNote(q))}"><span class="num">${esc(main)}</span>${sub ? `<small class="num">${esc(sub)}</small>` : ''}<small>${oddsIsPre(g) ? oddsStateLabel(q) : 'Recorded'}</small></span>`;
    return oddsHandoff(g,f5[k],'f5'+m,side,k,label,`<button type="button" class="odds-px${isBest ? ' best' : ''}" data-odds-bet="${pk}|f5${m}|${side}|${k}" aria-label="${esc(label)}"><span class="num">${esc(main)}</span>${sub ? `<small class="num">${esc(sub)}</small>` : ''}</button>`);
  };
  const rows = keys.map((k) => `<tr><td><div class="odds-bk">${esc(oddsBookName(k))}</div></td><td>${cell(k, 'ml', 'away')}</td><td>${cell(k, 'ml', 'home')}</td><td>${cell(k, 'rl', 'away')}</td><td>${cell(k, 'rl', 'home')}</td><td>${cell(k, 't', 'over')}</td><td>${cell(k, 't', 'under')}</td></tr>`).join('');
  const ttCards = tt ? ['away', 'home'].filter((sd) => tt[sd]?.pts != null).map((sd) => `<div><div class="odds-tt-k">${esc(oddsTeam(g, sd).abbr)} team total</div><div class="odds-tt-v num">${oddsTrim(tt[sd].pts)}</div><div class="odds-tt-x">o ${esc(oddsFmt(tt[sd].over))} · u ${esc(oddsFmt(tt[sd].under))}</div></div>`).join('') : '';
  return `<section class="dlg-sec" aria-label="First five innings and team totals"><h3 class="sub-h">First five innings<span>${keys.length ? `${keys.length} books` : 'Team totals'}</span></h3>
    ${rows ? `<div class="card odds-f5"><table class="odds-f5t"><thead><tr><th>Book</th><th>${esc(away.abbr)} ML</th><th>${esc(home.abbr)} ML</th><th>${esc(away.abbr)} RL</th><th>${esc(home.abbr)} RL</th><th>Over</th><th>Under</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="odds-note">ML = moneyline · RL = run line; PK is a zero run line. First five innings settles on the score after five complete innings. If the game is called before that, these bets are void.</p></div>` : ''}
    ${ttCards ? `<div class="odds-tt">${ttCards}</div>` : ''}</section>`;
}

// A number you saw at a window. Private to this device.
function oddsCounterHTML(pk) {
  const g = S.games.get(pk);
  const mine = ODDS.manual[pk] || {};
  const books = [...ODDS.books, ...ODDS_BOOKS].filter((b, i, a) => a.findIndex((x) => x.key === b.key) === i).filter((b) => b.nv || b.sharp);
  const pick = ODDS.counterBook && books.some((b) => b.key === ODDS.counterBook) ? ODDS.counterBook : books[0]?.key;
  const have = Object.entries(mine).map(([k, L]) => `<li><span class="tag">${esc(oddsBookName(k))}</span><span class="num">${L.ml ? `${oddsFmt(L.ml[0])} / ${oddsFmt(L.ml[1])}` : ''}${L.t ? ` · o/u ${oddsTrim(L.t.line)}` : ''}</span><span class="faint">${esc(oddsAgo(L.seen))}</span><button type="button" class="odds-more" data-odds-mdel="${pk}|${k}">Remove</button></li>`).join('');
  return `<section class="dlg-sec" aria-label="Add a number you saw"><h3 class="sub-h">Standing at a window?<span>Only you see these</span></h3>
    <div class="card odds-counter">
      <p class="odds-lede">Type what the board says. It shows on your board with a marker until that book's feed reports something newer.</p>
      <div class="chips">${books.map((b) => `<button type="button" class="chip" data-odds-mbook="${b.key}" aria-pressed="${b.key === pick}">${esc(b.short)}</button>`).join('')}</div>
      <div class="fgrid">
        <label class="fld">${esc(oddsTeam(g, 'home').abbr)} moneyline<input class="inp" id="mMlHome" inputmode="text" autocomplete="off" placeholder="-145"></label>
        <label class="fld">${esc(oddsTeam(g, 'away').abbr)} moneyline<input class="inp" id="mMlAway" inputmode="text" autocomplete="off" placeholder="+125"></label>
        <label class="fld">Total<input class="inp" id="mTotal" inputmode="decimal" autocomplete="off" placeholder="8.5"></label>
        <label class="fld">Over / under juice<input class="inp" id="mOver" inputmode="text" autocomplete="off" placeholder="-115"></label>
      </div>
      <div class="err" id="mErr" role="alert"></div>
      <button type="button" class="btn" data-odds-msave="${pk}">Save this number</button>
      ${have ? `<ul class="odds-mine">${have}</ul>` : ''}
    </div></section>`;
}

function oddsSheetHTML(pk) {
  const g = S.games.get(pk);
  const away = oddsTeam(g, 'away'), home = oddsTeam(g, 'home');
  const pre = oddsIsPre(g);
  const O = oddsGame(pk);
  const nv = oddsBookKeys(O).filter((k) => ODDS_NV_LINK[k]);
  const links = (nv.length ? nv : Object.keys(ODDS_NV_LINK)).map((k) => `<a class="lbtn odds-nv" href="${ODDS_NV_LINK[k]}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(oddsBookFull(k))} Nevada sportsbook in a new tab">${esc(oddsBookName(k))} ↗</a>`).join('');
  return `<div class="odds-sheet">
    <div class="odds-sh-head">
      <div class="odds-sh-teams">${g ? `${logo(away.id)}${logo(home.id)}` : ''}</div>
      <div style="min-width:0"><h2 id="dlgTitle">${esc(away.name || away.abbr)} at ${esc(home.name || home.abbr)}</h2>
      <p class="muted odds-sh-sub">${g ? esc(pre ? `First pitch ${timeLabel(g.start)}` : gameStatus(g)) : ''}${g?.venue?.name ? ` · ${esc(g.venue.name)}` : ''}</p></div>
    </div>
    <div id="oddsSheetMove">${oddsSheetMoveHTML(pk)}</div>
    <section class="dlg-sec" aria-label="Line history"><div id="oddsChart">${oddsChartBlock(pk)}</div></section>
    <section class="dlg-sec" aria-label="Every book"><div id="oddsTable">${oddsTableHTML(pk)}</div></section>
    ${oddsFiveHTML(pk)}
    ${oddsSplitsHTML(pk)}
    ${oddsWxHTML(pk)}
    <div id="oddsExtra">${oddsExtraHTML(pk)}</div>
    ${oddsKeysHTML(pk)}
    ${pre ? oddsCounterHTML(pk) : ''}
    <section class="dlg-sec" aria-label="Nevada sportsbooks">
      <h3 class="sub-h">Open a Nevada book<span>For use in Nevada</span></h3>
      <div class="links odds-links">${links}</div>
    </section>
    ${g ? `<div class="links"><button type="button" class="lbtn" data-game="${pk}">Scores and every at-bat</button></div>` : ''}
    <p class="odds-note">Source clocks determine quote status. A recent app check does not make an old price current. Recorded prices remain available as historical context.</p>
  </div>`;
}
// Injury report (full league list and injured-list moves) and each book's opener and close (server: shared/injuries.js,
// shared/reference-lines.js). Moneyline only, which is what the MLB board prices.
function oddsExtraHTML(pk) {
  const X = ODDS.sheetExtra; if (!X || X.pk !== pk) return '';
  const g = S.games.get(pk), away = oddsTeam(g, 'away'), home = oddsTeam(g, 'home');
  const parts = [];
  const R = X.injuryReport;
  if (R && (R.away?.length || R.home?.length || R.ilMoves)) {
    const side = (s, t) => {
      const rows = (R[s] || []).slice(0, 12), moves = (R.ilMoves?.[s] || []).slice(0, 4);
      return `<div><h4 class="sub-h">${esc(t.abbr || t.name || s)}</h4>${rows.length ? rows.map((r) => `<p class="inj-r"><b>${esc(r.status || '')}</b> ${esc(r.name)}${r.pos ? ` <small>${esc(r.pos)}</small>` : ''}${r.comment ? `<br><small>${esc(r.comment)}</small>` : ''}</p>`).join('') : '<p class="muted">No one listed.</p>'}${moves.map((m) => `<p class="inj-r"><small>${esc(m.date || '')} · ${esc(m.text)}</small></p>`).join('')}</div>`;
    };
    parts.push(`<section class="dlg-sec" aria-label="Injury report"><h3 class="sub-h">Injury report<span>Full league list and injured-list moves</span></h3><div class="odds-inj">${side('away', away)}${side('home', home)}</div></section>`);
  }
  const F = X.reference;
  if (F && typeof LinesBoard !== 'undefined') {
    const O = oddsGame(pk), cur = oddsIsPre(g) ? (O?.books || {}) : {};
    const keys = [...new Set([...Object.keys(F.open || {}), ...Object.keys(F.close || {})])];
    const q = (M, i = 0) => (M && M.prices ? { line: M.line ?? null, price: M.prices[i] ?? null, pHome: LinesBoard.noVig(M.prices), at: M.observed_at?.[i] || null } : null);
    const now = (L, m) => {
      if (!L) return null;
      if (m === 's') return L.rl?.line == null ? null : { line: L.rl.line, price: L.rl.odds?.[0] ?? null };
      if (m === 't') return L.t?.line == null ? null : { line: L.t.line, price: L.t.odds?.[0] ?? null };
      const p = LinesBoard.noVig(L.ml); return p == null ? null : { price: L.ml[0], pHome: p };
    };
    const rows = (m) => keys.map((k) => ({ key: k, name: oddsBookFull(k), open: q(F.open?.[k]?.[m]), now: now(cur[k], m), close: q(F.close?.[k]?.[m]) })).filter((r) => r.open || r.close);
    parts.push(LinesBoard.html(`m${pk}`, { home: home.abbr || home.name, away: away.abbr || away.name, history: F.history || null, start: Date.parse(g?.start),
      markets: { ml: { label: 'Moneyline', rows: rows('ml') }, s: { label: 'Run line', rows: rows('s') }, t: { label: 'Total', rows: rows('t') } } }));
  }
  return parts.join('');
}
function oddsSheetMoveHTML(pk) {
  const g = S.games.get(pk), O = oddsGame(pk);
  if (!O) return '';
  return oddsMovement(g, O, oddsIsPre(g));
}

// The chart uses only recorded observations. A receipt timestamp is never called a source quote time.
const ODDS_CHART_MKTS = [['ml', 'Moneyline'], ['rl', 'Run line'], ['t', 'Total']];
function oddsHistorySeries(h, mkt) {
  const validOdds = (o) => Number.isFinite(o) && Math.abs(o) >= 100;
  return Object.entries(h?.b || {}).filter(([k]) => k !== 'open').map(([k, b]) => ({ k,
    pts: (b?.[mkt] || []).filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && r[0] > 0 && r[0] <= serverNow() && (mkt === 'ml' ? validOdds(r[1]) : Number.isFinite(r[1]) && validOdds(r[2])))
      .map((r) => ({ at: r[0], value: mkt === 'ml' ? oddsScale(r[1]) : r[1], line: mkt === 'ml' ? null : r[1], odds: mkt === 'ml' ? r[1] : r[2], opposite: mkt === 'ml' ? r[2] : r[3] }))
      .sort((a, b) => a.at - b.at),
  })).filter((s) => s.pts.length);
}
function oddsHistorySelection(series) {
  const one = series.find((s) => s.k === ODDS.chartBook) || series.find((s) => s.k === 'cons') || series[0];
  if (!one) return null;
  let index = one.pts.length - 1;
  if (Number.isFinite(ODDS.chartAt)) { index = one.pts.findLastIndex((p) => p.at <= ODDS.chartAt); if (index < 0) index = 0; }
  return { one, index, point: one.pts[index] };
}
function oddsObservationText(sel, mkt, g) {
  if (!sel) return '';
  const p = sel.point, side = mkt === 't' ? 'over' : 'home';
  const when = new Date(p.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
  const who = mkt === 't' ? 'Over' : oddsTeam(g, 'home').abbr;
  const opposite = Number.isFinite(p.opposite) && Math.abs(p.opposite) >= 100 ? ` · ${mkt === 't' ? 'Under' : oddsTeam(g, 'away').abbr} ${oddsFmt(p.opposite)}` : '';
  return `${oddsBookFull(sel.one.k)} · ${who} ${oddsMainTxt(mkt, side, p)}${opposite}. Recorded ${when}. Observation ${sel.index + 1} of ${sel.one.pts.length}.`;
}
function oddsChartBlock(pk) {
  const h = ODDS.sheetHist, g = S.games.get(pk), mkt = ODDS.chartMkt;
  const seg = `<div class="seg odds-chart-seg" role="group" aria-label="History market">${ODDS_CHART_MKTS.map(([k, l]) => `<button type="button" data-odds-chart="${k}" data-fk="ch${k}" aria-pressed="${mkt === k}">${l}</button>`).join('')}</div>`;
  const head = `<h3 class="sub-h">Price history<span>${mkt === 't' ? 'Total runs' : esc(oddsTeam(g, 'home').abbr) + (mkt === 'rl' ? ' run line' : ' moneyline')}</span></h3>${seg}`;
  if (!h) return `${head}<div class="odds-chart-empty" role="status">Loading recorded observations…</div>`;
  const series = oddsHistorySeries(h, mkt), sel = oddsHistorySelection(series);
  if (!sel) return `${head}<div class="odds-chart-empty">${h.failed ? 'History could not be loaded.' : 'No recorded observations for this market yet.'}${h.failed ? '<button type="button" class="lbtn" data-odds-history-retry>Retry history</button>' : ''}</div>`;
  return `${head}<div class="odds-chart-panel"><div class="odds-history-controls"><label>Sportsbook<select id="oddsHistoryBook" data-fk="historybook">${series.map((s) => `<option value="${esc(s.k)}"${s.k === sel.one.k ? ' selected' : ''}>${esc(oddsBookName(s.k))} · ${s.pts.length} observation${s.pts.length === 1 ? '' : 's'}</option>`).join('')}</select></label><span>${series.length} recorded sources</span></div>
    ${oddsChartSVG(h, oddsGame(pk), g, mkt, chartW())}
    <label class="odds-history-scrub">Explore observations<input type="range" id="oddsHistoryCursor" data-fk="historycursor" min="0" max="${sel.one.pts.length - 1}" step="1" value="${sel.index}"${sel.one.pts.length === 1 ? ' disabled' : ''} aria-label="Recorded price observation" aria-valuetext="${esc(oddsObservationText(sel, mkt, g))}"></label>
    <p class="odds-observation" id="oddsObservation" aria-live="polite">${esc(oddsObservationText(sel, mkt, g))}</p>
    <p class="odds-history-note">Times are app records. Historical source quote timestamps are unavailable. Lines stop at their last observation.${mkt === 'rl' ? ' Run line changes are shown in runs; price is listed with each observation.' : ''}</p></div>`;
}
function oddsChartSVG(h, O, g, mkt, width) {
  const series = oddsHistorySeries(h, mkt), sel = oddsHistorySelection(series);
  if (!sel) return '';
  const W = Math.max(270, width || 600), H = W < 500 ? 210 : 238, left = 46, right = 22, top = 20, bottom = 30;
  const all = series.flatMap((s) => s.pts), first = Math.min(...all.map((p) => p.at)), last = Math.max(...all.map((p) => p.at));
  const x0 = first === last ? first - 60e3 : first, x1 = first === last ? last + 60e3 : last;
  let lo = Math.min(...all.map((p) => p.value)), hi = Math.max(...all.map((p) => p.value));
  const minSpan = mkt === 'ml' ? 20 : 1;
  if (hi - lo < minSpan) { const mid = (lo + hi) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  const pad = (hi - lo) * .15; lo -= pad; hi += pad;
  const X = (t) => (left + (t - x0) / (x1 - x0) * (W - left - right)).toFixed(1);
  const Y = (v) => (top + (1 - (v - lo) / (hi - lo)) * (H - top - bottom)).toFixed(1);
  const fmt = (v) => mkt === 'ml' ? oddsFmt(oddsUnscale(v)) : mkt === 'rl' ? oddsFmtLine(v) : oddsTrim(v);
  const step = mkt === 'ml' ? [5, 10, 20, 50, 100].find((n) => (hi - lo) / n <= 4) || 100 : [0.5, 1, 2, 5, 10].find((n) => (hi - lo) / n <= 4) || 10;
  const ticks = []; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const grid = ticks.map((v) => `<line class="gl" x1="${left}" x2="${W - right}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${left - 8}" y="${+Y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`).join('');
  const path = (pts) => pts.map((p, i) => i ? `H${X(p.at)} V${Y(p.value)}` : `M${X(p.at)},${Y(p.value)}`).join(' ');
  const lines = [...series].sort((a, b) => Number(a.k === sel.one.k) - Number(b.k === sel.one.k)).map((s) => `<path class="ln ${s.k === sel.one.k ? 't2' : 't0'}" d="${path(s.pts)}"><title>${esc(oddsBookFull(s.k))}</title></path>`).join('');
  const dots = sel.one.pts.map((p, i) => `<circle class="odds-history-point${i === sel.index ? ' selected' : ''}" data-history-point="${i}" cx="${X(p.at)}" cy="${Y(p.value)}" r="${i === sel.index ? 4.5 : 2.5}"/>`).join('');
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `<svg class="odds-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${oddsBookFull(sel.one.k)} recorded ${mkt === 'ml' ? 'moneyline' : mkt === 'rl' ? 'run line' : 'total'}. ${sel.one.pts.length} observations. ${oddsObservationText(sel, mkt, g)}`)}">${grid}${lines}<line class="odds-history-line" id="oddsHistoryLine" x1="${X(sel.point.at)}" x2="${X(sel.point.at)}" y1="${top}" y2="${H - bottom}"/>${dots}<text class="ax" x="${left}" y="${H - 6}">${esc(time(first))}</text><text class="ax" x="${W - right}" y="${H - 6}" text-anchor="end">${esc(time(last))}</text></svg>`;
}
function oddsHistoryScrub(index) {
  const series = oddsHistorySeries(ODDS.sheetHist, ODDS.chartMkt), sel = oddsHistorySelection(series);
  if (!sel) return;
  const n = Math.max(0, Math.min(sel.one.pts.length - 1, Math.round(Number(index) || 0)));
  ODDS.chartAt = sel.one.pts[n].at;
  const next = { one: sel.one, index: n, point: sel.one.pts[n] };
  const text = oddsObservationText(next, ODDS.chartMkt, S.games.get(ODDS.sheetPk));
  const readout = $('#oddsObservation'); if (readout) readout.textContent = text;
  $('#oddsHistoryCursor')?.setAttribute('aria-valuetext', text);
  const points = document.querySelectorAll('[data-history-point]');
  points.forEach((p) => { const selected = Number(p.dataset.historyPoint) === n; p.classList.toggle('selected', selected); p.setAttribute('r', selected ? '4.5' : '2.5'); if (selected) { const x = p.getAttribute('cx'); $('#oddsHistoryLine')?.setAttribute('x1', x); $('#oddsHistoryLine')?.setAttribute('x2', x); } });
}

// Every book: moneyline, run line and total, best price marked, price age when it's over 5 minutes.
function oddsLiveTableHTML(pk) {
  const O = oddsGame(pk), g = S.games.get(Number(pk));
  if (g?.state !== 'Live') return '';
  const books = Object.keys(O?.live || {}).filter((k) => !ODDS_NOT_BETTABLE.has(k));
  const cells = (book, mkt, sides) => sides.map((side) => oddsLiveCell(g, O, mkt, side, book, oddsLiveBest(g, O, mkt, side))).join('');
  return `<h3 class="sub-h">Live prices<span>Source-verified prices only</span></h3><p class="odds-note">Top: away / over · bottom: home / under. Unavailable prices cannot prefill a ticket. Pregame closing history stays below.</p>${books.length ? `<div class="card odds-tbl-wrap"><table class="odds-tbl"><thead><tr><th scope="col">Book</th><th scope="col">Money</th><th scope="col">Run line</th><th scope="col">Total</th></tr></thead><tbody>${books.map((book) => `<tr><th scope="row">${esc(oddsBookName(book))}</th><td>${cells(book, 'ml', ['away', 'home'])}</td><td>${cells(book, 'rl', ['away', 'home'])}</td><td>${cells(book, 't', ['over', 'under'])}</td></tr>`).join('')}</tbody></table></div>` : '<p class="odds-none">Live quotes unavailable.</p>'}`;
}
function oddsTableHTML(pk) {
  const O = oddsGame(pk), g = S.games.get(pk);
  if (!O) return '<h3 class="sub-h">Every book</h3><div class="odds-chart-empty">No prices for this game yet.</div>';
  const pre = oddsIsPre(g);
  const keys = [...(O.books?.cons ? ['cons'] : []), ...(O.open || O.books?.open ? ['open'] : []), ...oddsBookKeys(O)];
  const best = {};
  for (const mkt of ['ml', 'rl', 't']) for (const s of mkt === 't' ? ['over', 'under'] : ['away', 'home']) best[`${mkt}|${s}`] = pre ? oddsBest(O, mkt, s) : null;
  const away = oddsTeam(g, 'away'), home = oddsTeam(g, 'home');
  const cell = (k, L, mkt, side) => {
    const p = oddsSide(L, mkt, side);
    if (!p || p.odds == null) return '<span class="odds-tp na" aria-label="No price">—</span>';
    const txt = mkt === 'ml' ? oddsFmt(p.odds) : mkt === 'rl' ? `${oddsFmtLine(p.line)} ${oddsFmt(p.odds)}` : `${side === 'over' ? 'o' : 'u'}${oddsTrim(p.line)} ${oddsFmt(p.odds)}`;
    const b = best[`${mkt}|${side}`];
    const isBest = !!b && (b.book === k || (k !== 'cons' && k !== 'open' && p.odds === b.odds && (mkt === 'ml' || p.line === b.line) && !!oddsQuote(L, mkt, side)?.actionable));
    const who = mkt === 't' ? (side === 'over' ? 'Over' : 'Under') : (side === 'home' ? home : away).abbr;
    const fl = oddsFlash(pk, `k|${k}|${mkt}|${side}`);
    const spoken = `${oddsBookFull(k)}, ${who} ${ODDS_MKT_WORD[mkt]} ${oddsSpokenPrice(mkt, side, p)}${isBest ? ', best price' : ''}.${fl.label}`;
    const q = oddsQuote(L, mkt, side), state = k === 'open' || !pre ? 'Recorded' : oddsStateLabel(q);
    if (!pre || ODDS_NOT_BETTABLE.has(k) || !q?.actionable) return oddsHandoff(g,L,mkt,side,k,spoken,`<span class="odds-tp na${isBest ? ' best' : ''}${fl.cls}"${fl.style} role="img" title="${esc(oddsQuoteNote(q))}" aria-label="${esc(spoken + ' ' + state)}"><span class="num">${esc(txt)}</span><small>${state}</small></span>`);
    return oddsHandoff(g,L,mkt,side,k,spoken,`<button type="button" class="odds-tp${isBest ? ' best' : ''}${fl.cls}"${fl.style} data-fk="t${k}${mkt}${side}" data-odds-bet="${pk}|${mkt}|${side}|${k}" aria-label="${esc(`${spoken} Opens a bet slip.`)}"><span class="num">${esc(txt)}</span><small>${isBest ? 'Best · fresh' : 'Fresh'}</small></button>`);
  };
  const rows = keys.map((k) => {
    const L = k === 'open' ? O.open || O.books?.open : O.books[k];
    const type = ODDS_NOT_BETTABLE.has(k) ? (k === 'cons' ? 'Average' : 'Where it started') : oddsBookType(k);
    const age = oddsAgeMin(L?.seen);
    const ageTxt = !ODDS_NOT_BETTABLE.has(k) && age != null && age > 5 ? `${age < 120 ? `${age} min` : `${Math.round(age / 60)} hr`} old` : '';
    return `<tr class="${ODDS_NOT_BETTABLE.has(k) ? 'ref' : ''}${oddsStale(L) ? ' stale' : ''}">
      <th scope="row"><b>${esc(oddsBookName(k))}</b>${type ? `<span>${esc(type)}</span>` : ''}${ageTxt ? `<em>${esc(ageTxt)}</em>` : ''}</th>
      <td>${cell(k, L, 'ml', 'away')}${cell(k, L, 'ml', 'home')}</td>
      <td>${cell(k, L, 'rl', 'away')}${cell(k, L, 'rl', 'home')}</td>
      <td>${cell(k, L, 't', 'over')}${cell(k, L, 't', 'under')}</td>
    </tr>`;
  }).join('');
  return `${oddsLiveTableHTML(pk)}<h3 class="sub-h">${pre ? 'Every book' : 'Pregame closing context'}<span>${pre ? `Top: ${esc(away.abbr)} / over · bottom: ${esc(home.abbr)} / under` : 'Last prices before first pitch'}</span></h3>
    <div class="card odds-tbl-wrap"><table class="odds-tbl">
      <thead><tr><th scope="col">Book</th><th scope="col">Money</th><th scope="col">Run line</th><th scope="col">Total</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

// ------------------------------------------------------------ Edge Finder MLB
/* How each book's price compares with the sharp price, honestly (ported from Hook & Ladder's edge.js).

   The sharp price is Pinnacle's (else Circa's) with the bookmaker's cut removed, and only when that book listed it in
   the last 10 minutes. If neither is fresh, there is no comparison: the market consensus is never used as "fair".
   MLB v1 compares only at the same number (the same run line, the same total). Moneylines remove the cut with the
   power method (proportional removal flatters underdogs).

   Gap = expected return per $1 at that price if the sharp price is right: P(win) × decimal odds + P(push) − 1,
   where P(win) is the no-vig chance conditional on no push and P(push), for a whole-number total, is how often
   last season's games landed on exactly that number.
     Solid      the gap is at least twice its uncertainty AND the other books agree (still +1% against their median).
     Thin       the gap is bigger than its uncertainty and the other books don't contradict it.
     Weak read  everything else. Hidden unless you ask for it.
   Presentation: sorted by first pitch, whole percentages, no stakes, no alerts; rows open the game odds sheet. */
const ODDS_EDGE_MIN = 0.01;          // shown from +1%
const ODDS_EDGE_MAX = 0.12;          // above this it's almost always a stale or broken price
const ODDS_EDGE_ML_LONG = 500;       // skip moneylines longer than +500
const ODDS_EDGE_SRC = ['pin', 'circa'];
const ODDS_SHARP_FRESH = 10 * 60e3;
const ODDS_PUSH_T = 0.085;           // fallback until last season's finals are loaded
// A whole-number total pushes when the game lands exactly on it, and that chance is not the same at 7 as at 11.
// Measured from last season's finals (/api/keys) rather than assumed; the flat number is only a fallback.
function oddsPushT(line) {
  const k = ODDS.keys;
  const n = k?.n ? k.n : 0;
  const hit = n ? Number(k.total?.[String(line)]) || 0 : 0;
  return n > 500 ? hit / n : ODDS_PUSH_T;
}
const ODDS_MKTS = ['ml', 'rl', 't'];
// First-five markets price off the first-five book, with the same maths as the full game.
const ODDS_F5_BASE = { f5ml: 'ml', f5rl: 'rl', f5t: 't' };
const oddsBase = (mkt) => ODDS_F5_BASE[mkt] || mkt;
const oddsSetFor = (O, mkt) => (ODDS_F5_BASE[mkt] ? O?.f5 : O?.books) || {};
const ODDS_CONF = { solid: 'Solid', thin: 'Thin', weak: 'Weak read' };

// Chance for side A with the cut removed. Moneylines: power method, find k with pA^k + pB^k = 1.
function oddsNoVig(mkt, a, b) {
  const pa = oddsImp(a), pb = oddsImp(b);
  if (!(pa > 0 && pb > 0 && pa < 1 && pb < 1)) return null;
  if (mkt !== 'ml') return pa / (pa + pb);
  let lo = 0.5, hi = 4;
  for (let i = 0; i < 50; i++) { const k = (lo + hi) / 2; if (pa ** k + pb ** k > 1) lo = k; else hi = k; }
  return pa ** ((lo + hi) / 2);
}
function oddsSharp(O, mkt) {
  const base = oddsBase(mkt);
  const set = oddsSetFor(O, mkt);
  const [a, b] = base === 't' ? ['over', 'under'] : ['home', 'away'];
  for (const k of ODDS_EDGE_SRC) {
    const L = set[k];
    const q = oddsQuote(L, base, a), age = q?.seen ? serverNow() - q.seen : null;
    if (!oddsPairFresh(L, base) || age == null || age > ODDS_SHARP_FRESH) continue; // sharp prices must be recent
    const pa = oddsSide(L, base, a), pb = oddsSide(L, base, b);
    if (!pa || !pb || pa.odds == null || pb.odds == null) continue;
    if (base !== 'ml' && pa.line == null) continue;
    const p = oddsNoVig(base, pa.odds, pb.odds);
    if (p == null) continue;
    return { book: k, line: pa.line, p, sideA: a, age };
  }
  return null;
}
// Median no-vig chance for this side among the other fresh books hanging this exact number.
function oddsMarketP(O, mkt, side, line, exclude) {
  const base = oddsBase(mkt);
  const ps = [];
  for (const [k, L] of Object.entries(oddsSetFor(O, mkt))) {
    if (k === exclude || ODDS_NOT_BETTABLE.has(k) || !oddsPairFresh(L, base)) continue;
    const a = oddsSide(L, base, side), b = oddsSide(L, base, oddsOther(side));
    if (!a || !b || a.odds == null || b.odds == null) continue;
    if (base !== 'ml' && a.line !== line) continue;
    const p = oddsNoVig(base, a.odds, b.odds);
    if (p != null) ps.push(p);
  }
  if (ps.length < 2) return null;
  ps.sort((x, y) => x - y);
  const mid = ps.length >> 1;
  return { p: ps.length % 2 ? ps[mid] : (ps[mid - 1] + ps[mid]) / 2, n: ps.length };
}
// True when no other book offers this side at as good a number or price (a lone outlier is often a stale line).
function oddsOnlyBook(O, mkt, side, line, odds, book) {
  const base = oddsBase(mkt);
  const d0 = oddsDec(odds);
  for (const [k, L] of Object.entries(oddsSetFor(O, mkt))) {
    if (k === book || ODDS_NOT_BETTABLE.has(k) || !L || oddsStale(L)) continue;
    const px = oddsQuote(L, base, side);
    if (!px?.actionable) continue;
    if (base !== 'ml') {
      const better = base === 't' ? (side === 'over' ? px.line < line : px.line > line) : px.line > line;
      if (better) return false;
      if (px.line !== line) continue;
    }
    if (oddsDec(px.odds) >= d0 - 0.05) return false;
  }
  return true;
}
// One price, fully read. The list and the bet slip both use this, so they always agree.
function oddsEdgePrice(pk, mkt, side, line, odds, book = null) {
  pk = Number(pk);
  const O = oddsGame(pk), g = S.games.get(pk);
  const base = oddsBase(mkt);
  if (!O || (!ODDS_MKTS.includes(mkt) && !ODDS_F5_BASE[mkt]) || odds == null || !Number.isFinite(+odds) || Math.abs(odds) < 100) return null;
  if (g && !oddsIsPre(g)) return null;
  if (!['home', 'away', 'over', 'under'].includes(side) || (base === 't') !== (side === 'over' || side === 'under')) return null;
  const target = book ? oddsQuote(oddsSetFor(O, mkt)[book], base, side) : null;
  if (book && (!target?.actionable || target.odds !== +odds || (base !== 'ml' && target.line !== +line))) return null;
  const F = oddsSharp(O, mkt);
  if (!F) return null;
  const pSide = side === F.sideA ? F.p : 1 - F.p;
  const sLine = base === 'ml' ? null : base === 't' ? F.line : side === 'home' ? F.line : -F.line;
  let push = 0;
  if (base !== 'ml') {
    if (line == null || !Number.isFinite(+line) || +line !== sLine) return null; // same number only
    if (Number.isInteger(+line)) { if (base === 'rl') return null; push = oddsPushT(+line); }
  }
  const d = oddsDec(odds);
  const w = pSide * (1 - push);
  const ev = w * d + push - 1;
  const M = oddsMarketP(O, mkt, side, base === 'ml' ? null : +line, book);
  const evMkt = M ? M.p * (1 - push) * d + push - 1 : null;
  let sig = 0.013;
  if (base === 'ml' && odds >= 150) sig = 0.025;
  if (push) sig += 0.005;
  const conf = ev >= 2 * sig && evMkt != null && evMkt >= 0.01 ? 'solid' : ev >= sig && (evMkt == null || evMkt > 0) ? 'thin' : 'weak';
  const L = book ? oddsSetFor(O, mkt)[book] : null;
  return {
    pk, g, mkt, side, book, line: base === 'ml' ? null : +line, odds: +odds, ev, evMkt, mktN: M?.n || 0,
    p: pSide, push, fairAm: oddsProbToAm(pSide), src: F.book, srcAge: F.age, sig, conf,
    onlyBook: book ? oddsOnlyBook(O, mkt, side, +line, +odds, book) : false,
    age: target?.seen ? serverNow() - target.seen : null,
  };
}
// For the bet slip: the fair chance of this price, from the same calculation as the list.
function oddsFairFor(pk, mkt, side, line, odds) {
  const e = oddsEdgePrice(pk, mkt, side, line, odds, null);
  return e ? { p: e.p, push: e.push, ev: e.ev, src: e.src, conf: e.conf } : null;
}
function oddsEdgeScore(g) {
  const out = [];
  const O = oddsGame(g?.pk);
  if (!O || !oddsIsPre(g)) return out;
  for (const mkt of ODDS_MKTS) {
    const F = oddsSharp(O, mkt);
    if (!F) continue;
    for (const side of mkt === 't' ? ['over', 'under'] : ['home', 'away']) {
      for (const k of oddsBookKeys(O)) {
        if (k === F.book) continue;
        const L = O.books[k];
        if (!L || oddsStale(L)) continue;
        const px = oddsSide(L, mkt, side);
        if (!px || px.odds == null || Math.abs(px.odds) < 100) continue;
        if (mkt === 'ml' && px.odds > ODDS_EDGE_ML_LONG) continue;
        const e = oddsEdgePrice(g.pk, mkt, side, px.line, px.odds, k);
        if (e && e.ev >= ODDS_EDGE_MIN && e.ev <= ODDS_EDGE_MAX) out.push(e);
      }
    }
  }
  return out;
}
const oddsShowWeak = () => !!store.get('edgeWeak', false);
// Rows for the list: the same price at several books is one row. Sorted by first pitch, never by size.
function oddsEdgeRows(all = false) {
  const groups = new Map();
  for (const e of oddsDayGames().filter(oddsIsPre).flatMap(oddsEdgeScore)) {
    if (!all && !oddsShowWeak() && e.conf === 'weak') continue;
    const k = `${e.pk}|${e.mkt}|${e.side}|${e.line}|${e.odds}`;
    const r = groups.get(k);
    if (!r) groups.set(k, { ...e, books: [e.book] });
    else { r.books.push(e.book); r.onlyBook = false; if (e.age != null && (r.age == null || e.age < r.age)) r.age = e.age; }
  }
  // Both sides of the same number showing a gap (Over 8.5 at one book, Under 8.5 at another) is the books disagreeing
  // with each other, not a lean: each side alone is close to a coin flip. Mark both rows so they say so.
  const num = (e) => (e.mkt === 't' ? e.line : e.line == null ? 'ml' : e.side === 'home' ? e.line : -e.line);
  const OTHER = { home: 'away', away: 'home', over: 'under', under: 'over' }, bySide = new Map();
  for (const r of groups.values()) { const k = `${r.pk}|${r.mkt}|${num(r)}|${r.side}`, b = bySide.get(k); if (!b || r.ev > b.ev) bySide.set(k, r); }
  for (const r of groups.values()) {
    const o = bySide.get(`${r.pk}|${r.mkt}|${num(r)}|${OTHER[r.side]}`);
    r.twoWay = o ? { pick: oddsPick(o.g, o.mkt, o.side, o.line), odds: o.odds, books: o.books } : null;
  }
  // A pair is the books disagreeing, not an edge on either side: both sides are left out.
  const rank = { solid: 0, thin: 1, weak: 2 };
  return [...groups.values()].filter((r) => !r.twoWay).sort((a, b) => Date.parse(a.g.start) - Date.parse(b.g.start) || a.pk - b.pk || rank[a.conf] - rank[b.conf]);
}
const oddsEdgePct = (e) => `+${Math.max(1, Math.round(e.ev * 100))}%`;
function oddsEdgeCaveats(e) {
  const c = [];
  if (e.twoWay) c.push(`Other side too: ${e.twoWay.pick} ${oddsFmt(e.twoWay.odds)} at ${e.twoWay.books.map(oddsBookName).join(', ')}, books disagree, a coin flip alone`);
  if (e.evMkt != null && e.evMkt < 0) c.push('Other books disagree');
  if (e.onlyBook) c.push('Only book at this price');
  const age = e.age != null ? Math.round(e.age / 60e3) : null;
  if (age != null && age >= 5) c.push(`Price ${age} min old`);
  const O = oddsGame(e.pk);
  if ([...ODDS.moves.values(), ...(O?.moves || [])].some((m) => Number(m.pk) === e.pk && m.mkt === e.mkt && serverNow() - m.t < 3600e3)) c.push('Line moved in the last hour');
  if (e.mkt === 'ml' && e.odds >= 200) c.push('Long moneyline');
  return [...new Set(c)].slice(0, 3);
}
const oddsEdgeWhen = (g) => `First pitch ${timeLabel(g.start)}`;
function oddsEdgeRead(e) {
  const fair = oddsFmt(e.fairAm);
  return `Estimate: ${oddsBookName(e.src)} without the cut, ${fair}${e.push ? ' (can push)' : ''}`;
}
function oddsEdgeRow(e) {
  const g = e.g;
  const t = e.mkt === 't' ? g.home : g[e.side];
  const cav = oddsEdgeCaveats(e);
  const pick = oddsPick(g, e.mkt, e.side, e.line);
  const label = `${e.books.map(oddsBookFull).join(', ')}: ${pick} at ${oddsFmt(e.odds)}. An estimated ${Math.max(1, Math.round(e.ev * 100))} percent above the sharp price. ${ODDS_CONF[e.conf]}.${cav.length ? ` ${cav.join('. ')}.` : ''} ${g.away.name || g.away.abbr} at ${g.home.name || g.home.abbr}, ${oddsEdgeWhen(g)}. Opens every book for this game.`;
  return `<button type="button" class="odds-edge-row c-${e.conf}" data-odds-open="${e.pk}" data-fk="e${e.pk}${e.mkt}${e.side}${e.odds}" aria-label="${esc(oddsSpoken(label))}">
    ${logo(t.id, 'logo odds-edge-logo')}
    <span class="odds-edge-mid">
      <span class="odds-edge-t"><b>${esc(pick)}</b> <span class="num">${esc(oddsFmt(e.odds))}</span> <span class="odds-edge-bk">· ${esc(e.books.map(oddsBookName).join(', '))}</span></span>
      <span class="odds-edge-s">${esc(oddsEdgeRead(e))}</span>
      ${cav.length ? `<span class="odds-edge-c">${esc(cav.join(' · '))}</span>` : ''}
      <span class="odds-edge-s">${esc(oddsEdgeWhen(g))} · ${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</span>
    </span>
    <span class="odds-edge-v"><span class="odds-edge-p num">${esc(oddsEdgePct(e))}</span><span class="odds-edge-k">${esc(ODDS_CONF[e.conf])}</span></span>
  </button>`;
}
const ODDS_EDGE_EXPLAIN = 'An estimate of how each price compares with the sharp price after removing the bookmaker’s cut. Sharp prices are close, not exact, and small gaps are often noise.';
function oddsEdgeEntry() {
  // The push chances come from last season's finals; fetch them once, then redraw with the real numbers.
  if (!ODDS.keys) oddsLoadKeys().then((k) => { if (k) oddsRepaint(); });
  const rows = oddsEdgeRows();
  const solid = rows.filter((e) => e.conf === 'solid').length;
  const sub = rows.length ? `${rows.length} price${rows.length === 1 ? '' : 's'} differ from the sharp price${solid ? ` · ${solid} solid` : ''} · estimates` : 'Nothing notable against the sharp price right now';
  return `<button type="button" class="odds-edge-entry" data-odds-edges data-fk="edges" aria-label="${esc(`Open Edge Finder. ${sub}`)}"><span><b>Edge Finder</b><span>${esc(sub)}</span></span>${ICON.chev}</button>`;
}
const ODDS_EDGE_CHIPS = [['all', 'All'], ['ml', 'Money'], ['rl', 'Run line'], ['t', 'Total']];
function oddsEdgeSheetHTML() {
  const rows = oddsEdgeRows();
  const list = rows.filter((e) => ODDS.edgeMkt === 'all' || e.mkt === ODDS.edgeMkt);
  const weakN = oddsShowWeak() ? 0 : oddsEdgeRows(true).filter((e) => e.conf === 'weak').length;
  const chips = ODDS_EDGE_CHIPS.map(([k, l]) => `<button type="button" data-odds-edge-mkt="${k}" data-fk="em${k}" aria-pressed="${ODDS.edgeMkt === k}">${esc(l)} <span class="num faint">${rows.filter((e) => k === 'all' || e.mkt === k).length}</span></button>`).join('');
  return `<h2 id="dlgTitle">Edge Finder</h2>
    <p class="odds-lede">${esc(ODDS_EDGE_EXPLAIN)}</p>
    <p class="odds-edge-sizing">Today's pre-game prices, by first pitch. Showing gaps of +1% or more, at the same number only.</p>
    <div class="seg odds-edge-chips" role="group" aria-label="Market">${chips}</div>
    ${list.length ? `<div class="card odds-edge-list">${list.map(oddsEdgeRow).join('')}</div>`
      : `<p class="odds-edge-none">${rows.length ? 'Nothing +1% or more from the sharp price in this market.' : 'No prices are +1% or more from the sharp price right now. That’s normal most of the time.'}</p>`}
    <div class="odds-edge-opts">
      <button type="button" class="lbtn" data-odds-weak data-fk="weak" aria-pressed="${oddsShowWeak()}">${oddsShowWeak() ? 'Hide weak reads' : `Show weak reads${weakN ? ` (${weakN})` : ''}`}</button>
    </div>
    <p class="odds-note"><b>How this works.</b> We take Pinnacle’s price (else Circa’s), remove the cut (the power method on moneylines), and use it only if it was listed in the last 10 minutes; otherwise there’s no comparison. We only compare at the same run line and the same total. <b>Solid</b> means the gap is well beyond its uncertainty and the other books agree; <b>Thin</b> means it might be real; <b>Weak read</b> is probably noise. Whole-number totals can push, so those use a rough push chance. None of this predicts a result, and prices change often.</p>`;
}
function oddsEdgeOpen() {
  const html = oddsEdgeSheetHTML();
  openSheet(html, 'edges');
  $('#dlgBody').dataset.key = html;
  ODDS.edgePaint = Date.now();
}
function oddsEdgeRefresh() {
  if (S.dlgKind !== 'edges') return;
  const wait = 50 - (Date.now() - ODDS.edgePaint);
  if (wait > 0) { if (!ODDS.edgeTimer) ODDS.edgeTimer = setTimeout(() => { ODDS.edgeTimer = 0; oddsEdgeRefresh(); }, wait); return; }
  oddsEdgePaint();
}
function oddsEdgePaint() {
  if (S.dlgKind !== 'edges') return;
  ODDS.edgePaint = Date.now();
  const box = $('#dlgIn'), top = box ? box.scrollTop : 0;
  oddsSwap($('#dlgBody'), oddsEdgeSheetHTML());
  if (box) box.scrollTop = top;
}

// Save (or clear) a number you typed in at a window.
async function oddsSaveCounter(pk) {
  const val = (id) => String($(`#${id}`)?.value || '').trim().replace(/−/g, '-');
  const books = [...ODDS.books, ...ODDS_BOOKS];
  const book = ODDS.counterBook || books.find((b) => b.nv || b.sharp)?.key;
  const body = { pk: Number(pk), book, mlHome: val('mMlHome'), mlAway: val('mMlAway'), total: val('mTotal'), over: val('mOver'), under: val('mOver') ? -(200 + Number(val('mOver'))) : '' };
  const err = $('#mErr');
  try {
    const r = await fetch('api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'That didn’t save.');
    await oddsLoadManual();
    oddsSheetPaint();
    oddsRepaint();
    if (typeof toastText === 'function') toastText(`${oddsBookFull(book)} number saved. Only you see it.`);
  } catch (e) {
    if (err) err.textContent = e.message;
  }
}
async function oddsClearCounter(pk, book) {
  try {
    await fetch(`api/manual?pk=${encodeURIComponent(pk)}&book=${encodeURIComponent(book)}`, { method: 'DELETE' });
    await oddsLoadManual();
    oddsSheetPaint();
    oddsRepaint();
  } catch { /* offline */ }
}

// ------------------------------------------------------------ clicks (data-odds-* only)
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-odds-refresh],[data-odds-reset],[data-odds-history-retry],[data-odds-view],[data-odds-filter],[data-odds-mkt],[data-odds-bet],[data-odds-open],[data-odds-edges],[data-odds-edge-mkt],[data-odds-weak],[data-odds-chart],[data-odds-moves],[data-odds-mbook],[data-odds-msave],[data-odds-mdel]');
  if (!t) return;
  const d = t.dataset;
  ev.preventDefault();
  if (d.oddsRefresh !== undefined) { oddsFetchDay(S.date, true); return; }
  if (d.oddsReset !== undefined) { ODDS.filter = 'all'; ODDS.query = ''; store.set('oddsFilter', 'all'); oddsRepaint(); return; }
  if (d.oddsHistoryRetry !== undefined) { ODDS.sheetHist = null; oddsSheetPaint(); oddsLoadHist(ODDS.sheetPk); return; }
  if (d.oddsView) {
    if (typeof setTab === 'function') setTab(d.oddsView === 'odds' ? 'odds' : 'games');
  } else if (d.oddsFilter) {
    ODDS.filter = d.oddsFilter;
    store.set('oddsFilter', ODDS.filter);
    oddsRepaint();
  } else if (d.oddsMkt) {
    ODDS.mkt = d.oddsMkt;
    store.set('oddsMkt', ODDS.mkt);
    oddsRepaint();
  } else if (d.oddsBet) {
    const [pk, mkt, side, book] = d.oddsBet.split('|');
    const px = oddsPriceAt(pk, mkt, side, book);
    if (!px) { if (typeof betsToast === 'function') betsToast('This price is no longer available. Refresh the board or enter your ticket manually.'); return; }
    if (typeof betsOpenSlip === 'function') betsOpenSlip({ pk: Number(pk), mkt, side, book, line: px?.line ?? null, odds: px?.odds ?? null });
    else if (typeof toastText === 'function') toastText('The bet slip isn’t available yet.');
  } else if (d.oddsOpen) oddsOpenSheet(d.oddsOpen);
  else if (d.oddsEdges !== undefined) oddsEdgeOpen();
  else if (d.oddsEdgeMkt) { ODDS.edgeMkt = d.oddsEdgeMkt; oddsEdgePaint(); }
  else if (d.oddsWeak !== undefined) { store.set('edgeWeak', !oddsShowWeak()); oddsEdgePaint(); oddsRepaint(); }
  else if (d.oddsChart) { ODDS.chartMkt = d.oddsChart; ODDS.chartAt = null; store.set('oddsChart', ODDS.chartMkt); oddsSwap($('#oddsChart'), oddsChartBlock(ODDS.sheetPk)); }
  else if (d.oddsMoves !== undefined) oddsMovesSheet();
  else if (d.oddsMbook) { ODDS.counterBook = d.oddsMbook; oddsSheetPaint(); }
  else if (d.oddsMsave) oddsSaveCounter(d.oddsMsave);
  else if (d.oddsMdel) { const [pk, book] = d.oddsMdel.split('|'); oddsClearCounter(pk, book); }
});
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'oddsHistoryCursor') { oddsHistoryScrub(ev.target.value); return; }
  if (ev.target.id !== 'oddsFind') return;
  ODDS.query = ev.target.value;
  const at = ev.target.selectionStart;
  oddsRepaint();
  const again = $('#oddsFind');
  if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch { /* search inputs */ } }
});
$('#dlg')?.addEventListener('close', () => { ODDS.sheetPk = null; ODDS.sheetHist = null; });
// Relative times ("12 min old") and freshness keep moving while the view is up.
setInterval(() => { if (!document.hidden && (S.tab === 'odds' || S.tab === 'live' || S.dlgKind === 'odds' || S.dlgKind === 'edges')) oddsRepaint(); }, 5000);

/* BetMGM Nevada — its price is a real link, so one tap opens BetMGM with the bet already in the slip (a
   popup blocker can stop window.open, never an anchor). This opens the board's own slip alongside it so
   the bet is still logged here. Deliberately no preventDefault. */
document.addEventListener('click', (ev) => {
  const a = ev.target && ev.target.closest && ev.target.closest('[data-mgmbet]');
  if (!a) return;
  const parts = String(a.dataset.mgmbet || '').split('|');
  const pk = parts[0], mkt = parts[1], side = parts[2], book = parts[3];
  if (!oddsIsPre(S.games.get(Number(pk)))) { ev.preventDefault(); if (typeof betsToast === 'function') betsToast('Pregame links are unavailable after first pitch. Use a current live price.'); return; }
  try {
    const px = typeof oddsPriceAt === 'function' ? oddsPriceAt(pk, mkt, side, book) : null;
    if (!px) { ev.preventDefault(); if (typeof betsToast === 'function') betsToast('This quote is no longer fresh. Refresh odds or enter your ticket manually.'); return; }
    if (typeof betsOpenSlip === 'function') betsOpenSlip({ pk: Number(pk), mkt, side, book, line: px?.line ?? null, odds: px?.odds ?? null });
  } catch (e) { ev.preventDefault(); }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.id === 'oddsBookPick') { ODDS.phoneBook = t.value; store.set('oddsBook', t.value); oddsRepaint(); }
  if (t.id === 'oddsGameFilter') { ODDS.filter = t.value; store.set('oddsFilter', t.value); oddsRepaint(); }
  if (t.id === 'oddsHistoryBook') { ODDS.chartBook = t.value; ODDS.chartAt = null; oddsSwap($('#oddsChart'), oddsChartBlock(ODDS.sheetPk)); }
});

document.addEventListener('bbl:odds_status', (ev) => { const d = ev.detail; if (!d?.date) return; ODDS.status.set(d.date, { sources: d.sources, coverage: d.coverage, refresh: d.refresh }); if ('next' in d) ODDS.next = d.next || null; oddsRepaint(); });

function oddsHandoff(g,L,mkt,side,book,label,html) {
 if(typeof betHandoffCell!=='function'||!S.isToday||!g||L?.m||!(oddsIsPre(g)||oddsIsLive(g)))return html;
 const base=mkt.replace(/^f5/,'')||'ml',q=L?.quote_meta?.[base]?.[side];if(!q||q.is_live!==oddsIsLive(g))return html;
 return betHandoffCell(q,book,g.pk,mkt,side,label,html);
}
