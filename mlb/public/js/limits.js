'use strict';
/* Bing Bong Live — play limits. Optional daily and weekly caps on the total stake you log, saved on this device only and
   off until you set one. Going past a cap never blocks a bet: the slip says so once, calmly, and Save becomes
   "Save anyway". "Take a break" hides the Odds view's Edge Finder entry and the price flashes until a date you pick
   (up to 30 days) or until you turn it off. Every top-level name here starts with lim / LIM_. */

const LIM_MAX_DAYS = 30;
const LIM_DEF = { day: 0, week: 0, brk: false, until: '' };

// ------------------------------------------------------------ settings (store: bbl.limits)
function limCfg() {
  const c = { ...LIM_DEF, ...(store.get('limits', null) || {}) };
  c.day = Number(c.day) > 0 ? Math.round(Number(c.day) * 100) / 100 : 0;
  c.week = Number(c.week) > 0 ? Math.round(Number(c.week) * 100) / 100 : 0;
  c.brk = !!c.brk;
  c.until = /^\d{4}-\d{2}-\d{2}$/.test(c.until || '') ? c.until : '';
  return c;
}
function limSet(patch) {
  store.set('limits', { ...limCfg(), ...patch });
  limApplyBreak();
}
const limMoney = (n) => (typeof betsFmtMoney === 'function' ? betsFmtMoney(Math.round(n * 100) / 100) : `$${Math.round(n)}`);
const limISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function limAddDays(n) { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return limISO(d); }
const limDateTxt = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '');

// ------------------------------------------------------------ what you've logged (local day, week starting Monday)
function limStarts() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getTime();
  const w = new Date(d);
  w.setDate(w.getDate() - ((w.getDay() + 6) % 7));
  return { day, week: w.getTime() };
}
function limLogged(list) {
  const src = list || (typeof betsVisible === 'function' ? betsVisible() : []);
  const s = limStarts();
  let day = 0, week = 0;
  for (const b of src) {
    if (!b || b.status === 'void' || !(b.stake > 0)) continue; // a voided bet's stake came back
    const t = Date.parse(b.placed) || b.created || 0;
    if (t >= s.week) week += b.stake;
    if (t >= s.day) day += b.stake;
  }
  return { day, week };
}
// The limits a new stake would pass, as plain sentences. Empty when it wouldn't pass any.
function limOver(stake) {
  const c = limCfg();
  if (!(stake > 0) || (!c.day && !c.week)) return [];
  const n = limLogged();
  const out = [];
  if (c.week && n.week + stake > c.week) out.push(`This would take you to ${limMoney(n.week + stake)} logged this week, past your ${limMoney(c.week)} limit.`);
  if (c.day && n.day + stake > c.day) out.push(`This would take you to ${limMoney(n.day + stake)} logged today, past your ${limMoney(c.day)} daily limit.`);
  return out;
}

// ------------------------------------------------------------ the bet slip (called from bets.js)
// The notice shows only after the first Save tap, and goes away if the stake drops back under.
function limSlipHTML(sl) {
  if (!sl?.limAck) return '';
  const over = limOver(sl.stake);
  if (!over.length) { sl.limAck = false; return ''; }
  return `<div class="lim-note" role="status">${over.map((t) => `<p>${esc(t)}</p>`).join('')}<p class="lim-note-s">It’s still your call. Tap Save anyway to log it, or change the amount.</p></div>`;
}
// true = go ahead and save. The first tap past a limit shows the notice and turns Save into "Save anyway".
function limSlipGate(sl) {
  if (!sl) return true;
  if (!limOver(sl.stake).length) { sl.limAck = false; return true; }
  if (sl.limAck) return true;
  sl.limAck = true;
  const box = $('#betsLim');
  if (box) { const h = limSlipHTML(sl); box.innerHTML = h; box.dataset.key = h; }
  const bt = $('#betsBtns');
  if (bt && typeof betsBtnsHTML === 'function') bt.innerHTML = betsBtnsHTML();
  $('[data-bets-save]')?.focus({ preventScroll: true });
  return false;
}

// ------------------------------------------------------------ My bets: where you are this week
function limMineHTML(list) {
  const c = limCfg();
  if (!c.day && !c.week) return '';
  const n = limLogged(list);
  const row = (label, have, cap) => {
    const pct = Math.min(100, Math.round((have / cap) * 100));
    const past = have > cap;
    return `<div class="lim-row"><div class="lim-row-t"><span>${label}: <b class="num">${esc(limMoney(have))}</b> of your <span class="num">${esc(limMoney(cap))}</span> limit${past ? ' · past it' : ''}</span></div><div class="lim-bar" aria-hidden="true"><i style="width:${Math.max(pct, have > 0 ? 2 : 0)}%"></i></div></div>`;
  };
  return `<section class="card lim-mine" aria-label="Play limits">${c.week ? row('This week', n.week, c.week) : ''}${c.day ? row('Today', n.day, c.day) : ''}</section>`;
}

// ------------------------------------------------------------ Mine → Results → Settings
function limCardHTML() {
  return `<section class="card bets-tool lim-card" id="limCard" aria-labelledby="limTitle">
    <h3 id="limTitle">Play limits</h3>
    <p>Pick how much you want to log in a day or a week. If a bet would go past it, the slip lets you know before you save. It never stops you. Leave a box empty to keep that limit off.</p>
    <div class="bets-fgrid">
      <label class="bets-fld">Daily limit ($)<input class="bets-inp" id="limDay" inputmode="decimal" autocomplete="off" placeholder="Off"></label>
      <label class="bets-fld">Weekly limit ($)<input class="bets-inp" id="limWeek" inputmode="decimal" autocomplete="off" placeholder="Off"></label>
    </div>
    <p class="lim-now" id="limNow" aria-live="polite"></p>
    <div class="lim-brk">
      <div class="lim-brk-h">
        <div><b id="limBrkLabel">Take a break</b><span>Hides Edge Finder and the price flashes on the Odds board. Your bets and scores stay as they are.</span></div>
        <button type="button" class="lim-sw" id="limBrk" role="switch" aria-checked="false" aria-labelledby="limBrkLabel" data-lim-brk><i></i></button>
      </div>
      <div class="lim-until" id="limUntilBox" hidden>
        <label class="bets-fld">Until (optional)<input class="bets-inp" id="limUntil" type="date"></label>
        <div class="bets-chips" role="group" aria-label="Break length">
          <button type="button" class="bets-chip" data-lim-days="1">1 day</button>
          <button type="button" class="bets-chip" data-lim-days="7">1 week</button>
          <button type="button" class="bets-chip" data-lim-days="30">30 days</button>
          <button type="button" class="bets-chip" data-lim-days="0">Until I turn it off</button>
        </div>
        <p class="lim-brk-s" id="limBrkNow"></p>
      </div>
    </div>
    <div class="bets-btns"><button type="button" class="bets-btn ghost" data-lim-clear>Clear limits</button></div>
    <p class="bets-note-p">Saved on this device only.</p>
  </section>`;
}
function limHelpHTML() {
  return '<p class="lim-help">Gambling problem? Call <a href="tel:+18004262537" aria-label="Call 1-800-GAMBLER, 1 800 426 2537">1-800-GAMBLER</a>.</p>';
}
function limPaint() {
  const card = $('#limCard');
  if (!card) return;
  const c = limCfg();
  const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
  set('#limDay', c.day ? String(c.day) : '');
  set('#limWeek', c.week ? String(c.week) : '');
  const n = limLogged();
  $('#limNow').textContent = `Logged today ${limMoney(n.day)} · this week ${limMoney(n.week)}${c.day || c.week ? '' : ' · no limits set'}`;
  const on = limBreakOn();
  const sw = $('#limBrk');
  sw.setAttribute('aria-checked', String(on));
  $('#limUntilBox').hidden = !on;
  const u = $('#limUntil');
  u.min = limAddDays(1);
  u.max = limAddDays(LIM_MAX_DAYS);
  set('#limUntil', c.until || '');
  const days = c.until ? Math.round((Date.parse(`${c.until}T12:00:00`) - Date.parse(`${limAddDays(0)}T12:00:00`)) / 864e5) : 0;
  for (const b of $$('[data-lim-days]', card)) b.setAttribute('aria-pressed', String(Number(b.dataset.limDays) === days));
  $('#limBrkNow').textContent = on ? (c.until ? `On until ${limDateTxt(c.until)}. It turns itself off that morning.` : 'On until you turn it off.') : '';
  const clr = $('[data-lim-clear]', card);
  if (clr) clr.hidden = !c.day && !c.week;
}

// ------------------------------------------------------------ Take a break
function limBreakOn() {
  const c = limCfg();
  if (!c.brk) return false;
  return !c.until || limISO(new Date()) < c.until;
}
function limApplyBreak() {
  const c = limCfg();
  if (c.brk && c.until && limISO(new Date()) >= c.until) store.set('limits', { ...c, brk: false, until: '' }); // the date came: back on quietly
  const on = limBreakOn();
  document.documentElement.classList.toggle('lim-break', on);
  if (on && S.dlgKind === 'edges' && typeof closeSheet === 'function') closeSheet();
}
function limUntilPick(iso) {
  let v = iso || '';
  if (v) { const lo = limAddDays(1), hi = limAddDays(LIM_MAX_DAYS); v = v < lo ? lo : v > hi ? hi : v; }
  limSet({ brk: true, until: v });
  limPaint();
}

// ------------------------------------------------------------ interactions (data-lim-*)
let limTimer = 0;
function limReadMoney(el) {
  const t = String(el.value || '').replace(/[$,\s]/g, '');
  if (t === '') return 0;
  const v = Number(t);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 1e7) : null;
}
document.addEventListener('input', (ev) => {
  const id = ev.target.id;
  if (id !== 'limDay' && id !== 'limWeek') return;
  const v = limReadMoney(ev.target);
  if (v == null) return; // not a number yet; keep what was saved
  clearTimeout(limTimer);
  limTimer = setTimeout(() => {
    limSet(id === 'limDay' ? { day: v } : { week: v });
    limPaint();
    if (typeof invalidate === 'function') invalidate();
  }, 300);
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'limUntil') limUntilPick(ev.target.value);
  if (ev.target.id === 'limDay' || ev.target.id === 'limWeek') { clearTimeout(limTimer); const v = limReadMoney(ev.target); if (v != null) limSet(ev.target.id === 'limDay' ? { day: v } : { week: v }); limPaint(); if (typeof invalidate === 'function') invalidate(); }
});
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-lim-brk],[data-lim-days],[data-lim-clear]');
  if (!t) return;
  const d = t.dataset;
  if (d.limBrk !== undefined) {
    const on = !limBreakOn();
    limSet(on ? { brk: true, until: '' } : { brk: false, until: '' });
    limPaint();
    if (typeof toastText === 'function') toastText(on ? 'Break on. Edge Finder and price flashes are hidden.' : 'Break off. Edge Finder is back on the Odds board.');
    return;
  }
  if (d.limDays !== undefined) { const n = Number(d.limDays); limUntilPick(n ? limAddDays(n) : ''); return; }
  if (d.limClear !== undefined) {
    limSet({ day: 0, week: 0 });
    for (const id of ['#limDay', '#limWeek']) { const el = $(id); if (el) el.value = ''; }
    limPaint();
    if (typeof invalidate === 'function') invalidate();
  }
});

// ------------------------------------------------------------ start
limApplyBreak();
setInterval(() => { if (!document.hidden) limApplyBreak(); }, 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) limApplyBreak(); });
