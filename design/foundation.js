(() => {
  'use strict';
  function mount() {
    if (document.getElementById('board-workspace-nav')) return;
    const nav = document.createElement('nav'); nav.id = 'board-workspace-nav'; nav.setAttribute('aria-label', 'Workspace');
    nav.innerHTML = '<a href="/opportunities">Opportunities <span aria-hidden="true">↗</span></a><a href="/account">Account & sync</a><button type="button" aria-pressed="false">Focus mode</button>';
    const sportbar = document.getElementById('xsport'); if (sportbar) sportbar.after(nav); else document.body.prepend(nav);
    let account, focusTouched = false, regionTouched = false, applyingAccount = false, revision = 0, queue = Promise.resolve();
    const button = nav.querySelector('button');
    const apply = enabled => { enabled = enabled === true; document.documentElement.classList.toggle('board-focus', enabled); button.setAttribute('aria-pressed', String(enabled)); button.textContent = enabled ? 'Exit focus' : 'Focus mode'; button.title = enabled ? 'Show everything again (F)' : 'Only the games, prices, model and your bets (F)'; try { localStorage.setItem('board.focus', enabled ? '1' : '0'); } catch { /* Storage optional. */ } };
    function persist(patch) {
      if (!account?.account) return;
      account.account.preferences = { ...account.account.preferences, ...patch }; const current = ++revision;
      queue = queue.catch(() => {}).then(async () => {
        // keepalive: a save started just before the app is closed still reaches the server
        const response = await fetch('/api/account/preferences', { method:'POST', credentials:'same-origin', keepalive:true, headers:{'content-type':'application/json','x-account-csrf':account.csrf}, body:JSON.stringify(account.account.preferences) });
        if (!response.ok) throw new Error('Preferences unavailable.');
        const value = await response.json(); if (revision === current && value?.preferences) account.account.preferences = value.preferences;
        if (Array.isArray(patch.books)) document.dispatchEvent(new CustomEvent('board:my-books-saved', { detail: { books: value?.preferences?.books || patch.books } }));
      }).catch(() => { button.title = 'Saved on this device. Account preference sync is unavailable.'; });
    }
    try { apply(localStorage.getItem('board.focus') === '1'); } catch { apply(false); }
    const toggleFocus = () => { focusTouched = true; const enabled = button.getAttribute('aria-pressed') !== 'true'; apply(enabled); persist({ focusMode:enabled }); };
    button.addEventListener('click', toggleFocus);
    // F turns focus mode on and off, except while typing.
    document.addEventListener('keydown', event => { if (event.key !== 'f' && event.key !== 'F') return; if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return; const t = event.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; event.preventDefault(); toggleFocus(); });
    // My books (design/mybooks.js): a change on any board is saved to the account's preferences.books.
    document.addEventListener('board:my-books', event => { const books = event.detail?.books; if (Array.isArray(books)) persist({ books, booksSet: true }); });
    document.addEventListener('board:betting-state', event => { if (applyingAccount) return; const state = event.detail?.state; if (!/^[a-z]{2}$/.test(state || '')) return; regionTouched = true; persist({ region:state.toUpperCase() }); });
    fetch('/api/account/me', { cache:'no-store', credentials:'same-origin' }).then(r => r.ok ? r.json() : null).then(value => {
      account = value; if (!account?.account) return;
      nav.querySelector('a[href="/account"]').textContent = 'My account';
      const local = {};
      if (!focusTouched) apply(account.account.preferences?.focusMode === true); else local.focusMode = button.getAttribute('aria-pressed') === 'true';
      if (!regionTouched && window.BoardHandoff?.setState) { applyingAccount = true; try { window.BoardHandoff.setState(account.account.preferences?.region?.toLowerCase()); } finally { applyingAccount = false; } }
      else if (regionTouched && window.BoardHandoff?.getState) local.region = window.BoardHandoff.getState().toUpperCase();
      if (Object.keys(local).length) persist(local);
      const prefs = account.account.preferences || {};
      document.dispatchEvent(new CustomEvent('board:account-books', { detail: { books: prefs.books || [], set: prefs.booksSet === true || (prefs.books || []).length > 0 } }));
    }).catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once:true }); else mount();
})();
