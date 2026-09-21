'use strict';
/* Bing Bong Live — share a bet as an image. "Share" on a bet card in My bets opens a preview sheet with a clean
   1080×1350 PNG drawn on a canvas in the app's own colors (the design tokens, light or dark as shown): the pick and
   odds, the book, matchup and date, Open / Won / Lost / Push with the final runs, and closing line value when known.
   Team colors appear only as a thin identifier line. The amount stays off unless you switch it on.
   Every top-level name here starts with share / SHARE_. */

const SHARE_W = 1080, SHARE_H = 1350;
const SHARE_FONT = 'Geist, ui-sans-serif, system-ui, -apple-system, sans-serif';
const SHARE_ICON = new Set(['circa', 'stn', 'czr', 'mgm', 'sp', 'wg', 'wynn', 'dk', 'fd', 'pin']);
const SHARE_MKT = { ml: 'Moneyline', rl: 'Run line', t: 'Total runs' };
const SHARE_STATE = { open: 'Open', won: 'Won', lost: 'Lost', push: 'Push' };
const SHARE_MINUS = '−';
const SHARE = { bet: null, amount: false, blob: null, url: '', seq: 0 };

// ------------------------------------------------------------ helpers
const shareOdds = (o) => (o == null || !Number.isFinite(o) ? '' : o === 100 ? 'EV' : o > 0 ? `+${o}` : `${SHARE_MINUS}${Math.abs(o)}`);
function shareMoney(n, sign = false) {
  if (typeof betsFmtMoney === 'function') return betsFmtMoney(Math.round(n * 100) / 100, sign);
  const s = `$${Math.abs(n).toFixed(2).replace(/\.00$/, '')}`;
  return n < 0 ? `${SHARE_MINUS}${s}` : sign && n > 0 ? `+${s}` : s;
}
const shareSigned = (v, unit, d = 1) => `${v > 0 ? '+' : v < 0 ? SHARE_MINUS : ''}${Math.abs(v).toFixed(d)}${unit}`;
function shareTokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k, d) => (cs.getPropertyValue(k) || '').trim() || d;
  return {
    bg: v('--bg', '#F4F4F6'), surface: v('--surface', '#FFFFFF'), ink: v('--ink', '#0B0B0D'), ink2: v('--ink-2', '#62626B'),
    ink3: v('--ink-3', '#A3A3AB'), line: v('--line', 'rgba(11,11,13,.08)'), fill: v('--fill', 'rgba(11,11,13,.045)'),
    win: v('--bets-win', '#1A8F4C'), winFill: v('--bets-win-fill', 'rgba(26,143,76,.12)'),
  };
}
const shareBookKey = (name) => (typeof betsBookKey === 'function' ? betsBookKey(name) : '') || '';
const shareGame = (pk) => (typeof betsGame === 'function' ? betsGame(pk) : null);
function shareWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
function shareFinal(l) {
  const f = l.final;
  if (!f || f.h == null || f.a == null) return '';
  const [a, h] = (l.matchup || '').split(' @ ');
  return `Final · ${a || 'Away'} ${f.a}, ${h || 'Home'} ${f.h}`;
}
function shareClv(c) {
  if (!c) return '';
  if (c.pts != null && c.pts !== 0) return `${shareSigned(c.pts, Math.abs(c.pts) === 1 ? ' run' : ' runs', c.pts % 1 ? 1 : 0)} vs the close`;
  if (c.pct != null) return `${shareSigned(c.pct, '%')} vs the closing price`;
  if (c.pts === 0) return 'Same number as the close';
  return '';
}
function shareLabel(b) { return b.legs.length > 1 ? `${b.legs.length}-leg parlay` : b.legs[0]?.label || ''; }
function shareImg(src) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
}
async function shareFonts() {
  try {
    await Promise.all(['400', '500', '600', '700'].map((w) => document.fonts.load(`${w} 40px Geist`)));
    await document.fonts.ready;
  } catch { /* system font fallback */ }
}

// ------------------------------------------------------------ drawing
function shareRound(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function shareFont(ctx, weight, size) { ctx.font = `${weight} ${size}px ${SHARE_FONT}`; }
// Shrink to fit, then ellipsize if even the smallest size is too wide.
function shareFit(ctx, text, maxW, weight, size, min = size * 0.55) {
  let s = size;
  shareFont(ctx, weight, s);
  while (s > min && ctx.measureText(text).width > maxW) { s -= 2; shareFont(ctx, weight, s); }
  let t = text;
  while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -2) + '…';
  return { t, s };
}
function shareText(ctx, text, x, y, { weight = 500, size = 32, color, align = 'left', maxW = 824, min } = {}) {
  const f = shareFit(ctx, text, maxW, weight, size, min);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(f.t, x, y);
  return f;
}
function sharePill(ctx, text, xRight, y, T, state) {
  shareFont(ctx, 600, 30);
  const w = ctx.measureText(text).width + 48, h = 56;
  const x = xRight - w;
  const win = state === 'won';
  shareRound(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = win ? T.winFill : T.fill;
  ctx.fill();
  ctx.fillStyle = win ? T.win : state === 'lost' ? T.ink2 : T.ink;
  ctx.textAlign = 'center';
  ctx.fillText(text, x + w / 2, y + 38);
}
async function shareBookMark(ctx, key, name, x, y, size, T) {
  shareRound(ctx, x, y, size, size, size * 0.28);
  ctx.save();
  ctx.clip();
  const im = SHARE_ICON.has(key) ? await shareImg(`icons/books/${key}.png`) : null;
  if (im) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, y, size, size);
    ctx.drawImage(im, x, y, size, size);
  } else {
    ctx.fillStyle = T.fill;
    ctx.fillRect(x, y, size, size);
    const mono = (name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '…';
    shareFont(ctx, 650, Math.round(size * 0.38));
    ctx.fillStyle = T.ink;
    ctx.textAlign = 'center';
    ctx.fillText(mono, x + size / 2, y + size * 0.63);
  }
  ctx.restore();
}
// Thin identifier line in team colors: away then home for each game on the ticket.
function shareTeamLine(ctx, b, x, y, w) {
  const cols = [];
  for (const l of b.legs) {
    const g = shareGame(l.pk);
    if (!g || typeof TC === 'undefined') continue;
    for (const t of [g.away, g.home]) if (TC[t?.id]) cols.push(TC[t.id]);
  }
  if (!cols.length) return;
  const seg = w / cols.length;
  cols.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(x + i * seg, y, Math.ceil(seg), 6); });
}

async function shareDraw(b, { amount = false } = {}) {
  await shareFonts();
  const T = shareTokens();
  const cv = document.createElement('canvas');
  cv.width = SHARE_W;
  cv.height = SHARE_H;
  const ctx = cv.getContext('2d');
  ctx.textBaseline = 'alphabetic';
  // page and card
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, SHARE_W, SHARE_H);
  const M = 56, P = 72;
  shareRound(ctx, M, M, SHARE_W - 2 * M, SHARE_H - 2 * M, 56);
  ctx.fillStyle = T.surface;
  ctx.fill();
  const L = M + P, R = SHARE_W - M - P, W = R - L;

  // header: the app's mark, name and the ticket's status
  shareRound(ctx, L, 124, 48, 48, 14);
  ctx.fillStyle = T.ink;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(L + 24, 148, 9, 0, Math.PI * 2);
  ctx.fillStyle = T.surface;
  ctx.fill();
  shareText(ctx, 'Bing Bong Live', L + 68, 162, { weight: 650, size: 38, color: T.ink, maxW: W - 260 });
  const st = SHARE_STATE[b.status] || 'Open';
  sharePill(ctx, st, R, 120, T, b.status);
  shareTeamLine(ctx, b, L, 212, W);

  const single = b.legs.length === 1;
  const l0 = b.legs[0] || {};
  let y = 300;
  if (single) {
    // center the pick block between the header and the book row
    const fin = b.status !== 'open' ? shareFinal(l0) : '';
    const clv = shareClv(l0.clv);
    const h = 34 + 118 + 96 + 116 + 54 + (fin ? 66 : 0) + (clv ? (fin ? 50 : 66) : 0);
    y = 250 + Math.max(0, Math.round((760 - h) / 2)) + 34;
    shareText(ctx, SHARE_MKT[l0.mkt] || '', L, y, { weight: 500, size: 34, color: T.ink2 });
    y += 118;
    shareText(ctx, l0.label || '', L, y, { weight: 700, size: 124, color: T.ink, min: 64 });
    y += 96;
    shareText(ctx, shareOdds(b.odds), L, y, { weight: 600, size: 76, color: T.ink2 });
    y += 116;
    shareText(ctx, l0.matchup || '', L, y, { weight: 600, size: 44, color: T.ink });
    y += 54;
    shareText(ctx, shareWhen(l0.start) || '', L, y, { weight: 500, size: 32, color: T.ink2 });
    if (fin) { y += 66; shareText(ctx, fin, L, y, { weight: 600, size: 36, color: T.ink }); }
    if (clv) { y += fin ? 50 : 66; shareText(ctx, `Closing line value: ${clv}`, L, y, { weight: 500, size: 32, color: T.ink2 }); }
  } else {
    shareText(ctx, `${b.legs.length}-leg parlay`, L, y + 40, { weight: 700, size: 96, color: T.ink, min: 60 });
    y += 124;
    shareText(ctx, shareOdds(b.odds), L, y, { weight: 600, size: 64, color: T.ink2 });
    y += 40;
    const max = b.legs.length > 6 ? 5 : 6;
    for (const l of b.legs.slice(0, max)) {
      ctx.fillStyle = T.line;
      ctx.fillRect(L, y, W, 2);
      const tag = l.state && l.state !== 'open' ? SHARE_STATE[l.state] || (l.state === 'void' ? 'Void' : '') : '';
      shareFont(ctx, 600, 26);
      const tagW = tag ? ctx.measureText(tag).width + 36 : 0;
      shareText(ctx, `${l.label || ''}  ${shareOdds(l.odds)}`, L, y + 52, { weight: 600, size: 36, color: T.ink, maxW: W - tagW - 16 });
      const sub = [l.matchup, l.state && l.state !== 'open' ? shareFinal(l).replace(/^Final · /, 'Final ') : shareWhen(l.start), shareClv(l.clv)].filter(Boolean).join(' · ');
      shareText(ctx, sub, L, y + 92, { weight: 500, size: 26, color: T.ink2, maxW: W - tagW - 16 });
      if (tag) {
        shareFont(ctx, 600, 26);
        const x = R - tagW;
        shareRound(ctx, x, y + 22, tagW, 44, 22);
        ctx.fillStyle = l.state === 'won' ? T.winFill : T.fill;
        ctx.fill();
        ctx.fillStyle = l.state === 'won' ? T.win : T.ink2;
        ctx.textAlign = 'center';
        ctx.fillText(tag, x + tagW / 2, y + 53);
      }
      y += 112;
    }
    if (b.legs.length > max) shareText(ctx, `+ ${b.legs.length - max} more legs`, L, y + 40, { weight: 500, size: 28, color: T.ink2 });
  }

  // book, amount, footer
  const bookName = b.book || '';
  const showAmt = amount && b.stake > 0;
  const by = 1040;
  if (bookName) {
    await shareBookMark(ctx, shareBookKey(bookName), bookName, L, by, 76, T);
    shareText(ctx, bookName, L + 100, by + 50, { weight: 600, size: 38, color: T.ink, maxW: showAmt ? W / 2 - 124 : W - 100 });
  }
  if (showAmt) {
    const win = typeof betsToWin === 'function' ? betsToWin(b.stake, b.odds) : null;
    const txt = b.status === 'open' || b.net == null ? `${shareMoney(b.stake)} to win ${win == null ? '' : shareMoney(win)}`
      : b.status === 'won' ? `Won ${shareMoney(b.net, true)} on ${shareMoney(b.stake)}`
      : b.status === 'push' ? `${shareMoney(b.stake)} back` : `${shareMoney(b.stake)} staked`;
    shareText(ctx, txt, bookName ? R : L, by + 50, { weight: 600, size: 38, color: b.status === 'won' ? T.win : T.ink, align: bookName ? 'right' : 'left', maxW: bookName ? W / 2 : W });
  }
  ctx.fillStyle = T.line;
  ctx.fillRect(L, 1170, W, 2);
  const placed = b.placed ? new Date(b.placed).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  shareText(ctx, placed ? `Logged ${placed}` : 'Logged in Bing Bong Live', L, 1224, { weight: 500, size: 28, color: T.ink3, maxW: W / 2 });
  shareText(ctx, 'For fun. Not advice.', R, 1224, { weight: 500, size: 28, color: T.ink3, align: 'right', maxW: W / 2 });
  return cv;
}

// ------------------------------------------------------------ the preview sheet
const shareCanFiles = () => {
  try { return !!navigator.canShare && navigator.canShare({ files: [new File([new Blob([''])], 'x.png', { type: 'image/png' })] }); } catch { return false; }
};
function shareSheetHTML(b) {
  const label = shareLabel(b);
  const amt = b.stake > 0 ? `<div class="share-opt">
      <div><b id="shareAmtL">Include amount</b><span>Adds your stake and payout to the image.</span></div>
      <button type="button" class="share-sw" role="switch" aria-checked="${SHARE.amount}" aria-labelledby="shareAmtL" data-share-amount><i></i></button>
    </div>` : '';
  return `<div class="share-sheet">
    <h2 id="dlgTitle">Share this bet</h2>
    <p class="share-lede">${esc(label)} ${esc(shareOdds(b.odds))}. The amount stays off the image unless you add it.</p>
    <div class="share-prev" id="sharePrev"><span class="share-wait">Drawing…</span></div>
    ${amt}
    <div class="bets-btns share-btns" id="shareBtns">
      ${shareCanFiles() ? '<button type="button" class="bets-btn" data-share-go disabled>Share</button>' : ''}
      <a class="bets-btn ghost" id="shareSave" download="bing-bong-bet.png" aria-disabled="true">Save image</a>
    </div>
    <p class="share-err" id="shareErr" role="alert"></p>
  </div>`;
}
async function sharePaint() {
  const b = SHARE.bet;
  if (!b) return;
  const seq = ++SHARE.seq;
  let cv;
  try { cv = await shareDraw(b, { amount: SHARE.amount }); } catch (e) { const er = $('#shareErr'); if (er) er.textContent = 'The image couldn’t be drawn. Try again.'; return; }
  const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
  if (seq !== SHARE.seq || S.dlgKind !== 'share' || !blob) return;
  if (SHARE.url) URL.revokeObjectURL(SHARE.url);
  SHARE.blob = blob;
  SHARE.url = URL.createObjectURL(blob);
  const st = SHARE_STATE[b.status] || 'Open';
  const alt = `Share image: ${shareLabel(b)} ${shareOdds(b.odds)}${b.book ? ` at ${b.book}` : ''}, ${st}${SHARE.amount && b.stake > 0 ? ', with the amount' : ''}.`.replace(/−/g, 'minus ');
  $('#sharePrev').innerHTML = `<img src="${SHARE.url}" width="${SHARE_W}" height="${SHARE_H}" alt="${esc(alt)}">`;
  const save = $('#shareSave');
  if (save) { save.href = SHARE.url; save.removeAttribute('aria-disabled'); }
  const go = $('[data-share-go]');
  if (go) go.disabled = false;
}
function shareOpen(id) {
  const b = typeof id === 'object' ? id : (typeof BETS !== 'undefined' ? BETS.list.find((x) => x.id === id) : null);
  if (!b) return;
  SHARE.bet = b;
  SHARE.amount = false; // hidden by default, every time
  openSheet(shareSheetHTML(b), 'share');
  sharePaint();
}
async function shareGo() {
  if (!SHARE.blob) return;
  const file = new File([SHARE.blob], 'bing-bong-bet.png', { type: 'image/png' });
  try {
    await navigator.share({ files: [file], title: 'My bet · Bing Bong Live' });
  } catch (e) {
    if (e?.name === 'AbortError') return; // closed the share sheet
    const er = $('#shareErr');
    if (er) er.textContent = 'Sharing didn’t work here. Use Save image instead.';
  }
}

// ------------------------------------------------------------ interactions (data-share-*)
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-share-bet],[data-share-amount],[data-share-go],#shareSave');
  if (!t) return;
  if (t.id === 'shareSave') { if (!SHARE.url) ev.preventDefault(); return; }
  const d = t.dataset;
  if (d.shareBet) { ev.preventDefault(); shareOpen(d.shareBet); return; }
  if (d.shareAmount !== undefined) {
    SHARE.amount = !SHARE.amount;
    t.setAttribute('aria-checked', String(SHARE.amount));
    const go = $('[data-share-go]');
    if (go) go.disabled = true;
    sharePaint();
    return;
  }
  if (d.shareGo !== undefined) shareGo();
});
$('#dlg')?.addEventListener('close', () => {
  SHARE.seq++;
  SHARE.bet = null;
  SHARE.blob = null;
  if (SHARE.url) { URL.revokeObjectURL(SHARE.url); SHARE.url = ''; }
});
