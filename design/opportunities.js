(() => {
  'use strict';
  const $ = id => document.getElementById(id), esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const SPORTS = ['all','nfl','ncaaf','mlb','nhl'], STATES = 'al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy'.split(' ');
  const price = x => (x > 0 ? '+' : '') + x, ms = x => Number.isFinite(x) ? x < 1000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(2)} s` : '—';
  const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage is optional. */ } };
  const region = value => typeof value === 'string' && STATES.includes(value.toLowerCase()) ? value.toLowerCase() : null;
  const old = read('board.opportunity-filters'), saved = old && typeof old === 'object' && !Array.isArray(old) ? old : {};
  const filters = { sport: SPORTS.includes(saved.sport) ? saved.sport : 'all', book: typeof saved.book === 'string' && /^(?:all|[a-z0-9][a-z0-9_-]{0,47})$/.test(saved.book) ? saved.book : 'all', ev: typeof saved.ev === 'number' && Number.isFinite(saved.ev) && saved.ev >= .5 && saved.ev <= 10 ? Math.round(saved.ev * 2) / 2 : 1,
    region: region(window.BoardHandoff?.getState?.()) || region(read('board.betting-state')) || region(saved.region) || 'nv' };
  let data = { rows: [] }, latest = null, stream, pointer = false, pending = null, lastPaint = 0, generation = 0, syncedClock = false;
  let serverClock = { at: Date.now(), local: performance.now() }, account = null, regionTouched = false, filtersTouched = false, preferenceQueue = Promise.resolve(), preferenceRevision = 0;
  const acked = new Set(), requestedId = new URLSearchParams(location.search).get('opportunity') || new URLSearchParams(location.search).get('id');
  let requestedShown = false, requestedQueued = false;
  const clock = () => serverClock.at + performance.now() - serverClock.local;
  const selected = () => data.rows.filter(r => r.expiresAt > clock() && (filters.sport === 'all' || r.sport === filters.sport) && (filters.book === 'all' || r.book === filters.book) && r.evPct >= filters.ev);
  const inspecting = () => pointer || $('op-list').contains(document.activeElement) || $('op-chart').contains(document.activeElement);
  const timeLabel = value => { const time = new Date(value); return Number.isFinite(time.getTime()) ? time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'Time unavailable'; };
  function validRow(r) {
    return r && typeof r.id === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(r.id) && typeof r.version === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(r.version) && SPORTS.slice(1).includes(r.sport) && typeof r.book === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(r.book) && ['ml','s','t'].includes(r.market) && typeof r.live === 'boolean' && r.eligible === true && Number.isFinite(r.expiresAt) && Number.isFinite(r.evPct) && r.evPct >= .5 && r.evPct <= 15 && Number.isFinite(r.odds) && Math.abs(r.odds) >= 100 && Number.isFinite(r.probability) && r.probability > 0 && r.probability < 1 && Array.isArray(r.references) && r.references.length > 0 && r.references.every(q => q && ['pin','circa'].includes(q.book));
  }
  function persistRegion(value) {
    if (window.BoardHandoff?.setState) window.BoardHandoff.setState(value);
    else save('board.betting-state', value);
  }
  function preference(patch) {
    if (!account?.account) return;
    account.account.preferences = { ...account.account.preferences, ...patch };
    const revision = ++preferenceRevision;
    preferenceQueue = preferenceQueue.catch(() => {}).then(async () => {
      const response = await fetch('/api/account/preferences', { method:'POST', credentials:'same-origin', headers:{'content-type':'application/json','x-account-csrf':account.csrf}, body:JSON.stringify(account.account.preferences) });
      if (!response.ok) throw new Error('Preferences could not sync.');
      const value = await response.json();
      if (revision === preferenceRevision && value?.preferences) account.account.preferences = value.preferences;
    }).catch(() => { $('op-held').textContent = 'Filters saved on this device · account sync unavailable'; });
  }
  function syncControls() {
    $('op-sport').value = filters.sport; $('op-region').value = filters.region; $('op-ev').value = filters.ev; $('op-ev-value').textContent = filters.ev + '%';
    if (![...$('op-book').options].some(o => o.value === filters.book)) $('op-book').add(new Option(filters.book, filters.book));
    $('op-book').value = filters.book;
  }
  for (const state of STATES) if (![...$('op-region').options].some(o => o.value === state)) $('op-region').add(new Option(state.toUpperCase(), state));
  function card(r, oldVersion) {
    const href = `/api/opportunities/go?id=${encodeURIComponent(r.id)}&v=${encodeURIComponent(r.version)}&state=${encodeURIComponent(filters.region)}`;
    return `<article class="op-card${oldVersion && oldVersion !== r.version ? ' op-changed' : ''}${requestedShown && requestedId === r.id ? ' is-selected' : ''}" tabindex="-1" id="op-${esc(r.id)}" data-id="${esc(r.id)}" data-version="${esc(r.version)}"><div class="op-card-top"><span class="op-tag">${esc(r.sport.toUpperCase())} · ${r.live ? 'Live' : 'Pregame'} · ${r.market === 'ml' ? 'Moneyline' : r.market === 's' ? 'Spread' : 'Total'}</span><strong class="op-edge">+${r.evPct.toFixed(1)}% <small>EV</small></strong></div><h3>${esc(r.label)}</h3><p>${esc(r.away)} at ${esc(r.home)}</p><div class="op-price-row"><div><span class="op-price">${price(r.odds)}</span><span class="op-book">${esc(r.bookName)}</span></div><a class="op-action" ${r.handoff === true ? `href="${esc(href)}"` : 'aria-disabled="true"'}>${r.handoff === true ? 'Check & open bet ↗' : 'Link unavailable'}</a></div><div class="op-expiry"><span data-expiry="${r.expiresAt}">Checking expiry</span><span>${r.observedAt ? 'Quote observed' : 'Delivery timestamp only'}</span></div><details><summary>Price evidence</summary><p>Reference: ${esc(r.references.map(q => q.book === 'pin' ? 'Pinnacle' : 'Circa').join(' + '))} · ${Math.round(r.probability * 1000) / 10}% estimated fair probability.</p><p>${r.observedAt ? 'Source observed ' + esc(timeLabel(r.observedAt)) : 'Provider delivered ' + esc(timeLabel(r.deliveredAt)) + '. Source observation time was not supplied.'}</p><p>${esc(r.provider === 'sharp' ? 'WebSocket API' : 'Additional Coverage')} · Full game · Final price checked on click. Sportsbook confirmation is still required.</p></details></article>`;
  }
  function expire() {
    const current = new Map(data.rows.map(r => [r.id, r]));
    document.querySelectorAll('[data-expiry]').forEach(el => {
      const card = el.closest('article'), row = current.get(card?.dataset.id), seconds = Math.max(0, Math.ceil((Number(el.dataset.expiry) - clock()) / 1000));
      const changed = !row || row.version !== card?.dataset.version;
      el.textContent = !seconds ? 'Expired · wait for a new price' : changed ? 'Price changed · update pending' : `Recheck window · ${seconds}s`;
      if (!seconds || changed) { const a = card?.querySelector('.op-action'); if (a) { a.setAttribute('aria-disabled', 'true'); a.removeAttribute('href'); a.textContent = changed && seconds ? 'Price changed' : 'Expired'; } }
    });
  }
  function chart(rows) {
    const dots = rows.slice(0, 60), max = 90;
    $('op-chart').innerHTML = dots.length ? `<svg viewBox="0 0 360 290" role="group" aria-label="Opportunity EV and remaining recheck window"><path d="M35 15V245H340" fill="none" stroke="#526170"/><path d="M35 92H340M35 168H340" fill="none" stroke="#344657" stroke-dasharray="3 5"/><text x="5" y="23">90s</text><text x="5" y="170">30s</text><text x="20" y="249">0</text><text x="36" y="267">0%</text><text x="300" y="267">15% EV</text>${dots.map(r => `<g tabindex="0" role="button" data-point="${esc(r.id)}" aria-label="${esc(r.label)} at ${esc(r.bookName)}, ${r.evPct.toFixed(1)} percent reference EV"><circle class="op-point-hit" cx="${35 + Math.min(r.evPct, 15) / 15 * 305}" cy="${245 - Math.min(max, Math.max(0, (r.expiresAt - clock()) / 1000)) / max * 228}" r="22"/><circle class="op-point" cx="${35 + Math.min(r.evPct, 15) / 15 * 305}" cy="${245 - Math.min(max, Math.max(0, (r.expiresAt - clock()) / 1000)) / max * 228}" r="7"/><title>${esc(r.label)} · ${esc(r.bookName)} · +${r.evPct.toFixed(1)}%</title></g>`).join('')}</svg>` : '<p class="op-empty">Qualified prices will appear here as the feed supplies them.</p>';
    $('op-chart-note').textContent = dots.length ? `${dots.length} prices shown. The recheck window is an expiry limit, not a promise that the sportsbook will hold a price.` : 'There is no simulated market data on this screen.';
  }
  function focusCard(id) {
    const card = $('op-' + id); if (!card) return false;
    document.querySelectorAll('.is-selected').forEach(el => el.classList.remove('is-selected'));
    card.classList.add('is-selected'); card.focus({ preventScroll:true }); card.scrollIntoView({ behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'center' }); return true;
  }
  function requestNotice(rows) {
    const notice = $('op-requested'); if (!requestedId || !notice) return;
    const row = data.rows.find(r => r.id === requestedId && r.expiresAt > clock());
    if (!row) { notice.hidden = false; notice.textContent = 'This alert is expired or unavailable. Current prices are shown below.'; return; }
    if (!rows.some(r => r.id === requestedId)) { notice.hidden = false; notice.innerHTML = 'This alert is hidden by your filters. <button type="button" id="op-show-alert">Show this price</button>'; $('op-show-alert').addEventListener('click', () => showRequested(row)); return; }
    notice.hidden = false; notice.textContent = 'Price from your alert. Check its current evidence before opening the sportsbook.';
    if (!requestedShown && !requestedQueued && !document.hidden && (!document.activeElement || document.activeElement === document.body)) {
      requestedQueued = true; requestAnimationFrame(() => { requestedQueued = false; if (!document.hidden && (!document.activeElement || document.activeElement === document.body) && focusCard(requestedId)) requestedShown = true; });
    }
  }
  function showRequested(row) {
    filters.sport = row.sport; filters.book = row.book; filters.ev = Math.max(.5, Math.min(filters.ev, Math.floor(row.evPct * 2) / 2)); syncControls(); pointer = false; document.activeElement?.blur?.(); paint(latest); requestedShown = focusCard(row.id);
  }
  function acknowledge(packet, began, paintGeneration, rows) {
    const token = packet?.snapshot.ack;
    if (!token || acked.has(token) || document.hidden || !rows.some(r => packet.changedIds.has(r.id))) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (document.hidden || generation !== paintGeneration || acked.has(token)) return;
      // This token is acknowledged only after its visible rows have survived a browser paint.
      acked.add(token); while (acked.size > 256) acked.delete(acked.values().next().value);
      fetch('/api/opportunities/ack', { method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body:JSON.stringify({ ack:token, renderMs:performance.now() - began }), keepalive:true }).catch(() => {});
    }));
  }
  function paint(packet = latest) {
    if (!packet) return;
    if (inspecting()) { pending = packet; $('op-held').textContent = 'Updates held while you inspect'; expire(); return; }
    pending = null; const rows = selected(), list = $('op-list'), began = performance.now(), paintGeneration = ++generation;
    const before = new Map([...list.querySelectorAll('[data-id]')].map(el => [el.dataset.id, el.dataset.version]));
    const open = new Set([...list.querySelectorAll('details[open]')].map(el => el.closest('[data-id]').dataset.id));
    list.innerHTML = rows.length ? rows.map(r => card(r, before.get(r.id))).join('') : '<div class="op-empty"><strong>No qualified prices right now.</strong>Try a lower threshold or another book. Prices with incomplete evidence are excluded.</div>';
    list.querySelectorAll('details').forEach(el => { el.open = open.has(el.closest('[data-id]').dataset.id); });
    $('op-total').textContent = rows.length; $('op-best').textContent = rows.length ? '+' + Math.max(...rows.map(r => r.evPct)).toFixed(1) + '%' : '—';
    $('op-count').textContent = `${data.rows.length} qualified prices across ${new Set(data.rows.map(r => r.book)).size} books`; $('op-held').textContent = 'Sorted by estimated EV';
    const metric = data.metrics || {}; $('op-metric-description').textContent = metric.description || 'Delivery measurements appear after rendered updates are acknowledged.'; $('op-p50').textContent = ms(metric.receiptToAckMs?.p50); $('op-p95').textContent = ms(metric.receiptToAckMs?.p95); $('op-samples').textContent = metric.sampleCount ? `${metric.sampleCount} samples · last hour` : 'Waiting for measured samples';
    data.rows.forEach(r => { if (![...$('op-book').options].some(o => o.value === r.book)) $('op-book').add(new Option(String(r.bookName || r.book), r.book)); }); syncControls();
    chart(rows); expire(); lastPaint = performance.now(); requestNotice(rows); acknowledge(packet, began, paintGeneration, rows);
  }
  function receive(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.rows)) throw new Error('Invalid opportunity update.');
    const at = Number.isFinite(snapshot.serverAt) ? snapshot.serverAt : clock();
    serverClock = { at:syncedClock ? Math.max(clock(), at) : at, local:performance.now() }; syncedClock = true;
    const incoming = snapshot.rows.slice(0, 400).filter(validRow), merged = new Map(snapshot.type === 'delta' ? data.rows.map(r => [r.id, r]) : []);
    if (snapshot.type === 'delta' && Array.isArray(snapshot.removed)) for (const id of snapshot.removed) if (typeof id === 'string') merged.delete(id);
    for (const row of incoming) merged.set(row.id, row);
    data = { ...snapshot, rows:[...merged.values()].sort((a,b) => b.evPct - a.evPct || a.id.localeCompare(b.id)).slice(0,400) }; latest = { snapshot:data, changedIds:new Set(incoming.map(r => r.id)) };
    const requested = !requestedShown && !filtersTouched && data.rows.find(r => r.id === requestedId && r.expiresAt > clock());
    if (requested) { filters.sport = requested.sport; filters.book = requested.book; filters.ev = Math.max(.5, Math.min(filters.ev, Math.floor(requested.evPct * 2) / 2)); syncControls(); }
    paint(latest);
  }
  function connect() {
    stream?.close(); generation++; if (document.hidden) return;
    const connection = stream = new EventSource('/api/opportunities/stream'); let revision = -1;
    stream.onopen = () => { if (stream === connection) $('op-connection').textContent = 'Board stream connected'; };
    stream.onerror = () => { if (stream === connection) $('op-connection').textContent = 'Reconnecting · prices expire normally'; };
    stream.addEventListener('opportunities', event => { if (stream !== connection || document.hidden) return; try { const snapshot = JSON.parse(event.data); if (Number.isFinite(snapshot.revision) && snapshot.revision < revision) return; revision = Number.isFinite(snapshot.revision) ? snapshot.revision : revision; receive(snapshot); } catch { $('op-connection').textContent = 'Update unavailable'; } });
  }
  syncControls();
  for (const [id, key] of [['op-sport','sport'],['op-book','book'],['op-ev','ev'],['op-region','region']]) $(id).addEventListener('input', () => {
    filtersTouched = true; filters[key] = key === 'ev' ? Number($(id).value) : $(id).value;
    if (key === 'region') { regionTouched = true; persistRegion(filters.region); preference({ region:filters.region.toUpperCase() }); }
    save('board.opportunity-filters', filters); syncControls(); paint(latest);
  });
  document.addEventListener('board:betting-state', event => {
    const state = region(event.detail?.state); if (!state || state === filters.region) return;
    regionTouched = true; filtersTouched = true; filters.region = state; preference({ region:state.toUpperCase() }); save('board.opportunity-filters', filters); syncControls(); paint(latest);
  });
  function release() { pointer = false; if (pending && !inspecting()) paint(pending); }
  document.addEventListener('pointerdown', e => { if ($('op-list').contains(e.target) || $('op-chart').contains(e.target)) pointer = true; });
  document.addEventListener('pointerup', release); document.addEventListener('pointercancel', release);
  for (const el of [$('op-list'), $('op-chart')]) el.addEventListener('focusout', () => setTimeout(release, 0));
  $('op-list').addEventListener('click', e => { const action = e.target.closest('.op-action'); if (!action) return; expire(); if (action.getAttribute('aria-disabled') === 'true' || !action.getAttribute('href')) { e.preventDefault(); return; } const card = action.closest('article'), row = data.rows.find(r => r.id === card?.dataset.id); if (!row || row.version !== card.dataset.version || row.expiresAt <= clock()) { e.preventDefault(); return; } action.setAttribute('href', `/api/opportunities/go?id=${encodeURIComponent(row.id)}&v=${encodeURIComponent(row.version)}&state=${encodeURIComponent(filters.region)}`); });
  function inspect(e) { const dot = e.target.closest('[data-point]'); if (!dot || e.type === 'keydown' && !['Enter',' '].includes(e.key)) return; e.preventDefault(); focusCard(dot.dataset.point); }
  $('op-chart').addEventListener('click', inspect); $('op-chart').addEventListener('keydown', inspect);
  document.addEventListener('visibilitychange', connect);
  setInterval(() => { expire(); if (!document.hidden && performance.now() - lastPaint > 5000 && !pending) paint(latest); }, 1000);
  fetch('/api/account/me', { cache:'no-store', credentials:'same-origin' }).then(r => r.ok ? r.json() : null).then(value => {
    account = value; if (!account?.account) return;
    if (regionTouched) preference({ region:filters.region.toUpperCase() });
    else { const state = region(account.account.preferences?.region); if (state) { filters.region = state; persistRegion(state); save('board.opportunity-filters', filters); syncControls(); paint(latest); } }
  }).catch(() => {});
  window.BoardNotifications?.mount($('op-notifications'), { api:'/api/notifications', serviceWorker:'/sw.js' });
  connect();
})();
