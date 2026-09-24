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
  const VIEW_KEY = 'tb_bookView';
  // The board's book columns: an optional "My books only" filter and the column order. With no order of your own,
  // the order is smart: your starred books first (in the order you starred them), then the rest as the board lists
  // them. Dragging a column (or Alt+Arrow on its header) saves your own order; "Reset order" goes back to smart.
  function arrange(books, { mine = [], mineOnly = false, order = [] } = {}) {
    const list = Array.isArray(books) ? books.filter((b) => b && valid(b.key)) : [];
    const starred = new Set(mine);
    let out = mineOnly && list.some((b) => starred.has(b.key)) ? list.filter((b) => starred.has(b.key)) : list.slice();
    const pos = new Map(list.map((b, i) => [b.key, i]));
    if (order.length) {
      const at = new Map(order.map((k, i) => [k, i]));
      out.sort((a, b) => (at.has(a.key) ? at.get(a.key) : 1e6 + pos.get(a.key)) - (at.has(b.key) ? at.get(b.key) : 1e6 + pos.get(b.key)));
    } else {
      const rank = new Map(mine.map((k, i) => [k, i]));
      out.sort((a, b) => (rank.has(a.key) ? rank.get(a.key) : 1e6 + pos.get(a.key)) - (rank.has(b.key) ? rank.get(b.key) : 1e6 + pos.get(b.key)));
    }
    return out;
  }
  // Move `key` next to `target` (before it, or after it when `after`) in the shown order; books not shown keep their
  // place in the saved order after the shown ones.
  function moveKey(shown, key, target, after = false, saved = []) {
    const s = shown.filter((k) => k !== key);
    let i = s.indexOf(target);
    if (i < 0 || key === target) return shown.slice();
    if (after) i++;
    s.splice(i, 0, key);
    return [...s, ...saved.filter((k) => !s.includes(k))];
  }

  function create({ storage = null, emit = null } = {}) {
    const readView = () => { try { const v = storage && JSON.parse(storage.getItem(VIEW_KEY) || '{}'); return { mineOnly: !!(v && v.mineOnly), order: clean(v && v.order) }; } catch { return { mineOnly: false, order: [] }; } };
    const writeView = () => { try { if (storage) storage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* private mode */ } };
    let view = readView(), pickOpen = false;
    const read = () => { try { const v = storage && storage.getItem(KEY); return v == null ? [] : clean(JSON.parse(v)); } catch { return []; } };
    const write = (list) => { try { if (storage) storage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ } };
    let set = new Set(read()), touched = false;
    // A change the account has not confirmed yet. Kept on the device so a change made just before the app is closed
    // (force-quit kills the account save in flight) still wins over the account's older list on the next launch.
    const PENDING = KEY + '_pending';
    const pending = () => { try { return !!(storage && storage.getItem(PENDING)); } catch { return false; } };
    const setPending = (on) => { try { if (!storage) return; if (on) storage.setItem(PENDING, '1'); else if (typeof storage.removeItem === 'function') storage.removeItem(PENDING); else storage.setItem(PENDING, ''); } catch { /* private mode */ } };
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
        touched = true; write(api.list()); setPending(true); notify(); push();
        return set.has(k);
      },
      setPickOpen(on) { pickOpen = !!on; },
      // ---- the board's book columns (this device)
      mineOnly: () => view.mineOnly && set.size > 0,
      setMineOnly(on) { view = { ...view, mineOnly: !!on }; writeView(); notify(); },
      order: () => view.order.slice(),
      customOrder: () => view.order.length > 0,
      setOrder(keys) { view = { ...view, order: clean(keys) }; writeView(); notify(); },
      resetOrder() { if (!view.order.length) return; view = { ...view, order: [] }; writeView(); notify(); },
      // What a board shows: books filtered and ordered. books: [{key, ...}] in the board's own order.
      arrange: (books) => arrange(books, { mine: [...set], mineOnly: view.mineOnly, order: view.order }),
      // Move one column; `shown` is the key order on screen now.
      move(shown, key, target, after = false) { api.setOrder(moveKey(shown, key, target, after, view.order)); },
      // The bar above a board: All books / My books, and how to rearrange.
      viewBarHTML(books, e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))) {
        const n = (books || []).filter((b) => b && set.has(b.key)).length, only = view.mineOnly && n > 0;
        const seg = `<div class="bkv-seg" role="group" aria-label="Book columns"><button type="button" data-bkview="all" aria-pressed="${!only}">All books</button><button type="button" data-bkview="mine" aria-pressed="${only}"${n ? '' : ' disabled title="Star books in the Book menu or Tools first"'}>My books${n ? ` (${n})` : ''}</button></div>`;
        const hint = `<span class="bkv-hint">${n ? '' : 'Choose your books to filter. '}Drag a book's column to move it${view.order.length ? '' : '; your books come first'}.</span>`;
        const reset = view.order.length ? '<button type="button" class="bkv-reset" data-bkorder-reset>Reset order</button>' : '';
        // Choose books right here (desktop has no Book menu): the same star chips as Tools, folded until asked for.
        const list = (books || []).filter((b) => b && valid(b.key) && b.key !== 'cons' && b.key !== 'open');
        const pick = list.length ? `<details class="bkv-pick" data-bkv-pick${pickOpen ? ' open' : ''}><summary><span aria-hidden="true">★</span> ${n ? 'Edit my books' : 'Choose my books'}</summary>${api.pickerHTML(list, { label: 'My books', note: 'Star the books you bet at. "My books" then shows only their columns, on every board.' })}</details>` : '';
        return `<div class="bkv"><span class="bkv-l">Books</span>${seg}${pick}${hint}${reset}</div>`;
      },
      // Un-star every book at once (the picker's Clear button). Saves, repaints and syncs like toggle.
      clear() {
        if (!set.size) return false;
        set = new Set(); touched = true; write([]); setPending(true); notify(); push();
        return true;
      },
      subscribe(fn) { if (typeof fn === 'function') subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
      // Signed in (design/foundation.js): the account's saved list wins unless you changed books on this page
      // first (that change, a Clear included, is pushed up instead). An account that never chose books (empty and
      // not `set`) picks up this device's books instead of wiping them; one that was cleared on purpose clears here too.
      adoptAccount(list, { set: chosen = false } = {}) {
        const acct = clean(list);
        if (touched || pending()) { push(); return; }
        if (!acct.length && !chosen) { if (set.size) push(); return; }
        const same = acct.length === set.size && acct.every((k) => set.has(k));
        set = new Set(acct); write(api.list());
        if (!same) notify();
      },
      // The account confirmed it saved this device's list (design/foundation.js).
      saved(list) { const l = clean(list); if (l.length === set.size && l.every((k) => set.has(k))) setPending(false); },
      // Another tab changed the list.
      reloadView() { view = readView(); notify(); },
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

  const out = { create, clean, KEY, VIEW_KEY, arrange, moveKey, BoardFair };
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
  // The board bar and its column moves.
  doc.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest && ev.target.closest('[data-bkview],[data-bkorder-reset]');
    if (!t) return;
    ev.preventDefault();
    if (t.hasAttribute('data-bkorder-reset')) MyBooks.resetOrder(); else MyBooks.setMineOnly(t.dataset.bkview === 'mine');
  });
  const shownKeys = (th) => [...th.closest('tr').querySelectorAll('th[data-bk]')].map((x) => x.dataset.bk);
  // Mouse or pen: drag a column header sideways onto another. (Touch keeps scrolling the table; there the order is
  // smart by default and the keyboard / desktop order carries over.)
  let drag = null;
  doc.addEventListener('pointerdown', (ev) => {
    const th = ev.target && ev.target.closest && ev.target.closest('th[data-bk][data-bk-move]');
    if (!th || ev.pointerType === 'touch' || ev.button !== 0) return;
    drag = { th, key: th.dataset.bk, x: ev.clientX, on: false, target: null, after: false };
  });
  const clearMarks = () => { for (const x of doc.querySelectorAll('.bk-drag,.bk-drop-l,.bk-drop-r')) x.classList.remove('bk-drag', 'bk-drop-l', 'bk-drop-r'); };
  doc.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (!drag.on && Math.abs(ev.clientX - drag.x) < 6) return;
    drag.on = true; clearMarks();
    drag.th.classList.add('bk-drag');
    const over = doc.elementFromPoint(ev.clientX, ev.clientY), th = over && over.closest && over.closest('th[data-bk]');
    if (th && th !== drag.th && th.closest('tr') === drag.th.closest('tr')) {
      const r = th.getBoundingClientRect(); drag.target = th.dataset.bk; drag.after = ev.clientX > r.left + r.width / 2;
      th.classList.add(drag.after ? 'bk-drop-r' : 'bk-drop-l');
    } else drag.target = null;
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag; drag = null; clearMarks();
    if (d.on && d.target) MyBooks.move(shownKeys(d.th), d.key, d.target, d.after);
    if (d.on) { const stop = (e) => { e.stopPropagation(); e.preventDefault(); }; doc.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => doc.removeEventListener('click', stop, { capture: true }), 0); }
  };
  doc.addEventListener('pointerup', endDrag);
  doc.addEventListener('pointercancel', () => { drag = null; clearMarks(); });
  // Keyboard: Alt+Left / Alt+Right on a focused book header moves that column.
  doc.addEventListener('keydown', (ev) => {
    const th = ev.target && ev.target.closest && ev.target.closest('th[data-bk][data-bk-move]');
    if (!th || !ev.altKey || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight')) return;
    const keys = shownKeys(th), i = keys.indexOf(th.dataset.bk), j = ev.key === 'ArrowLeft' ? i - 1 : i + 1;
    if (j < 0 || j >= keys.length) return;
    ev.preventDefault();
    const key = th.dataset.bk;
    MyBooks.move(keys, key, keys[j], ev.key === 'ArrowRight');
    requestAnimationFrame(() => { const again = doc.querySelector(`th[data-bk="${key}"][data-bk-move]`); if (again) again.focus(); });
  });
  // keep the inline "Choose my books" panel open across board repaints
  doc.addEventListener('toggle', (ev) => { const d = ev.target; if (d && d.matches && d.matches('[data-bkv-pick]')) MyBooks.setPickOpen(d.open); }, true);
  doc.addEventListener('board:my-books-saved', (ev) => MyBooks.saved(ev.detail && ev.detail.books));
  doc.addEventListener('board:account-books', (ev) => MyBooks.adoptAccount(ev.detail && ev.detail.books, { set: !!(ev.detail && ev.detail.set) }));
  root.addEventListener('storage', (ev) => { if (ev.key === KEY) MyBooks.reload(); if (ev.key === VIEW_KEY) MyBooks.reloadView(); });
  root.MyBooks = MyBooks;
  root.BoardFair = BoardFair;
})(typeof window !== 'undefined' ? window : null);
