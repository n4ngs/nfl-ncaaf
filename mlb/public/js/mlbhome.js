'use strict';
/* Bing Bong Live — the betting story on the home (Live) page.

   Three blocks, modelled on Hook & Ladder's home page and adapted to baseball:
     1. Move cards  (#mlbMoveSlot)   at most two, only for fresh moves on games that haven't started.
     2. Game of the moment (top of #liveOddsHost)  the live game worth watching, else the next one up.
     3. Line moves  (#liveOddsHost)  the newest moves, newest first.

   Informational by design: no urgency, no countdowns, no stakes, no "act now". Every model number says est.
   Green is never used here — it belongs to the user's own winning tickets. The one red accent is the live dot
   and the steam tag, nothing else.

   Nothing here owns data: prices, moves and wording all come from odds.js (ODDS, oddsBest, oddsMarket,
   oddsMoveText, oddsNoVig, oddsAgo, oddsOpenSheet…). Rows and cards carry data-odds-open / data-odds-moves so
   odds.js's own click handler opens the sheets.

   Classic scripts share one global scope, so every top-level name here starts with mlbHome. The one entry
   point views.js calls on every Live render is mlbHomeHook(); it must stay cheap and idempotent. */

// ------------------------------------------------------------ constants & tiny helpers
const mlbHomeFreshMs = 20 * 60e3;          // a move card is worth showing for this long
const mlbHomeLiveMs = 15 * 60e3;           // a market price older than this is a "last" price, not a live one
const mlbHomeMktWord = { ml: 'Money', rl: 'Run line', t: 'Total' };
const mlbHomeTagWord = { steam: 'Steam', flip: 'Flip', move: 'Move' };
const mlbHomeState = { raf: 0 };

const mlbHomeGame = (pk) => S.games.get(Number(pk)) || null;
const mlbHomeOdds = (pk) => (typeof oddsGame === 'function' ? oddsGame(pk) : null);
const mlbHomeTeam = (g, side) => g?.[side] || {};
const mlbHomeAbbr = (g, side) => mlbHomeTeam(g, side).abbr || (side === 'home' ? 'Home' : 'Away');
const mlbHomeName = (g, side) => mlbHomeTeam(g, side).name || mlbHomeAbbr(g, side);
const mlbHomeMatch = (g) => `${mlbHomeAbbr(g, 'away')} @ ${mlbHomeAbbr(g, 'home')}`;
const mlbHomePct = (p) => `${Math.round(p * 100)}%`;
const mlbHomeScore = (g, side) => mlbHomeTeam(g, side).score ?? 0;
const mlbHomeLiveNow = (g) => !!g && g.state === 'Live' && !isOff(g) && !/suspend|delay|postpon/i.test(g.detail || '');

// The opening line, wherever odds.js kept it for this game.
const mlbHomeOpenLine = (O) => O?.open || O?.books?.open || null;
// One price, read off a stored line object. Null-safe all the way down.
const mlbHomeOddsAt = (L, mkt, side) => oddsSide(L, mkt, side)?.odds ?? null;
// The side the market makes the favorite. American odds compare on oddsScale: more favored is higher.
function mlbHomeFavSide(home, away) {
  if (home == null || away == null) return null;
  return oddsScale(home) >= oddsScale(away) ? 'home' : 'away';
}

// ------------------------------------------------------------ 1. move cards
// A move's number, in the units that market uses: American odds, a run line, or a total.
function mlbHomeMoveNum(mv, v) {
  if (v == null) return '—';
  if (Math.abs(v) >= 100) return oddsFmt(v);
  return mv.mkt === 'rl' ? oddsFmtLine(v) : oddsTrim(v);
}
// What just happened, in one short line. The full sentence lives in the odds sheet.
function mlbHomeMoveTitle(mv, g) {
  const teamSide = mv.dir === 'home' || mv.dir === 'away';
  if (mv.kind === 'flip') return `New favorite: the ${mlbHomeName(g, teamSide ? mv.dir : 'home')}`;
  if (mv.mkt === 't') return mv.to == null ? 'The total moved' : `Total ${mv.dir === 'under' ? 'down' : 'up'} to ${oddsTrim(mv.to)}`;
  if (!teamSide) return `The ${mlbHomeMktWord[mv.mkt] === 'Money' ? 'money line' : 'line'} moved`;
  const word = mv.mkt === 'rl' ? 'Run line' : 'Money line';
  return mv.kind === 'steam' ? `Steam toward the ${mlbHomeName(g, mv.dir)}` : `${word} toward the ${mlbHomeName(g, mv.dir)}`;
}
// The kicker above the card: how many books moved together, or simply that it was a big one.
function mlbHomeKicker(mv) {
  if (mv.kind === 'flip') return 'New favorite';
  if (mv.kind !== 'steam') return 'Big move';
  const n = mv.books?.length || 3;
  const when = mv.secs != null ? `in ${Math.max(1, Math.round(mv.secs / 60))} min` : 'within 10 min';
  return `Steam · ${n} books ${when}`;
}
// Fresh moves on games that haven't started, steam first, one per game and market, at most two.
function mlbHomeFreshMoves() {
  const now = serverNow();
  const seen = new Set();
  return [...ODDS.moves.values()]
    .filter((m) => m && m.t != null && now - m.t < mlbHomeFreshMs && oddsIsPre(mlbHomeGame(m.pk)))
    .sort((a, b) => (b.kind === 'steam') - (a.kind === 'steam') || b.t - a.t)
    .filter((m) => { const k = `${m.pk}|${m.mkt}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 2);
}
function mlbHomeMoveCard(mv) {
  const g = mlbHomeGame(mv.pk);
  const teamSide = mv.dir === 'home' || mv.dir === 'away';
  const t = teamSide ? mlbHomeTeam(g, mv.dir) : null;
  const title = mlbHomeMoveTitle(mv, g);
  const from = mlbHomeMoveNum(mv, mv.from), to = mlbHomeMoveNum(mv, mv.to);
  // Money-line and run-line moves are stored from the home side, so that's whose number this is.
  const cap = mv.mkt === 't' ? 'runs' : mlbHomeAbbr(g, 'home');
  const books = mv.books?.length ? mv.books.map(oddsBookName).join(', ') : 'Market consensus';
  const when = `${mlbHomeMatch(g)} · first pitch ${timeLabel(g.start)}`;
  const market = mlbHomeMktWord[mv.mkt] || 'Line';
  const label = `${mlbHomeKicker(mv)}. ${title}. ${when}. ${cap} ${oddsSpoken(from)} to ${oddsSpoken(to)} at ${books}. ${market}. Opens every book for this game.`;
  return `<button type="button" class="card mh-mv" data-odds-open="${g.pk}" data-fk="mhc${esc(mv.id)}" aria-label="${esc(label)}">
    <span class="mh-mv-top"><span class="mh-mv-k${mv.kind === 'steam' ? ' hot' : ''}">${mv.kind === 'steam' ? '<span class="dot pulse"></span>' : ''}${esc(mlbHomeKicker(mv))}</span><span class="muted">${esc(oddsAgo(mv.t))}</span></span>
    <span class="mh-mv-main">${t?.id ? logo(t.id, 'logo mh-mv-lg') : ''}
      <span class="mh-mv-who"><b>${esc(title)}</b><span>${esc(when)}</span></span>
      <span class="mh-mv-num num"><s>${esc(from)}</s>${esc(to)}<small>${esc(cap)}</small></span></span>
    <span class="mh-mv-foot"><span>${esc(books)}</span><span>${esc(market)} ${ICON.chev}</span></span>
  </button>`;
}
function mlbHomeCardsHTML() {
  return mlbHomeFreshMoves().map(mlbHomeMoveCard).join('');
}

// ------------------------------------------------------------ 2. game of the moment
// A live game is more interesting the closer it is and the later it gets. Prices break ties.
function mlbHomeHeat(g) {
  const d = Math.abs(mlbHomeScore(g, 'home') - mlbHomeScore(g, 'away'));
  const inn = Math.min(g.inning || 1, 12);
  return (10 - Math.min(d, 10)) * 4 + inn * 5 + (d <= 1 ? 12 : 0) + (mlbHomeOdds(g.pk) ? 8 : 0);
}
function mlbHomeHeroGame() {
  const games = oddsDayGames();
  const live = games.filter(mlbHomeLiveNow);
  if (live.length) return [...live].sort((a, b) => mlbHomeHeat(b) - mlbHomeHeat(a))[0];
  const pre = games.filter(oddsIsPre).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return pre[0] || null;
}
// Two rows: away over home, with the score when there is one.
function mlbHomeBoard(g, live) {
  const row = (side) => {
    const t = mlbHomeTeam(g, side);
    const behind = live && mlbHomeScore(g, side) < mlbHomeScore(g, side === 'home' ? 'away' : 'home');
    return `<span class="mh-t${behind ? ' behind' : ''}">${t.id ? logo(t.id, 'logo mh-t-lg') : ''}<span class="mh-t-nm">${esc(mlbHomeName(g, side))}</span>${live ? `<b class="num mh-t-sc">${mlbHomeScore(g, side)}</b>` : ''}</span>`;
  };
  return `<span class="mh-sb">${row('away')}${row('home')}</span>`;
}
function mlbHomeStat(value, label) {
  return `<span class="mh-st"><span class="v num">${esc(value)}</span><span class="l">${esc(label)}</span></span>`;
}
// The win-chance bar. No color beyond the ink and line tokens — it reads as a share, not as good news.
function mlbHomeBar(g, pHome) {
  if (pHome == null) return '';
  return `<span class="mh-wpb" aria-hidden="true"><i style="width:${((1 - pHome) * 100).toFixed(1)}%"></i></span>
    <span class="mh-wpl" aria-hidden="true"><span><b>${esc(mlbHomeAbbr(g, 'away'))}</b> ${mlbHomePct(1 - pHome)}</span><span>${mlbHomePct(pHome)} <b>${esc(mlbHomeAbbr(g, 'home'))}</b></span></span>`;
}
function mlbHomeSay(lines, muted) {
  const say = lines.filter(Boolean).join(' ');
  if (!say && !muted) return '';
  return `<span class="mh-say">${esc(say)}${muted ? `<span class="muted">${esc(muted)}</span>` : ''}</span>`;
}
// A live game: the live money line, the closing money line, and the chance the live price implies.
function mlbHomeHeroLive(g, O) {
  const mk = O ? oddsMarket(O) : { L: null };
  const hNow = mlbHomeOddsAt(mk.L, 'ml', 'home'), aNow = mlbHomeOddsAt(mk.L, 'ml', 'away');
  const fav = mlbHomeFavSide(hNow, aNow) || 'home';
  const abbr = mlbHomeAbbr(g, fav);
  const nowOdds = fav === 'home' ? hNow : aNow;
  const closeL = O?.close || null;
  const closeOdds = mlbHomeOddsAt(closeL, 'ml', fav);
  const openL = mlbHomeOpenLine(O);
  const openOdds = mlbHomeOddsAt(openL, 'ml', fav);
  const pHome = hNow != null && aNow != null ? oddsNoVig('ml', hNow, aNow) : null;
  const pFav = pHome == null ? null : fav === 'home' ? pHome : 1 - pHome;
  // A price is only "live" when the market moved after first pitch froze the closing line. Otherwise the books
  // are still showing the number they closed at, and calling that a live win chance would be wrong.
  const live = mk.L?.seen != null && (closeL?.at == null ? serverNow() - mk.L.seen < mlbHomeLiveMs : mk.L.seen > closeL.at + 60e3);

  const lead = mlbHomeScore(g, 'home') === mlbHomeScore(g, 'away') ? null : mlbHomeScore(g, 'home') > mlbHomeScore(g, 'away') ? 'home' : 'away';
  const inn = g.inning ? ` in the ${ordinal(g.inning)}` : '';
  const diff = Math.abs(mlbHomeScore(g, 'home') - mlbHomeScore(g, 'away'));
  const s1 = lead ? `The ${mlbHomeName(g, lead)} lead by ${diff}${inn}.` : `Tied ${mlbHomeScore(g, 'home')}–${mlbHomeScore(g, 'away')}${inn}.`;
  let s2 = '';
  if (openOdds != null && nowOdds != null) s2 = `The market opened ${abbr} at ${oddsFmt(openOdds)} and ${live ? `now has them ${oddsFmt(nowOdds)}` : `closed them at ${oddsFmt(nowOdds)}`}.`;
  else if (closeOdds != null && nowOdds != null && live) s2 = `${abbr} closed at ${oddsFmt(closeOdds)} and the live market has them ${oddsFmt(nowOdds)}.`;
  const closeT = closeL?.t?.line ?? openL?.t?.line ?? null;
  const runs = mlbHomeScore(g, 'home') + mlbHomeScore(g, 'away');
  const muted = [
    closeT != null ? `${runs} run${runs === 1 ? '' : 's'} so far against a total of ${oddsTrim(closeT)} at the close.` : '',
    live ? '' : 'No live price for this game, so these are the numbers the market closed at.',
    pFav != null ? `The chance is an estimate from the ${live ? 'live' : 'closing'} price with the book’s cut taken out.` : '',
  ].filter(Boolean).join(' ');

  const stats = nowOdds == null && closeOdds == null && pFav == null ? '' : `<span class="mh-big3">
    ${mlbHomeStat(nowOdds == null ? '—' : oddsFmt(nowOdds), nowOdds == null ? 'No price' : `${abbr} ${live ? 'live money' : 'last money'}`)}
    ${mlbHomeStat(closeOdds == null ? '—' : oddsFmt(closeOdds), closeOdds == null ? 'No closing line' : `${abbr} at the close`)}
    ${mlbHomeStat(pFav == null ? '—' : mlbHomePct(pFav), pFav == null ? 'Win chance' : `${abbr} ${live ? 'win chance' : 'chance at the close'} · est.`)}
  </span>`;
  const spoken = `${oddsSpoken(s1)} ${oddsSpoken(s2)}`.trim();
  return { body: `${mlbHomeBoard(g, true)}${stats}${mlbHomeBar(g, pHome)}${mlbHomeSay([s1, s2], muted)}`, spoken };
}
// A game that hasn't started: the money line, the total, and how far the money line has moved since it opened.
function mlbHomeHeroPre(g, O) {
  const mk = O ? oddsMarket(O) : { L: null };
  const hNow = mlbHomeOddsAt(mk.L, 'ml', 'home'), aNow = mlbHomeOddsAt(mk.L, 'ml', 'away');
  const fav = mlbHomeFavSide(hNow, aNow);
  const abbr = fav ? mlbHomeAbbr(g, fav) : '';
  const nowOdds = fav ? (fav === 'home' ? hNow : aNow) : null;
  const openL = mlbHomeOpenLine(O);
  const openOdds = fav ? mlbHomeOddsAt(openL, 'ml', fav) : null;
  const total = mk.L?.t?.line ?? null;
  const openT = openL?.t?.line ?? null;
  const cents = openOdds != null && nowOdds != null ? oddsScale(nowOdds) - oddsScale(openOdds) : null;
  const pHome = hNow != null && aNow != null ? oddsNoVig('ml', hNow, aNow) : null;
  const pFav = pHome == null ? null : fav === 'home' ? pHome : 1 - pHome;

  const s1 = fav && nowOdds != null
    ? `The ${mlbHomeName(g, fav)} are the favorite at ${oddsFmt(nowOdds)}${pFav != null ? `, an estimated ${mlbHomePct(pFav)} chance once the book’s cut is taken out` : ''}.`
    : O ? 'Neither side is favored yet.' : 'No prices for this game yet.';
  const toward = cents == null || cents === 0 ? '' : mlbHomeName(g, cents > 0 ? fav : fav === 'home' ? 'away' : 'home');
  const s2 = cents == null ? '' : cents === 0
    ? 'The money line has not moved since it opened.'
    : `The money line has moved ${Math.abs(cents)} cent${Math.abs(cents) === 1 ? '' : 's'} toward the ${toward} since it opened.`;
  const muted = `First pitch ${timeLabel(g.start)}${g.venue?.name ? ` · ${g.venue.name}` : ''}. Prices change often.`;

  const stats = nowOdds == null && total == null ? '' : `<span class="mh-big3">
    ${mlbHomeStat(nowOdds == null ? '—' : oddsFmt(nowOdds), nowOdds == null ? 'Money line' : `${abbr} money line`)}
    ${mlbHomeStat(total == null ? '—' : oddsTrim(total), total == null ? 'Total' : `Total runs${openT != null ? ` · opened ${oddsTrim(openT)}` : ''}`)}
    ${mlbHomeStat(cents == null ? '—' : cents === 0 ? 'Flat' : `${cents > 0 ? '+' : '−'}${Math.abs(cents)}¢`, cents == null ? 'No opening line' : 'Money line since it opened')}
  </span>`;
  const spoken = `${oddsSpoken(s1)} ${oddsSpoken(s2)}`.trim();
  return { body: `${mlbHomeBoard(g, false)}${stats}${mlbHomeSay([s1, s2], muted)}`, spoken };
}
function mlbHomeHeroHTML() {
  const g = mlbHomeHeroGame();
  if (!g) return '';
  const live = mlbHomeLiveNow(g);
  const O = mlbHomeOdds(g.pk);
  const { body, spoken } = live ? mlbHomeHeroLive(g, O) : mlbHomeHeroPre(g, O);
  const side = live ? gameStatus(g) : `First pitch ${timeLabel(g.start)}`;
  const title = `${mlbHomeName(g, 'away')} at ${mlbHomeName(g, 'home')}`;
  const label = `Game of the moment. ${title}, ${side}. ${spoken} Opens every book for this game.`;
  return `<div class="hero-lab mh-lab"><b>${live ? '<span class="dot pulse"></span>' : ''}Game of the moment</b><span>${esc(side)}</span></div>
    <button type="button" class="card mh-hero" data-odds-open="${g.pk}" data-fk="mhhero" aria-label="${esc(label)}">${body}</button>`;
}

// ------------------------------------------------------------ 3. line moves
function mlbHomeMoveRow(mv, g) {
  const kind = mlbHomeTagWord[mv.kind] || 'Move';
  // Short in the row, the full sentence odds.js writes in the label and in the sheet.
  const title = mlbHomeMoveTitle(mv, g);
  const to = mlbHomeMoveNum(mv, mv.to);
  const label = `${kind}, ${mlbHomeMatch(g)}, ${oddsAgo(mv.t)}: ${oddsSpoken(oddsMoveText(mv, g))} Now ${oddsSpoken(to)}. Opens every book for this game.`;
  return `<button type="button" class="mh-li" data-odds-open="${g.pk}" data-fk="mhl${esc(mv.id)}" aria-label="${esc(label)}">
    <span class="tag mh-tag${mv.kind === 'steam' ? ' hot' : ''}">${esc(kind)}</span>
    <span class="mh-li-mid"><span class="mh-li-t">${esc(title)}</span><span class="mh-li-s">${esc(mlbHomeMatch(g))} · ${esc(oddsAgo(mv.t))}</span></span>
    <span class="mh-li-v num">${esc(to)}</span>
  </button>`;
}
function mlbHomeMovesHTML() {
  const onDay = new Map(oddsDayGames().map((g) => [g.pk, g]));
  const list = [...ODDS.moves.values()].filter((m) => onDay.has(Number(m.pk))).sort((a, b) => b.t - a.t);
  const limit = isDesk() ? 8 : 6;
  const rows = list.slice(0, limit).map((mv) => mlbHomeMoveRow(mv, onDay.get(Number(mv.pk)))).join('');
  const more = list.length > limit ? `<button type="button" class="mh-more" data-odds-moves data-fk="mhmore">All ${list.length} moves ${ICON.chev}</button>` : '';
  return `<section class="sec mh-sec" aria-label="Line moves">
    <div class="sec-h"><h2>Line moves</h2><span class="more">${list.length ? 'Newest first' : ''}</span></div>
    <div class="card mh-list">${rows || '<div class="empty mh-empty"><b>Quiet so far</b>Steam and big moves show up here the moment they happen.</div>'}${more}</div>
  </section>`;
}

// ------------------------------------------------------------ paint
function mlbHomeOddsHTML() {
  const hero = mlbHomeHeroHTML();
  return `${hero ? `<section class="sec mh-sec" aria-label="Game of the moment">${hero}</section>` : ''}${mlbHomeMovesHTML()}`;
}
// views.js calls this at the end of every Live render, so it has to be cheap: oddsSwap only touches the DOM
// when the markup actually changed.
function mlbHomeHook() {
  const slot = $('#mlbMoveSlot'), host = $('#liveOddsHost');
  if (!slot && !host) return;
  // Replay days never open the Games tab, so ask odds.js for that day's prices here too. It fetches once.
  if (S.date && !S.loading && typeof oddsFetchDay === 'function') oddsFetchDay(S.date);
  if (slot) oddsSwap(slot, mlbHomeCardsHTML());
  if (host) oddsSwap(host, mlbHomeOddsHTML());
}
function mlbHomeRepaint() {
  if (mlbHomeState.raf || S.tab !== 'live') return;
  mlbHomeState.raf = requestAnimationFrame(() => {
    mlbHomeState.raf = 0;
    if (S.tab === 'live') mlbHomeHook();
  });
}
for (const mlbHomeEv of ['bbl:snapshot', 'bbl:odds', 'bbl:move', 'bbl:bets']) document.addEventListener(mlbHomeEv, mlbHomeRepaint);
// "12 min ago" and price freshness keep moving even when nothing new arrives.
setInterval(() => { if (!document.hidden && S.tab === 'live') mlbHomeRepaint(); }, 20e3);
