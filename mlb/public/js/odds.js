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
  flashed: new Map(),   // cell key -> ms it changed
  view: store.get('gamesView', 'scores'),
  sheetPk: null, sheetHist: null, sheetPaint: 0, sheetTimer: 0,
  chartMkt: store.get('oddsChart', 'ml'),
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
    source_observed_at: q.source_observed_at, source: q.source || L.source || L.src || null };
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
  const state = p.actionable ? 'Live' : p.freshness.charAt(0) + p.freshness.slice(1).toLowerCase();
  const isBest = p.actionable && best?.book === book;
  const label = `${oddsBookFull(book)}, ${oddsWho(g, mkt, side)} ${oddsSpokenPrice(mkt, side, p)}, live ${state.toLowerCase()}`;
  const inner = `<span class="num">${esc(main)}</span>${sub ? `<small class="num">${esc(sub)}</small>` : ''}<small>${esc(state)}${isBest ? ' · Best' : ''}</small>`;
  if (!actionable || !p.actionable || ODDS_NOT_BETTABLE.has(book)) return `<span class="odds-px na${p.actionable ? '' : ' old'}" aria-label="${esc(label)}">${inner}</span>`;
  return `<button type="button" class="odds-px${isBest ? ' best' : ''}" data-odds-bet="${g.pk}|${mkt}|${side}|${book}" aria-label="${esc(label + '. Opens a bet slip.')}" data-fk="live${g.pk}${book}${mkt}${side}">${inner}</button>`;
}
// Better for the bettor: the better number first, then the better price.
function oddsBetter(mkt, side, a, b) {
  if (!b) return true;
  if (!a) return false;
  if (mkt !== 'ml' && a.line !== b.line) return mkt === 't' ? (side === 'over' ? a.line < b.line : a.line > b.line) : a.line > b.line;
  return oddsDec(a.odds) > oddsDec(b.odds);
}
const oddsStale = (L) => !!(L?.seen && serverNow() - L.seen > 15 * 60e3);
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
    const p = oddsSide(L, mkt, side);
    if (!p || p.odds == null) continue;
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
  const p = oddsSide(L, f5 ? mkt.slice(2) || 'ml' : mkt, side);
  return p && p.odds != null ? { ...p, book, seen: L.seen ?? null } : null;
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
async function oddsFetchDay(date) {
  const f = ODDS.fetched.get(date);
  if (f && (f.ok || f.busy || Date.now() - f.at < 60e3)) return;
  ODDS.fetched.set(date, { at: Date.now(), busy: true });
  let ok = false;
  try {
    const r = await fetch(`api/odds?date=${encodeURIComponent(date)}`);
    if (r.ok) { oddsLoad(await r.json(), false); ok = true; }
  } catch { /* offline or not there yet */ }
  ODDS.fetched.set(date, { at: Date.now(), ok });
  oddsRepaint();
}

// ------------------------------------------------------------ repaint scheduling
function oddsRepaint() {
  if (ODDS.raf) return;
  ODDS.raf = requestAnimationFrame(() => {
    ODDS.raf = 0;
    if (S.tab === 'games') oddsGamesHook();
    if (S.dlgKind === 'edges') oddsEdgeRefresh();
    if (S.dlgKind === 'odds') oddsSheetRefresh();
  });
}
// Replace a container's HTML only when it changed, keeping keyboard focus on the same control.
function oddsSwap(el, html) {
  if (!el || el.dataset.key === html) return;
  const f = document.activeElement;
  const fk = f && el.contains(f) ? f.dataset.fk : null;
  el.innerHTML = html;
  el.dataset.key = html;
  if (fk) el.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
}

// ------------------------------------------------------------ Games tab: Scores | Odds
function oddsGamesHook() {
  const host = $('#oddsHost');
  if (!host) return;
  const day = S.loading || S.date;
  if (day && !S.loading) oddsFetchDay(day);
  if (!host.dataset.ready) {
    host.dataset.ready = '1';
    host.innerHTML = '<div class="odds-switch seg" role="group" aria-label="Show scores or odds" id="oddsSwitch"></div><div id="oddsView" class="odds-view"></div>';
  }
  const on = ODDS.view === 'odds';
  oddsSwap($('#oddsSwitch'), `<button type="button" data-odds-view="scores" aria-pressed="${!on}">Scores</button><button type="button" data-odds-view="odds" aria-pressed="${on}">Odds</button>`);
  $('#gamesList').hidden = on;
  const view = $('#oddsView');
  view.hidden = !on;
  if (on) oddsSwap(view, oddsViewHTML());
}

function oddsDayGames() {
  return [...S.games.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.pk - b.pk);
}
function oddsViewHTML() {
  if (S.loading) return '<div class="card empty"><b>Loading odds…</b></div>';
  const games = oddsDayGames();
  if (!games.length) return `<div class="card empty"><b>No games ${S.isToday ? 'today' : 'on this day'}</b>Pick another day above.</div>`;
  const f = ODDS.fetched.get(S.date);
  const any = games.some((g) => ODDS.games.has(g.pk));
  if (!any) {
    const busy = f?.busy || (!f && S.date);
    return `<div class="card empty"><b>${busy ? 'Loading odds…' : 'No prices for this day'}</b>${busy ? '' : S.isToday ? 'Prices show up here once the books post them.' : 'Line history is only kept for days the app was running.'}</div>`;
  }
  const mkt = ODDS.mkt;
  const edge = S.isToday ? oddsEdgeEntry() : '';
  // The first five innings is a pregame market: only show the games that actually have one.
  const shown = games.filter((g) => oddsPasses(g) && oddsMatches(g) && (mkt !== 'f5' || Object.keys(oddsGame(g.pk)?.f5 || {}).length));
  // Games in progress first, then the ones still to come, with the finished ones folded at the bottom.
  const grp = (list) => list.filter((g) => ODDS.games.has(g.pk));
  const live = grp(shown.filter((g) => g.state === 'Live' && !isOff(g)));
  const soon = grp(shown.filter((g) => oddsIsPre(g)));
  const done = grp(shown.filter((g) => g.state === 'Final' || isOff(g)));
  // The best price is only worth a column where you can still take it.
  const block = (list) => { const best = list.some((g) => oddsIsPre(g) || (oddsIsLive(g) && mkt !== 'f5')); return `<div class="card odds-brd">${oddsRowHead(mkt, best)}${list.map((g) => oddsRow(g, mkt, best)).join('')}</div>${oddsBoardTable(list, mkt)}`; };
  const section = (title, list) => (list.length ? `<div class="odds-grp"><h3>${esc(title)}</h3><span>${list.length === 1 ? '1 game' : `${list.length} games`}</span></div>${block(list)}` : '');
  const wasOpen = document.getElementById('oddsDone')?.open;
  const none = !live.length && !soon.length && !done.length;
  const noneWhy = mkt === 'f5'
    ? 'First five innings prices show up once the books post them, usually in the morning for that night\'s games.'
    : ODDS.query ? `Nothing for “${esc(ODDS.query)}”.` : 'Try another filter.';
  return `<p class="odds-lede">Every book side by side. The market price, then the best price and where it is. Tap a price to add it to a bet slip. <button type="button" class="odds-link" data-bets-books>Where to bet ↗</button><span id="oddsFresh">${oddsFreshText(games)}</span></p>
    ${oddsMktSeg(mkt)}
    ${oddsFilterBar(games)}
    ${none ? `<div class="card empty"><b>${mkt === 'f5' && !ODDS.query ? 'No first-five prices yet' : 'No games match'}</b>${noneWhy}</div>` : ''}
    <div class="odds-lay">
      ${edge ? `<div class="odds-edge-slot">${edge}</div>` : ''}
      <div class="odds-boards">
        ${section('Playing now', live)}${section(live.length ? 'Still to come' : 'Today', soon)}
        ${done.length ? `<details class="odds-done" id="oddsDone"${wasOpen || (!live.length && !soon.length) ? ' open' : ''}><summary class="odds-grp"><h3>Final</h3><span>${done.length === 1 ? '1 game' : `${done.length} games`} · closing prices ${ICON.chev}</span></summary>${block(done)}</details>` : ''}
      </div>
      <div class="odds-moves-slot">${oddsMovesHTML(games)}</div>
    </div>`;
}
// Filters: everything, the ones that have moved, the ones the public is piling on, or your own bets.
const ODDS_FILTERS = [['all', 'All'], ['moving', 'Moving'], ['public', 'Public heavy'], ['mine', 'My bets']];
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
  const counts = Object.fromEntries(ODDS_FILTERS.map(([f]) => { const was = ODDS.filter; ODDS.filter = f; const n = games.filter(oddsPasses).length; ODDS.filter = was; return [f, n]; }));
  const chips = ODDS_FILTERS.filter(([f]) => counts[f] || f === 'all' || f === ODDS.filter)
    .map(([f, label]) => `<button type="button" class="odds-fil" data-odds-filter="${f}" aria-pressed="${ODDS.filter === f}">${esc(label)}<span class="odds-n">${counts[f]}</span></button>`).join('');
  return `<div class="odds-ctrl"><div class="odds-fils" role="group" aria-label="Filter games">${chips}</div>
    <input class="odds-find" id="oddsFind" type="search" placeholder="Find a team" autocomplete="off" aria-label="Find a team" value="${esc(ODDS.query)}"></div>`;
}
// "checked 12s ago": the newest confirmation across the board.
function oddsFreshText(games) {
  let at = 0;
  for (const g of games) { const O = ODDS.games.get(g.pk); for (const L of Object.values(O?.books || {})) if ((L.seen || 0) > at) at = L.seen; }
  if (!at) return '';
  const s = Math.max(0, Math.round((serverNow() - at) / 1000));
  return ` Prices checked ${s < 60 ? `${s}s` : `${Math.round(s / 60)} min`} ago.`;
}

// Money, run line or total: one market at a time, the way the college football board does it.
function oddsMktSeg(mkt) {
  const one = ([k, label]) => `<button type="button" data-odds-mkt="${k}" aria-pressed="${mkt === k}">${esc(label)}</button>`;
  return `<div class="seg odds-mseg" role="group" aria-label="Which market to show">${ODDS_MKT_TABS.map(one).join('')}</div>`;
}

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
const ODDS_MKT_TABS = [['ml', 'Money'], ['rl', 'Run line'], ['t', 'Total'], ['f5', 'First 5']];
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
    const p = oddsSide(L, mkt, side);
    if (!p || p.odds == null) continue;
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
  const label = `${oddsWho(g, base, side)} ${ODDS_MKT_WORD[mkt]}, ${word} ${oddsSpokenPrice(base, side, p)}`;
  return `<span class="odds-px na${fl.cls}"${fl.style} data-fk="m${g.pk}${mkt}${side}" role="img" aria-label="${esc(label)}"><span class="num">${esc(main)}</span>${sub ? `<small class="num">${esc(sub)}</small>` : ''}</span>`;
}
// The best price anywhere, with the book underneath. Tapping it opens the slip at that book.
function oddsBestCell(g, O, mkt, side, pre) {
  const base = oddsBaseMkt(mkt);
  const best = g?.state === 'Live' ? oddsLiveBest(g, O, mkt, side) : pre ? (oddsIsF5(mkt) ? oddsBestIn(O?.f5, base, side) : oddsBest(O, mkt, side)) : null;
  if (!best) return '<span class="odds-px na" aria-hidden="true">—</span>';
  const { main } = oddsTwoLine(base, side, best);
  const sub = base === 'ml' ? oddsBookCode(best.book) : `${oddsFmt(best.odds)} ${oddsBookCode(best.book)}`;
  const fl = oddsFlash(g.pk, `b|${mkt}|${side}`);
  const label = `${oddsWho(g, base, side)} ${ODDS_MKT_WORD[mkt]}, best price ${oddsSpokenPrice(base, side, best)} at ${oddsBookFull(best.book)}.${fl.label} Opens a bet slip.`;
  return `<button type="button" class="odds-px best${fl.cls}"${fl.style} data-fk="b${g.pk}${mkt}${side}" data-odds-bet="${g.pk}|${oddsBetMkt(mkt)}|${side}|${best.book}" aria-label="${esc(label)}"><span class="num">${esc(main)}</span><small class="num">${esc(sub)}</small></button>`;
}
// One book's own price, for the wide table.
function oddsBookCell(g, O, mkt, side, book, best, pre) {
  if (g?.state === 'Live') return oddsLiveCell(g, O, mkt, side, book, best);
  const base = oddsBaseMkt(mkt);
  const L = oddsBooksFor(O, mkt)[book];
  const p = oddsSide(L, base, side);
  if (!p || p.odds == null) return '<span class="odds-px na" aria-hidden="true">—</span>';
  const { main, sub } = oddsTwoLine(base, side, p);
  const isBest = pre && best && best.book === book;
  const old = oddsStale(L);
  const fl = oddsFlash(g.pk, `k|${book}|${mkt}|${side}`);
  const label = `${oddsBookFull(book)}, ${oddsWho(g, base, side)} ${oddsSpokenPrice(base, side, p)}${isBest ? ', best price' : ''}${L.m ? `, typed in ${oddsAgo(L.seen)}` : old ? `, last seen ${oddsAgo(L.seen)}` : ''}.${fl.label}${pre ? ' Opens a bet slip.' : ''}`;
  const cls = `odds-px${isBest ? ' best' : ''}${old ? ' old' : ''}${L.m ? ' mine' : ''}${fl.cls}`;
  const inner = `<span class="num">${esc(main)}</span>${sub ? `<small class="num">${esc(sub)}</small>` : ''}`;
  if (!pre) return `<span class="${cls}"${fl.style} role="img" aria-label="${esc(label)}">${inner}</span>`;
  // BetMGM Nevada is the one book this board links into: a real anchor, so one tap goes straight to a
  // prefilled slip. It carries data-mgmbet rather than data-odds-bet, because the odds click handler
  // calls preventDefault on everything it matches, which would kill the navigation.
  if (book === 'mgm') return `<a class="${cls}"${fl.style} href="api/betmgm/go?g=${encodeURIComponent(g.pk)}&m=${encodeURIComponent(mkt)}&s=${encodeURIComponent(side)}" target="_blank" rel="noopener" data-fk="k${g.pk}${book}${mkt}${side}" data-mgmbet="${g.pk}|${oddsBetMkt(mkt)}|${side}|${book}" aria-label="${esc(label)}, bet at BetMGM">${inner}</a>`;
  return `<button type="button" class="${cls}"${fl.style} data-fk="k${g.pk}${book}${mkt}${side}" data-odds-bet="${g.pk}|${oddsBetMkt(mkt)}|${side}|${book}" aria-label="${esc(label)}">${inner}</button>`;
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
  const mid = showBest || mkt === 'f5' ? 'Market' : 'Close';
  return `<div class="odds-brhd${showBest ? '' : ' nb'}" aria-hidden="true"><span>${esc(name)}</span><span>${mid}</span>${showBest ? '<span>Best</span>' : ''}</div>`;
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
    return `<div class="odds-br-t${trail ? ' trail' : ''}">${logo(t.id)}<span class="odds-br-n">${esc(t.abbr)}${mkt === 't' ? `<small>${pSide === 'over' ? 'Over' : 'Under'}</small>` : ''}</span><span class="odds-br-s num">${!pre && g[tSide]?.score != null ? g[tSide].score : ''}</span>${oddsMktCell(g, O, mkt, pSide, pre)}${showBest ? oddsBestCell(g, O, mkt, pSide, pre) : ''}</div>`;
  };
  const move = oddsMoveBits(g, O, pre);
  const extra = pre ? oddsRowExtras(g, O) : '';
  const status = pre ? `First pitch ${timeLabel(g.start)}` : gameStatus(g);
  const foot = `<button type="button" class="odds-br-f" data-odds-open="${g.pk}" data-fk="o${g.pk}" aria-label="${esc(`${oddsTeam(g, 'away').name} at ${oddsTeam(g, 'home').name}: every book and line history`)}">
    <span class="${live ? 'odds-br-live' : ''}">${live ? '<span class="dot"></span>' : ''}${esc(status)}</span>${move ? `<span class="odds-sep"></span>${move}` : ''}${extra}<span class="odds-br-spk">${O && !oddsIsF5(mkt) ? oddsSpark(O, g) : ''}${ICON.chev}</span></button>`;
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
  const books = [...ODDS.books, ...ODDS_BOOKS].map((b) => b.key).filter((k, i, a) => a.indexOf(k) === i && k !== 'cons' && k !== 'open');
  const [s1, s2] = oddsSides(mkt);
  const head = `<tr><th class="l stk">Matchup</th><th>Open</th><th>Market</th><th>Move</th>${books.map((k) => `<th title="${esc(oddsBookFull(k))}"><span class="odds-bt-bk">${esc(oddsBookName(k))}</span>${oddsBook(k).sharp ? '<span class="odds-sharp" aria-hidden="true">S</span>' : ''}</th>`).join('')}<th>Tickets · money</th><th>Wind</th></tr>`;
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
      <td class="l stk"><div class="odds-bt-mu"><div class="odds-bt-st">${live ? '<span class="dot"></span>' : ''}<b>${esc(pre ? timeLabel(g.start) : gameStatus(g))}</b></div><div class="odds-bt-tms">${tm('away', s1)}${tm('home', s2)}</div></div></td>
      <td><div class="odds-st2">${open(s1)}${open(s2)}</div></td>
      <td><div class="odds-st2">${oddsMktCell(g, O, mkt, s1, pre)}${oddsMktCell(g, O, mkt, s2, pre)}</div></td>
      <td><div class="odds-bt-mv">${O && !oddsIsF5(mkt) ? oddsSpark(O, g) : ''}${move || (oddsIsF5(mkt) ? '<span class="faint">—</span>' : '<span class="faint">steady</span>')}</div></td>
      ${books.map((k) => `<td><div class="odds-st2">${oddsBookCell(g, O, mkt, s1, k, best1, pre)}${oddsBookCell(g, O, mkt, s2, k, best2, pre)}</div></td>`).join('')}
      <td>${oddsSplitCell(g, O, mkt)}</td>
      <td>${oddsWxCell(O, pre)}</td>
    </tr>`;
  }).join('');
  return `<div class="odds-btwrap"><table class="odds-bt"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
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
  ODDS.sheetHist = null;
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
  } catch {
    if (ODDS.sheetPk !== pk) return;
    ODDS.sheetHist = { b: {}, failed: true };
  }
  oddsSheetPaint();
}
// Keep the chart live: add the newest price per book when it differs from the last point.
function oddsHistAppend(h, O) {
  if (!h?.b || !O?.books) return;
  const t = O.at || serverNow();
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
  const wait = 1500 - (Date.now() - ODDS.sheetPaint);
  if (wait > 0) { if (!ODDS.sheetTimer) ODDS.sheetTimer = setTimeout(() => { ODDS.sheetTimer = 0; oddsSheetRefresh(); }, wait); return; }
  oddsSheetPaint();
}
function oddsSheetPaint() {
  if (S.dlgKind !== 'odds' || ODDS.sheetPk == null) return;
  ODDS.sheetPaint = Date.now();
  const pk = ODDS.sheetPk;
  oddsSwap($('#oddsChart'), oddsChartBlock(pk));
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
    const isBest = oddsIsPre(g) && k !== 'cons' && b?.book === k;
    const who = m === 't' ? (side === 'over' ? 'Over' : 'Under') : oddsTeam(g, side).name;
    const label = `${oddsBookFull(k)}, first five innings, ${who} ${oddsSpokenPrice(m, side, p)}${isBest ? ', best price' : ''}. Opens a bet slip.`;
    if (!oddsIsPre(g)) return `<span class="odds-px na"><span class="num">${esc(main)}</span>${sub ? `<small class="num">${esc(sub)}</small>` : ''}<small>Pregame</small></span>`;
    return `<button type="button" class="odds-px${isBest ? ' best' : ''}" data-odds-bet="${pk}|f5${m}|${side}|${k}" aria-label="${esc(label)}"><span class="num">${esc(main)}</span>${sub ? `<small class="num">${esc(sub)}</small>` : ''}</button>`;
  };
  const rows = keys.map((k) => `<tr><td><div class="odds-bk">${esc(oddsBookName(k))}</div></td><td>${cell(k, 'ml', 'away')}</td><td>${cell(k, 'ml', 'home')}</td><td>${cell(k, 't', 'over')}</td><td>${cell(k, 't', 'under')}</td></tr>`).join('');
  const ttCards = tt ? ['away', 'home'].filter((sd) => tt[sd]?.pts != null).map((sd) => `<div><div class="odds-tt-k">${esc(oddsTeam(g, sd).abbr)} team total</div><div class="odds-tt-v num">${oddsTrim(tt[sd].pts)}</div><div class="odds-tt-x">o ${esc(oddsFmt(tt[sd].over))} · u ${esc(oddsFmt(tt[sd].under))}</div></div>`).join('') : '';
  return `<section class="dlg-sec" aria-label="First five innings and team totals"><h3 class="sub-h">First five innings<span>${keys.length ? `${keys.length} books` : 'Team totals'}</span></h3>
    ${rows ? `<div class="card odds-f5"><table class="odds-f5t"><thead><tr><th>Book</th><th>${esc(away.abbr)}</th><th>${esc(home.abbr)}</th><th>Over</th><th>Under</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="odds-note">First five innings settles on the score after five complete innings. If the game is called before that, these bets are void.</p></div>` : ''}
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
    ${oddsKeysHTML(pk)}
    ${pre ? oddsCounterHTML(pk) : ''}
    <section class="dlg-sec" aria-label="Nevada sportsbooks">
      <h3 class="sub-h">Open a Nevada book<span>For use in Nevada</span></h3>
      <div class="links odds-links">${links}</div>
    </section>
    ${g ? `<div class="links"><button type="button" class="lbtn" data-game="${pk}">Scores and every at-bat</button></div>` : ''}
    <p class="odds-note">Prices come from each book's public odds and can be a few minutes behind. Pinnacle and Circa are the sharp books: they move first and take the biggest bets.</p>
  </div>`;
}
function oddsSheetMoveHTML(pk) {
  const g = S.games.get(pk), O = oddsGame(pk);
  if (!O) return '';
  return oddsMovement(g, O, oddsIsPre(g));
}

// Line history chart for one market: consensus bold, sharp books emphasized, the rest faint.
const ODDS_CHART_MKTS = [['ml', 'Money'], ['rl', 'Run line'], ['t', 'Total']];
function oddsChartBlock(pk) {
  const h = ODDS.sheetHist;
  const g = S.games.get(pk);
  const seg = `<div class="seg odds-chart-seg" role="group" aria-label="Chart market">${ODDS_CHART_MKTS.map(([k, l]) => `<button type="button" data-odds-chart="${k}" data-fk="ch${k}" aria-pressed="${ODDS.chartMkt === k}">${l}</button>`).join('')}</div>`;
  const head = `<h3 class="sub-h">Line history<span>${ODDS.chartMkt === 't' ? 'Total runs' : `${esc(oddsTeam(g, 'home').abbr)} price`}</span></h3>${seg}`;
  if (!h) return `${head}<div class="odds-chart-empty">Loading the line history…</div>`;
  const svg = oddsChartSVG(h, oddsGame(pk), g, ODDS.chartMkt, chartW());
  if (!svg) return `${head}<div class="odds-chart-empty">${h.failed ? 'Line history isn’t available right now.' : 'Not enough history yet. The chart fills in as prices change.'}</div>`;
  return `${head}${svg}
    <div class="odds-legend" aria-hidden="true"><span><i class="c"></i>Market</span><span><i class="s"></i>Pinnacle, Circa</span><span><i class="o"></i>Other books</span><span><i class="op"></i>Open</span></div>`;
}
function oddsChartSVG(h, O, g, mkt, W) {
  const val = (row) => (mkt === 't' ? row[1] : mkt === 'rl' ? oddsScale(row[2]) : oddsScale(row[1]));
  const series = [];
  for (const [k, b] of Object.entries(h.b || {})) {
    if (k === 'open') continue;
    const pts = (b?.[mkt] || []).filter((r) => r && r[0] && val(r) != null).map((r) => [r[0], val(r)]).sort((a, c) => a[0] - c[0]);
    if (pts.length) series.push({ k, pts, tier: k === 'cons' ? 2 : oddsBook(k).sharp ? 1 : 0 });
  }
  if (!series.length) return '';
  const openL = h.open || O?.open || O?.books?.open || null;
  const openV = !openL ? null : mkt === 't' ? openL.t?.line ?? null : mkt === 'rl' ? oddsScale(openL.rl?.odds?.[0]) : oddsScale(openL.ml?.[0]);
  const start = g?.start ? Date.parse(g.start) : null;
  const pre = oddsIsPre(g);
  let x0 = Math.min(...series.map((s) => s.pts[0][0]));
  const lastT = Math.max(...series.map((s) => s.pts[s.pts.length - 1][0]));
  const x1 = pre || !start ? Math.max(lastT, serverNow()) : Math.max(start, lastT);
  if (x1 - x0 < 30 * 60e3) x0 = x1 - 30 * 60e3;
  const all = series.flatMap((s) => s.pts.map((p) => p[1])).concat(openV != null ? [openV] : []);
  let lo = Math.min(...all), hi = Math.max(...all);
  const minSpan = mkt === 't' ? 1 : 20;
  if (hi - lo < minSpan) { const m = (hi + lo) / 2; lo = m - minSpan / 2; hi = m + minSpan / 2; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const H = W < 500 ? 210 : 240, Lf = 46, R = 58, T = 14, B = 26;
  const X = (t) => Lf + ((clamp(t, x0, x1) - x0) / (x1 - x0)) * (W - Lf - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const path = (pts) => {
    let d = '';
    pts.forEach((p, i) => { d += i ? ` H${X(p[0]).toFixed(1)} V${Y(p[1]).toFixed(1)}` : `M${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`; });
    return `${d} H${X(x1).toFixed(1)}`;
  };
  const fmtV = (v) => (mkt === 't' ? oddsTrim(Math.round(v * 2) / 2) : oddsFmt(oddsUnscale(v)));
  // three gridlines on round values
  const step = mkt === 't' ? 0.5 : [5, 10, 20, 25, 50, 100].find((s) => (hi - lo) / s <= 4) || 100;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const grid = ticks.slice(0, 6).map((v) => `<line class="gl" x1="${Lf}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ax" x="${Lf - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmtV(v))}</text>`).join('');
  const lines = [...series].sort((a, b) => a.tier - b.tier).map((s) => `<path class="ln t${s.tier}" d="${path(s.pts)}"><title>${esc(oddsBookFull(s.k))}</title></path>`).join('');
  const cons = series.find((s) => s.k === 'cons') || series.find((s) => s.tier === 1) || series[0];
  const endV = cons.pts[cons.pts.length - 1][1];
  const openLine = openV != null ? `<line class="op" x1="${Lf}" x2="${W - R}" y1="${Y(openV).toFixed(1)}" y2="${Y(openV).toFixed(1)}"/><text class="opl" x="${Lf + 4}" y="${(Y(openV) - 5).toFixed(1)}">Open ${esc(fmtV(openV))}</text>` : '';
  const fp = start && start >= x0 && start <= x1 ? `<line class="fp" x1="${X(start).toFixed(1)}" x2="${X(start).toFixed(1)}" y1="${T}" y2="${H - B}"/><text class="fpl" x="${(X(start) - 4).toFixed(1)}" y="${T + 10}" text-anchor="end">First pitch</text>` : '';
  const tl = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const who = mkt === 't' ? 'Total' : `${oddsTeam(g, 'home').abbr} ${mkt === 'ml' ? 'moneyline' : 'run line price'}`;
  const openTxt = openV != null ? `, open ${oddsSpoken(fmtV(openV))}` : '';
  return `<svg class="odds-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${who} over time from ${series.length} sources${openTxt}. ${oddsBookFull(cons.k)} now ${oddsSpoken(fmtV(endV))}.`)}">
    ${grid}${openLine}${fp}${lines}
    <circle class="end" cx="${X(x1).toFixed(1)}" cy="${Y(endV).toFixed(1)}" r="3.5"/>
    <text class="endl" x="${(X(x1) + 7).toFixed(1)}" y="${(Y(endV) + 4).toFixed(1)}">${esc(fmtV(endV))}</text>
    <text class="ax" x="${Lf}" y="${H - 6}">${esc(tl(x0))}</text>
    <text class="ax" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(pre ? 'Now' : tl(x1))}</text>
  </svg>`;
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
    const isBest = b && b.book === k;
    const who = mkt === 't' ? (side === 'over' ? 'Over' : 'Under') : (side === 'home' ? home : away).abbr;
    const fl = oddsFlash(pk, `k|${k}|${mkt}|${side}`);
    const spoken = `${oddsBookFull(k)}, ${who} ${ODDS_MKT_WORD[mkt]} ${oddsSpokenPrice(mkt, side, p)}${isBest ? ', best price' : ''}.${fl.label}`;
    if (!pre || ODDS_NOT_BETTABLE.has(k)) return `<span class="odds-tp na${isBest ? ' best' : ''}${fl.cls}"${fl.style} role="img" aria-label="${esc(spoken)}"><span class="num">${esc(txt)}</span></span>`;
    return `<button type="button" class="odds-tp${isBest ? ' best' : ''}${fl.cls}"${fl.style} data-fk="t${k}${mkt}${side}" data-odds-bet="${pk}|${mkt}|${side}|${k}" aria-label="${esc(`${spoken} Opens a bet slip.`)}"><span class="num">${esc(txt)}</span>${isBest ? '<small>Best</small>' : ''}</button>`;
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
    const age = L?.seen ? serverNow() - L.seen : null;
    if (!L || age == null || age > ODDS_SHARP_FRESH) continue; // sharp prices must be recent
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
    if (k === exclude || ODDS_NOT_BETTABLE.has(k) || !L || oddsStale(L)) continue;
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
    const px = oddsSide(L, base, side);
    if (!px || px.odds == null) continue;
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
    age: L?.seen ? serverNow() - L.seen : null,
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
  const rank = { solid: 0, thin: 1, weak: 2 };
  return [...groups.values()].sort((a, b) => Date.parse(a.g.start) - Date.parse(b.g.start) || a.pk - b.pk || rank[a.conf] - rank[b.conf]);
}
const oddsEdgePct = (e) => `+${Math.max(1, Math.round(e.ev * 100))}%`;
function oddsEdgeCaveats(e) {
  const c = [];
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
  const wait = 1500 - (Date.now() - ODDS.edgePaint);
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
  const t = ev.target.closest('[data-odds-view],[data-odds-filter],[data-odds-mkt],[data-odds-bet],[data-odds-open],[data-odds-edges],[data-odds-edge-mkt],[data-odds-weak],[data-odds-chart],[data-odds-moves],[data-odds-mbook],[data-odds-msave],[data-odds-mdel]');
  if (!t) return;
  const d = t.dataset;
  ev.preventDefault();
  if (d.oddsView) {
    ODDS.view = d.oddsView === 'odds' ? 'odds' : 'scores';
    store.set('gamesView', ODDS.view);
    oddsGamesHook();
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
  else if (d.oddsChart) { ODDS.chartMkt = d.oddsChart; store.set('oddsChart', ODDS.chartMkt); oddsSwap($('#oddsChart'), oddsChartBlock(ODDS.sheetPk)); }
  else if (d.oddsMoves !== undefined) oddsMovesSheet();
  else if (d.oddsMbook) { ODDS.counterBook = d.oddsMbook; oddsSheetPaint(); }
  else if (d.oddsMsave) oddsSaveCounter(d.oddsMsave);
  else if (d.oddsMdel) { const [pk, book] = d.oddsMdel.split('|'); oddsClearCounter(pk, book); }
});
document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'oddsFind') return;
  ODDS.query = ev.target.value;
  const at = ev.target.selectionStart;
  oddsRepaint();
  const again = $('#oddsFind');
  if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch { /* search inputs */ } }
});
$('#dlg')?.addEventListener('close', () => { ODDS.sheetPk = null; ODDS.sheetHist = null; });
// Relative times ("12 min old") and freshness keep moving while the view is up.
setInterval(() => { if (!document.hidden && (S.tab === 'games' || S.dlgKind === 'odds' || S.dlgKind === 'edges')) oddsRepaint(); }, 5000);

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
    if (typeof betsOpenSlip === 'function') betsOpenSlip({ pk: Number(pk), mkt, side, book, line: px?.line ?? null, odds: px?.odds ?? null });
  } catch (e) { /* the link still opens */ }
});
