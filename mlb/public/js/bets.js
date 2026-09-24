'use strict';
/* Bing Bong Live — your bets. The bet slip (betsOpenSlip), the parlay tray, Mine → My bets (with "Most likely to hit"),
   Mine → Results (closing line value, profit, by market and book), Kelly sizing and "Your bets" device linking.
   Ported from Hook & Ladder and adapted to MLB: ml (moneyline), rl (run line) and t (total runs).
   Informational only: no default stakes, Kelly is opt-in, every model number says est.
   A leg's line is stored from the bettor's side (away +1.5, home −1.5, over/under 8.5). */

// ------------------------------------------------------------ constants
const BETS_MINUS = '−';
// Nevada sportsbook pages. Boomer's and Wynn have no betting website, only their Nevada iPhone apps.
const BETS_SITE = {
  boom: 'https://apps.apple.com/us/app/boomers-sportsbook-nevada/id6749002754',
  wynn: 'https://apps.apple.com/us/app/wynn-sports-nevada/id6476514610',
  mgm: 'https://www.nv.betmgm.com/en/sports',
  czr: 'https://sportsbook.caesars.com/us/nv/bet',
  circa: 'https://www.circasports.com/',
  stn: 'https://stnsports.com/',
  wg: 'https://www.superbook.com/',
  sp: 'https://southpointcasino.com/',
};
// Used until the server's odds list arrives (snapshot.odds.books).
const BETS_BOOKS = [
  { key: 'circa', name: 'Circa Sports', short: 'Circa', sharp: true, nv: true },
  { key: 'pin', name: 'Pinnacle', short: 'Pinnacle', sharp: true },
  { key: 'stn', name: 'Station Casinos', short: 'Station', nv: true },
  { key: 'boom', name: "Boomer's", short: "Boomer's", nv: true },
  { key: 'czr', name: 'Caesars', short: 'Caesars', nv: true },
  { key: 'mgm', name: 'BetMGM', short: 'BetMGM', nv: true },
  { key: 'sp', name: 'South Point', short: 'S. Point', nv: true },
  { key: 'wg', name: 'Westgate SuperBook', short: 'Westgate', nv: true },
  { key: 'wynn', name: 'Wynn', short: 'Wynn', nv: true },
  { key: 'dk', name: 'DraftKings', short: 'DK' },
  { key: 'fd', name: 'FanDuel', short: 'FanDuel' },
];
const BETS_MKT = { ml: 'Moneyline', rl: 'Run line', t: 'Total runs', f5ml: 'First 5 innings', f5rl: 'First 5 run line', f5t: 'First 5 total' };
const BETS_MKTS = { ml: 'Moneylines', rl: 'Run lines', t: 'Totals', f5ml: 'First 5 moneylines', f5rl: 'First 5 run lines', f5t: 'First 5 totals' };
const BETS_CONF = { solid: 'Solid', thin: 'Thin', weak: 'Weak read' };
const BETS_SEGS = [['follow', 'Following'], ['mine', 'My bets'], ['results', 'Results']];

const BETS = {
  list: [], loaded: false,
  odds: new Map(), books: [], games: new Map(),
  pending: new Set(), // bets hidden while their Undo toast is showing
  seg: new URLSearchParams(location.search).has('portfolio') ? 'mine' : ['follow', 'mine', 'results'].includes(store.get('betsSeg', 'mine')) ? store.get('betsSeg', 'mine') : 'mine',
  parlay: (() => { const p = store.get('betsParlay', null); return p && Array.isArray(p.legs) && Date.now() - (p.at || 0) < 24 * 3600e3 ? p.legs.slice(0, 12) : []; })(),
  slip: null, more: false,
  me: null, link: null, linkTimer: 0,
};

// ------------------------------------------------------------ small helpers
const betsTrim = (n) => (Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1));
const betsFmtLine = (v) => (v == null || !Number.isFinite(v) ? '—' : v === 0 ? 'PK' : `${v > 0 ? '+' : BETS_MINUS}${betsTrim(Math.abs(v))}`);
const betsFmtTot = (v) => (v == null || !Number.isFinite(v) ? '—' : betsTrim(v));
const betsFmtOdds = (o) => (o == null || !Number.isFinite(o) ? '' : o === 100 ? 'EV' : o > 0 ? `+${o}` : `${BETS_MINUS}${Math.abs(o)}`);
const betsFmtPct = (p, d = 0) => (p == null || !Number.isFinite(p) ? '—' : `${(p * 100).toFixed(d)}%`);
function betsFmtMoney(n, sign = false) {
  if (n == null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  const s = a >= 1000 ? `$${Math.round(a).toLocaleString()}` : `$${a % 1 ? a.toFixed(2) : a}`;
  return n < 0 ? `${BETS_MINUS}${s}` : sign && n > 0 ? `+${s}` : s;
}
const betsPlural = (n, w, p = `${w}s`) => `${n} ${n === 1 ? w : p}`;
const betsDec = (o) => (o == null || !Number.isFinite(o) ? null : o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o));
const betsImp = (o) => (o == null || !Number.isFinite(o) ? null : o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100));
const betsToAm = (d) => (d == null || d <= 1 ? null : d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
const betsToWin = (stake, o) => (stake > 0 && o != null && Number.isFinite(o) ? stake * (betsDec(o) - 1) : null);
const betsSigned = (v, unit = '', d = 1) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? BETS_MINUS : ''}${Math.abs(v).toFixed(d)}${unit}`);
async function betsApi(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
const betsBookList = () => (BETS.books.length ? BETS.books : BETS_BOOKS).filter((b) => b.key !== 'cons' && b.key !== 'open');
const betsBook = (k) => (BETS.books.length ? BETS.books : BETS_BOOKS).find((b) => b.key === k);
const betsBookName = (k) => ({ cons: 'Market', open: 'Open', close: 'Close' }[k] || betsBook(k)?.short || k || '');
const betsBookFull = (k) => ({ cons: 'Market consensus', open: 'Opening line' }[k] || betsBook(k)?.name || k || '');
const betsBookKey = (name) => (BETS.books.length ? BETS.books : BETS_BOOKS).find((b) => b.key === name || b.name === name || b.short === name)?.key || '';

// Games: today's live copy (S.games) first, then the last snapshot (kept even while another day is on screen).
const betsGame = (pk) => (S.isToday ? S.games.get(Number(pk)) : null) || BETS.games.get(Number(pk)) || S.games.get(Number(pk)) || null;
const betsOff = (g) => typeof isOff === 'function' && isOff(g);
const betsIsPre = (g) => !!g && g.state === 'Preview' && !betsOff(g);
const betsIsLive = (g) => !!g && g.state === 'Live' && !betsOff(g) && !/suspend/i.test(g.detail || '');
const betsIsFinal = (g) => !!g && g.state === 'Final' && !betsOff(g);
const betsMatchup = (g) => (g ? `${g.away.abbr} @ ${g.home.abbr}` : '');
function betsWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(serverNow()).toDateString() === d.toDateString();
  return `${today ? 'Today' : d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}
const betsShortDate = (t) => (t ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
function betsInningText(g) {
  if (!g) return '';
  return typeof gameStatus === 'function' ? gameStatus(g) : `${g.half || ''} ${g.inning || ''}`;
}

// ------------------------------------------------------------ prices
// { line, odds } for one side at one book. Book lines keep the run line from the HOME side; legs keep the bettor's side.
const betsOddsFor = (pk) => (typeof oddsGame === 'function' ? oddsGame(pk) : null) || BETS.odds.get(Number(pk)) || null;
// Current quote evidence for display. Reference/open/close prices never become slip prefills.
function betsQuote(pk, book, mkt, side) {
  const f5 = String(mkt).startsWith('f5'), base = f5 ? mkt.slice(2) : mkt;
  if (['open', 'close'].includes(book) || !['ml', 'rl', 't'].includes(base) || !(base === 't' ? ['over', 'under'] : ['home', 'away']).includes(side)) return null;
  const O = betsOddsFor(pk), g = betsGame(pk);
  if (g?.state === 'Live') return typeof oddsLiveQuote === 'function' ? oddsLiveQuote(g, O, book, mkt, side) : null;
  if (!betsIsPre(g) || /suspend/i.test(g.detail || '')) return null;
  const L = (f5 ? O?.f5 : O?.books)?.[book];
  if (L?.is_live === true) return null;
  return typeof oddsQuote === 'function' ? oddsQuote(L, base, side) : null;
}
function betsPrice(pk, book, mkt, side) {
  const p = betsQuote(pk, book, mkt, side);
  return p?.actionable && (p.freshness === 'FRESH' || p.freshness === 'AGING') ? p : null;
}
function betsLegLabel(g, l) {
  const who = l.side === 'home' || l.side === 'away' ? (g ? g[l.side].abbr : l.side === 'home' ? 'Home' : 'Away') : null;
  const f5 = l.mkt.startsWith('f5') ? ' F5' : '';
  if (l.mkt === 'ml' || l.mkt === 'f5ml') return `${who}${f5} ML`;
  if (l.mkt === 'rl' || l.mkt === 'f5rl') return `${who}${f5} ${betsFmtLine(l.line)}`;
  if (l.mkt === 't' || l.mkt === 'f5t') return `${l.side === 'over' ? 'Over' : 'Under'}${f5} ${betsFmtTot(l.line)}`;
  return '';
}
// The sharp read, from the odds board (odds.js). Pre-game only. Returns { p, push, ev, src, conf } or null.
function betsFair(l) {
  if (typeof oddsFairFor !== 'function' || !l || !Number.isFinite(l.odds)) return null;
  const g = betsGame(l.pk);
  if (g && !betsIsPre(g)) return null;
  try {
    const r = oddsFairFor(Number(l.pk), l.mkt, l.side, l.mkt === 'ml' || l.mkt === 'f5ml' ? null : l.line, l.odds);
    return r && Number.isFinite(r.p) ? r : null;
  } catch { return null; }
}
function betsWords(g, l, okOdds) {
  if (l.mkt === 'rl' && Number.isFinite(l.line)) {
    const n = g ? g[l.side].name || g[l.side].abbr : 'This side';
    const m = Math.abs(l.line);
    if (l.line < 0) return Number.isInteger(m) ? `${n} has to win by ${m + 1} or more. Winning by exactly ${m} is a push.` : `${n} has to win by ${Math.ceil(m)} or more.`;
    if (l.line > 0) return Number.isInteger(m) ? `${n} covers by winning, or losing by ${m - 1} or fewer. Losing by exactly ${m} is a push.` : `${n} covers by winning, or by losing by ${Math.floor(m)} or fewer.`;
    return `${n} just has to win.`;
  }
  if (l.mkt === 't' && Number.isFinite(l.line)) {
    const t = l.line;
    return Number.isInteger(t) ? `The over needs ${t + 1}+ total runs; exactly ${t} is a push.` : `The over needs ${Math.ceil(t)}+ total runs; the under needs ${Math.floor(t)} or fewer.`;
  }
  if ((l.mkt === 'ml' || l.mkt === 'f5ml') && okOdds) {
    const o = l.odds;
    return o < 0 ? `Risk ${betsFmtMoney(Math.abs(o))} to win $100 (${betsFmtPct(betsImp(o))} implied).` : `$100 wins ${betsFmtMoney(o)} (${betsFmtPct(betsImp(o))} implied).`;
  }
  return '';
}

// ------------------------------------------------------------ toasts with Undo
// When a sheet is open, toasts go inside the dialog so the Undo button stays reachable above the backdrop.
function betsToast(msg, action) {
  const dlgEl = $('#dlg');
  let box = $('#toasts');
  if (dlgEl?.open) {
    box = $('#betsDlgToasts');
    if (!box) { box = document.createElement('div'); box.id = 'betsDlgToasts'; box.className = 'toasts bets-dlg-toasts'; box.setAttribute('aria-live', 'polite'); dlgEl.appendChild(box); }
  }
  const el = document.createElement('div');
  el.className = 'toast text bets-toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="bets-undo" type="button">${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').addEventListener('click', (ev) => { ev.stopPropagation(); el.remove(); action.run(); });
  box.prepend(el);
  while (box.children.length > 3) box.lastElementChild.remove();
  setTimeout(() => el.remove(), action ? 6000 : 4000);
}
$('#dlg')?.addEventListener('close', () => {
  // Carry any toasts still showing out of the closed sheet.
  const inner = $('#betsDlgToasts');
  if (inner) [...inner.children].reverse().forEach((t) => $('#toasts').prepend(t));
  betsTray();
});

// ------------------------------------------------------------ where the slip came from
// Remember the sheet (Bing Bong's game sheet, the odds game sheet, Edge Finder…) and how far down you were, so
// Add to parlay and Save bet put you back there instead of closing everything.
function betsOrigin() {
  const d = $('#dlg');
  if (!d?.open || !S.dlgKind) return null;
  if (S.dlgKind === 'slip') return BETS.slip?.returnTo || null;
  const scroll = $('#dlgIn')?.scrollTop || 0;
  if (S.dlgKind === 'game') return { kind: 'game', pk: S.gameOpen, scroll };
  // The odds board's sheets (odds.js): 'odds' (one game, ODDS.sheetPk), 'edges' (Edge Finder), 'odds-moves'.
  const pk = S.dlgKind === 'odds' && typeof ODDS !== 'undefined' ? ODDS.sheetPk : null;
  return { kind: S.dlgKind, pk, scroll };
}
function betsReturn(r) {
  let ok = false;
  try {
    if (r?.kind === 'game' && r.pk) { openGame(r.pk); ok = true; }
    else if (r?.kind === 'odds' && r.pk != null && typeof oddsOpenSheet === 'function') { oddsOpenSheet(r.pk); ok = true; }
    else if (r?.kind === 'edges' && typeof oddsEdgeOpen === 'function') { oddsEdgeOpen(); ok = true; }
    else if (r?.kind === 'odds-moves' && typeof oddsMovesSheet === 'function') { oddsMovesSheet(); ok = true; }
  } catch { ok = false; }
  if (!ok) { closeSheet(); return; }
  if (!r.scroll) return;
  // The sheet may still be loading; keep trying to restore the scroll for a moment.
  const until = Date.now() + 1500;
  const put = () => {
    const box = $('#dlgIn');
    if (!box) return;
    if (box.scrollHeight - box.clientHeight >= r.scroll || Date.now() > until) { box.scrollTop = r.scroll; return; }
    requestAnimationFrame(put);
  };
  requestAnimationFrame(put);
}

// ------------------------------------------------------------ the bet slip
function betsLegFrom(pk, mkt, side, book) {
  pk = Number(pk);
  const b = book && book !== 'cons' && book !== 'open' && book !== 'close' ? book : '';
  const p = betsPrice(pk, book || 'cons', mkt, side) || {};
  return { pk, mkt, side, line: mkt === 'ml' || mkt === 'f5ml' ? null : p.line ?? NaN, odds: p.odds ?? NaN, book: b };
}
function betsOpenSlip(opts = {}) {
  const returnTo = betsOrigin();
  let slip;
  if (opts.parlay) slip = { legs: BETS.parlay.map((l) => ({ ...l })), stake: NaN, book: BETS.parlay.find((l) => l.book)?.book || '', parlay: true };
  else if (opts.pk && opts.mkt && opts.side) {
    const l = betsLegFrom(opts.pk, opts.mkt, opts.side, opts.book);
    // A named book is a quoted handoff. Re-read it now; rendered opts can already be out of date.
    // The manual picker has no named book and remains usable with blank price fields.
    if (l.book && !Number.isFinite(l.odds)) {
      betsToast(`This ${betsGame(opts.pk)?.state === 'Live' ? 'live ' : ''}price is unavailable. Enter your ticket manually.`);
      return;
    }
    slip = { legs: [l], stake: NaN, book: l.book };
  } else slip = { legs: [], stake: NaN, book: '', pick: true };
  slip.returnTo = returnTo;
  BETS.slip = slip;
  openSheet(`<div class="bets-slip" id="betsSlip">${betsSlipHTML()}</div>`, 'slip');
}
function betsPaintSlip() {
  const el = $('#betsSlip');
  if (!el || S.dlgKind !== 'slip') return;
  el.innerHTML = betsSlipHTML();
  const on = el.querySelector('.bets-bk.on');
  if (on) on.parentElement.scrollLeft = Math.max(0, on.offsetLeft - on.parentElement.offsetLeft - 16);
}
function betsSlipOdds() {
  const sl = BETS.slip;
  if (sl.legs.length === 1) return sl.legs[0].odds;
  if (Number.isFinite(sl.odds) && sl.odds !== sl.autoOdds) return sl.odds;
  const d = sl.legs.reduce((p, l) => p * (betsDec(l.odds) || NaN), 1);
  sl.autoOdds = Number.isFinite(d) ? betsToAm(d) : NaN;
  return sl.autoOdds;
}
// Book icons shipped in public/icons/books; books without one get a clean monogram.
const BETS_BOOK_ICON = new Set(['circa', 'stn', 'czr', 'mgm', 'sp', 'wg', 'wynn', 'dk', 'fd', 'pin']);
function betsBookIcon(k, size = 32) {
  if (BETS_BOOK_ICON.has(k)) return `<img class="bets-bk-ico" src="icons/books/${k}.png" width="${size}" height="${size}" alt="" loading="lazy">`;
  const name = k === 'other' ? '…' : (betsBook(k)?.short || k || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  return `<span class="bets-bk-ico bets-bk-mono" style="width:${size}px;height:${size}px" aria-hidden="true">${esc(name)}</span>`;
}
// Better for the bettor: the better number first, then the better price.
function betsBetter(mkt, side, a, b) {
  if (mkt !== 'ml' && a.line !== b.line) return mkt === 't' ? (side === 'over' ? a.line < b.line : a.line > b.line) : a.line > b.line;
  return (betsDec(a.odds) || 0) > (betsDec(b.odds) || 0);
}
// Every book's price for this exact pick. Only fresh selection evidence can change the slip.
function betsSlipBooksHTML(l, sel) {
  if (!l) return '';
  const g = betsGame(l.pk), live = g?.state === 'Live';
  if (!betsIsPre(g) && !live) return '';
  const f5 = l.mkt.startsWith('f5'), base = f5 ? l.mkt.slice(2) : l.mkt;
  if (live && f5) return '';
  const O = betsOddsFor(l.pk), books = live ? O?.live : f5 ? O?.f5 : O?.books;
  if (!books) return '';
  const rows = [];
  for (const b of betsBookList()) {
    const L = books[b.key], p = betsQuote(l.pk, b.key, l.mkt, l.side);
    if (!p || p.odds == null || (base !== 'ml' && p.line == null)) continue;
    const enabled = p.actionable && (p.freshness === 'FRESH' || p.freshness === 'AGING');
    rows.push({ k: b.key, p, typed: !live && !!L?.m, old: !enabled, enabled,
      state: live ? enabled ? 'Live' : p.freshness : typeof oddsStateLabel === 'function' ? oddsStateLabel(p) : p.freshness });
  }
  if (!rows.length) return '';
  const best = rows.filter((r) => r.enabled).reduce((a, r) => (!a || betsBetter(base, l.side, r.p, a.p) ? r : a), null)?.k || null;
  rows.sort((a, b) => (a.k === best ? -1 : b.k === best ? 1 : 0) || Number(b.enabled) - Number(a.enabled) || (betsBetter(base, l.side, a.p, b.p) ? -1 : betsBetter(base, l.side, b.p, a.p) ? 1 : 0));
  const priceTxt = (p) => (base === 'ml' ? betsFmtOdds(p.odds) : `${base === 't' ? (l.side === 'over' ? 'o' : 'u') + betsFmtTot(p.line) : betsFmtLine(p.line)} ${betsFmtOdds(p.odds)}`);
  const spoken = (s) => s.replace(new RegExp(BETS_MINUS, 'g'), 'minus ').replace(/\+/g, 'plus ');
  return `<div class="bets-books-h"><span>Where to bet</span><span>Tap a fresh price to use it · <button type="button" class="bets-k" data-bets-books>book links</button></span></div>
    <div class="bets-books" role="group" aria-label="Choose a book">${rows.map((r) => `<button type="button" class="bets-bk${sel === r.k ? ' on' : ''}${r.old ? ' old' : ''}" ${r.enabled ? `data-bets-book="${r.k}"` : 'disabled'} aria-pressed="${sel === r.k}" aria-label="${esc(spoken(`${betsBookFull(r.k)}: ${priceTxt(r.p)}, ${r.state}${r.k === best ? ', best price' : ''}${r.typed ? ', typed in' : ''}${r.old ? ', unavailable for prefill' : ''}`))}">
      ${betsBookIcon(r.k)}<span class="bets-bk-n">${esc(betsBookName(r.k))}</span><span class="bets-bk-p num">${esc(priceTxt(r.p))}</span><span class="bets-bk-tag">${esc(r.state)}${r.k === best ? ' · Best' : ''}${r.typed ? ' · Typed' : ''}</span>
    </button>`).join('')}
      <button type="button" class="bets-bk${sel === 'other' ? ' on' : ''}" data-bets-book="other" aria-pressed="${sel === 'other'}" aria-label="Another book. Type the price.">${betsBookIcon('other')}<span class="bets-bk-n">Other</span><span class="bets-bk-p">Type the price</span></button>
    </div>${betsWhereHTML(sel)}`;
}
// ------------------------------------------------------------ where to bet
// Where to place it: the book's own site and its Nevada app. You sign in at the book — this app never asks
// for a sportsbook login, never stores one, and never places a bet.
function betsBookGo(k) {
  const b = betsBook(k) || {};
  return { site: b.site || null, app: b.ios || null };
}
function betsWhereHTML(book) {
  const { site, app } = betsBookGo(book);
  if (!site && !app) return `<p class="bets-go"><button type="button" class="bets-k" data-bets-books>Where to bet ↗</button><span>Pick a Nevada book to place this at.</span></p>`;
  const links = [site ? `<a class="bets-k" href="${site}" target="_blank" rel="noopener noreferrer">Open ${esc(betsBookFull(book))} ↗</a>` : '',
                 app ? `<a class="bets-k" href="${app}" target="_blank" rel="noopener noreferrer">Get the app ↗</a>` : ''].filter(Boolean).join('');
  return `<p class="bets-go">${links}<span>You sign in at the book. Prices there can differ from what\u2019s shown here \u2014 check the ticket before you bet.</span></p>`;
}
// Every Nevada book on the board, with the two ways in. Nothing here takes a login.
function betsBooksSheet() {
  const all = betsBookList();
  const nv = all.filter((b) => b.nv);
  const off = all.filter((b) => !b.nv);
  const row = (b) => {
    const links = [b.site ? `<a class="bets-btn ghost sm" href="${b.site}" target="_blank" rel="noopener noreferrer">Open site \u2197</a>` : '',
                   b.ios ? `<a class="bets-btn ghost sm" href="${b.ios}" target="_blank" rel="noopener noreferrer">Get the app \u2197</a>` : ''].filter(Boolean).join('');
    const tags = [b.sharp ? '<span class="bets-tag sharp">Sharp</span>' : '', b.feed ? '<span class="bets-tag">Live on the board</span>' : '<span class="bets-tag">Counter numbers</span>'].join('');
    return `<div class="bets-bkrow">${betsBookIcon(b.key, 36)}<div class="bets-bkrow-m"><b>${esc(b.name)}</b><div class="bets-tags">${tags}</div></div>
      <div class="bets-bkrow-go">${links || '<span class="bets-m">No app or site \u2014 at the window only</span>'}</div></div>`;
  };
  openSheet(`<h2 id="dlgTitle">Where to bet</h2>
    <p class="odds-lede">Bing Bong Live shows the numbers. The bet is placed at the book: these open the book\u2019s own site or its Nevada app, where you sign in yourself. This app never asks for a sportsbook login, never stores one, and never places a bet for you.</p>
    ${typeof oddsMyBooksPicker === 'function' ? oddsMyBooksPicker() : ''}
    <div class="card bets-note" style="margin-top:16px"><b>Two things Nevada asks first</b>Nevada apps make you sign up in person at the casino once, with ID. After that you can bet from your phone, but only while you\u2019re inside the state.</div>
    <h3 class="sub-h" style="margin-top:20px">Nevada books</h3>
    <div class="card bets-bklist">${nv.map(row).join('')}</div>
    <h3 class="sub-h" style="margin-top:20px">On the board for comparison</h3>
    <p class="bets-m" style="margin:0 0 8px">${esc(off.map((b) => b.name).join(', '))} don\u2019t take Nevada bets. They\u2019re here because the sharp offshore number and the big national apps tell you where the market really is.</p>`, 'books');
}

// The parlay button follows what's in your parlay right now.
function betsBtnsHTML() {
  const sl = BETS.slip;
  const single = sl.legs.length === 1 && !sl.parlay;
  const save = `<button class="bets-btn" type="button" data-bets-save>${sl.limAck ? 'Save anyway' : 'Save bet'}</button>`;
  if (!single) return `<div class="bets-btns">${save}</div>`;
  const l = sl.legs[0];
  const n = BETS.parlay.length;
  const inIt = BETS.parlay.some((x) => Number(x.pk) === Number(l.pk) && x.mkt === l.mkt);
  const now = BETS.parlay.reduce((p, x) => p * (betsDec(x.odds) || 1), 1);
  const okOdds = Number.isFinite(l.odds) && Math.abs(l.odds) >= 100;
  const combo = n && okOdds ? betsToAm(now * betsDec(l.odds)) : null;
  const line = n ? `<p class="bets-parlay-l">Your parlay: ${betsPlural(n, 'leg')} · <span class="num">${esc(betsFmtOdds(betsToAm(now)))}</span> <button type="button" class="bets-link" data-bets-parlay-open aria-label="Review your ${betsPlural(n, 'leg')} parlay">Review</button></p>` : '';
  const btn = inIt ? `<button class="bets-btn ghost" type="button" data-bets-parlay-open aria-label="This pick is in your parlay. Review the parlay.">In your parlay ✓ · Review</button>`
    : n >= 12 ? ''
    : n ? `<button class="bets-btn ghost" type="button" data-bets-addleg aria-label="${esc(`Add as leg ${n + 1}${combo != null ? `, parlay odds ${betsFmtOdds(combo).replace(BETS_MINUS, 'minus ')}` : ''}`)}">Add as leg ${n + 1}${combo != null ? ` · <span class="num">${esc(betsFmtOdds(combo))}</span>` : ''}</button>`
    : '<button class="bets-btn ghost" type="button" data-bets-addleg>Start a parlay</button>';
  return `${line}<div class="bets-btns">${btn}${save}</div>`;
}
function betsSlipHTML() {
  const sl = BETS.slip;
  if (sl.pick && !sl.legs.length) return betsPickerHTML();
  const single = sl.legs.length === 1;
  const l0 = sl.legs[0];
  const g0 = betsGame(l0?.pk);
  const odds = betsSlipOdds();
  const books = betsBookList();
  const bookOpts = [['', 'Choose a book'], ...books.map((b) => [b.key, b.name]), ['other', 'Other']]
    .map(([k, n]) => `<option value="${esc(k)}" ${sl.book === k ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const tiles = single && !sl.parlay ? betsSlipBooksHTML(l0, sl.book) : '';
  const showBook = true;
  const lineVal = single && l0.mkt !== 'ml' && Number.isFinite(l0.line) ? (l0.mkt === 't' ? betsFmtTot(l0.line) : betsFmtLine(l0.line).replace(BETS_MINUS, '-')) : '';
  const legRow = (l, i) => {
    const g = betsGame(l.pk);
    const when = g ? (betsIsLive(g) ? `live, ${betsInningText(g)}` : betsIsFinal(g) ? 'final' : betsWhen(g.start)) : '';
    const label = betsLegLabel(g, l);
    return `<div class="card bets-pick"><div class="bets-pick-t"><b class="num">${esc(label)}</b><span>${esc([betsMatchup(g), when, single ? '' : l.book ? betsBookName(l.book) : ''].filter(Boolean).join(' · '))}</span></div>
      ${single ? '' : `<span class="num bets-pick-o">${esc(betsFmtOdds(l.odds))}</span><button class="bets-x" type="button" data-bets-rmleg="${i}" aria-label="Remove ${esc(label)} from the parlay">✕</button>`}</div>`;
  };
  return `
    <h2 id="dlgTitle">${single ? 'Log this bet' : `${sl.legs.length}-leg parlay`}</h2>
    <p class="bets-lede">${single ? esc(BETS_MKT[l0.mkt] || '') : 'Every leg has to win. Pushes drop out.'}</p>
    <div class="bets-picks">${sl.legs.map(legRow).join('')}</div>
    <div class="bets-fgrid portfolio-entry-primary">
      ${single && l0.mkt !== 'ml' && l0.mkt !== 'f5ml' ? `<label class="bets-fld">Line<input class="bets-inp" id="betsLine" inputmode="text" autocomplete="off" value="${esc(lineVal)}"></label>` : ''}
      <label class="bets-fld">${single ? 'Odds' : 'Ticket odds'}<input class="bets-inp" id="betsOdds" inputmode="text" autocomplete="off" value="${esc(Number.isFinite(odds) ? String(odds) : '')}" placeholder="-110"></label>
      <label class="bets-fld${!showBook && single && l0.mkt !== 'ml' ? ' bets-full' : ''}">Stake ($)<input class="bets-inp" id="betsStake" inputmode="decimal" autocomplete="off" value="${esc(Number.isFinite(sl.stake) ? String(sl.stake) : '')}" placeholder="Amount"></label>
      ${showBook ? `<label class="bets-fld${single && l0.mkt !== 'ml' ? '' : ' bets-full-m'}">Book<span class="bets-sel"><select class="bets-inp" id="betsBook">${bookOpts}</select></span></label>` : ''}
    </div><details class="portfolio-entry-more"><summary>Add a note</summary><div class="bets-fgrid">
      <label class="bets-fld bets-full">Note<input class="bets-inp bets-note" id="betsNote" autocomplete="off" placeholder="Optional: why you like it" maxlength="200" value="${esc(sl.note || '')}"></label>
    </div></details>
    ${single && g0 && betsIsFinal(g0) ? '<p class="bets-note-p">This game is over, so it can’t be logged.</p>' : ''}
    <div class="bets-err" id="betsErr" role="alert"></div>
    <div id="betsLim" aria-live="polite">${typeof limSlipHTML === 'function' ? limSlipHTML(sl) : ''}</div>
    <div id="betsBtns">${betsBtnsHTML()}</div>
    ${tiles ? `<details class="portfolio-entry-more"><summary>Compare available prices</summary><div>${tiles}</div></details>` : ''}
    <details class="portfolio-entry-more"><summary>Payout &amp; price analysis</summary><div id="betsCalc">${betsCalcHTML()}</div></details>`;
}
// Payout, implied chance and the price against the sharp fair price. Redrawn on every keystroke.
function betsCalcHTML() {
  const sl = BETS.slip;
  const single = sl.legs.length === 1;
  const l0 = sl.legs[0];
  const g0 = betsGame(l0?.pk);
  const odds = betsSlipOdds();
  const okOdds = Number.isFinite(odds) && Math.abs(odds) >= 100;
  const win = okOdds && sl.stake > 0 ? betsToWin(sl.stake, odds) : null;
  const fair = single && okOdds ? betsFair({ ...l0, odds }) : null;
  const src = fair ? betsBookName(fair.src) || 'sharp' : '';
  const words = single && l0 ? betsWords(g0, { ...l0, odds }, okOdds) : '';
  const vs = fair && Number.isFinite(fair.ev) ? `${fair.est ? '≈ ' : ''}${fair.ev >= 0 ? '+' : BETS_MINUS}${Math.abs(Math.round(fair.ev * 100))}%` : '—';
  return `<div class="bets-calc">
      <div><div class="k">To win</div><div class="v num">${win == null ? '—' : betsFmtMoney(Math.round(win * 100) / 100)}</div></div>
      <div><div class="k">Implied</div><div class="v num">${okOdds ? betsFmtPct(betsImp(odds), 1) : '—'}</div></div>
      <div><div class="k">${fair ? `vs ${esc(src)}${fair.est ? ' (est.)' : ''}` : 'vs sharp'}</div><div class="v num soft">${vs}</div></div>
    </div>
    ${betsKellySlipHTML(fair, odds, okOdds, sl.stake)}
    ${words || fair ? `<p class="bets-note-p">${esc(words)}${fair ? ` With the cut removed, ${esc(src)}’s price implies about ${Math.round(fair.p * 100)}% for this side: the market’s estimate, not a sure thing. ${fair.ev > 0 ? `Reading: ${esc(BETS_CONF[fair.conf] || fair.conf || 'est.')}.` : 'This price is at or below the sharp price.'}` : ''}</p>` : ''}
    ${single || sl.parlay ? betsBookLinkHTML(sl.book) : ''}`;
}
// Kelly sizing, only when asked: collapsed, never fills the stake by itself, and needs a bankroll you entered.
function betsKellySlipHTML(fair, odds, okOdds, stake) {
  if (!fair || !okOdds) return '';
  const c = betsKellyCfg();
  const open = BETS.slip?.kOpen ? ' open' : '';
  if (!c.bankroll) return `<details class="bets-kslip"${open}><summary>Kelly sizing</summary><p>Kelly sizing needs a bankroll. <button type="button" class="bets-link" data-bets-kelly-settings>Set one in Results</button></p></details>`;
  const push = fair.push || 0;
  const k = betsKellyStake(fair.p, odds, push);
  if (!k) return '';
  if (!k.dollars) return `<details class="bets-kslip"${open}><summary>Kelly sizing</summary><p>At ${esc(betsFmtOdds(odds))} this is at or below the sharp price, so Kelly sizing is $0.</p></details>`;
  const same = Math.abs((stake || 0) - k.dollars) < 0.5;
  return `<details class="bets-kslip"${open}><summary>Kelly sizing</summary><p>At your ${esc(betsKellyName())} settings this works out to <b class="num">${esc(betsFmtMoney(k.dollars))}</b> (${(k.pct * 100).toFixed(1)}% of your bankroll${k.capped ? ', held to your cap' : ''}). Kelly assumes the win chance is right; if it’s too high, Kelly bets too much.</p>${same ? '<span class="bets-kon">Stake matches</span>' : `<button type="button" class="bets-link" data-bets-kelly-use="${k.dollars}">Put ${esc(betsFmtMoney(k.dollars))} in the stake</button>`}</details>`;
}
// A plain link to a Nevada book's own page. Prices there can differ.
function betsBookLinkHTML(book) {
  const url = BETS_SITE[book];
  if (!url) return '';
  return `<p class="bets-go"><a class="bets-link" href="${url}" target="_blank" rel="noopener noreferrer">Open ${esc(betsBookFull(book))} ↗</a><span>Prices there can differ from what’s shown here. Check the ticket before you bet.</span></p>`;
}
function betsUpdateCalc() {
  const el = $('#betsCalc');
  if (el) el.innerHTML = betsCalcHTML();
  const lim = $('#betsLim');
  if (lim && typeof limSlipHTML === 'function') { const h = limSlipHTML(BETS.slip); if (lim.dataset.key !== h) { lim.innerHTML = h; lim.dataset.key = h; } }
  const bt = $('#betsBtns');
  if (bt) bt.innerHTML = betsBtnsHTML();
  betsShowProblems([]);
}

// Log a bet by hand: pick a game, then a side.
function betsPickerHTML() {
  const src = S.isToday ? S.games : BETS.games;
  const games = [...src.values()].filter((g) => betsIsPre(g) || betsIsLive(g)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const sel = BETS.slip.pickPk || '';
  return `<h2 id="dlgTitle">Log a bet</h2><p class="bets-lede">Pick the game, then the side. Or tap any price on the odds board.</p>
    ${games.length ? `<div class="bets-fgrid"><label class="bets-fld bets-full">Game<span class="bets-sel"><select class="bets-inp" id="betsPickGame"><option value="">Choose a game</option>${games.map((g) => `<option value="${g.pk}" ${String(sel) === String(g.pk) ? 'selected' : ''}>${esc(`${betsWhen(g.start)} · ${g.away.abbr} @ ${g.home.abbr}`)}</option>`).join('')}</select></span></label></div>
    <div id="betsPickSides">${sel ? betsPickSides(sel) : ''}</div>` : '<div class="card empty"><b>No games left today</b>Bets can be logged for games that haven’t finished.</div>'}`;
}
function betsPickSides(pk) {
  const g = betsGame(pk);
  if (!g) return '';
  const btn = (mkt, side, label) => {
    const p = betsPrice(pk, 'cons', mkt, side);
    const px = p ? (mkt === 'ml' ? betsFmtOdds(p.odds) : mkt === 't' ? betsFmtTot(p.line) : betsFmtLine(p.line)) : '';
    return `<button class="bets-chip" type="button" data-bets-pick="${g.pk}|${mkt}|${side}">${esc(label)}${px ? ` <small class="num">${esc(px)}</small>` : ''}</button>`;
  };
  return `<h3 class="sub-h bets-pick-h">Moneyline</h3><div class="bets-chips">${btn('ml', 'away', g.away.abbr)}${btn('ml', 'home', g.home.abbr)}</div>
    <h3 class="sub-h bets-pick-h">Run line</h3><div class="bets-chips">${btn('rl', 'away', g.away.abbr)}${btn('rl', 'home', g.home.abbr)}</div>
    <h3 class="sub-h bets-pick-h">Total runs</h3><div class="bets-chips">${btn('t', 'over', 'Over')}${btn('t', 'under', 'Under')}</div>`;
}

function betsReadSlip() {
  const sl = BETS.slip;
  if (!sl) return;
  const num = (id) => {
    const el = $(id);
    if (!el) return undefined;
    const t = String(el.value).trim().replace(/[−–]/g, '-');
    if (t === '') return NaN;
    if (/^pk$/i.test(t)) return 0;
    if (/^ev(en)?$/i.test(t)) return 100;
    return Number(t.replace(/[$,\s]/g, '').replace(/^\+/, ''));
  };
  const line = num('#betsLine'), odds = num('#betsOdds'), stake = num('#betsStake');
  if (line !== undefined && sl.legs.length === 1) sl.legs[0].line = line;
  if (odds !== undefined) { if (sl.legs.length === 1) sl.legs[0].odds = odds; sl.odds = odds; }
  if (stake !== undefined) sl.stake = stake;
  const bk = $('#betsBook')?.value;
  if (bk != null) { sl.book = bk; if (sl.legs.length === 1) sl.legs[0].book = bk === 'other' ? '' : bk; }
  const note = $('#betsNote')?.value;
  if (note != null) sl.note = note;
}
// A list of [fieldId, message]; empty means good to save. needStake=false for Add to parlay.
function betsProblems(needStake = true) {
  const sl = BETS.slip;
  const out = [];
  // The stake is optional (the log still grades and tracks prices); if typed, it has to read as an amount.
  if (needStake && !Number.isNaN(sl.stake) && sl.stake != null && !(sl.stake > 0)) out.push(['#betsStake', 'Enter an amount above $0, or leave it empty.']);
  if (needStake && Number.isNaN(sl.stake) && String($('#betsStake')?.value || '').trim() !== '') out.push(['#betsStake', 'That amount doesn’t read right.']);
  if (needStake && sl.stake > 1e6) out.push(['#betsStake', 'That stake looks too big. Check the amount.']);
  const odds = sl.legs.length === 1 ? sl.legs[0].odds : sl.odds;
  if (!Number.isFinite(odds) || Math.abs(odds) < 100 || Math.abs(odds) > 100000) out.push(['#betsOdds', 'Use American odds like −110 or +150.']);
  const l0 = sl.legs[0];
  if (sl.legs.length === 1 && l0.mkt !== 'ml') {
    const bad = !Number.isFinite(l0.line) || Math.abs(l0.line) > 40 || (l0.mkt === 't' && l0.line <= 0) || Math.round(l0.line * 2) !== l0.line * 2;
    if (bad) out.push(['#betsLine', l0.mkt === 't' ? 'Enter the total, like 8.5.' : 'Enter the run line, like −1.5 or +1.5.']);
  }
  return out;
}
function betsShowProblems(list) {
  for (const id of ['#betsStake', '#betsOdds', '#betsLine']) { const el = $(id); if (el) { el.removeAttribute('aria-invalid'); el.closest('.bets-fld')?.querySelector('.bets-hint')?.remove(); } }
  for (const [id, msg] of list) {
    const el = $(id);
    if (!el) continue;
    el.setAttribute('aria-invalid', 'true');
    el.insertAdjacentHTML('afterend', `<span class="bets-hint">${esc(msg)}</span>`);
  }
  if (list.length) $(list[0][0])?.focus();
}
function betsLegOut(l) {
  const g = betsGame(l.pk);
  return { pk: Number(l.pk), mkt: l.mkt, side: l.side, line: l.mkt === 'ml' ? null : l.line, odds: l.odds, label: l.label || betsLegLabel(g, l), matchup: l.matchup || betsMatchup(g), start: l.start || g?.start || null, book: l.book || '' };
}
async function betsSave() {
  betsReadSlip();
  const sl = BETS.slip;
  const problems = betsProblems(true);
  betsShowProblems(problems);
  if (problems.length) return;
  if (sl.legs.length === 1 && betsIsFinal(betsGame(sl.legs[0].pk))) { $('#betsErr').textContent = 'This game is over.'; return; }
  if (typeof limSlipGate === 'function' && !limSlipGate(sl)) return; // a play limit: one calm notice, then Save anyway
  const legs = sl.legs.map(betsLegOut);
  const book = sl.book === 'other' ? 'Other' : sl.book ? betsBookFull(sl.book) : '';
  const btn = $('[data-bets-save]');
  if (btn) btn.disabled = true;
  try {
    const bet = await betsApi('/api/bets', { method: 'POST', body: JSON.stringify({ legs, stake: sl.stake > 0 ? sl.stake : null, odds: legs.length > 1 ? betsSlipOdds() : undefined, book, note: (sl.note || '').trim() }) });
    if (bet?.id && !BETS.list.some((b) => b.id === bet.id)) BETS.list = [bet, ...BETS.list];
    if (sl.parlay) { BETS.parlay = []; betsTray(); }
    const back = sl.returnTo;
    BETS.slip = null;
    betsReturn(back);
    betsToast('Bet saved. It grades itself when the game ends.', bet?.id ? { label: 'Undo', run: () => betsRemoveNow(bet.id) } : null);
    invalidate();
  } catch (e) {
    if (btn) btn.disabled = false;
    const el = $('#betsErr');
    if (el) el.textContent = e.message;
  }
}
// Undo right after saving: take it away now and delete it on the server.
function betsRemoveNow(id) {
  BETS.pending.add(id);
  invalidate();
  betsApi(`/api/bets/${encodeURIComponent(id)}`, { method: 'DELETE' })
    .then(() => { BETS.list = BETS.list.filter((b) => b.id !== id); BETS.pending.delete(id); invalidate(); })
    .catch((e) => { BETS.pending.delete(id); betsToast(e.message); betsRefresh(); });
}
function betsAddLeg() {
  betsReadSlip();
  const problems = betsProblems(false);
  betsShowProblems(problems);
  if (problems.length) return;
  const sl = BETS.slip;
  const l = betsLegOut(sl.legs[0]);
  if (betsIsFinal(betsGame(l.pk))) { $('#betsErr').textContent = 'This game is over.'; return; }
  if (BETS.parlay.some((x) => x.pk === l.pk && x.mkt === l.mkt)) { $('#betsErr').textContent = 'That game and market is already in the parlay.'; return; }
  if (BETS.parlay.length >= 12) { $('#betsErr').textContent = 'A parlay here holds up to 12 legs.'; return; }
  BETS.parlay.push(l);
  betsTraySave();
  const back = sl.returnTo;
  BETS.slip = null;
  betsReturn(back);
  betsToast(`Added. ${betsPlural(BETS.parlay.length, 'leg')} in the parlay.`);
  betsTray();
}

// ------------------------------------------------------------ parlay tray (kept for a day across restarts)
function betsTraySave() { store.set('betsParlay', { at: Date.now(), legs: BETS.parlay }); }
function betsTray() {
  let t = $('#betsTray');
  if (!t) {
    t = document.createElement('div');
    t.id = 'betsTray';
    t.className = 'bets-tray';
    t.setAttribute('role', 'region');
    t.setAttribute('aria-label', 'Parlay');
    document.body.appendChild(t);
  }
  const n = BETS.parlay.length;
  t.hidden = !n;
  document.body.classList.toggle('bets-tray-on', !!n);
  if (!n) { t.innerHTML = ''; return; }
  const d = BETS.parlay.reduce((p, l) => p * (betsDec(l.odds) || 1), 1);
  const html = `<span class="bets-tray-t"><b>${betsPlural(n, 'leg')}</b> · <span class="num">${esc(betsFmtOdds(betsToAm(d)))}</span></span><button type="button" data-bets-parlay-open aria-label="Review the ${betsPlural(n, 'leg')} parlay">Review</button><button type="button" class="bets-tray-x" data-bets-parlay-clear aria-label="Clear the parlay">✕</button>`;
  if (t.dataset.key !== html) { t.innerHTML = html; t.dataset.key = html; }
}

// ------------------------------------------------------------ live chance to cash (est.)
// A simple, honest model: each team's remaining runs are Poisson, at a per-half-inning rate from the pre-game total
// (8.8 if none), split by the pre-game moneyline. Innings left come from the live inning, half and outs. A tie after
// the last out goes to extras, where the favorite is a slight edge and the final margin is one run.
const betsPois = (lam, K = 30) => { const out = []; let p = Math.exp(-lam); for (let k = 0; k <= K; k++) { out.push(p); p = (p * lam) / (k + 1); } return out; };
function betsHalvesLeft(g) {
  const n = g.inning || 1, half = String(g.half || '').toLowerCase(), outs = clamp(g.outs ?? 0, 0, 3);
  const cur = (3 - outs) / 3;
  const rest = Math.max(0, 9 - n);
  const hLead = (g.home.score ?? 0) > (g.away.score ?? 0);
  if (half.startsWith('t')) return { a: rest + cur, h: rest + 1 };
  if (half.startsWith('m')) return { a: rest, h: n >= 9 && hLead ? 0 : rest + 1 };
  if (half.startsWith('b')) return { a: rest, h: rest + cur };
  return { a: rest, h: rest };
}
function betsLiveDist(g) {
  const O = betsOddsFor(g.pk);
  const L = O?.close || O?.books?.cons || O?.books?.pin || null;
  const total = Number.isFinite(L?.t?.line) ? L.t.line : 8.8;
  let pH = 0.5;
  if (L?.ml?.[0] != null && L?.ml?.[1] != null) { const a = betsImp(L.ml[0]), b = betsImp(L.ml[1]); pH = a / (a + b); }
  const shareH = clamp(0.5 + (pH - 0.5) * 0.6, 0.3, 0.7);
  const left = betsHalvesLeft(g);
  const A = betsPois((total * (1 - shareH) / 9) * left.a), H = betsPois((total * shareH / 9) * left.h);
  const a0 = g.away.score ?? 0, h0 = g.home.score ?? 0;
  const pTieH = clamp(0.5 + (pH - 0.5) * 0.5, 0.3, 0.7);
  const margin = new Map(), tot = new Map();
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < H.length; j++) {
      const p = A[i] * H[j];
      if (p < 1e-9) continue;
      const d = h0 + j - (a0 + i), t = h0 + j + a0 + i;
      if (d === 0) { margin.set(1, (margin.get(1) || 0) + p * pTieH); margin.set(-1, (margin.get(-1) || 0) + p * (1 - pTieH)); tot.set(t + 1, (tot.get(t + 1) || 0) + p); } // extras: about one more run
      else { margin.set(d, (margin.get(d) || 0) + p); tot.set(t, (tot.get(t) || 0) + p); }
    }
  }
  return { margin, tot };
}
// { p: chance to win, push } for one open leg of a live game.
function betsLiveChance(g, l) {
  if (!betsIsLive(g)) return null;
  const { margin, tot } = betsLiveDist(g);
  let win = 0, push = 0, all = 0;
  if (l.mkt === 'ml' || l.mkt === 'rl') {
    const line = l.mkt === 'ml' ? 0 : l.line ?? 0;
    for (const [d, p] of margin) {
      const mine = (l.side === 'home' ? d : -d) + line;
      all += p;
      if (mine > 0) win += p; else if (mine === 0 && l.mkt === 'rl') push += p;
    }
  } else if (l.mkt === 't') {
    for (const [t, p] of tot) {
      const mine = l.side === 'over' ? t - l.line : l.line - t;
      all += p;
      if (mine > 0) win += p; else if (mine === 0) push += p;
    }
  } else return null;
  if (!all) return null;
  return { p: clamp(win / all, 0.005, 0.995), push: push / all };
}
// Where a leg stands on the scoreboard: > 0 is winning, in runs past the number.
function betsLegNow(l, g, fin) {
  const h = fin ? fin.h : g?.home?.score, a = fin ? fin.a : g?.away?.score;
  if (h == null || a == null) return null;
  if (l.mkt === 'ml') return l.side === 'home' ? h - a : a - h;
  if (l.mkt === 'rl') return (l.side === 'home' ? h - a : a - h) + (l.line ?? 0);
  if (l.mkt === 't') return l.side === 'over' ? h + a - l.line : l.line - (h + a);
  return null;
}

// ------------------------------------------------------------ Most likely to hit
const BETS_TIERS = [[0.6, 'Likely'], [0.4, 'Toss-up'], [0, 'Long shot']];
const betsTier = (p) => BETS_TIERS.find(([t]) => p >= t)[1];
function betsHitLeg(l) {
  if (l.state === 'won') return { p: 1, how: 'won' };
  if (l.state === 'lost') return { p: 0, how: 'lost' };
  if (l.state === 'push' || l.state === 'void') return { p: 1, how: 'push' };
  const g = betsGame(l.pk);
  if (!g) return { p: betsImp(l.odds) ?? 0.5, how: 'price' };
  if (betsIsFinal(g)) { const now = betsLegNow(l, g); return { p: now > 0 ? 1 : now < 0 ? 0 : 1, how: now > 0 ? 'won' : now < 0 ? 'lost' : 'push', now, g }; }
  if (betsIsLive(g)) {
    const c = betsLiveChance(g, l);
    return { p: c ? c.p : 0.5, how: 'live', now: betsLegNow(l, g), g, rough: !c };
  }
  const f = betsFair(l);
  if (f) return { p: f.p, how: 'fair', g };
  return { p: betsImp(l.odds) ?? 0.5, how: 'price', g };
}
function betsHitBet(b) {
  const legs = b.legs.map((l) => ({ l, ...betsHitLeg(l) }));
  const p = legs.reduce((acc, x) => acc * x.p, 1);
  const open = legs.filter((x) => x.how === 'live' || x.how === 'fair' || x.how === 'price');
  const pays = betsToWin(b.stake, b.odds) || 0;
  const weakest = [...open].sort((x, y) => x.p - y.p)[0] || legs[0];
  const live = legs.some((x) => x.how === 'live');
  const first = Math.min(...legs.map((x) => (x.g ? Date.parse(x.g.start) : Date.parse(x.l.start) || Infinity)));
  // green only when your ticket is actually winning right now
  const winning = live && legs.every((x) => x.how === 'won' || x.how === 'push' || (x.how === 'live' && x.now > 0));
  return { b, legs, p, pays, ev: b.stake > 0 ? p * pays - (1 - p) * b.stake : null, weakest, live, first, winning };
}
function betsHitStatus(x) {
  if (x.b.legs.length > 1) {
    const left = x.legs.filter((y) => y.how === 'live' || y.how === 'fair' || y.how === 'price').length;
    return `${left} of ${x.legs.length} legs left${x.weakest && left ? ` · weakest ${esc(x.weakest.l.label || '')} ${betsFmtPct(x.weakest.p)}` : ''}`;
  }
  const g = x.weakest?.g;
  if (!g) return esc(x.b.legs[0].matchup || '');
  if (betsIsLive(g)) {
    const now = x.weakest.now, l = x.weakest.l;
    const where = now == null ? '' : l.mkt === 't' ? '' : now > 0 ? ` · ahead by ${betsTrim(now)}` : now < 0 ? ` · needs ${betsTrim(-now)}` : ' · even';
    return `<span class="dot pulse" aria-hidden="true"></span>${esc(g.away.abbr)} ${g.away.score ?? 0}–${g.home.score ?? 0} ${esc(g.home.abbr)} · ${esc(betsInningText(g))}${esc(where)}`;
  }
  return `${esc(betsMatchup(g))} · ${esc(betsWhen(g.start))}`;
}
function betsHitList(open) {
  if (!open.length) return '';
  const rows = open.map(betsHitBet);
  const sort = store.get('betsHitSort', 'p');
  rows.sort(sort === 'time' ? (a, b) => a.first - b.first || b.p - a.p : (a, b) => b.p - a.p || a.first - b.first);
  const exp = rows.reduce((s, x) => s + x.p, 0);
  const staked = rows.filter((x) => x.ev != null);
  const ev = staked.reduce((s, x) => s + x.ev, 0);
  const risk = rows.reduce((s, x) => s + (x.b.stake || 0), 0);
  const anyPrice = rows.some((x) => x.legs.some((y) => y.how === 'price'));
  const row = (x, i) => {
    const pct = Math.round(x.p * 100);
    const pk = x.weakest?.l?.pk || x.b.legs[0].pk;
    const tier = betsTier(x.p);
    return `<button type="button" class="bets-hit-row${x.live ? ' is-live' : ''}" data-bets-game="${esc(pk)}" aria-label="${esc(`${betsLabel(x.b)}, ${pct}% estimated chance to cash, ${tier}. Opens the game.`)}">
      <span class="bets-hit-rk num" aria-hidden="true">${i + 1}</span>
      <span class="bets-hit-main">
        <b class="bets-hit-pick">${esc(betsLabel(x.b))} <small class="num">${esc(betsFmtOdds(x.b.odds))}</small></b>
        <span class="bets-hit-sub">${betsHitStatus(x)}</span>
        <span class="bets-hit-bar" aria-hidden="true"><i class="${x.winning ? 'win' : ''}" style="width:${Math.max(2, pct)}%"></i><em></em></span>
      </span>
      <span class="bets-hit-v"><b class="num${x.winning && x.p >= 0.5 ? ' win' : ''}">${pct}%</b><span class="bets-tier t-${tier.replace(/\W/g, '').toLowerCase()}">${tier}</span></span>
    </button>`;
  };
  return `<section class="card bets-hit" aria-labelledby="betsHitTitle">
    <div class="bets-hit-h">
      <div><h3 id="betsHitTitle">Most likely to hit</h3><p>Updates live. Chances are est.${rows.some((x) => x.winning) ? ' A green bar is winning right now.' : ''}${anyPrice ? ' Some pre-game bets use the price you took.' : ''}</p></div>
      <div class="seg bets-seg-sm" role="group" aria-label="Order"><button type="button" data-bets-hitsort="p" aria-pressed="${sort !== 'time'}">Likeliest</button><button type="button" data-bets-hitsort="time" aria-pressed="${sort === 'time'}">First pitch</button></div>
    </div>
    <div class="bets-sum3">
      <div><b class="num">${exp.toFixed(1)}</b><span>of ${open.length} expected to cash, est.</span></div>
      <div><b class="num">${staked.length ? esc(betsFmtMoney(Math.round(ev), true)) : '—'}</b><span>expected profit, est.${staked.length && staked.length < rows.length ? ` (${staked.length} with a stake)` : ''}</span></div>
      <div><b class="num">${esc(betsFmtMoney(risk))}</b><span>at risk</span></div>
    </div>
    <div class="bets-hit-list">${rows.map(row).join('')}</div>
  </section>`;
}

// ------------------------------------------------------------ My bets
const betsLabel = (b) => (b.legs.length > 1 ? `${b.legs.length}-leg parlay` : b.legs[0]?.label || '');
const betsState = (s) => ({ won: 'Won', lost: 'Lost', push: 'Push', void: 'Void', open: 'Open' }[s] || s);
function betsCard(b) {
  const legs = b.legs.map((l) => {
    const g = betsGame(l.pk);
    let status = '', prog = '';
    if (l.state && l.state !== 'open') {
      status = `<span class="bets-cov ${l.state === 'won' ? 'win' : ''}">${esc(betsState(l.state))}</span>`;
      const fin = l.final || (g && betsIsFinal(g) ? { h: g.home.score, a: g.away.score } : null);
      const ab = l.matchup ? l.matchup.split(' @ ') : [g?.away.abbr, g?.home.abbr];
      if (fin && fin.h != null) prog = `<div class="bets-leg-s"><span>Final · ${esc(ab[0] || 'Away')} ${fin.a}, ${esc(ab[1] || 'Home')} ${fin.h}</span></div>`;
    } else if (g && betsIsLive(g)) {
      const now = betsLegNow(l, g);
      const c = betsLiveChance(g, l);
      const txt = now == null ? '' : l.mkt === 'ml' ? (now > 0 ? `Up ${now}` : now < 0 ? `Down ${-now}` : 'Tied') : now > 0 ? `+${betsTrim(now)}` : now < 0 ? `${BETS_MINUS}${betsTrim(-now)}` : 'Even';
      status = `<span class="bets-cov ${now > 0 ? 'win' : ''}" aria-label="${esc(now > 0 ? `Winning, ${txt}` : now < 0 ? `Behind, ${txt}` : txt)}">${esc(txt)}</span>`;
      const span = l.mkt === 't' ? 8 : 5;
      const pos = clamp(50 + ((now || 0) / span) * 50, 2, 98);
      prog = `<div class="bets-leg-s"><span>${esc(g.away.abbr)} <b>${g.away.score ?? 0}</b> · ${esc(g.home.abbr)} <b>${g.home.score ?? 0}</b> · ${esc(betsInningText(g))}</span><span>${c ? `est. ${betsFmtPct(c.p)} to cash` : ''}</span></div><div class="bets-prog" aria-hidden="true"><i class="${now > 0 ? 'win' : ''}" style="${now >= 0 ? `left:50%;width:${pos - 50}%` : `left:${pos}%;width:${50 - pos}%`}"></i><b></b></div>`;
    } else if (g && betsIsPre(g)) {
      const cur = betsPrice(l.pk, 'cons', l.mkt, l.side);
      const same = cur && (l.mkt === 'ml' || cur.line === l.line);
      prog = `<div class="bets-leg-s"><span>${esc(betsWhen(l.start || g.start))}${cur ? ` · market now ${esc(l.mkt === 'ml' ? betsFmtOdds(cur.odds) : `${l.mkt === 't' ? betsFmtTot(cur.line) : betsFmtLine(cur.line)} ${same ? betsFmtOdds(cur.odds) : ''}`.trim())}` : ''}</span></div>`;
    } else if (g && betsOff(g)) {
      prog = `<div class="bets-leg-s"><span>${esc(betsInningText(g))}. Postponed games are void.</span></div>`;
    } else if (!g && l.start) {
      prog = `<div class="bets-leg-s"><span>${esc(betsWhen(l.start))}</span></div>`;
    }
    const clv = l.clv ? (l.clv.pts != null && l.clv.pts !== 0 ? `<span class="bets-legclv">${betsSigned(l.clv.pts, l.clv.pts === 1 || l.clv.pts === -1 ? ' run' : ' runs', l.clv.pts % 1 ? 1 : 0)} vs close</span>` : l.clv.pct != null ? `<span class="bets-legclv" title="Your price against the no-vig closing price">${betsSigned(l.clv.pct, '%')} vs close</span>` : l.clv.pts === 0 ? '<span class="bets-legclv">Same as close</span>' : '') : '';
    return `<div class="bets-leg" data-bets-game="${esc(l.pk)}" role="button" tabindex="0" aria-label="${esc(`${l.label}, ${l.matchup || ''}. Opens the game.`)}"><div class="bets-leg-h"><span class="bets-leg-l">${esc(l.label)}${b.legs.length > 1 && l.odds != null ? ` <small class="num">${esc(betsFmtOdds(l.odds))}</small>` : ''}</span>${status}</div><div class="bets-leg-s"><span>${esc(l.matchup || '')}</span>${clv}</div>${prog}</div>`;
  }).join('');
  const st = b.status;
  const live = st === 'open' && b.legs.some((l) => l.state === 'open' && betsIsLive(betsGame(l.pk)));
  const tag = st === 'open' ? (live ? '<span class="bets-tag hot"><span class="dot" aria-hidden="true"></span>Live</span>' : '<span class="bets-tag">Open</span>') : `<span class="bets-tag ${st === 'won' ? 'win' : ''}">${esc(betsState(st))}</span>`;
  const label = betsLabel(b);
  const win = betsToWin(b.stake, b.odds);
  const share = st !== 'void' && typeof shareOpen === 'function' ? `<button type="button" data-share-bet="${esc(b.id)}" aria-label="Share ${esc(label)} as an image">Share</button>` : '';
  const acts = share + (st === 'open'
    ? `<button type="button" data-bets-void="${esc(b.id)}" aria-label="Void ${esc(label)}">Void</button><button type="button" data-bets-del="${esc(b.id)}" aria-label="Delete ${esc(label)}">Delete</button>`
    : `${st === 'void' ? `<button type="button" data-bets-reopen="${esc(b.id)}" aria-label="Restore ${esc(label)}">Restore</button>` : ''}<button type="button" data-bets-del="${esc(b.id)}" aria-label="Delete ${esc(label)}">Delete</button>`);
  const foot = st === 'open'
    ? `<span class="bets-f-t">Placed ${esc(betsShortDate(b.placed || b.created))}${b.note ? ` · ${esc(b.note)}` : ''}</span>`
    : `<span class="bets-f-t">${st === 'void' ? 'No win or loss' : b.net == null ? esc(betsState(st)) : `<b class="num ${b.net > 0 ? 'win' : ''}">${esc(betsFmtMoney(b.net, true))}</b>`} · ${esc(betsShortDate(b.settled || b.placed || b.created))}${b.note ? ` · ${esc(b.note)}` : ''}</span>`;
  return `<article class="card bets-card${st === 'void' ? ' is-void' : ''}" aria-label="${esc(`${label}, ${betsState(st)}`)}">
    <div class="bets-card-h"><div class="bets-card-t"><b>${esc(label)} <span class="num">${esc(betsFmtOdds(b.odds))}</span></b><div class="m">${esc([b.book, b.stake ? `${betsFmtMoney(b.stake)} to win ${betsFmtMoney(win == null ? null : Math.round(win * 100) / 100)}` : ''].filter(Boolean).join(' · '))}</div></div>${tag}</div>
    ${legs}
    <div class="bets-card-f">${foot}<span class="bets-acts">${acts}</span></div>
  </article>`;
}
function betsStats(list) {
  const done = list.filter((b) => b.status !== 'open' && b.status !== 'void');
  const money = done.filter((b) => b.stake > 0 && b.net != null); // bets logged without a stake count in the record only
  const net = money.reduce((s, b) => s + b.net, 0);
  const risked = money.reduce((s, b) => s + b.stake, 0);
  const w = done.filter((b) => b.status === 'won').length, l = done.filter((b) => b.status === 'lost').length, p = done.filter((b) => b.status === 'push').length;
  const open = list.filter((b) => b.status === 'open');
  return { net, risked, roi: risked ? net / risked : null, w, l, p, done: done.length, money: money.length, openRisk: open.reduce((s, b) => s + (b.stake || 0), 0), openWin: open.reduce((s, b) => s + (betsToWin(b.stake, b.odds) || 0), 0), open: open.length };
}
function betsSummaryHTML(st) {
  return `<div class="bets-stats">
    <div><div class="v num ${st.net > 0 ? 'win' : ''}">${st.money ? esc(betsFmtMoney(Math.round(st.net * 100) / 100, true)) : '—'}</div><div class="l">Net</div><div class="s">${st.roi != null ? `${(st.roi * 100).toFixed(1)}% on ${esc(betsFmtMoney(Math.round(st.risked)))} risked` : st.done ? 'No stakes logged' : 'No results yet'}</div></div>
    <div><div class="v num">${st.w}–${st.l}${st.p ? `–${st.p}` : ''}</div><div class="l">Record</div><div class="s">${st.w + st.l ? `${Math.round((st.w / (st.w + st.l)) * 100)}% winners` : 'Won–lost'}</div></div>
    <div><div class="v num">${esc(betsFmtMoney(Math.round(st.openRisk * 100) / 100))}</div><div class="l">At risk</div><div class="s">${betsPlural(st.open, 'open bet')}${st.open ? ` · to win ${esc(betsFmtMoney(Math.round(st.openWin)))}` : ''}</div></div>
  </div>`;
}
const betsVisible = () => BETS.list.filter((b) => !BETS.pending.has(b.id));
const betsLiveBet = (b) => b.legs.some((l) => l.state === 'open' && betsIsLive(betsGame(l.pk)));
function betsMineHTML() {
  const list = betsVisible();
  const st = betsStats(list);
  const open = list.filter((b) => b.status === 'open').sort((a, b) => Number(betsLiveBet(b)) - Number(betsLiveBet(a)) || (Date.parse(a.legs[0]?.start) || 0) - (Date.parse(b.legs[0]?.start) || 0));
  const settled = list.filter((b) => b.status !== 'open').sort((a, b) => (b.settled || Date.parse(b.placed) || b.created || 0) - (a.settled || Date.parse(a.placed) || a.created || 0));
  const shown = BETS.more ? settled : settled.slice(0, 20);
  const top = `${betsSummaryHTML(st)}${typeof limMineHTML === 'function' ? limMineHTML(list) : ''}
    <div class="bets-btns bets-top-btns"><button class="bets-btn" type="button" data-bets-new>Log a bet</button>${list.length ? '<a class="bets-btn ghost" href="/api/bets.csv" download>Export CSV</a>' : ''}</div>`;
  if (!BETS.loaded && !list.length) return `${top}<div class="card empty"><b>Loading your bets…</b></div>`;
  if (!list.length) return `${top}<div class="card empty bets-empty"><b>No bets yet</b>Tap any price on the Games → Odds board to log one, or use Log a bet. Your bets are private to this device.</div>`;
  return `${top}
    <div class="bets-cols">
      <div>
        ${betsHitList(open)}
        <h2 class="bets-h2">Open<span>${open.length ? betsPlural(open.length, 'bet') : ''}</span></h2>
        ${open.length ? `<div class="bets-list">${open.map(betsCard).join('')}</div>` : '<div class="card empty bets-empty"><b>No open bets</b>Bets you log show up here and follow the game live.</div>'}
      </div>
      <div>
        <h2 class="bets-h2">Settled<span>${settled.length ? betsPlural(settled.length, 'bet') : ''}</span></h2>
        ${settled.length ? `<div class="bets-list">${shown.map(betsCard).join('')}</div>${settled.length > shown.length ? `<button class="bets-btn ghost" type="button" data-bets-more>Show all ${settled.length}</button>` : ''}` : '<div class="card empty bets-empty"><b>Nothing settled yet</b>Bets grade themselves when the game goes final.</div>'}
      </div>
    </div>`;
}

// ------------------------------------------------------------ Results: closing line value, profit, by market and book
function betsClvLegs(list) {
  const out = [];
  for (const b of list) {
    if (b.status === 'void') continue;
    for (const l of b.legs) if (l.clv && (l.clv.pts != null || l.clv.pct != null)) out.push({ b, l, t: Date.parse(b.placed) || b.created || 0 });
  }
  return out.sort((x, y) => x.t - y.t);
}
const betsAvg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
// A leg beat the close if its number was better, or at the same number its price was better.
const betsBeat = (c) => (c.pts != null && c.pts !== 0 ? c.pts > 0 : c.pct != null ? c.pct > 0 : false);
const betsSame = (c) => (c.pts == null || c.pts === 0) && (c.pct == null || Math.abs(c.pct) < 0.05);
function betsClvCard(list) {
  const legs = betsClvLegs(list);
  if (!legs.length) return `<section class="card bets-clv"><h3>Closing line value</h3><p class="bets-clv-lede">At first pitch, each bet is compared with where the market closed. Getting a better price than the close is the most reliable sign of good betting over time. Your report shows up after your first bet’s game starts.</p></section>`;
  const pts = legs.filter((x) => x.l.clv.pts != null && x.l.clv.pts !== 0).map((x) => x.l.clv.pts);
  const pcts = legs.map((x) => x.l.clv.pct).filter((v) => v != null);
  const avgPts = betsAvg(pts), avgPct = betsAvg(pcts);
  const n = legs.length;
  const beat = legs.filter((x) => betsBeat(x.l.clv)).length, same = legs.filter((x) => betsSame(x.l.clv)).length, worse = n - beat - same;
  let verdict;
  if (n < 20) verdict = `Early days: ${betsPlural(n, 'bet')} with a closing price. Closing line value starts to mean something around 50 bets.`;
  else if ((avgPct ?? 0) > 1 || (avgPct == null && (avgPts ?? 0) > 0.2)) verdict = 'You’re regularly getting a better price than where the market closed. Over time that’s the most reliable sign of good betting, though it says nothing about any single result.';
  else if ((avgPct ?? 0) < -1 || (avgPct == null && (avgPts ?? 0) < -0.2)) verdict = 'You’re usually getting a worse price than the close. Betting earlier, or comparing books before you bet, tends to help.';
  else verdict = 'You’re getting about the closing price on average.';
  let run = 0;
  const series = legs.filter((x) => x.l.clv.pct != null).map((x, i) => (run += x.l.clv.pct) / (i + 1));
  const group = (keyOf) => {
    const m = new Map();
    for (const x of legs) {
      const k = keyOf(x);
      const r = m.get(k) || { n: 0, pts: [], pct: [], beat: 0 };
      r.n++;
      if (x.l.clv.pts != null && x.l.clv.pts !== 0) r.pts.push(x.l.clv.pts);
      if (x.l.clv.pct != null) r.pct.push(x.l.clv.pct);
      if (betsBeat(x.l.clv)) r.beat++;
      m.set(k, r);
    }
    return [...m].sort((a, b) => b[1].n - a[1].n);
  };
  const rows = (title, g) => `<table class="bets-tbl"><thead><tr><th scope="col">${esc(title)}</th><th scope="col">Bets</th><th scope="col">Avg vs close</th><th scope="col">Beat it</th></tr></thead><tbody>${g.map(([k, r]) => `<tr><td>${esc(k)}</td><td class="num">${r.n}</td><td class="num">${r.pct.length ? betsSigned(betsAvg(r.pct), '%') : '—'}${r.pts.length ? `<small>${betsSigned(betsAvg(r.pts), ' runs')}</small>` : ''}</td><td class="num">${betsFmtPct(r.beat / r.n)}</td></tr>`).join('')}</tbody></table>`;
  return `<section class="card bets-clv" aria-labelledby="betsClvTitle">
    <h3 id="betsClvTitle">Closing line value</h3>
    <p class="bets-clv-lede">How your price compared with where the market closed at first pitch, with the cut removed. It measures the price you got, not whether you won.</p>
    <div class="bets-sum3">
      <div><b class="num">${betsSigned(avgPct, '%')}</b><span>avg price vs the close</span></div>
      <div><b class="num">${betsFmtPct(beat / n)}</b><span>beat the close</span></div>
      <div><b class="num">${n}</b><span>${n === 1 ? 'bet' : 'bets'} measured</span></div>
    </div>
    <div class="bets-split" role="img" aria-label="${beat} better, ${same} same, ${worse} worse than the close"><i style="flex:${beat}"></i><i style="flex:${same}"></i><i style="flex:${worse}"></i></div>
    <div class="bets-split-l" aria-hidden="true"><span>Better ${beat}</span><span>Same ${same}</span><span>Worse ${worse}</span></div>
    <p class="bets-clv-v">${esc(verdict)}</p>
    ${pts.length ? `<p class="bets-note-p">When the run line or total moved, your number averaged ${esc(betsSigned(avgPts, ' runs'))} against the close (${betsPlural(pts.length, 'bet')}).</p>` : ''}
    ${series.length >= 3 ? betsClvSpark(series) : ''}
    ${rows('Market', group((x) => BETS_MKTS[x.l.mkt] || x.l.mkt))}
    ${rows('Book', group((x) => x.b.book || 'Unknown'))}
  </section>`;
}
function betsClvSpark(series) {
  const W = 640, H = 120, P = 8;
  const lo = Math.min(0, ...series), hi = Math.max(0, ...series);
  const X = (i) => P + (i / Math.max(1, series.length - 1)) * (W - 2 * P);
  const Y = (v) => P + ((hi - v) / (hi - lo || 1)) * (H - 2 * P);
  return `<div class="bets-chart"><h4 class="sub-h">Running average<span>price vs the close, over time</span></h4>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Running average closing line value, now ${esc(betsSigned(series[series.length - 1], ' percent'))}">
      <line class="z" x1="${P}" x2="${W - P}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"/>
      <polyline class="ln" points="${series.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>
      <circle class="end" cx="${X(series.length - 1).toFixed(1)}" cy="${Y(series[series.length - 1]).toFixed(1)}" r="4"/>
    </svg></div>`;
}
function betsResultsHTML() {
  const list = betsVisible();
  const done = list.filter((b) => b.status !== 'open' && b.status !== 'void' && b.stake > 0 && b.net != null).sort((a, b) => (a.settled || 0) - (b.settled || 0));
  let body = betsClvCard(list);
  if (!done.length) {
    body += '<div class="card empty bets-empty"><b>No results yet</b>Your profit chart and your results by market and book show up after your first graded bet with a stake.</div>';
  } else {
    let run = 0;
    const pts = [[0, 0], ...done.map((b, i) => [i + 1, (run += b.net || 0)])];
    const W = 640, H = 200, L = 64, lo = Math.min(0, ...pts.map((p) => p[1])), hi = Math.max(0, ...pts.map((p) => p[1]));
    const X = (i) => L + (i / Math.max(1, pts.length - 1)) * (W - L - 12), Y = (v) => 12 + ((hi - v) / (hi - lo || 1)) * (H - 36);
    const last = pts[pts.length - 1];
    const chart = `<section class="card bets-pnl"><h3 class="sub-h">Profit over time<span>${betsPlural(done.length, 'graded bet')}</span></h3><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative profit over ${done.length} bets, now ${esc(betsFmtMoney(Math.round(last[1]), true))}">
      <line class="z" x1="${L}" x2="${W - 12}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"/>
      <text x="${L - 10}" y="${(Y(hi) + 5).toFixed(1)}" text-anchor="end">${esc(betsFmtMoney(Math.round(hi)))}</text>${lo < 0 && Y(lo) - Y(hi) > 24 ? `<text x="${L - 10}" y="${(Y(lo) + 5).toFixed(1)}" text-anchor="end">${esc(betsFmtMoney(Math.round(lo)))}</text>` : ''}${hi > 0 && lo < 0 && Y(0) - Y(hi) > 24 && Y(lo) - Y(0) > 24 ? `<text x="${L - 10}" y="${(Y(0) + 5).toFixed(1)}" text-anchor="end">$0</text>` : ''}
      <polyline class="ln" points="${pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')}"/><circle class="end" cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="5"/></svg></section>`;
    const by = (keyFn) => {
      const m = new Map();
      for (const b of done) { const k = keyFn(b); const r = m.get(k) || { n: 0, w: 0, net: 0, risk: 0 }; r.n++; r.w += b.status === 'won' ? 1 : 0; r.net += b.net || 0; r.risk += b.stake || 0; m.set(k, r); }
      return [...m].sort((a, b) => b[1].net - a[1].net);
    };
    const table = (title, col, rows) => `<section class="card bets-brk"><h3 class="sub-h">${esc(title)}</h3><table class="bets-tbl"><thead><tr><th scope="col">${esc(col)}</th><th scope="col">Bets</th><th scope="col">Won</th><th scope="col">Net</th><th scope="col">ROI</th></tr></thead><tbody>${rows.map(([k, r]) => `<tr><td>${esc(k)}</td><td class="num">${r.n}</td><td class="num">${r.w}</td><td class="num ${r.net > 0 ? 'win' : ''}">${esc(betsFmtMoney(Math.round(r.net * 100) / 100, true))}</td><td class="num">${r.risk ? `${((r.net / r.risk) * 100).toFixed(0)}%` : '—'}</td></tr>`).join('')}</tbody></table></section>`;
    body += `<div class="bets-res-grid">${chart}<div class="bets-res-tables">${table('By market', 'Market', by((b) => (b.legs.length > 1 ? 'Parlays' : BETS_MKTS[b.legs[0]?.mkt] || b.legs[0]?.mkt || '—')))}${table('By book', 'Book', by((b) => b.book || 'Unknown'))}</div></div>`;
  }
  return `${betsSummaryHTML(betsStats(list))}<div class="bets-res">${body}</div>`;
}

// ------------------------------------------------------------ Kelly (opt-in; saved on this device only)
// Full Kelly as a share of bankroll: f* = (b·p − q) / b, b = decimal odds − 1, q = chance to lose (a push sits out).
const BETS_KELLY_DEF = { bankroll: 0, frac: 0.25, capPct: 2, round: 5 };
const BETS_KELLY_PRESETS = [[0.125, '⅛'], [0.25, '¼'], [0.5, '½']]; // no one-tap full Kelly
const BETS_KELLY_ROUNDS = [1, 5, 10, 25];
function betsKellyCfg() {
  const c = { ...BETS_KELLY_DEF, ...(store.get('betsKelly', null) || {}) };
  c.bankroll = Number(c.bankroll) > 0 ? Number(c.bankroll) : 0; // never invented
  c.frac = clamp(Number(c.frac) || BETS_KELLY_DEF.frac, 0.05, 0.5);
  c.capPct = clamp(Number(c.capPct) || BETS_KELLY_DEF.capPct, 0.5, 10);
  c.round = BETS_KELLY_ROUNDS.includes(Number(c.round)) ? Number(c.round) : BETS_KELLY_DEF.round;
  return c;
}
function betsKellySet(patch) {
  store.set('betsKelly', { ...betsKellyCfg(), ...patch });
  betsKellyPaint();
  if (BETS.slip && $('#betsCalc')) betsUpdateCalc();
}
function betsKellyName(f = betsKellyCfg().frac) {
  const p = BETS_KELLY_PRESETS.find(([v]) => Math.abs(v - f) < 0.001);
  return p ? `${p[1]} Kelly` : `${Math.round(f * 100)}% Kelly`;
}
// p = chance to win, odds = American, push = chance of a push. Returns { full, pct, dollars, capped, edge } or null.
function betsKellyStake(p, odds, push = 0, c = betsKellyCfg()) {
  const d = betsDec(odds);
  if (!(p > 0 && p < 1) || d == null || d <= 1) return null;
  const b = d - 1, q = Math.max(0, 1 - p - push);
  const edge = p * d + push - 1;
  const full = (b * p - q) / b;
  if (!(full > 0)) return { full: 0, pct: 0, dollars: 0, capped: false, edge };
  const want = full * c.frac;
  const pct = Math.min(want, c.capPct / 100);
  const dollars = c.bankroll ? Math.max(c.round, Math.round((pct * c.bankroll) / c.round) * c.round) : null;
  return { full, pct, dollars, capped: want > c.capPct / 100, edge };
}
function betsKellyCard() {
  return `<section class="card bets-tool bets-kelly" id="betsKelly" aria-labelledby="betsKellyTitle">
    <h3 id="betsKellyTitle">Bet sizing · Kelly</h3>
    <p>Kelly is a formula that sizes a bet from a win chance and a price. It’s only as good as the win chance: overestimate it a little and Kelly bets too much. Most people who use it bet a small fraction of it, or nothing. Nothing is sized in dollars until you enter a bankroll.</p>
    <div class="bets-fgrid">
      <label class="bets-fld">Bankroll ($)<input class="bets-inp" id="betsKBank" inputmode="decimal" autocomplete="off" placeholder="Not set"></label>
      <label class="bets-fld">Round stakes to<span class="bets-sel"><select class="bets-inp" id="betsKRound">${BETS_KELLY_ROUNDS.map((r) => `<option value="${r}">$${r}</option>`).join('')}</select></span></label>
    </div>
    <div class="bets-kf">
      <div class="bets-kh"><span>How much of Kelly</span><b class="num" id="betsKFracV"></b></div>
      <div class="bets-chips" role="group" aria-label="Kelly fraction presets">${BETS_KELLY_PRESETS.map(([v, l]) => `<button type="button" class="bets-chip" data-bets-kelly-frac="${v}" aria-label="${l} Kelly">${l}</button>`).join('')}</div>
      <input class="bets-range" id="betsKFrac" type="range" min="5" max="50" step="5" aria-label="Fraction of Kelly, percent">
    </div>
    <div class="bets-kf">
      <div class="bets-kh"><span>Most on one bet</span><b class="num" id="betsKCapV"></b></div>
      <input class="bets-range" id="betsKCap" type="range" min="0.5" max="10" step="0.5" aria-label="Largest bet, percent of bankroll">
    </div>
    <div class="bets-kex" id="betsKEx" aria-live="polite"></div>
    <div class="bets-btns"><button type="button" class="bets-btn ghost" data-bets-kelly-clear>Clear bankroll</button></div>
    <p class="bets-note-p">Sizes are estimates, not advice, and only as good as the win chance behind them: in the bet slip that’s the sharp fair price with the vig removed. Saved on this device only.</p>
  </section>`;
}
function betsKellyPaint() {
  const card = $('#betsKelly');
  if (!card) return;
  const c = betsKellyCfg();
  const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
  set('#betsKBank', c.bankroll ? String(c.bankroll) : '');
  set('#betsKRound', String(c.round));
  set('#betsKFrac', String(Math.round(c.frac * 100)));
  set('#betsKCap', String(c.capPct));
  $('#betsKFracV').textContent = betsKellyName(c.frac);
  $('#betsKCapV').textContent = c.bankroll ? `${c.capPct}% · ${betsFmtMoney(Math.round((c.capPct / 100) * c.bankroll))}` : `${c.capPct}% of bankroll`;
  for (const b of $$('[data-bets-kelly-frac]', card)) b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.betsKellyFrac) - c.frac) < 0.001));
  const ex = betsKellyStake(1.04 / betsDec(-110), -110, 0, c);
  $('#betsKEx').innerHTML = ex ? `At these settings, a <b>+4% estimate at ${esc(betsFmtOdds(-110))}</b> would size to ${ex.dollars ? `<b class="num">${esc(betsFmtMoney(ex.dollars))}</b>, ` : ''}${(ex.pct * 100).toFixed(1)}% of your bankroll${ex.capped ? ' (held to your cap)' : ''}. If the real edge is 0%, Kelly’s answer is $0.` : '';
  const clr = $('[data-bets-kelly-clear]', card);
  if (clr) clr.hidden = !c.bankroll;
}

// ------------------------------------------------------------ Your bets: link a device, claim old bets
function betsAcctCard() {
  return `<section class="card bets-tool bets-acct" id="betsAcct" aria-labelledby="betsAcctTitle">
    <h3 id="betsAcctTitle">Your bets</h3>
    <p>Your bet log is private: only this device sees it. To see the same bets on your phone and your computer, link them.</p>
    <div class="bets-acct-link" id="betsLinkBox"></div>
    <div class="bets-acct-join">
      <label class="bets-fld">Have a code from your other device?<input class="bets-inp bets-code" id="betsJoinCode" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="8-character code" maxlength="9"></label>
      <button class="bets-btn ghost" type="button" data-bets-join>Link this device</button>
    </div>
    <div class="bets-err" id="betsAcctErr" role="alert"></div>
    <div id="betsClaim"></div>
  </section>`;
}
function betsAcctPaint() {
  const box = $('#betsLinkBox');
  if (!box) return;
  if (!BETS.me) betsAcctLoad();
  const left = BETS.link ? Math.max(0, Math.round((BETS.link.exp - Date.now()) / 1000)) : 0;
  if (BETS.link && left <= 0) BETS.link = null;
  const html = BETS.link
    ? `<div class="bets-code-show"><span>On your other device, open Mine → Results → Your bets and enter</span><b class="num">${esc(BETS.link.code.slice(0, 4))} ${esc(BETS.link.code.slice(4))}</b><span>Good for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · one use</span></div>`
    : '<button class="bets-btn" type="button" data-bets-link>Link another device</button>';
  if (box.dataset.key !== html) { box.innerHTML = html; box.dataset.key = html; }
  const c = $('#betsClaim');
  const claim = BETS.me?.claimable
    ? `<div class="bets-claim"><b>${betsPlural(BETS.me.claimable, 'bet')} from before logs were private</b><p>They’re hidden from everyone. If you run this app, enter your owner code to move them into your log; delete any that aren’t yours.</p>
       <div class="bets-acct-join"><label class="bets-fld">Owner code<input class="bets-inp" id="betsOwner" type="password" autocomplete="off" spellcheck="false"></label><button class="bets-btn ghost" type="button" data-bets-claim>Claim</button></div></div>`
    : '';
  if (c.dataset.key !== claim) { c.innerHTML = claim; c.dataset.key = claim; }
}
async function betsAcctLoad() {
  BETS.me = { bets: 0, claimable: 0 };
  try { BETS.me = await betsApi('/api/me'); } catch { /* offline: linking still works */ }
  betsAcctPaint();
}
function betsAcctErr(msg) { const e = $('#betsAcctErr'); if (e) e.textContent = msg || ''; }
async function betsRefresh() {
  try { const list = await betsApi('/api/bets'); if (Array.isArray(list)) betsSetList(list); } catch { /* server not ready */ }
}

// ------------------------------------------------------------ Mine tab: Following | My bets | Results
function betsMineHook() {
  const host = $('#betsHost');
  if (!host) return;
  if (!host.dataset.built) {
    host.innerHTML = `<div class="bets-segrow"><div class="seg bets-seg" role="group" aria-label="Show">${BETS_SEGS.map(([k, l]) => `<button type="button" data-bets-seg="${k}">${l}</button>`).join('')}</div></div>
      <div id="betsMain"></div>
      <div id="betsTools" hidden><h2 class="bets-h2">Settings</h2><div class="bets-tools">${betsKellyCard()}${typeof limCardHTML === 'function' ? limCardHTML() : ''}${betsAcctCard()}</div>${typeof limHelpHTML === 'function' ? limHelpHTML() : ''}</div>`;
    host.dataset.built = '1';
  }
  const seg = BETS.seg;
  $$('[data-bets-seg]', host).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.betsSeg === seg)));
  const follow = $('#followBody');
  if (follow) follow.hidden = seg !== 'follow';
  const sub = $('#followSub');
  if (sub) sub.textContent = seg === 'mine' ? 'Your bets, live. Private to this device.' : seg === 'results' ? 'How your bets and your prices have done.' : 'Your players and teams, live.';
  const main = $('#betsMain');
  if (seg === 'mine' && typeof BoardPortfolioView !== 'undefined' && BoardPortfolioView.mount(main, {
    sport: 'mlb', currentBets: betsVisible(), currentGames: BETS.games,
    sports: location.pathname.startsWith('/mlb/') ? undefined : ['mlb'],
    basePaths: location.pathname.startsWith('/mlb/') ? undefined : { mlb: '' },
    onNew: () => betsOpenSlip({}), detailHTML: (ticket) => ticket.sport === 'mlb' ? betsCard(ticket.raw) : null,
    shareHTML: (ticket) => (ticket.sport === 'mlb' && ticket.raw && ticket.raw.status !== 'void' && typeof shareOpen === 'function' ? `<button type="button" data-share-bet="${esc(ticket.raw.id)}" aria-label="Share this bet">Share</button>` : ''),
    resultsHTML: () => `<h2>MLB results</h2>${betsResultsHTML()}`
  })) {
    $('#view-following')?.classList.add('portfolio-mode');
    $('#betsTools').hidden = true;
    if (!betsMineHook.didOpen && new URLSearchParams(location.search).get('portfolio') === 'new' && BETS.games.size) { betsMineHook.didOpen = true; betsOpenSlip({}); }
    return;
  }
  $('#view-following')?.classList.remove('portfolio-mode');
  main.classList.remove('portfolio');
  const html = seg === 'mine' ? betsMineHTML() : seg === 'results' ? betsResultsHTML() : '';
  if (main.dataset.key !== html) { main.innerHTML = html; main.dataset.key = html; }
  const tools = $('#betsTools');
  tools.hidden = seg !== 'results';
  if (seg === 'results') { betsKellyPaint(); betsAcctPaint(); if (typeof limPaint === 'function') limPaint(); }
}
function betsSetSeg(seg) {
  BETS.seg = seg;
  store.set('betsSeg', seg);
  betsMineHook();
}

// ------------------------------------------------------------ data from the stream
function betsSetList(list) {
  // Pending deletes stay in the list but hidden (betsVisible), so the stream can't bring them back and Undo still can.
  BETS.list = list.filter((b) => b && b.id && Array.isArray(b.legs));
  BETS.loaded = true;
  if (BETS.me) BETS.me.bets = BETS.list.length;
  if (S.tab === 'following' && BETS.seg !== 'follow') invalidate();
}
function betsTakeOdds(o) {
  if (!o) return;
  const games = o.games || {};
  for (const O of Array.isArray(games) ? games : Object.values(games)) if (O?.pk != null) BETS.odds.set(Number(O.pk), O);
  if (Array.isArray(o.books) && o.books.length) BETS.books = o.books;
}
document.addEventListener('bbl:snapshot', (ev) => {
  const d = ev.detail || {};
  if (Array.isArray(d.games) && d.today !== false) BETS.games = new Map(d.games.map((g) => [g.pk, g]));
  if (d.odds) betsTakeOdds(d.odds);
  if (Array.isArray(d.bets)) betsSetList(d.bets);
  else if (!BETS.loaded) betsRefresh();
  if (S.tab === 'following' && BETS.seg !== 'follow') invalidate();
});
document.addEventListener('bbl:odds', (ev) => {
  const O = ev.detail;
  if (O?.pk == null) return;
  BETS.odds.set(Number(O.pk), O);
  if (S.tab === 'following' && BETS.seg === 'mine') invalidate();
});
document.addEventListener('bbl:bets', (ev) => { if (Array.isArray(ev.detail)) betsSetList(ev.detail); });

// ------------------------------------------------------------ interactions (data-bets-*; boot.js ignores these)
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-bets-seg],[data-bets-hitsort],[data-bets-game],[data-bets-save],[data-bets-addleg],[data-bets-rmleg],[data-bets-parlay-open],[data-bets-parlay-clear],[data-bets-new],[data-bets-pick],[data-bets-void],[data-bets-reopen],[data-bets-del],[data-bets-more],[data-bets-kelly-frac],[data-bets-kelly-settings],[data-bets-kelly-use],[data-bets-kelly-clear],[data-bets-link],[data-bets-join],[data-bets-claim],[data-bets-book],[data-bets-books]');
  if (!t) return;
  const d = t.dataset;
  if (d.betsBooks !== undefined) { ev.preventDefault(); betsBooksSheet(); return; }
  if (d.betsSeg) { betsSetSeg(d.betsSeg); return; }
  if (d.betsHitsort) { store.set('betsHitSort', d.betsHitsort); betsMineHook(); return; }
  if (d.betsGame) {
    if (ev.target.closest('button') && ev.target.closest('button') !== t) return; // a button inside the leg
    ev.preventDefault();
    if (typeof openGame === 'function') openGame(Number(d.betsGame));
    return;
  }
  if (d.betsBook && BETS.slip?.legs.length === 1) { // a book tile in the slip: use that book and its price
    betsReadSlip();
    const sl = BETS.slip, l = sl.legs[0];
    const p = d.betsBook === 'other' ? null : betsPrice(l.pk, d.betsBook, l.mkt, l.side);
    if (d.betsBook !== 'other' && !p) { betsToast('This price is no longer available.'); betsPaintSlip(); return; }
    sl.book = d.betsBook;
    if (d.betsBook === 'other') l.book = '';
    else {
      l.odds = p.odds;
      if (l.mkt !== 'ml' && l.mkt !== 'f5ml') l.line = p.line;
      l.book = d.betsBook;
    }
    betsPaintSlip();
    $(`[data-bets-book="${CSS.escape(d.betsBook)}"]`)?.focus({ preventScroll: true });
    return;
  }
  if (d.betsSave !== undefined) { betsSave(); return; }
  if (d.betsAddleg !== undefined) { betsAddLeg(); return; }
  if (d.betsRmleg !== undefined) {
    betsReadSlip();
    BETS.slip.legs.splice(Number(d.betsRmleg), 1);
    BETS.parlay = BETS.slip.legs.map((l) => ({ ...l }));
    betsTraySave();
    betsTray();
    if (!BETS.parlay.length) { betsReturn(BETS.slip.returnTo); BETS.slip = null; return; }
    BETS.slip.odds = NaN;
    betsPaintSlip();
    return;
  }
  if (d.betsParlayOpen !== undefined) { betsOpenSlip({ parlay: true }); return; }
  if (d.betsParlayClear !== undefined) {
    const was = BETS.parlay;
    BETS.parlay = [];
    betsTraySave();
    betsTray();
    betsToast('Parlay cleared.', { label: 'Undo', run: () => { BETS.parlay = was; betsTraySave(); betsTray(); } });
    return;
  }
  if (d.betsNew !== undefined) { betsOpenSlip({}); return; }
  if (d.betsPick) { const [pk, mkt, side] = d.betsPick.split('|'); const back = BETS.slip?.returnTo || null; betsOpenSlip({ pk, mkt, side, book: 'cons' }); BETS.slip.returnTo = back; return; }
  if (d.betsVoid || d.betsReopen) {
    const id = d.betsVoid || d.betsReopen;
    const to = d.betsVoid ? 'void' : 'open';
    const b = BETS.list.find((x) => x.id === id);
    const prev = b?.status;
    const patch = (status) => {
      if (b) { b.status = status; if (status === 'open') { b.net = null; } invalidate(); }
      return betsApi(`/api/bets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    };
    patch(to)
      .then(() => betsToast(to === 'void' ? 'Bet voided. No win or loss.' : 'Bet restored.', { label: 'Undo', run: () => patch(to === 'void' ? 'open' : 'void').catch((e) => { betsToast(e.message); betsRefresh(); }) }))
      .catch((e) => { if (b) b.status = prev; invalidate(); betsToast(e.message); });
    return;
  }
  if (d.betsDel) {
    // Off the screen now; deleted on the server only if Undo isn't tapped within 6 seconds.
    const id = d.betsDel;
    BETS.pending.add(id);
    invalidate();
    const timer = setTimeout(() => {
      betsApi(`/api/bets/${encodeURIComponent(id)}`, { method: 'DELETE' })
        .then(() => { BETS.pending.delete(id); BETS.list = BETS.list.filter((b) => b.id !== id); invalidate(); })
        .catch((e) => { BETS.pending.delete(id); invalidate(); betsToast(e.message); });
    }, 6000);
    betsToast('Bet deleted.', { label: 'Undo', run: () => { clearTimeout(timer); BETS.pending.delete(id); invalidate(); } });
    return;
  }
  if (d.betsMore !== undefined) { BETS.more = true; betsMineHook(); return; }
  if (d.betsKellyFrac) { betsKellySet({ frac: Number(d.betsKellyFrac) }); return; }
  if (d.betsKellyClear !== undefined) { betsKellySet({ bankroll: 0 }); const el = $('#betsKBank'); if (el) el.value = ''; return; }
  if (d.betsKellySettings !== undefined) {
    ev.preventDefault();
    closeSheet();
    BETS.seg = 'results';
    store.set('betsSeg', 'results');
    if (typeof setTab === 'function') setTab('following');
    setTimeout(() => { betsMineHook(); $('#betsKelly')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }, 60);
    return;
  }
  if (d.betsKellyUse && BETS.slip) {
    betsReadSlip();
    BETS.slip.stake = Number(d.betsKellyUse);
    const el = $('#betsStake');
    if (el) el.value = String(BETS.slip.stake);
    betsUpdateCalc();
    return;
  }
  if (d.betsLink !== undefined) {
    betsAcctErr('');
    betsApi('/api/me/link', { method: 'POST', body: '{}' }).then((r) => {
      BETS.link = r;
      clearInterval(BETS.linkTimer);
      BETS.linkTimer = setInterval(() => { betsAcctPaint(); if (!BETS.link) clearInterval(BETS.linkTimer); }, 1000);
      betsAcctPaint();
    }).catch((e) => betsAcctErr(e.message));
    return;
  }
  if (d.betsJoin !== undefined) {
    const code = String($('#betsJoinCode')?.value || '').replace(/[\s-]/g, '').toUpperCase();
    if (code.length < 8) { betsAcctErr('Enter the 8-character code from your other device.'); return; }
    betsAcctErr('');
    betsApi('/api/me/join', { method: 'POST', body: JSON.stringify({ code }) }).then((r) => {
      $('#betsJoinCode').value = '';
      BETS.me = null;
      betsToast(`Linked. This device now shares that log${r?.moved ? `, and brought ${betsPlural(r.moved, 'bet')} with it` : ''}.`);
      betsAcctPaint();
      betsRefresh();
    }).catch((e) => betsAcctErr(e.message));
    return;
  }
  if (d.betsClaim !== undefined) {
    const code = String($('#betsOwner')?.value || '').trim();
    if (!code) { betsAcctErr('Enter the owner code.'); return; }
    betsAcctErr('');
    betsApi('/api/me/claim', { method: 'POST', body: JSON.stringify({ code }) }).then((r) => {
      BETS.me = null;
      betsToast(r?.claimed ? `Moved ${betsPlural(r.claimed, 'bet')} into your log. Delete any that aren’t yours in My bets.` : 'Nothing left to claim.');
      betsAcctPaint();
      betsRefresh();
    }).catch((e) => betsAcctErr(e.message));
  }
});
document.addEventListener('input', (ev) => {
  const id = ev.target.id;
  if (id === 'betsOdds' || id === 'betsStake' || id === 'betsLine') { betsReadSlip(); betsUpdateCalc(); return; } // math only; never redraw a field mid-typing
  if (id === 'betsKBank') { const v = Number(String(ev.target.value).replace(/[^\d.]/g, '')); if (v >= 10) betsKellySet({ bankroll: v }); return; }
  if (id === 'betsKFrac') { betsKellySet({ frac: Number(ev.target.value) / 100 }); return; }
  if (id === 'betsKCap') betsKellySet({ capPct: Number(ev.target.value) });
});
document.addEventListener('change', (ev) => {
  const id = ev.target.id;
  if (id === 'betsBook') { betsReadSlip(); betsUpdateCalc(); return; } // the Open-book link follows the book
  if (id === 'betsKRound') { betsKellySet({ round: Number(ev.target.value) }); return; }
  if (id === 'betsPickGame' && BETS.slip) { BETS.slip.pickPk = ev.target.value; const el = $('#betsPickSides'); if (el) el.innerHTML = ev.target.value ? betsPickSides(ev.target.value) : ''; }
});
document.addEventListener('toggle', (ev) => { if (ev.target.matches?.('.bets-kslip') && BETS.slip) BETS.slip.kOpen = ev.target.open; }, true);
document.addEventListener('keydown', (ev) => {
  // Enter in a slip field saves, like a form.
  if (ev.key === 'Enter' && BETS.slip && ['betsOdds', 'betsStake', 'betsLine', 'betsNote'].includes(ev.target.id)) { ev.preventDefault(); betsSave(); }
});
// Live bets move with the game; keep "Most likely to hit" and the cards fresh even between stream events.
setInterval(() => { if (S.tab === 'following' && BETS.seg === 'mine' && !document.hidden && BETS.list.some((b) => b.status === 'open')) invalidate(); }, 15000);

// ------------------------------------------------------------ start
betsTray();
