'use strict';
/* THE.BOARD shared, loaded by all four boards (NFL, NCAAF, MLB, NHL):

   1. MyBooks — the books this user bets at. Nothing is highlighted by default. Picking a book (a star chip in a
      board's book controls or its "Where to bet" sheet) highlights that book's column and prices on every board;
      un-picking it takes the formatting away again. Saved on this device (localStorage "tb_myBooks", one list for
      all four sports, so a book picked on NFL is picked on MLB too) and, when signed in, to the account's
      preferences.books (design/foundation.js carries it; shared/accounts.js already stores it).
   2. BoardFair — the model's fair-price math for the boards' Model column: win probability from a fair margin
      (normal, the model's own margin SD) and the no-vig American price of a probability. Prices past ±2500 are
      noise, not a number to read, so they come back null (shown as a dash).

   Classic script (the terminal concatenates it into each board's bundle); also exports for node tests. */
(function (root) {
  const KEY = 'tb_myBooks';
  const valid = (k) => typeof k === 'string' && /^[a-z0-9_-]{1,48}$/.test(k);
  const clean = (list) => [...new Set((Array.isArray(list) ? list : []).filter(valid))].slice(0, 80);

  // ------------------------------------------------------------------ fair prices
  // Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7).
  function ncdf(x) {
    if (!Number.isFinite(x)) return x > 0 ? 1 : x < 0 ? 0 : NaN;
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
    return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  // P(side wins) when the model's fair margin for that side is `margin` points/goals/runs with SD `sd`.
  const winFromMargin = (margin, sd) => (Number.isFinite(margin) && Number.isFinite(sd) && sd > 0 ? ncdf(margin / sd) : null);
  // No-vig American price for probability p. Null outside (0,1) or past ±cap.
  function american(p, cap = 2500) {
    if (!(p > 0 && p < 1)) return null;
    const v = p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p;
    return Math.abs(v) > cap ? null : Math.round(v);
  }
  const fmtAmerican = (v) => (v == null ? '' : v > 0 ? `+${v}` : `−${Math.abs(v)}`);
  const BoardFair = { ncdf, winFromMargin, american, fmtAmerican };

  // ------------------------------------------------------------------ my books
  function create({ storage = null, emit = null } = {}) {
    const read = () => { try { const v = storage && storage.getItem(KEY); return v == null ? [] : clean(JSON.parse(v)); } catch { return []; } };
    const write = (list) => { try { if (storage) storage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ } };
    let set = new Set(read()), touched = false;
    const subs = [];
    const notify = () => { for (const fn of subs) { try { fn(api.list()); } catch { /* one board's repaint never blocks another */ } } };
    const push = () => { if (emit) emit('board:my-books', { books: api.list() }); };
    const api = {
      has: (k) => set.has(k),
      list: () => [...set],
      size: () => set.size,
      // Flip one book. Saves, repaints every subscriber, and hands the new list to the account sync.
      toggle(k) {
        if (!valid(k)) return false;
        if (set.has(k)) set.delete(k); else set.add(k);
        touched = true; write(api.list()); notify(); push();
        return set.has(k);
      },
      // Un-star every book at once (the picker's Clear button). Saves, repaints and syncs like toggle.
      clear() {
        if (!set.size) return false;
        set = new Set(); touched = true; write([]); notify(); push();
        return true;
      },
      subscribe(fn) { if (typeof fn === 'function') subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
      // Signed in (design/foundation.js): the account's saved list wins unless you changed books on this page
      // first; an empty account list picks up this device's books instead of wiping them.
      adoptAccount(list) {
        const acct = clean(list);
        if (touched || !acct.length) { if (set.size) push(); return; }
        const same = acct.length === set.size && acct.every((k) => set.has(k));
        set = new Set(acct); write(api.list());
        if (!same) notify();
      },
      // Another tab changed the list.
      reload() { const next = read(); const same = next.length === set.size && next.every((k) => set.has(k)); set = new Set(next); if (!same) notify(); },
      cls: (k) => (set.has(k) ? ' my-bk' : ''),
      star: (k) => (set.has(k) ? '★' : '☆'),
      // A row of star chips, one per book. books: [{key, name|short}]
      pickerHTML(books, { label = 'My books', note = 'Star the books you bet at. Their columns and prices are highlighted on every board, on this device and your account.' } = {}) {
        const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const chips = (books || []).filter((b) => b && valid(b.key)).map((b) => api.chipHTML(b.key, b.short || b.name || b.key, b.name || b.short || b.key, e)).join('');
        const clear = `<button type="button" class="mybk-clear" data-mybook-clear${set.size ? '' : ' disabled'} aria-label="Clear my books: un-star every book">Clear</button>`;
        return `<div class="mybk"><div class="mybk-top"><div class="mybk-h"><b>${e(label)}</b><span>${e(note)}</span></div>${clear}</div><div class="mybk-chips" role="group" aria-label="${e(label)}">${chips}</div></div>`;
      },
      chipHTML(k, short, full, e = (v) => String(v)) {
        const on = set.has(k);
        return `<button type="button" class="mybk-chip" data-mybook="${e(k)}" aria-pressed="${on}" aria-label="${e(full)}: ${on ? 'one of my books' : 'not one of my books'}"><span class="mybk-star" aria-hidden="true">${on ? '★' : '☆'}</span>${e(short)}</button>`;
      },
    };
    return api;
  }

  const out = { create, clean, KEY, BoardFair };
  if (typeof module === 'object' && module.exports) module.exports = out;
  if (!root || !root.document) return;

  // ------------------------------------------------------------------ browser wiring
  let storage = null; try { storage = root.localStorage; } catch { /* storage blocked */ }
  const doc = root.document;
  const MyBooks = create({ storage, emit: (name, detail) => doc.dispatchEvent(new CustomEvent(name, { detail })) });
  // Keep every chip on screen in step (a board may show the same book's chip in two places).
  const syncChips = () => {
    for (const b of doc.querySelectorAll('[data-mybook]')) {
      const k = b.dataset.mybook, on = MyBooks.has(k);
      b.setAttribute('aria-pressed', String(on));
      const s = b.querySelector('.mybk-star'); if (s) s.textContent = on ? '★' : '☆';
      const lbl = b.getAttribute('aria-label'); if (lbl) b.setAttribute('aria-label', lbl.replace(/: (not )?one of my books$/, on ? ': one of my books' : ': not one of my books'));
    }
  };
  const syncClear = () => { for (const c of doc.querySelectorAll('[data-mybook-clear]')) c.disabled = !MyBooks.size(); };
  MyBooks.subscribe(syncChips);
  MyBooks.subscribe(syncClear);
  doc.addEventListener('click', (ev) => {
    const c = ev.target && ev.target.closest && ev.target.closest('[data-mybook-clear]');
    if (c) { ev.preventDefault(); ev.stopPropagation(); MyBooks.clear(); return; }
    const b = ev.target && ev.target.closest && ev.target.closest('[data-mybook]');
    if (!b) return;
    ev.preventDefault(); ev.stopPropagation();
    MyBooks.toggle(b.dataset.mybook);
  }, true);
  doc.addEventListener('board:account-books', (ev) => MyBooks.adoptAccount(ev.detail && ev.detail.books));
  root.addEventListener('storage', (ev) => { if (ev.key === KEY) MyBooks.reload(); });
  root.MyBooks = MyBooks;
  root.BoardFair = BoardFair;
})(typeof window !== 'undefined' ? window : null);
