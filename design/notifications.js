/* Explicit opt-in only: mounting settings never requests browser permission or subscribes. */
(function (root) {
  'use strict';
  const states = new WeakMap();
  const names = { nfl: 'NFL', ncaaf: 'College', mlb: 'MLB', nhl: 'NHL' };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function local(value, fallback) {
    const url = new URL(value || fallback, root.location.origin);
    if (url.origin !== root.location.origin) throw new Error('Notification settings require a same-origin URL.');
    return url.pathname + url.search;
  }
  function bytes(value) { const s = root.atob(value.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
  async function subscriptionId(sub) { const digest = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint)); return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
  async function request(s, method = 'GET', data) {
    const response = await root.fetch(s.api, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json', ...(data ? { 'content-type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    let json; try { json = await response.json(); } catch { throw new Error('Alert settings are unavailable.'); }
    if (!response.ok) throw new Error(json?.error || 'Alert settings are unavailable.');
    return json;
  }
  function supported() { return root.isSecureContext && root.navigator?.serviceWorker && root.PushManager && root.Notification; }
  function render(s) {
    const value = s.value, r = value?.rules || { sports: ['nfl', 'ncaaf', 'mlb', 'nhl'], books: [], minEV: 3, cooldown: 900 };
    s.el.innerHTML = `<section class="board-notifications" aria-label="Opportunity alerts"><div class="bn-heading"><div><h2>Opportunity alerts</h2><p>Choose which eligible prices can send a background alert. An alert never places a bet.</p></div><span class="bn-state">${value?.enabled ? 'On' : 'Off'}</span></div>
      <p class="bn-status" role="status">${esc(s.message || (!supported() ? 'This browser cannot enable background alerts here. Open the installed app or a supported browser over HTTPS.' : root.Notification.permission === 'denied' ? 'Notifications are blocked in browser settings. You can still save your filters.' : value ? 'Alerts expire with their source prices. Availability can change before you open them.' : 'Loading alert settings…'))}</p>
      <form class="bn-form"><fieldset><legend>Sports</legend><div class="bn-options">${Object.entries(names).map(([key, label]) => `<label><input type="checkbox" name="sports" value="${key}" ${r.sports.includes(key) ? 'checked' : ''}> ${label}</label>`).join('')}</div></fieldset>
      <details class="bn-books"><summary>Sportsbooks <span>${r.books.length ? `${r.books.length} selected` : 'All available'}</span></summary><p>Leave all unchecked to include every available book.</p><div class="bn-options">${(value?.supportedBooks || []).map((key) => `<label><input type="checkbox" name="books" value="${esc(key)}" ${r.books.includes(key) ? 'checked' : ''}> ${esc(key.toUpperCase())}</label>`).join('')}</div></details>
      <div class="bn-fields"><label>Minimum estimated EV (%)<input name="minEV" type="number" min="0" max="100" step="0.1" value="${esc(r.minEV)}" required></label><label>Minimum time between alerts<select name="cooldown">${[[60,'1 minute'],[300,'5 minutes'],[900,'15 minutes'],[1800,'30 minutes'],[3600,'1 hour'],[21600,'6 hours'],[86400,'1 day']].map(([value, label]) => `<option value="${value}" ${r.cooldown === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
      <div class="bn-actions"><button type="submit" ${!value || s.busy ? 'disabled' : ''}>Save filters</button><button type="button" data-bn-enable ${!value || s.busy || !supported() || root.Notification?.permission === 'denied' ? 'disabled' : ''}>Enable on this browser</button>${value?.enabled ? '<button type="button" data-bn-pause>Pause all alerts</button>' : ''}<button type="button" data-bn-remove ${!value || s.busy || !supported() ? 'disabled' : ''}>Remove this browser</button></div>
      <p class="bn-caption">${value?.subscriptions?.length || 0} registered browser${value?.subscriptions?.length === 1 ? '' : 's'}. Filters and pause apply to your signed-in identity.</p></form></section>`;
  }
  function read(s) {
    const form = s.el.querySelector('form');
    return { sports: [...form.querySelectorAll('[name=sports]:checked')].map((el) => el.value), books: [...form.querySelectorAll('[name=books]:checked')].map((el) => el.value), minEV: Number(form.elements.minEV.value), cooldown: Number(form.elements.cooldown.value) };
  }
  async function action(s, kind) {
    if (s.busy) return;
    const rules = read(s);
    if (!rules.sports.length) { s.message = 'Choose at least one sport.'; render(s); return; }
    s.busy = true; s.message = '';
    try {
      if (kind === 'enable') {
        // Keep permission inside this user click, before any network or worker await.
        const permission = await root.Notification.requestPermission();
        if (permission !== 'granted') throw new Error('Alerts remain off. Browser permission was not granted.');
        const reg = await root.navigator.serviceWorker.register(s.worker, { scope: s.scope });
        if (!reg.active) await new Promise((resolve, reject) => { const worker = reg.installing || reg.waiting; if (!worker) { reject(new Error('The alert worker is unavailable.')); return; } const timer = root.setTimeout(() => reject(new Error('The alert worker did not become ready. Retry to enable alerts.')), 10000); worker.addEventListener('statechange', () => { if (worker.state === 'activated') { root.clearTimeout(timer); resolve(); } }); });
        const existing = await reg.pushManager.getSubscription();
        const sub = existing || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(s.value.publicKey) });
        try { s.value = await request(s, 'POST', { subscription: sub.toJSON(), rules }); } catch (error) { if (!existing) await sub.unsubscribe().catch(() => {}); throw error; }
        s.message = 'Alerts enabled on this browser.';
      } else if (kind === 'remove') {
        const reg = await root.navigator.serviceWorker.getRegistration(s.scope);
        const sub = await reg?.pushManager.getSubscription();
        if (sub) { s.value = await request(s, 'DELETE', { id: await subscriptionId(sub) }); await sub.unsubscribe(); }
        s.message = 'This browser is no longer subscribed.';
      } else { s.value = await request(s, 'PATCH', kind === 'pause' ? { enabled: false } : { rules }); s.message = kind === 'pause' ? 'All alerts paused.' : 'Alert filters saved.'; }
    } catch (error) { s.message = error.message || 'Alert settings could not be saved.'; }
    finally { s.busy = false; render(s); }
  }
  async function mount(el, options = {}) {
    if (!el) return false;
    let s = states.get(el); if (s) return true;
    s = { el, api: local(options.api, '/api/notifications'), worker: local(options.serviceWorker, '/sw.js'), scope: local(options.scope, '/'), value: null, busy: false, message: '' }; states.set(el, s);
    el.addEventListener('submit', (event) => { if (!event.target.closest('.bn-form')) return; event.preventDefault(); action(s, 'save'); });
    el.addEventListener('click', (event) => { const button = event.target.closest('[data-bn-enable],[data-bn-pause],[data-bn-remove]'); if (!button || button.disabled) return; action(s, button.hasAttribute('data-bn-enable') ? 'enable' : button.hasAttribute('data-bn-pause') ? 'pause' : 'remove'); });
    render(s);
    try { s.value = await request(s); } catch (error) { s.message = error.message; }
    render(s); return true;
  }
  root.BoardNotifications = Object.freeze({ mount });
})(globalThis);
