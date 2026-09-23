(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoardPortfolioView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const states = new WeakMap();
  const names = { nfl: 'NFL', ncaaf: 'College', mlb: 'MLB', nhl: 'NHL' };
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (x, signed = false) => Number.isFinite(x) ? (signed && x > 0 ? '+' : '') + new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(x) : '—';
  const odds = (x) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x : '—';
  const when = (x) => { const d = new Date(x ?? NaN); return Number.isFinite(d.getTime()) ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Time unavailable'; };
  const toWin = (t) => Number.isFinite(t.stake) && Number.isFinite(t.odds) && Math.abs(t.odds) >= 100 ? t.stake * (t.odds > 0 ? t.odds / 100 : 100 / -t.odds) : null;
  const isSettled = (t) => ['won', 'lost', 'push', 'void'].includes(t.status);
  const label = (t) => t.legs.length > 1 ? `${t.legs.length}-leg parlay` : t.legs[0]?.label || 'Recorded ticket';
  function select(tickets, filter = {}) {
    const q = String(filter.query || '').trim().toLowerCase();
    return tickets.filter((t) => (!filter.sport || filter.sport === 'all' || t.sport === filter.sport) &&
      (!filter.status || filter.status === 'all' || (filter.status === 'open' ? t.status === 'open' : filter.status === 'settled' ? isSettled(t) : t.status === 'open' && t.phase === filter.status)) &&
      (!q || [t.book, t.note, names[t.sport], ...t.legs.flatMap((l) => [l.label, l.matchup])].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => {
        const rank = (t) => t.status !== 'open' ? 3 : t.phase === 'live' ? 0 : t.phase === 'upcoming' ? 1 : 2;
        return rank(a) - rank(b) || (Date.parse(b.placedAt) || 0) - (Date.parse(a.placedAt) || 0) || a.key.localeCompare(b.key);
      });
  }
  function summarize(tickets) {
    const open = tickets.filter((t) => t.status === 'open');
    const settled = tickets.filter((t) => isSettled(t) && t.status !== 'void');
    const knownNet = settled.filter((t) => Number.isFinite(t.profit));
    return { open: open.length, live: open.filter((t) => t.phase === 'live').length,
      risk: open.reduce((n, t) => n + (Number.isFinite(t.stake) ? t.stake : 0), 0), missingStake: open.filter((t) => !Number.isFinite(t.stake)).length,
      net: knownNet.reduce((n, t) => n + t.profit, 0), knownNet: knownNet.length, missingNet: settled.length - knownNet.length,
      won: settled.filter((t) => t.status === 'won').length, lost: settled.filter((t) => t.status === 'lost').length };
  }
  function insightBook(value) {
    const label = String(value || '').trim(), alias = label.toLowerCase().replace(/[^a-z0-9]/g, '');
    const labels = { mgm: 'BetMGM', betmgm: 'BetMGM', dk: 'DraftKings', draftkings: 'DraftKings', fd: 'FanDuel', fanduel: 'FanDuel',
      circa: 'Circa', circasports: 'Circa', pin: 'Pinnacle', pinnacle: 'Pinnacle', stn: 'Station', station: 'Station', stationcasinos: 'Station',
      boom: "Boomer's", boomers: "Boomer's", czr: 'Caesars', caesars: 'Caesars', sp: 'South Point', southpoint: 'South Point',
      wg: 'Westgate', westgate: 'Westgate', westgatesuperbook: 'Westgate', wynn: 'Wynn' };
    const known = Object.prototype.hasOwnProperty.call(labels, alias) ? labels[alias] : null;
    return { key: known || label.toLowerCase() || 'unknown', label: known || label || 'Book not recorded' };
  }
  // Insights use recorded settlement times only. Entries without dates stay in the balance,
  // but cannot invent a point on the timeline. The caller supplies the private loaded scope.
  function insightData(tickets, grouping = 'sport') {
    const days = new Map(), exposure = new Map();
    let missingNet = 0, missingDate = 0, settled = 0, dated = 0, open = 0, missingStake = 0, risk = 0;
    for (const t of tickets) {
      if (isSettled(t) && t.status !== 'void') {
        settled++;
        if (!Number.isFinite(t.profit)) missingNet++;
        else {
          const time = typeof t.settledAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(t.settledAt) ? Date.parse(t.settledAt) : NaN;
          if (!Number.isFinite(time)) missingDate++;
          else {
            const day = new Date(time).toISOString().slice(0, 10);
            const row = days.get(day) || { day, net: 0, count: 0 };
            row.net += t.profit; row.count++; dated++; days.set(day, row);
          }
        }
      }
      if (t.status !== 'open') continue;
      open++;
      const book = insightBook(t.book), key = grouping === 'book' ? book.key : t.sport;
      const row = exposure.get(key) || { key, label: grouping === 'book' ? book.label : names[key] || key, stake: 0, count: 0, missing: 0 };
      row.count++;
      if (Number.isFinite(t.stake) && t.stake >= 0) { row.stake += t.stake; risk += t.stake; }
      else { row.missing++; missingStake++; }
      exposure.set(key, row);
    }
    let cumulative = 0;
    const points = [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((row) => ({ ...row, cumulative: cumulative += row.net }));
    return { points, net: cumulative, settled, dated, missingNet, missingDate, open, risk, missingStake,
      exposure: [...exposure.values()].sort((a, b) => b.stake - a.stake || a.label.localeCompare(b.label)) };
  }
  function chooseInsightDay(points, selectedDay, action) {
    if (!points.length) return '';
    const found = points.findIndex((p) => p.day === selectedDay);
    const index = found < 0 ? points.length - 1 : found;
    const next = action === 'previous' ? Math.max(0, index - 1) : action === 'next' ? Math.min(points.length - 1, index + 1) : index;
    return points[next].day;
  }
  const insightDay = (day) => new Date(day + 'T00:00:00Z').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  function chartGeometry(points) {
    const values = [0, ...points.map((p) => p.cumulative)];
    const low = Math.min(...values), high = Math.max(...values);
    const span = high - low || 1;
    const first = Date.parse(points[0]?.day), last = Date.parse(points.at(-1)?.day);
    const x = (p) => points.length === 1 ? 350 : 76 + (Date.parse(p.day) - first) / (last - first) * 544;
    const y = (value) => high === low ? 82 : 16 + (high - value) / span * 132;
    return { low, high, x, y, path: points.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(2)},${y(p.cumulative).toFixed(2)}`).join(' ') };
  }
  function insightReadout(point) {
    return `<div><span>Through ${esc(insightDay(point.day))}</span><strong>${money(point.cumulative, true)}</strong></div><p>${money(point.net, true)} that day <span>· ${point.count} ${point.count === 1 ? 'ticket' : 'tickets'} settled</span></p>`;
  }
  const insightPreferences = { expanded: null };
  function renderInsights(model, state = {}) {
    const { points } = model;
    const selectedDay = chooseInsightDay(points, state.day);
    const index = points.findIndex((p) => p.day === selectedDay), point = points[index];
    const missing = [model.missingNet ? `${model.missingNet} settled ${model.missingNet === 1 ? 'ticket has' : 'tickets have'} no recorded net result.` : '',
      model.missingDate ? `${model.missingDate} ${model.missingDate === 1 ? 'result has' : 'results have'} no settlement time.` : ''].filter(Boolean).join(' ');
    const geometry = chartGeometry(points), compactMoney = (n) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n);
    const graph = point ? `<div class="portfolio-insight-readout" data-pf-readout aria-live="polite" aria-atomic="true">${insightReadout(point)}</div>
      <svg class="portfolio-insight-chart" data-pf-plot viewBox="0 0 640 168" role="img" aria-label="Cumulative recorded net by settlement day. Use the date slider or previous and next buttons to explore.">
        ${[...new Set([geometry.high, 0, geometry.low])].map((n) => `<line x1="76" x2="620" y1="${geometry.y(n)}" y2="${geometry.y(n)}" class="portfolio-chart-grid${n === 0 ? ' is-zero' : ''}"/><text x="0" y="${geometry.y(n) + 4}" class="portfolio-chart-label">${esc(compactMoney(n))}</text>`).join('')}
        ${points.length > 1 ? `<path d="${geometry.path}" class="portfolio-chart-line"/>` : ''}<circle data-pf-marker cx="${geometry.x(point)}" cy="${geometry.y(point.cumulative)}" r="5" class="portfolio-chart-marker"/>
      </svg><div class="portfolio-chart-dates"><span>${esc(insightDay(points[0].day))}</span><span>${points.length > 1 ? esc(insightDay(points.at(-1).day)) : 'One recorded day'}</span></div>
      <div class="portfolio-chart-controls"><button type="button" data-pf-day-step="previous" data-pf-insight-control="previous" aria-label="Previous settlement day" ${index <= 0 ? 'disabled' : ''}>←</button><label><span class="sr-only">Settlement day</span><input type="range" min="0" max="${points.length - 1}" step="1" value="${index}" data-pf-day data-pf-insight-control="day" aria-label="Settlement day" aria-valuetext="${esc(insightDay(point.day))}: ${esc(money(point.cumulative, true))} cumulative net" ${points.length < 2 ? 'disabled' : ''}></label><button type="button" data-pf-day-step="next" data-pf-insight-control="next" aria-label="Next settlement day" ${index >= points.length - 1 ? 'disabled' : ''}>→</button></div>`
      : `<div class="portfolio-insight-empty"><strong>${model.settled ? 'A result needs a date to tell its story.' : 'Your first result starts the line.'}</strong><p>${model.settled ? 'The timeline appears when a settled ticket has both a recorded net result and settlement time.' : 'Settle a saved ticket to start your performance history.'}</p></div>`;
    const rows = model.exposure.map((row) => `<div class="portfolio-exposure-row"><div><span>${esc(row.label)}</span><strong>${row.missing === row.count ? '—' : money(row.stake)}</strong></div><div class="portfolio-exposure-track" aria-hidden="true"><span style="width:${model.risk ? Math.max(0, Math.min(100, row.stake / model.risk * 100)) : 0}%"></span></div><small>${row.count} ${row.count === 1 ? 'open ticket' : 'open tickets'}${row.missing ? ` · ${row.missing} stake unavailable` : ''}</small></div>`).join('');
    return `<div class="portfolio-insight-grid"><section class="portfolio-trend" aria-label="Settled performance"><div class="portfolio-insight-heading"><h2>Settled net</h2><span>Recorded history</span></div>${graph}<p class="portfolio-insight-note">Settlement days use UTC. ${model.dated ? `${model.dated} dated ${model.dated === 1 ? 'result' : 'results'} shown.` : ''}${missing ? ' ' + esc(missing) + ' These are excluded from the line.' : ''}</p></section>
      <section class="portfolio-exposure" aria-label="Open stake exposure"><div class="portfolio-insight-heading"><h2>Where you’re exposed</h2></div><div class="portfolio-exposure-switch" role="group" aria-label="Group open stake">${[['sport','By sport'],['book','By book']].map(([key, title]) => `<button type="button" data-pf-exposure="${key}" data-pf-insight-control="${key}" aria-pressed="${(state.group || 'sport') === key}">${title}</button>`).join('')}</div>${rows || '<div class="portfolio-insight-empty"><strong>No open tickets</strong><p>Open stakes will appear here as you log bets.</p></div>'}<p class="portfolio-insight-note">${model.open ? `${model.missingStake === model.open ? 'Open stake unavailable' : money(model.risk) + ' in known open stakes'}.${model.missingStake ? ` ${model.missingStake} ${model.missingStake === 1 ? 'stake is' : 'stakes are'} unavailable.` : ''}` : 'Open stakes are grouped from your saved tickets.'}</p></section></div>
      ${points.length ? `<details class="portfolio-insight-data"><summary data-pf-insight-control="table">View settlement data <span>${points.length} ${points.length === 1 ? 'day' : 'days'}</span></summary><div class="portfolio-insight-table"><table><caption>${points.length > 30 ? 'Most recent 30 settlement days; the chart includes all recorded days.' : 'Recorded net by settlement day (UTC).'}</caption><thead><tr><th scope="col">Day</th><th scope="col">Tickets</th><th scope="col">Net</th><th scope="col">Cumulative</th></tr></thead><tbody>${points.slice(-30).reverse().map((p) => `<tr><th scope="row">${esc(insightDay(p.day))}</th><td>${p.count}</td><td>${money(p.net, true)}</td><td>${money(p.cumulative, true)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}`;
  }
  function updateInsightSelection(s, day) {
    const body = s.root.querySelector('.portfolio-insight-body'), points = s.insightModel?.points || [];
    if (!body || !points.length) return;
    s.insightDay = chooseInsightDay(points, day);
    const index = points.findIndex((p) => p.day === s.insightDay), point = points[index], geometry = chartGeometry(points);
    const readout = body.querySelector('[data-pf-readout]');
    if (readout) readout.innerHTML = insightReadout(point);
    const marker = body.querySelector('[data-pf-marker]');
    marker?.setAttribute('cx', String(geometry.x(point))); marker?.setAttribute('cy', String(geometry.y(point.cumulative)));
    const range = body.querySelector('[data-pf-day]');
    if (range) { range.value = String(index); range.setAttribute('aria-valuetext', `${insightDay(point.day)}: ${money(point.cumulative, true)} cumulative net`); }
    const previous = body.querySelector('[data-pf-day-step="previous"]'), next = body.querySelector('[data-pf-day-step="next"]');
    if (previous) previous.disabled = index <= 0;
    if (next) next.disabled = index >= points.length - 1;
    body.dataset.modelKey = JSON.stringify([s.insightModel, s.insightDay, s.insightGroup || 'sport']);
  }
  function updateInsights(s, tickets) {
    const body = s.root.querySelector('.portfolio-insight-body'); if (!body) return;
    const model = insightData(tickets, s.insightGroup || 'sport'); s.insightModel = model;
    s.insightDay = chooseInsightDay(model.points, s.insightDay);
    const brief = s.root.querySelector('[data-pf-insight-brief]');
    if (brief) brief.textContent = `Loaded logs · ${s.filter.sport === 'all' ? 'All sports' : names[s.filter.sport]} · ${model.open} open · ${model.dated} dated results`;
    const modelKey = JSON.stringify([model, s.insightDay, s.insightGroup || 'sport']);
    if (body.dataset.modelKey === modelKey) return;
    body.dataset.modelKey = modelKey;
    const html = renderInsights(model, { day: s.insightDay, group: s.insightGroup });
    if (body.dataset.renderKey === html) return;
    const focused = body.contains(document.activeElement) ? document.activeElement?.dataset?.pfInsightControl : null;
    const tableOpen = Boolean(body.querySelector('.portfolio-insight-data')?.open);
    body.innerHTML = html; body.dataset.renderKey = html;
    const table = body.querySelector('.portfolio-insight-data'); if (table) table.open = tableOpen;
    if (focused) [...body.querySelectorAll('[data-pf-insight-control]')].find((control) => control.dataset.pfInsightControl === focused)?.focus({ preventScroll: true });
  }
  function evidence(leg) {
    const i = leg.integrity;
    if (!i) return '<p class="portfolio-meta">Verified CLV evidence is unavailable for this entry.</p>';
    const row = (title, quote) => `<div class="portfolio-evidence"><span>${esc(title)}</span><strong>${quote ? `${esc(quote.line_value ?? '—')} / ${esc(odds(quote.american_odds))}` : 'Unavailable'}</strong><small>${quote ? esc([quote.sportsbook || quote.source, when(quote.source_observed_at || quote.entry_created_at)].filter(Boolean).join(' · ')) : ''}</small></div>`;
    const val = (v, suffix) => Number.isFinite(v) ? `${v > 0 ? '+' : ''}${Math.round(v * 100) / 100}${suffix}` : 'Unavailable';
    return `<p class="portfolio-meta">${esc(i.eligibility_status || i.status || 'UNAVAILABLE')}${i.reason_code ? ' · ' + esc(i.reason_code.replace(/_/g, ' ').toLowerCase()) : ''}</p>
      ${row('Entry snapshot', i.entry)}${row('Close', i.close?.snapshot || i.close)}
      <div class="portfolio-values"><div class="portfolio-value"><small>Line CLV</small><strong>${val(i.line_clv_points, ' pts')}</strong></div><div class="portfolio-value"><small>No-vig CLV</small><strong>${val(i.clv_fair_probability_pp, ' pp')}</strong></div><div class="portfolio-value"><small>Closing-fair EV</small><strong>${val(i.clv_ev_pct, '%')}</strong></div></div>
      <p class="portfolio-meta">${esc(i.close?.kickoff_basis || i.kickoff_basis || 'Closing basis unavailable')}</p>`;
  }
  function renderTicket(t, options = {}) {
    const open = t.status === 'open';
    const tag = open ? t.phase === 'live' ? 'Live' : t.phase === 'upcoming' ? 'Upcoming' : 'Open · awaiting update' : t.status.charAt(0).toUpperCase() + t.status.slice(1);
    const verified = t.legs.filter((l) => (l.integrity?.eligibility_status || l.integrity?.status) === 'VERIFIED_CLV').length;
    const missingEntry = t.legs.some((l) => !l.integrity?.entry || (l.integrity?.eligibility_status || l.integrity?.status) === 'MISSING_ENTRY_SNAPSHOT');
    const liveText = open ? [...new Set(t.legs.filter((l) => l.phase === 'live' && l.liveText).map((l) => l.liveText))].join(' / ') : '';
    const signal = options.signalText?.(t) || liveText || (verified ? `${verified} ${verified === 1 ? 'leg has' : 'legs have'} verified CLV` : missingEntry ? 'Recorded price · entry evidence unavailable' : open ? 'Entry saved · closing evidence pending' : 'CLV unavailable without verified entry and close');
    const detail = options.detailHTML?.(t) || t.legs.map((l) => `<div class="portfolio-leg"><strong>${esc(l.label || 'Selection')} ${esc(odds(l.odds))}</strong><p class="portfolio-meta">${esc(l.matchup || '')}</p>${evidence(l)}</div>`).join('');
    return `<article class="portfolio-ticket" data-ticket="${esc(t.key)}" data-status="${esc(t.status)}" data-phase="${esc(t.phase)}">
      <div class="portfolio-ticket-top"><div><span class="portfolio-badge">${esc(names[t.sport] || t.sport)}</span> <span class="portfolio-badge ${t.phase === 'live' && open ? 'is-live' : t.status === 'won' ? 'is-win' : 'is-muted'}">${esc(tag)}</span></div><span class="portfolio-meta">${esc(t.book || 'Book not recorded')}</span></div>
      <div class="portfolio-pick"><strong>${esc(label(t))}</strong><span class="portfolio-odds">${esc(odds(t.odds))}</span></div>
      <p class="portfolio-matchup">${esc(t.legs.length > 1 ? t.legs.map((l) => l.label).join(' · ') : t.legs[0]?.matchup || '')}</p>
      <div class="portfolio-values"><div class="portfolio-value"><small>Stake</small><strong>${money(t.stake)}</strong></div><div class="portfolio-value"><small>${open ? 'To win' : 'Net result'}</small><strong>${money(open ? toWin(t) : t.profit, !open)}</strong></div><div class="portfolio-value"><small>Placed</small><span>${esc(when(t.placedAt))}</span></div></div>
      <p class="portfolio-signal">${esc(signal)}</p>
      <details class="portfolio-details" data-details="${esc(t.key)}"><summary>Ticket details</summary><div class="portfolio-detail-body">${detail}${t.note ? `<p class="portfolio-meta">Note: ${esc(t.note)}</p>` : ''}${options.sport !== t.sport ? `<a class="portfolio-manage" href="${esc(t.sourceHref)}">Open ${esc(names[t.sport])} ticket log to manage</a>` : ''}</div></details>
    </article>`;
  }
  function visible(s) { return !s.disposed && s.root.isConnected && s.root.getClientRects().length > 0 && !document.hidden; }
  function updateList(s) {
    const data = s.data || { tickets: [], sources: [] };
    const scoped = select(data.tickets, { sport: s.filter.sport });
    const stats = summarize(scoped);
    updateInsights(s, scoped);
    const summaryHTML = `<div class="portfolio-stat"><span class="portfolio-stat-label">At risk</span><strong class="portfolio-stat-value">${stats.open && stats.missingStake === stats.open ? '—' : money(stats.risk)}</strong><small class="portfolio-stat-detail">${stats.missingStake ? `${stats.missingStake} stake missing` : 'Open tickets'}</small></div><div class="portfolio-stat"><span class="portfolio-stat-label">Open</span><strong class="portfolio-stat-value">${stats.open}<small>${stats.live ? ` · ${stats.live} live` : ''}</small></strong><small class="portfolio-stat-detail">${stats.won} won · ${stats.lost} lost</small></div><div class="portfolio-stat"><span class="portfolio-stat-label">Settled net</span><strong class="portfolio-stat-value">${stats.missingNet && !stats.knownNet ? '—' : money(stats.net, true)}</strong><small class="portfolio-stat-detail">${stats.missingNet ? `Known net · ${stats.missingNet} result unavailable` : 'All recorded stakes'}</small></div>`;
    if (s.summary.innerHTML !== summaryHTML) s.summary.innerHTML = summaryHTML;
    s.root.querySelectorAll('[data-pf-status]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pfStatus === s.filter.status)));
    const failed = data.sources.filter((x) => x.status === 'error').map((x) => names[x.sport]);
    const reconnecting = Object.entries(s.peerStatus || {}).filter(([,v]) => ['reconnecting','error'].includes(v)).map(([k])=>names[k]);
    const note = s.refreshError || (reconnecting.length ? `${reconnecting.join(', ')} live updates reconnecting. Live status may be unavailable.` : failed.length ? `${failed.join(', ')} unavailable. Showing only successfully loaded logs. Retry to reconnect.` : s.loading && !s.loaded ? 'Connecting your sports…' : `Private to this device · ${data.sources.filter((x) => x.status === 'ok').length} sports connected`);
    if (s.notice.textContent !== note) s.notice.textContent = note;
    const refreshButton = s.root.querySelector('[data-pf-refresh]');
    if (refreshButton) {
      refreshButton.disabled = Boolean(s.loading);
      refreshButton.setAttribute('aria-busy', String(Boolean(s.loading)));
      refreshButton.textContent = s.loading ? 'Refreshing…' : 'Refresh';
    }
    const tickets = select(data.tickets, s.filter);
    const limit = s.limit || 40;
    const html = tickets.length ? tickets.slice(0, limit).map((t) => renderTicket(t, s.options)).join('') + (tickets.length > limit ? `<button class="portfolio-manage" type="button" data-pf-more>Show ${Math.min(40, tickets.length - limit)} more tickets</button>` : '') : `<div class="portfolio-empty"><strong>${s.loaded ? s.filter.query || s.filter.status !== 'all' && data.tickets.length ? 'No tickets match' : 'Your tickets belong here' : 'Loading your tickets…'}</strong><p>${s.loaded ? data.tickets.length ? 'Try another sport or status, or clear your search.' : 'Log your first bet. Your pick, price and result will stay together.' : 'Opening your private logs across sports.'}</p></div>`;
    if (s.list.dataset.renderKey === html) return;
    const expanded = new Set([...s.list.querySelectorAll('details[open]')].map((d) => d.dataset.details));
    const active = document.activeElement;
    const focused = s.list.contains(active) ? { key: active.closest('[data-ticket]')?.dataset.ticket, html: active.outerHTML } : null;
    s.list.innerHTML = html;
    s.list.dataset.renderKey = html;
    s.list.querySelectorAll('details[data-details]').forEach((d) => { d.open = expanded.has(d.dataset.details); });
    if (focused?.key) {
      const ticket = [...s.list.querySelectorAll('[data-ticket]')].find((e) => e.dataset.ticket === focused.key);
      const control = ticket && [...ticket.querySelectorAll('button,a,summary')].find((e) => e.outerHTML === focused.html);
      (control || ticket?.querySelector('summary'))?.focus({ preventScroll: true });
    }
  }
  async function refresh(s, force = false) {
    if (!visible(s)) return;
    if (s.loading) { s.queued = true; return; }
    s.loading = true; s.refreshError = '';
    if (force) BoardPortfolio.invalidate();
    updateList(s);
    try {
      s.data = await BoardPortfolio.load({ sport: s.options.sport, currentBets: s.options.currentBets, gameOf: s.options.gameOf,
        currentGames: s.options.currentGames, gamesBySport: s.peerGames, betsBySport: s.peerBets, sports: s.options.sports, basePaths: s.options.basePaths });
      // A peer may disconnect while another HTTP request is pending. Rebuild every phase
      // from the current game cache so an old response cannot restore a stale Live badge.
      s.data.tickets = s.data.tickets.map((t) => BoardPortfolio.normalizeTicket(t.sport, t.raw, {
        gameOf: t.sport === s.options.sport ? s.options.gameOf : undefined,
        games: t.sport === s.options.sport ? s.options.currentGames : s.peerGames[t.sport],
        basePath: s.options.basePaths?.[t.sport]
      }));
      // Re-project the newest local/SSE lists after HTTP peers finish to avoid stale refresh races.
      for (const [sport, records] of Object.entries({ ...s.peerBets, [s.options.sport]: s.options.currentBets })) {
        if (!Array.isArray(records)) continue;
        s.data.tickets = s.data.tickets.filter((t) => t.sport !== sport).concat(records.map((b) => BoardPortfolio.normalizeTicket(sport, b, { gameOf: sport === s.options.sport ? s.options.gameOf : undefined, games: sport === s.options.sport ? s.options.currentGames : s.peerGames[sport], basePath: s.options.basePaths?.[sport] })).filter(Boolean));
      }
      s.loaded = true;
    } catch { s.refreshError = 'Tickets could not refresh. Your saved bets are unchanged. Use Refresh to retry.'; } finally { s.loading = false; if (s.root.isConnected) updateList(s); if (s.queued) { s.queued = false; refresh(s); } }
  }
  function mount(root, options) {
    if (!root || typeof BoardPortfolio === 'undefined') return false;
    let s = states.get(root);
    if (s && !root.contains(s.summary)) { s.disposed = true; clearInterval(s.timer); s.stop?.(); document.removeEventListener?.('visibilitychange', s.visibilityHandler); states.delete(root); s = null; }
    if (!s) {
      root.classList.add('portfolio'); root.parentElement.classList.add('portfolio-mode');
      root.innerHTML = `<div class="portfolio-head"><div><p class="portfolio-eyebrow">Your action, in one place</p><h1>My bets</h1></div><div class="portfolio-actions"><select class="portfolio-entry-sport" aria-label="Sport for new bet">${Object.entries(names).map(([k,n]) => `<option value="${k}" ${k === options.sport ? 'selected' : ''}>${n}</option>`).join('')}</select><button type="button" class="btn" data-pf-new>＋ Log a bet</button></div></div>
        <div class="portfolio-summary"></div><details class="portfolio-insights"><summary><span><strong>Portfolio insights</strong><small data-pf-insight-brief>Across your loaded sports</small></span><span class="portfolio-insight-toggle" aria-hidden="true"></span></summary><div class="portfolio-insight-body"></div></details><div class="portfolio-toolbar"><div class="portfolio-tabs" role="group" aria-label="Ticket status">${[['open','Open'],['live','Live'],['upcoming','Upcoming'],['settled','Settled'],['all','All']].map(([k,l])=>`<button type="button" data-pf-status="${k}" aria-pressed="${k==='open'}">${l}</button>`).join('')}</div><label class="portfolio-sport"><span class="sr-only">Sport</span><select aria-label="Filter tickets by sport"><option value="all">All sports</option><option value="nfl">NFL</option><option value="ncaaf">College</option><option value="mlb">MLB</option><option value="nhl">NHL</option></select></label><label class="portfolio-search"><span class="sr-only">Search tickets</span><input type="search" aria-label="Search tickets" placeholder="Team, pick or book" autocomplete="off"></label></div>
        <div class="portfolio-tools"><p class="portfolio-notice" role="status"></p><button type="button" class="portfolio-manage" data-pf-refresh>Refresh</button><button type="button" class="portfolio-manage" data-pf-results>${names[options.sport]} results</button><details class="portfolio-export"><summary>Export CSV</summary>${Object.entries(names).map(([k,n]) => `<a class="portfolio-manage" href="/${k}/api/bets.csv" download>${n} CSV</a>`).join('')}</details></div><div class="portfolio-list"></div><div class="portfolio-analysis" hidden></div><section class="portfolio-support" aria-label="Support THE.BOARD"><div class="portfolio-support-copy"><p class="portfolio-eyebrow">BUILT FOR YOUR NEXT MOVE</p><h2>Support THE.BOARD<span>.</span></h2><p>I’m Christopher. I built these models by hand. Your support helps cover live data and the work behind every improvement.</p><small>Scan on desktop. Tap on your phone.</small></div><div class="portfolio-support-codes"><a class="portfolio-support-pay" href="https://venmo.com/u/cmanlongat" target="_blank" rel="noopener noreferrer"><img src="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0nMS4wJyBlbmNvZGluZz0nVVRGLTgnPz4KPHN2ZyBzdHlsZT0iYmFja2dyb3VuZDp3aGl0ZSIgd2lkdGg9IjIyLjJtbSIgaGVpZ2h0PSIyMi4ybW0iIHZlcnNpb249IjEuMSIgdmlld0JveD0iMCAwIDIyLjIgMjIuMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMi40LDIuNEgzVjNIMi40ek0zLDIuNEgzLjZWM0gzek0zLjYsMi40SDQuMlYzSDMuNnpNNC4yLDIuNEg0LjhWM0g0LjJ6TTQuOCwyLjRINS40VjNINC44ek01LjQsMi40SDZWM0g1LjR6TTYsMi40SDYuNlYzSDZ6TTksMi40SDkuNlYzSDl6TTkuNiwyLjRIMTAuMlYzSDkuNnpNMTAuMiwyLjRIMTAuOFYzSDEwLjJ6TTEwLjgsMi40SDExLjRWM0gxMC44ek0xMS40LDIuNEgxMlYzSDExLjR6TTEzLjIsMi40SDEzLjhWM0gxMy4yek0xMy44LDIuNEgxNC40VjNIMTMuOHpNMTQuNCwyLjRIMTVWM0gxNC40ek0xNS42LDIuNEgxNi4yVjNIMTUuNnpNMTYuMiwyLjRIMTYuOFYzSDE2LjJ6TTE2LjgsMi40SDE3LjRWM0gxNi44ek0xNy40LDIuNEgxOFYzSDE3LjR6TTE4LDIuNEgxOC42VjNIMTh6TTE4LjYsMi40SDE5LjJWM0gxOC42ek0xOS4yLDIuNEgxOS44VjNIMTkuMnpNMi40LDNIM1YzLjZIMi40ek02LDNINi42VjMuNkg2ek03LjgsM0g4LjRWMy42SDcuOHpNOC40LDNIOVYzLjZIOC40ek05LDNIOS42VjMuNkg5ek0xMC4yLDNIMTAuOFYzLjZIMTAuMnpNMTAuOCwzSDExLjRWMy42SDEwLjh6TTExLjQsM0gxMlYzLjZIMTEuNHpNMTIsM0gxMi42VjMuNkgxMnpNMTMuMiwzSDEzLjhWMy42SDEzLjJ6TTE0LjQsM0gxNVYzLjZIMTQuNHpNMTUuNiwzSDE2LjJWMy42SDE1LjZ6TTE5LjIsM0gxOS44VjMuNkgxOS4yek0yLjQsMy42SDNWNC4ySDIuNHpNMy42LDMuNkg0LjJWNC4ySDMuNnpNNC4yLDMuNkg0LjhWNC4ySDQuMnpNNC44LDMuNkg1LjRWNC4ySDQuOHpNNiwzLjZINi42VjQuMkg2ek03LjIsMy42SDcuOFY0LjJINy4yek04LjQsMy42SDlWNC4ySDguNHpNOSwzLjZIOS42VjQuMkg5ek05LjYsMy42SDEwLjJWNC4ySDkuNnpNMTAuMiwzLjZIMTAuOFY0LjJIMTAuMnpNMTEuNCwzLjZIMTJWNC4ySDExLjR6TTE0LjQsMy42SDE1VjQuMkgxNC40ek0xNS42LDMuNkgxNi4yVjQuMkgxNS42ek0xNi44LDMuNkgxNy40VjQuMkgxNi44ek0xNy40LDMuNkgxOFY0LjJIMTcuNHpNMTgsMy42SDE4LjZWNC4ySDE4ek0xOS4yLDMuNkgxOS44VjQuMkgxOS4yek0yLjQsNC4ySDNWNC44SDIuNHpNMy42LDQuMkg0LjJWNC44SDMuNnpNNC4yLDQuMkg0LjhWNC44SDQuMnpNNC44LDQuMkg1LjRWNC44SDQuOHpNNiw0LjJINi42VjQuOEg2ek03LjIsNC4ySDcuOFY0LjhINy4yek03LjgsNC4ySDguNFY0LjhINy44ek05LjYsNC4ySDEwLjJWNC44SDkuNnpNMTAuOCw0LjJIMTEuNFY0LjhIMTAuOHpNMTEuNCw0LjJIMTJWNC44SDExLjR6TTEyLjYsNC4ySDEzLjJWNC44SDEyLjZ6TTEzLjgsNC4ySDE0LjRWNC44SDEzLjh6TTE1LjYsNC4ySDE2LjJWNC44SDE1LjZ6TTE2LjgsNC4ySDE3LjRWNC44SDE2Ljh6TTE3LjQsNC4ySDE4VjQuOEgxNy40ek0xOCw0LjJIMTguNlY0LjhIMTh6TTE5LjIsNC4ySDE5LjhWNC44SDE5LjJ6TTIuNCw0LjhIM1Y1LjRIMi40ek0zLjYsNC44SDQuMlY1LjRIMy42ek00LjIsNC44SDQuOFY1LjRINC4yek00LjgsNC44SDUuNFY1LjRINC44ek02LDQuOEg2LjZWNS40SDZ6TTcuMiw0LjhINy44VjUuNEg3LjJ6TTcuOCw0LjhIOC40VjUuNEg3Ljh6TTExLjQsNC44SDEyVjUuNEgxMS40ek0xMiw0LjhIMTIuNlY1LjRIMTJ6TTEyLjYsNC44SDEzLjJWNS40SDEyLjZ6TTEzLjIsNC44SDEzLjhWNS40SDEzLjJ6TTEzLjgsNC44SDE0LjRWNS40SDEzLjh6TTE0LjQsNC44SDE1VjUuNEgxNC40ek0xNS42LDQuOEgxNi4yVjUuNEgxNS42ek0xNi44LDQuOEgxNy40VjUuNEgxNi44ek0xNy40LDQuOEgxOFY1LjRIMTcuNHpNMTgsNC44SDE4LjZWNS40SDE4ek0xOS4yLDQuOEgxOS44VjUuNEgxOS4yek0yLjQsNS40SDNWNkgyLjR6TTYsNS40SDYuNlY2SDZ6TTcuMiw1LjRINy44VjZINy4yek05LDUuNEg5LjZWNkg5ek05LjYsNS40SDEwLjJWNkg5LjZ6TTEyLjYsNS40SDEzLjJWNkgxMi42ek0xNC40LDUuNEgxNVY2SDE0LjR6TTE1LjYsNS40SDE2LjJWNkgxNS42ek0xOS4yLDUuNEgxOS44VjZIMTkuMnpNMi40LDZIM1Y2LjZIMi40ek0zLDZIMy42VjYuNkgzek0zLjYsNkg0LjJWNi42SDMuNnpNNC4yLDZINC44VjYuNkg0LjJ6TTQuOCw2SDUuNFY2LjZINC44ek01LjQsNkg2VjYuNkg1LjR6TTYsNkg2LjZWNi42SDZ6TTcuMiw2SDcuOFY2LjZINy4yek04LjQsNkg5VjYuNkg4LjR6TTkuNiw2SDEwLjJWNi42SDkuNnpNMTAuOCw2SDExLjRWNi42SDEwLjh6TTEyLDZIMTIuNlY2LjZIMTJ6TTEzLjIsNkgxMy44VjYuNkgxMy4yek0xNC40LDZIMTVWNi42SDE0LjR6TTE1LjYsNkgxNi4yVjYuNkgxNS42ek0xNi4yLDZIMTYuOFY2LjZIMTYuMnpNMTYuOCw2SDE3LjRWNi42SDE2Ljh6TTE3LjQsNkgxOFY2LjZIMTcuNHpNMTgsNkgxOC42VjYuNkgxOHpNMTguNiw2SDE5LjJWNi42SDE4LjZ6TTE5LjIsNkgxOS44VjYuNkgxOS4yek03LjIsNi42SDcuOFY3LjJINy4yek03LjgsNi42SDguNFY3LjJINy44ek05LDYuNkg5LjZWNy4ySDl6TTkuNiw2LjZIMTAuMlY3LjJIOS42ek0xMC44LDYuNkgxMS40VjcuMkgxMC44ek0xMiw2LjZIMTIuNlY3LjJIMTJ6TTEzLjIsNi42SDEzLjhWNy4ySDEzLjJ6TTEzLjgsNi42SDE0LjRWNy4ySDEzLjh6TTIuNCw3LjJIM1Y3LjhIMi40ek0zLjYsNy4ySDQuMlY3LjhIMy42ek00LjIsNy4ySDQuOFY3LjhINC4yek00LjgsNy4ySDUuNFY3LjhINC44ek01LjQsNy4ySDZWNy44SDUuNHpNNiw3LjJINi42VjcuOEg2ek03LjgsNy4ySDguNFY3LjhINy44ek05LjYsNy4ySDEwLjJWNy44SDkuNnpNMTIsNy4ySDEyLjZWNy44SDEyek0xMi42LDcuMkgxMy4yVjcuOEgxMi42ek0xNS42LDcuMkgxNi4yVjcuOEgxNS42ek0xNi4yLDcuMkgxNi44VjcuOEgxNi4yek0xNi44LDcuMkgxNy40VjcuOEgxNi44ek0xNy40LDcuMkgxOFY3LjhIMTcuNHpNMTgsNy4ySDE4LjZWNy44SDE4ek00LjIsNy44SDQuOFY4LjRINC4yek02LjYsNy44SDcuMlY4LjRINi42ek03LjIsNy44SDcuOFY4LjRINy4yek03LjgsNy44SDguNFY4LjRINy44ek04LjQsNy44SDlWOC40SDguNHpNOSw3LjhIOS42VjguNEg5ek0xMC4yLDcuOEgxMC44VjguNEgxMC4yek0xMC44LDcuOEgxMS40VjguNEgxMC44ek0xMS40LDcuOEgxMlY4LjRIMTEuNHpNMTIuNiw3LjhIMTMuMlY4LjRIMTIuNnpNMTMuMiw3LjhIMTMuOFY4LjRIMTMuMnpNMTMuOCw3LjhIMTQuNFY4LjRIMTMuOHpNMTQuNCw3LjhIMTVWOC40SDE0LjR6TTE1LDcuOEgxNS42VjguNEgxNXpNMTUuNiw3LjhIMTYuMlY4LjRIMTUuNnpNMTYuMiw3LjhIMTYuOFY4LjRIMTYuMnpNMTYuOCw3LjhIMTcuNFY4LjRIMTYuOHpNMTkuMiw3LjhIMTkuOFY4LjRIMTkuMnpNMyw4LjRIMy42VjlIM3pNMy42LDguNEg0LjJWOUgzLjZ6TTQuMiw4LjRINC44VjlINC4yek02LDguNEg2LjZWOUg2ek02LjYsOC40SDcuMlY5SDYuNnpNOSw4LjRIOS42VjlIOXpNMTAuMiw4LjRIMTAuOFY5SDEwLjJ6TTEwLjgsOC40SDExLjRWOUgxMC44ek0xMS40LDguNEgxMlY5SDExLjR6TTEyLDguNEgxMi42VjlIMTJ6TTE0LjQsOC40SDE1VjlIMTQuNHpNMTUuNiw4LjRIMTYuMlY5SDE1LjZ6TTE2LjIsOC40SDE2LjhWOUgxNi4yek0xNi44LDguNEgxNy40VjlIMTYuOHpNNC44LDlINS40VjkuNkg0Ljh6TTcuMiw5SDcuOFY5LjZINy4yek0xMC4yLDlIMTAuOFY5LjZIMTAuMnpNMTEuNCw5SDEyVjkuNkgxMS40ek0xMy4yLDlIMTMuOFY5LjZIMTMuMnpNMTMuOCw5SDE0LjRWOS42SDEzLjh6TTE0LjQsOUgxNVY5LjZIMTQuNHpNMTUuNiw5SDE2LjJWOS42SDE1LjZ6TTE2LjIsOUgxNi44VjkuNkgxNi4yek0xNy40LDlIMThWOS42SDE3LjR6TTE4LjYsOUgxOS4yVjkuNkgxOC42ek0yLjQsOS42SDNWMTAuMkgyLjR6TTQuMiw5LjZINC44VjEwLjJINC4yek00LjgsOS42SDUuNFYxMC4ySDQuOHpNNiw5LjZINi42VjEwLjJINnpNNy4yLDkuNkg3LjhWMTAuMkg3LjJ6TTcuOCw5LjZIOC40VjEwLjJINy44ek04LjQsOS42SDlWMTAuMkg4LjR6TTksOS42SDkuNlYxMC4ySDl6TTEwLjgsOS42SDExLjRWMTAuMkgxMC44ek0xMS40LDkuNkgxMlYxMC4ySDExLjR6TTEyLjYsOS42SDEzLjJWMTAuMkgxMi42ek0xMy44LDkuNkgxNC40VjEwLjJIMTMuOHpNMTUsOS42SDE1LjZWMTAuMkgxNXpNMTcuNCw5LjZIMThWMTAuMkgxNy40ek0xOCw5LjZIMTguNlYxMC4ySDE4ek0yLjQsMTAuMkgzVjEwLjhIMi40ek0zLDEwLjJIMy42VjEwLjhIM3pNMy42LDEwLjJINC4yVjEwLjhIMy42ek00LjIsMTAuMkg0LjhWMTAuOEg0LjJ6TTQuOCwxMC4ySDUuNFYxMC44SDQuOHpNNS40LDEwLjJINlYxMC44SDUuNHpNNi42LDEwLjJINy4yVjEwLjhINi42ek03LjIsMTAuMkg3LjhWMTAuOEg3LjJ6TTkuNiwxMC4ySDEwLjJWMTAuOEg5LjZ6TTExLjQsMTAuMkgxMlYxMC44SDExLjR6TTEyLDEwLjJIMTIuNlYxMC44SDEyek0xMi42LDEwLjJIMTMuMlYxMC44SDEyLjZ6TTEzLjIsMTAuMkgxMy44VjEwLjhIMTMuMnpNMTMuOCwxMC4ySDE0LjRWMTAuOEgxMy44ek0xNSwxMC4ySDE1LjZWMTAuOEgxNXpNMTUuNiwxMC4ySDE2LjJWMTAuOEgxNS42ek0xNi4yLDEwLjJIMTYuOFYxMC44SDE2LjJ6TTE2LjgsMTAuMkgxNy40VjEwLjhIMTYuOHpNMTkuMiwxMC4ySDE5LjhWMTAuOEgxOS4yek02LDEwLjhINi42VjExLjRINnpNNy4yLDEwLjhINy44VjExLjRINy4yek05LDEwLjhIOS42VjExLjRIOXpNMTIuNiwxMC44SDEzLjJWMTEuNEgxMi42ek0xNC40LDEwLjhIMTVWMTEuNEgxNC40ek0xNS42LDEwLjhIMTYuMlYxMS40SDE1LjZ6TTE3LjQsMTAuOEgxOFYxMS40SDE3LjR6TTE4LDEwLjhIMTguNlYxMS40SDE4ek0zLDExLjRIMy42VjEySDN6TTMuNiwxMS40SDQuMlYxMkgzLjZ6TTQuMiwxMS40SDQuOFYxMkg0LjJ6TTUuNCwxMS40SDZWMTJINS40ek03LjIsMTEuNEg3LjhWMTJINy4yek03LjgsMTEuNEg4LjRWMTJINy44ek05LjYsMTEuNEgxMC4yVjEySDkuNnpNMTAuOCwxMS40SDExLjRWMTJIMTAuOHpNMTIsMTEuNEgxMi42VjEySDEyek0xNC40LDExLjRIMTVWMTJIMTQuNHpNMTUsMTEuNEgxNS42VjEySDE1ek0xNS42LDExLjRIMTYuMlYxMkgxNS42ek0xNi4yLDExLjRIMTYuOFYxMkgxNi4yek0xOC42LDExLjRIMTkuMlYxMkgxOC42ek0zLDEySDMuNlYxMi42SDN6TTMuNiwxMkg0LjJWMTIuNkgzLjZ6TTQuMiwxMkg0LjhWMTIuNkg0LjJ6TTYsMTJINi42VjEyLjZINnpNOS42LDEySDEwLjJWMTIuNkg5LjZ6TTEyLDEySDEyLjZWMTIuNkgxMnpNMTIuNiwxMkgxMy4yVjEyLjZIMTIuNnpNMTQuNCwxMkgxNVYxMi42SDE0LjR6TTE3LjQsMTJIMThWMTIuNkgxNy40ek0xOCwxMkgxOC42VjEyLjZIMTh6TTIuNCwxMi42SDNWMTMuMkgyLjR6TTcuOCwxMi42SDguNFYxMy4ySDcuOHpNOS42LDEyLjZIMTAuMlYxMy4ySDkuNnpNMTAuMiwxMi42SDEwLjhWMTMuMkgxMC4yek0xMC44LDEyLjZIMTEuNFYxMy4ySDEwLjh6TTExLjQsMTIuNkgxMlYxMy4ySDExLjR6TTEyLjYsMTIuNkgxMy4yVjEzLjJIMTIuNnpNMTMuMiwxMi42SDEzLjhWMTMuMkgxMy4yek0xMy44LDEyLjZIMTQuNFYxMy4ySDEzLjh6TTE0LjQsMTIuNkgxNVYxMy4ySDE0LjR6TTE1LDEyLjZIMTUuNlYxMy4ySDE1ek0xNS42LDEyLjZIMTYuMlYxMy4ySDE1LjZ6TTE2LjIsMTIuNkgxNi44VjEzLjJIMTYuMnpNMTYuOCwxMi42SDE3LjRWMTMuMkgxNi44ek0xOCwxMi42SDE4LjZWMTMuMkgxOHpNMTkuMiwxMi42SDE5LjhWMTMuMkgxOS4yek0yLjQsMTMuMkgzVjEzLjhIMi40ek0zLjYsMTMuMkg0LjJWMTMuOEgzLjZ6TTQuOCwxMy4ySDUuNFYxMy44SDQuOHpNNS40LDEzLjJINlYxMy44SDUuNHpNNiwxMy4ySDYuNlYxMy44SDZ6TTcuOCwxMy4ySDguNFYxMy44SDcuOHpNOC40LDEzLjJIOVYxMy44SDguNHpNOSwxMy4ySDkuNlYxMy44SDl6TTkuNiwxMy4ySDEwLjJWMTMuOEg5LjZ6TTEwLjIsMTMuMkgxMC44VjEzLjhIMTAuMnpNMTAuOCwxMy4ySDExLjRWMTMuOEgxMC44ek0xMS40LDEzLjJIMTJWMTMuOEgxMS40ek0xMiwxMy4ySDEyLjZWMTMuOEgxMnpNMTIuNiwxMy4ySDEzLjJWMTMuOEgxMi42ek0xNC40LDEzLjJIMTVWMTMuOEgxNC40ek0xNSwxMy4ySDE1LjZWMTMuOEgxNXpNMTYuMiwxMy4ySDE2LjhWMTMuOEgxNi4yek0xNi44LDEzLjJIMTcuNFYxMy44SDE2Ljh6TTE4LDEzLjJIMTguNlYxMy44SDE4ek0yLjQsMTMuOEgzVjE0LjRIMi40ek0zLjYsMTMuOEg0LjJWMTQuNEgzLjZ6TTUuNCwxMy44SDZWMTQuNEg1LjR6TTYuNiwxMy44SDcuMlYxNC40SDYuNnpNMTAuMiwxMy44SDEwLjhWMTQuNEgxMC4yek0xMS40LDEzLjhIMTJWMTQuNEgxMS40ek0xMy4yLDEzLjhIMTMuOFYxNC40SDEzLjJ6TTEzLjgsMTMuOEgxNC40VjE0LjRIMTMuOHpNMTQuNCwxMy44SDE1VjE0LjRIMTQuNHpNMTUuNiwxMy44SDE2LjJWMTQuNEgxNS42ek0xNi4yLDEzLjhIMTYuOFYxNC40SDE2LjJ6TTE2LjgsMTMuOEgxNy40VjE0LjRIMTYuOHpNMTguNiwxMy44SDE5LjJWMTQuNEgxOC42ek0yLjQsMTQuNEgzVjE1SDIuNHpNNC4yLDE0LjRINC44VjE1SDQuMnpNNS40LDE0LjRINlYxNUg1LjR6TTYsMTQuNEg2LjZWMTVINnpNNy4yLDE0LjRINy44VjE1SDcuMnpNOC40LDE0LjRIOVYxNUg4LjR6TTksMTQuNEg5LjZWMTVIOXpNMTAuOCwxNC40SDExLjRWMTVIMTAuOHpNMTEuNCwxNC40SDEyVjE1SDExLjR6TTEyLjYsMTQuNEgxMy4yVjE1SDEyLjZ6TTEzLjgsMTQuNEgxNC40VjE1SDEzLjh6TTE0LjQsMTQuNEgxNVYxNUgxNC40ek0xNSwxNC40SDE1LjZWMTVIMTV6TTE1LjYsMTQuNEgxNi4yVjE1SDE1LjZ6TTE2LjIsMTQuNEgxNi44VjE1SDE2LjJ6TTE2LjgsMTQuNEgxNy40VjE1SDE2Ljh6TTE4LDE0LjRIMTguNlYxNUgxOHpNMTguNiwxNC40SDE5LjJWMTVIMTguNnpNMTkuMiwxNC40SDE5LjhWMTVIMTkuMnpNNy4yLDE1SDcuOFYxNS42SDcuMnpNNy44LDE1SDguNFYxNS42SDcuOHpNOSwxNUg5LjZWMTUuNkg5ek0xMS40LDE1SDEyVjE1LjZIMTEuNHpNMTIsMTVIMTIuNlYxNS42SDEyek0xMy4yLDE1SDEzLjhWMTUuNkgxMy4yek0xNC40LDE1SDE1VjE1LjZIMTQuNHpNMTYuOCwxNUgxNy40VjE1LjZIMTYuOHpNMTcuNCwxNUgxOFYxNS42SDE3LjR6TTE4LDE1SDE4LjZWMTUuNkgxOHpNMTguNiwxNUgxOS4yVjE1LjZIMTguNnpNMTkuMiwxNUgxOS44VjE1LjZIMTkuMnpNMi40LDE1LjZIM1YxNi4ySDIuNHpNMywxNS42SDMuNlYxNi4ySDN6TTMuNiwxNS42SDQuMlYxNi4ySDMuNnpNNC4yLDE1LjZINC44VjE2LjJINC4yek00LjgsMTUuNkg1LjRWMTYuMkg0Ljh6TTUuNCwxNS42SDZWMTYuMkg1LjR6TTYsMTUuNkg2LjZWMTYuMkg2ek05LDE1LjZIOS42VjE2LjJIOXpNOS42LDE1LjZIMTAuMlYxNi4ySDkuNnpNMTIuNiwxNS42SDEzLjJWMTYuMkgxMi42ek0xMy44LDE1LjZIMTQuNFYxNi4ySDEzLjh6TTE0LjQsMTUuNkgxNVYxNi4ySDE0LjR6TTE1LjYsMTUuNkgxNi4yVjE2LjJIMTUuNnpNMTYuOCwxNS42SDE3LjRWMTYuMkgxNi44ek0xNy40LDE1LjZIMThWMTYuMkgxNy40ek0xOCwxNS42SDE4LjZWMTYuMkgxOHpNMi40LDE2LjJIM1YxNi44SDIuNHpNNiwxNi4ySDYuNlYxNi44SDZ6TTcuMiwxNi4ySDcuOFYxNi44SDcuMnpNOSwxNi4ySDkuNlYxNi44SDl6TTkuNiwxNi4ySDEwLjJWMTYuOEg5LjZ6TTEwLjgsMTYuMkgxMS40VjE2LjhIMTAuOHpNMTIsMTYuMkgxMi42VjE2LjhIMTJ6TTE0LjQsMTYuMkgxNVYxNi44SDE0LjR6TTE2LjgsMTYuMkgxNy40VjE2LjhIMTYuOHpNMTguNiwxNi4ySDE5LjJWMTYuOEgxOC42ek0xOS4yLDE2LjJIMTkuOFYxNi44SDE5LjJ6TTIuNCwxNi44SDNWMTcuNEgyLjR6TTMuNiwxNi44SDQuMlYxNy40SDMuNnpNNC4yLDE2LjhINC44VjE3LjRINC4yek00LjgsMTYuOEg1LjRWMTcuNEg0Ljh6TTYsMTYuOEg2LjZWMTcuNEg2ek03LjIsMTYuOEg3LjhWMTcuNEg3LjJ6TTcuOCwxNi44SDguNFYxNy40SDcuOHpNOC40LDE2LjhIOVYxNy40SDguNHpNMTIuNiwxNi44SDEzLjJWMTcuNEgxMi42ek0xNC40LDE2LjhIMTVWMTcuNEgxNC40ek0xNSwxNi44SDE1LjZWMTcuNEgxNXpNMTUuNiwxNi44SDE2LjJWMTcuNEgxNS42ek0xNi4yLDE2LjhIMTYuOFYxNy40SDE2LjJ6TTE2LjgsMTYuOEgxNy40VjE3LjRIMTYuOHpNMTgsMTYuOEgxOC42VjE3LjRIMTh6TTE5LjIsMTYuOEgxOS44VjE3LjRIMTkuMnpNMi40LDE3LjRIM1YxOEgyLjR6TTMuNiwxNy40SDQuMlYxOEgzLjZ6TTQuMiwxNy40SDQuOFYxOEg0LjJ6TTQuOCwxNy40SDUuNFYxOEg0Ljh6TTYsMTcuNEg2LjZWMThINnpNNy4yLDE3LjRINy44VjE4SDcuMnpNOC40LDE3LjRIOVYxOEg4LjR6TTksMTcuNEg5LjZWMThIOXpNMTAuOCwxNy40SDExLjRWMThIMTAuOHpNMTEuNCwxNy40SDEyVjE4SDExLjR6TTEzLjIsMTcuNEgxMy44VjE4SDEzLjJ6TTEzLjgsMTcuNEgxNC40VjE4SDEzLjh6TTE3LjQsMTcuNEgxOFYxOEgxNy40ek0xOCwxNy40SDE4LjZWMThIMTh6TTIuNCwxOEgzVjE4LjZIMi40ek0zLjYsMThINC4yVjE4LjZIMy42ek00LjIsMThINC44VjE4LjZINC4yek00LjgsMThINS40VjE4LjZINC44ek02LDE4SDYuNlYxOC42SDZ6TTcuMiwxOEg3LjhWMTguNkg3LjJ6TTcuOCwxOEg4LjRWMTguNkg3Ljh6TTEwLjgsMThIMTEuNFYxOC42SDEwLjh6TTExLjQsMThIMTJWMTguNkgxMS40ek0xMy4yLDE4SDEzLjhWMTguNkgxMy4yek0xMy44LDE4SDE0LjRWMTguNkgxMy44ek0xNC40LDE4SDE1VjE4LjZIMTQuNHpNMTUsMThIMTUuNlYxOC42SDE1ek0xNS42LDE4SDE2LjJWMTguNkgxNS42ek0xNi4yLDE4SDE2LjhWMTguNkgxNi4yek0xNi44LDE4SDE3LjRWMTguNkgxNi44ek0xNy40LDE4SDE4VjE4LjZIMTcuNHpNMTgsMThIMTguNlYxOC42SDE4ek0xOC42LDE4SDE5LjJWMTguNkgxOC42ek0yLjQsMTguNkgzVjE5LjJIMi40ek02LDE4LjZINi42VjE5LjJINnpNNy44LDE4LjZIOC40VjE5LjJINy44ek04LjQsMTguNkg5VjE5LjJIOC40ek05LDE4LjZIOS42VjE5LjJIOXpNMTEuNCwxOC42SDEyVjE5LjJIMTEuNHpNMTIsMTguNkgxMi42VjE5LjJIMTJ6TTE0LjQsMTguNkgxNVYxOS4ySDE0LjR6TTE1LjYsMTguNkgxNi4yVjE5LjJIMTUuNnpNMTcuNCwxOC42SDE4VjE5LjJIMTcuNHpNMTguNiwxOC42SDE5LjJWMTkuMkgxOC42ek0yLjQsMTkuMkgzVjE5LjhIMi40ek0zLDE5LjJIMy42VjE5LjhIM3pNMy42LDE5LjJINC4yVjE5LjhIMy42ek00LjIsMTkuMkg0LjhWMTkuOEg0LjJ6TTQuOCwxOS4ySDUuNFYxOS44SDQuOHpNNS40LDE5LjJINlYxOS44SDUuNHpNNiwxOS4ySDYuNlYxOS44SDZ6TTcuMiwxOS4ySDcuOFYxOS44SDcuMnpNOS42LDE5LjJIMTAuMlYxOS44SDkuNnpNMTEuNCwxOS4ySDEyVjE5LjhIMTEuNHpNMTIsMTkuMkgxMi42VjE5LjhIMTJ6TTEyLjYsMTkuMkgxMy4yVjE5LjhIMTIuNnpNMTMuOCwxOS4ySDE0LjRWMTkuOEgxMy44ek0xNS42LDE5LjJIMTYuMlYxOS44SDE1LjZ6TTE2LjIsMTkuMkgxNi44VjE5LjhIMTYuMnpNMTYuOCwxOS4ySDE3LjRWMTkuOEgxNi44ek0xNy40LDE5LjJIMThWMTkuOEgxNy40ek0xOCwxOS4ySDE4LjZWMTkuOEgxOHoiIGlkPSJxci1wYXRoIiBmaWxsPSIjMDAwMDAwIiBmaWxsLW9wYWNpdHk9IjEiIGZpbGwtcnVsZT0ibm9uemVybyIgc3Ryb2tlPSJub25lIiAvPjwvc3ZnPg==" alt="Scan to tip @cmanlongat on Venmo" width="148" height="148" loading="lazy"><strong>Venmo ↗</strong><span>@cmanlongat</span></a><a class="portfolio-support-pay" href="https://cash.app/$christophermanlongat" target="_blank" rel="noopener noreferrer"><img src="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0nMS4wJyBlbmNvZGluZz0nVVRGLTgnPz4KPHN2ZyBzdHlsZT0iYmFja2dyb3VuZDp3aGl0ZSIgd2lkdGg9IjIyLjJtbSIgaGVpZ2h0PSIyMi4ybW0iIHZlcnNpb249IjEuMSIgdmlld0JveD0iMCAwIDIyLjIgMjIuMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMi40LDIuNEgzVjNIMi40ek0zLDIuNEgzLjZWM0gzek0zLjYsMi40SDQuMlYzSDMuNnpNNC4yLDIuNEg0LjhWM0g0LjJ6TTQuOCwyLjRINS40VjNINC44ek01LjQsMi40SDZWM0g1LjR6TTYsMi40SDYuNlYzSDZ6TTguNCwyLjRIOVYzSDguNHpNOSwyLjRIOS42VjNIOXpNOS42LDIuNEgxMC4yVjNIOS42ek0xMC44LDIuNEgxMS40VjNIMTAuOHpNMTEuNCwyLjRIMTJWM0gxMS40ek0xMy44LDIuNEgxNC40VjNIMTMuOHpNMTUuNiwyLjRIMTYuMlYzSDE1LjZ6TTE2LjIsMi40SDE2LjhWM0gxNi4yek0xNi44LDIuNEgxNy40VjNIMTYuOHpNMTcuNCwyLjRIMThWM0gxNy40ek0xOCwyLjRIMTguNlYzSDE4ek0xOC42LDIuNEgxOS4yVjNIMTguNnpNMTkuMiwyLjRIMTkuOFYzSDE5LjJ6TTIuNCwzSDNWMy42SDIuNHpNNiwzSDYuNlYzLjZINnpNNy4yLDNINy44VjMuNkg3LjJ6TTcuOCwzSDguNFYzLjZINy44ek05LjYsM0gxMC4yVjMuNkg5LjZ6TTEwLjIsM0gxMC44VjMuNkgxMC4yek0xMS40LDNIMTJWMy42SDExLjR6TTEyLDNIMTIuNlYzLjZIMTJ6TTEzLjgsM0gxNC40VjMuNkgxMy44ek0xNC40LDNIMTVWMy42SDE0LjR6TTE1LjYsM0gxNi4yVjMuNkgxNS42ek0xOS4yLDNIMTkuOFYzLjZIMTkuMnpNMi40LDMuNkgzVjQuMkgyLjR6TTMuNiwzLjZINC4yVjQuMkgzLjZ6TTQuMiwzLjZINC44VjQuMkg0LjJ6TTQuOCwzLjZINS40VjQuMkg0Ljh6TTYsMy42SDYuNlY0LjJINnpNNy44LDMuNkg4LjRWNC4ySDcuOHpNMTEuNCwzLjZIMTJWNC4ySDExLjR6TTE0LjQsMy42SDE1VjQuMkgxNC40ek0xNS42LDMuNkgxNi4yVjQuMkgxNS42ek0xNi44LDMuNkgxNy40VjQuMkgxNi44ek0xNy40LDMuNkgxOFY0LjJIMTcuNHpNMTgsMy42SDE4LjZWNC4ySDE4ek0xOS4yLDMuNkgxOS44VjQuMkgxOS4yek0yLjQsNC4ySDNWNC44SDIuNHpNMy42LDQuMkg0LjJWNC44SDMuNnpNNC4yLDQuMkg0LjhWNC44SDQuMnpNNC44LDQuMkg1LjRWNC44SDQuOHpNNiw0LjJINi42VjQuOEg2ek05LjYsNC4ySDEwLjJWNC44SDkuNnpNMTAuOCw0LjJIMTEuNFY0LjhIMTAuOHpNMTEuNCw0LjJIMTJWNC44SDExLjR6TTEzLjIsNC4ySDEzLjhWNC44SDEzLjJ6TTE1LjYsNC4ySDE2LjJWNC44SDE1LjZ6TTE2LjgsNC4ySDE3LjRWNC44SDE2Ljh6TTE3LjQsNC4ySDE4VjQuOEgxNy40ek0xOCw0LjJIMTguNlY0LjhIMTh6TTE5LjIsNC4ySDE5LjhWNC44SDE5LjJ6TTIuNCw0LjhIM1Y1LjRIMi40ek0zLjYsNC44SDQuMlY1LjRIMy42ek00LjIsNC44SDQuOFY1LjRINC4yek00LjgsNC44SDUuNFY1LjRINC44ek02LDQuOEg2LjZWNS40SDZ6TTcuMiw0LjhINy44VjUuNEg3LjJ6TTcuOCw0LjhIOC40VjUuNEg3Ljh6TTExLjQsNC44SDEyVjUuNEgxMS40ek0xMy44LDQuOEgxNC40VjUuNEgxMy44ek0xNS42LDQuOEgxNi4yVjUuNEgxNS42ek0xNi44LDQuOEgxNy40VjUuNEgxNi44ek0xNy40LDQuOEgxOFY1LjRIMTcuNHpNMTgsNC44SDE4LjZWNS40SDE4ek0xOS4yLDQuOEgxOS44VjUuNEgxOS4yek0yLjQsNS40SDNWNkgyLjR6TTYsNS40SDYuNlY2SDZ6TTguNCw1LjRIOVY2SDguNHpNMTAuMiw1LjRIMTAuOFY2SDEwLjJ6TTEwLjgsNS40SDExLjRWNkgxMC44ek0xMS40LDUuNEgxMlY2SDExLjR6TTEyLjYsNS40SDEzLjJWNkgxMi42ek0xMy4yLDUuNEgxMy44VjZIMTMuMnpNMTMuOCw1LjRIMTQuNFY2SDEzLjh6TTE1LjYsNS40SDE2LjJWNkgxNS42ek0xOS4yLDUuNEgxOS44VjZIMTkuMnpNMi40LDZIM1Y2LjZIMi40ek0zLDZIMy42VjYuNkgzek0zLjYsNkg0LjJWNi42SDMuNnpNNC4yLDZINC44VjYuNkg0LjJ6TTQuOCw2SDUuNFY2LjZINC44ek01LjQsNkg2VjYuNkg1LjR6TTYsNkg2LjZWNi42SDZ6TTcuMiw2SDcuOFY2LjZINy4yek04LjQsNkg5VjYuNkg4LjR6TTkuNiw2SDEwLjJWNi42SDkuNnpNMTAuOCw2SDExLjRWNi42SDEwLjh6TTEyLDZIMTIuNlY2LjZIMTJ6TTEzLjIsNkgxMy44VjYuNkgxMy4yek0xNC40LDZIMTVWNi42SDE0LjR6TTE1LjYsNkgxNi4yVjYuNkgxNS42ek0xNi4yLDZIMTYuOFY2LjZIMTYuMnpNMTYuOCw2SDE3LjRWNi42SDE2Ljh6TTE3LjQsNkgxOFY2LjZIMTcuNHpNMTgsNkgxOC42VjYuNkgxOHpNMTguNiw2SDE5LjJWNi42SDE4LjZ6TTE5LjIsNkgxOS44VjYuNkgxOS4yek03LjgsNi42SDguNFY3LjJINy44ek04LjQsNi42SDlWNy4ySDguNHpNOSw2LjZIOS42VjcuMkg5ek0xMC4yLDYuNkgxMC44VjcuMkgxMC4yek0xMiw2LjZIMTIuNlY3LjJIMTJ6TTEyLjYsNi42SDEzLjJWNy4ySDEyLjZ6TTIuNCw3LjJIM1Y3LjhIMi40ek0zLjYsNy4ySDQuMlY3LjhIMy42ek00LjgsNy4ySDUuNFY3LjhINC44ek02LDcuMkg2LjZWNy44SDZ6TTcuOCw3LjJIOC40VjcuOEg3Ljh6TTEwLjgsNy4ySDExLjRWNy44SDEwLjh6TTExLjQsNy4ySDEyVjcuOEgxMS40ek0xMiw3LjJIMTIuNlY3LjhIMTJ6TTEyLjYsNy4ySDEzLjJWNy44SDEyLjZ6TTE2LjgsNy4ySDE3LjRWNy44SDE2Ljh6TTE4LjYsNy4ySDE5LjJWNy44SDE4LjZ6TTIuNCw3LjhIM1Y4LjRIMi40ek0zLDcuOEgzLjZWOC40SDN6TTMuNiw3LjhINC4yVjguNEgzLjZ6TTQuOCw3LjhINS40VjguNEg0Ljh6TTYuNiw3LjhINy4yVjguNEg2LjZ6TTkuNiw3LjhIMTAuMlY4LjRIOS42ek0xMiw3LjhIMTIuNlY4LjRIMTJ6TTE0LjQsNy44SDE1VjguNEgxNC40ek0xNSw3LjhIMTUuNlY4LjRIMTV6TTE1LjYsNy44SDE2LjJWOC40SDE1LjZ6TTE2LjIsNy44SDE2LjhWOC40SDE2LjJ6TTE3LjQsNy44SDE4VjguNEgxNy40ek0xOS4yLDcuOEgxOS44VjguNEgxOS4yek0yLjQsOC40SDNWOUgyLjR6TTMsOC40SDMuNlY5SDN6TTMuNiw4LjRINC4yVjlIMy42ek01LjQsOC40SDZWOUg1LjR6TTYsOC40SDYuNlY5SDZ6TTYuNiw4LjRINy4yVjlINi42ek03LjIsOC40SDcuOFY5SDcuMnpNOC40LDguNEg5VjlIOC40ek05LDguNEg5LjZWOUg5ek05LjYsOC40SDEwLjJWOUg5LjZ6TTEwLjIsOC40SDEwLjhWOUgxMC4yek0xMi42LDguNEgxMy4yVjlIMTIuNnpNMTQuNCw4LjRIMTVWOUgxNC40ek0xNSw4LjRIMTUuNlY5SDE1ek0xNi44LDguNEgxNy40VjlIMTYuOHpNMTgsOC40SDE4LjZWOUgxOHpNMTguNiw4LjRIMTkuMlY5SDE4LjZ6TTE5LjIsOC40SDE5LjhWOUgxOS4yek0yLjQsOUgzVjkuNkgyLjR6TTMuNiw5SDQuMlY5LjZIMy42ek00LjgsOUg1LjRWOS42SDQuOHpNNi42LDlINy4yVjkuNkg2LjZ6TTcuOCw5SDguNFY5LjZINy44ek05LDlIOS42VjkuNkg5ek05LjYsOUgxMC4yVjkuNkg5LjZ6TTEyLDlIMTIuNlY5LjZIMTJ6TTEyLjYsOUgxMy4yVjkuNkgxMi42ek0xMy4yLDlIMTMuOFY5LjZIMTMuMnpNMTMuOCw5SDE0LjRWOS42SDEzLjh6TTE1LDlIMTUuNlY5LjZIMTV6TTE1LjYsOUgxNi4yVjkuNkgxNS42ek0xNi4yLDlIMTYuOFY5LjZIMTYuMnpNMTYuOCw5SDE3LjRWOS42SDE2Ljh6TTE4LjYsOUgxOS4yVjkuNkgxOC42ek01LjQsOS42SDZWMTAuMkg1LjR6TTYsOS42SDYuNlYxMC4ySDZ6TTYuNiw5LjZINy4yVjEwLjJINi42ek03LjIsOS42SDcuOFYxMC4ySDcuMnpNNy44LDkuNkg4LjRWMTAuMkg3Ljh6TTguNCw5LjZIOVYxMC4ySDguNHpNOS42LDkuNkgxMC4yVjEwLjJIOS42ek0xMS40LDkuNkgxMlYxMC4ySDExLjR6TTEyLDkuNkgxMi42VjEwLjJIMTJ6TTEyLjYsOS42SDEzLjJWMTAuMkgxMi42ek0xMy44LDkuNkgxNC40VjEwLjJIMTMuOHpNMTQuNCw5LjZIMTVWMTAuMkgxNC40ek0xNSw5LjZIMTUuNlYxMC4ySDE1ek0xNS42LDkuNkgxNi4yVjEwLjJIMTUuNnpNMTcuNCw5LjZIMThWMTAuMkgxNy40ek0xOC42LDkuNkgxOS4yVjEwLjJIMTguNnpNMTkuMiw5LjZIMTkuOFYxMC4ySDE5LjJ6TTIuNCwxMC4ySDNWMTAuOEgyLjR6TTQuMiwxMC4ySDQuOFYxMC44SDQuMnpNNS40LDEwLjJINlYxMC44SDUuNHpNNy4yLDEwLjJINy44VjEwLjhINy4yek03LjgsMTAuMkg4LjRWMTAuOEg3Ljh6TTEwLjIsMTAuMkgxMC44VjEwLjhIMTAuMnpNMTIsMTAuMkgxMi42VjEwLjhIMTJ6TTEyLjYsMTAuMkgxMy4yVjEwLjhIMTIuNnpNMTMuMiwxMC4ySDEzLjhWMTAuOEgxMy4yek0xNC40LDEwLjJIMTVWMTAuOEgxNC40ek0xNSwxMC4ySDE1LjZWMTAuOEgxNXpNMTUuNiwxMC4ySDE2LjJWMTAuOEgxNS42ek0xNy40LDEwLjJIMThWMTAuOEgxNy40ek0xOS4yLDEwLjJIMTkuOFYxMC44SDE5LjJ6TTMuNiwxMC44SDQuMlYxMS40SDMuNnpNNC4yLDEwLjhINC44VjExLjRINC4yek00LjgsMTAuOEg1LjRWMTEuNEg0Ljh6TTYsMTAuOEg2LjZWMTEuNEg2ek03LjIsMTAuOEg3LjhWMTEuNEg3LjJ6TTcuOCwxMC44SDguNFYxMS40SDcuOHpNMTAuOCwxMC44SDExLjRWMTEuNEgxMC44ek0xMiwxMC44SDEyLjZWMTEuNEgxMnpNMTMuMiwxMC44SDEzLjhWMTEuNEgxMy4yek0xNS42LDEwLjhIMTYuMlYxMS40SDE1LjZ6TTE2LjIsMTAuOEgxNi44VjExLjRIMTYuMnpNMTcuNCwxMC44SDE4VjExLjRIMTcuNHpNMTguNiwxMC44SDE5LjJWMTEuNEgxOC42ek0xOS4yLDEwLjhIMTkuOFYxMS40SDE5LjJ6TTMsMTEuNEgzLjZWMTJIM3pNNC44LDExLjRINS40VjEySDQuOHpNNS40LDExLjRINlYxMkg1LjR6TTcuMiwxMS40SDcuOFYxMkg3LjJ6TTguNCwxMS40SDlWMTJIOC40ek05LDExLjRIOS42VjEySDl6TTEwLjIsMTEuNEgxMC44VjEySDEwLjJ6TTEwLjgsMTEuNEgxMS40VjEySDEwLjh6TTExLjQsMTEuNEgxMlYxMkgxMS40ek0xMiwxMS40SDEyLjZWMTJIMTJ6TTEyLjYsMTEuNEgxMy4yVjEySDEyLjZ6TTE2LjIsMTEuNEgxNi44VjEySDE2LjJ6TTE3LjQsMTEuNEgxOFYxMkgxNy40ek0xOC42LDExLjRIMTkuMlYxMkgxOC42ek0yLjQsMTJIM1YxMi42SDIuNHpNNC44LDEySDUuNFYxMi42SDQuOHpNNS40LDEySDZWMTIuNkg1LjR6TTYsMTJINi42VjEyLjZINnpNNi42LDEySDcuMlYxMi42SDYuNnpNNy4yLDEySDcuOFYxMi42SDcuMnpNOC40LDEySDlWMTIuNkg4LjR6TTksMTJIOS42VjEyLjZIOXpNMTAuOCwxMkgxMS40VjEyLjZIMTAuOHpNMTEuNCwxMkgxMlYxMi42SDExLjR6TTEyLDEySDEyLjZWMTIuNkgxMnpNMTIuNiwxMkgxMy4yVjEyLjZIMTIuNnpNMTQuNCwxMkgxNVYxMi42SDE0LjR6TTE1LDEySDE1LjZWMTIuNkgxNXpNMTUuNiwxMkgxNi4yVjEyLjZIMTUuNnpNMTYuMiwxMkgxNi44VjEyLjZIMTYuMnpNMTcuNCwxMkgxOFYxMi42SDE3LjR6TTE4LjYsMTJIMTkuMlYxMi42SDE4LjZ6TTE5LjIsMTJIMTkuOFYxMi42SDE5LjJ6TTMsMTIuNkgzLjZWMTMuMkgzek0zLjYsMTIuNkg0LjJWMTMuMkgzLjZ6TTQuMiwxMi42SDQuOFYxMy4ySDQuMnpNNC44LDEyLjZINS40VjEzLjJINC44ek01LjQsMTIuNkg2VjEzLjJINS40ek02LjYsMTIuNkg3LjJWMTMuMkg2LjZ6TTksMTIuNkg5LjZWMTMuMkg5ek05LjYsMTIuNkgxMC4yVjEzLjJIOS42ek0xMC44LDEyLjZIMTEuNFYxMy4ySDEwLjh6TTEyLDEyLjZIMTIuNlYxMy4ySDEyek0xNC40LDEyLjZIMTVWMTMuMkgxNC40ek0xNS42LDEyLjZIMTYuMlYxMy4ySDE1LjZ6TTE3LjQsMTIuNkgxOFYxMy4ySDE3LjR6TTE4LDEyLjZIMTguNlYxMy4ySDE4ek0xOS4yLDEyLjZIMTkuOFYxMy4ySDE5LjJ6TTIuNCwxMy4ySDNWMTMuOEgyLjR6TTMuNiwxMy4ySDQuMlYxMy44SDMuNnpNNS40LDEzLjJINlYxMy44SDUuNHpNNiwxMy4ySDYuNlYxMy44SDZ6TTYuNiwxMy4ySDcuMlYxMy44SDYuNnpNOC40LDEzLjJIOVYxMy44SDguNHpNMTAuMiwxMy4ySDEwLjhWMTMuOEgxMC4yek0xMiwxMy4ySDEyLjZWMTMuOEgxMnpNMTMuMiwxMy4ySDEzLjhWMTMuOEgxMy4yek0xNC40LDEzLjJIMTVWMTMuOEgxNC40ek0xNS42LDEzLjJIMTYuMlYxMy44SDE1LjZ6TTE2LjIsMTMuMkgxNi44VjEzLjhIMTYuMnpNMTYuOCwxMy4ySDE3LjRWMTMuOEgxNi44ek0xOC42LDEzLjJIMTkuMlYxMy44SDE4LjZ6TTE5LjIsMTMuMkgxOS44VjEzLjhIMTkuMnpNMywxMy44SDMuNlYxNC40SDN6TTMuNiwxMy44SDQuMlYxNC40SDMuNnpNNC4yLDEzLjhINC44VjE0LjRINC4yek00LjgsMTMuOEg1LjRWMTQuNEg0Ljh6TTcuMiwxMy44SDcuOFYxNC40SDcuMnpNOSwxMy44SDkuNlYxNC40SDl6TTEyLDEzLjhIMTIuNlYxNC40SDEyek0xMi42LDEzLjhIMTMuMlYxNC40SDEyLjZ6TTEzLjgsMTMuOEgxNC40VjE0LjRIMTMuOHpNMTQuNCwxMy44SDE1VjE0LjRIMTQuNHpNMTUsMTMuOEgxNS42VjE0LjRIMTV6TTE2LjIsMTMuOEgxNi44VjE0LjRIMTYuMnpNMTcuNCwxMy44SDE4VjE0LjRIMTcuNHpNMTguNiwxMy44SDE5LjJWMTQuNEgxOC42ek0yLjQsMTQuNEgzVjE1SDIuNHpNNC44LDE0LjRINS40VjE1SDQuOHpNNS40LDE0LjRINlYxNUg1LjR6TTYsMTQuNEg2LjZWMTVINnpNNi42LDE0LjRINy4yVjE1SDYuNnpNOSwxNC40SDkuNlYxNUg5ek05LjYsMTQuNEgxMC4yVjE1SDkuNnpNMTEuNCwxNC40SDEyVjE1SDExLjR6TTEyLDE0LjRIMTIuNlYxNUgxMnpNMTIuNiwxNC40SDEzLjJWMTVIMTIuNnpNMTQuNCwxNC40SDE1VjE1SDE0LjR6TTE1LDE0LjRIMTUuNlYxNUgxNXpNMTUuNiwxNC40SDE2LjJWMTVIMTUuNnpNMTYuMiwxNC40SDE2LjhWMTVIMTYuMnpNMTYuOCwxNC40SDE3LjRWMTVIMTYuOHpNNy4yLDE1SDcuOFYxNS42SDcuMnpNOSwxNUg5LjZWMTUuNkg5ek0xMC4yLDE1SDEwLjhWMTUuNkgxMC4yek0xMiwxNUgxMi42VjE1LjZIMTJ6TTEyLjYsMTVIMTMuMlYxNS42SDEyLjZ6TTEzLjgsMTVIMTQuNFYxNS42SDEzLjh6TTE0LjQsMTVIMTVWMTUuNkgxNC40ek0xNi44LDE1SDE3LjRWMTUuNkgxNi44ek0xOCwxNUgxOC42VjE1LjZIMTh6TTE4LjYsMTVIMTkuMlYxNS42SDE4LjZ6TTE5LjIsMTVIMTkuOFYxNS42SDE5LjJ6TTIuNCwxNS42SDNWMTYuMkgyLjR6TTMsMTUuNkgzLjZWMTYuMkgzek0zLjYsMTUuNkg0LjJWMTYuMkgzLjZ6TTQuMiwxNS42SDQuOFYxNi4ySDQuMnpNNC44LDE1LjZINS40VjE2LjJINC44ek01LjQsMTUuNkg2VjE2LjJINS40ek02LDE1LjZINi42VjE2LjJINnpNNy44LDE1LjZIOC40VjE2LjJINy44ek05LDE1LjZIOS42VjE2LjJIOXpNOS42LDE1LjZIMTAuMlYxNi4ySDkuNnpNMTAuOCwxNS42SDExLjRWMTYuMkgxMC44ek0xMy44LDE1LjZIMTQuNFYxNi4ySDEzLjh6TTE0LjQsMTUuNkgxNVYxNi4ySDE0LjR6TTE1LjYsMTUuNkgxNi4yVjE2LjJIMTUuNnpNMTYuOCwxNS42SDE3LjRWMTYuMkgxNi44ek0xNy40LDE1LjZIMThWMTYuMkgxNy40ek0xOC42LDE1LjZIMTkuMlYxNi4ySDE4LjZ6TTE5LjIsMTUuNkgxOS44VjE2LjJIMTkuMnpNMi40LDE2LjJIM1YxNi44SDIuNHpNNiwxNi4ySDYuNlYxNi44SDZ6TTguNCwxNi4ySDlWMTYuOEg4LjR6TTksMTYuMkg5LjZWMTYuOEg5ek0xMC4yLDE2LjJIMTAuOFYxNi44SDEwLjJ6TTEwLjgsMTYuMkgxMS40VjE2LjhIMTAuOHpNMTEuNCwxNi4ySDEyVjE2LjhIMTEuNHpNMTIuNiwxNi4ySDEzLjJWMTYuOEgxMi42ek0xMy4yLDE2LjJIMTMuOFYxNi44SDEzLjJ6TTEzLjgsMTYuMkgxNC40VjE2LjhIMTMuOHpNMTQuNCwxNi4ySDE1VjE2LjhIMTQuNHpNMTYuOCwxNi4ySDE3LjRWMTYuOEgxNi44ek0xNy40LDE2LjJIMThWMTYuOEgxNy40ek0xOC42LDE2LjJIMTkuMlYxNi44SDE4LjZ6TTE5LjIsMTYuMkgxOS44VjE2LjhIMTkuMnpNMi40LDE2LjhIM1YxNy40SDIuNHpNMy42LDE2LjhINC4yVjE3LjRIMy42ek00LjIsMTYuOEg0LjhWMTcuNEg0LjJ6TTQuOCwxNi44SDUuNFYxNy40SDQuOHpNNiwxNi44SDYuNlYxNy40SDZ6TTcuMiwxNi44SDcuOFYxNy40SDcuMnpNNy44LDE2LjhIOC40VjE3LjRINy44ek05LDE2LjhIOS42VjE3LjRIOXpNMTAuOCwxNi44SDExLjRWMTcuNEgxMC44ek0xMiwxNi44SDEyLjZWMTcuNEgxMnpNMTIuNiwxNi44SDEzLjJWMTcuNEgxMi42ek0xNC40LDE2LjhIMTVWMTcuNEgxNC40ek0xNSwxNi44SDE1LjZWMTcuNEgxNXpNMTUuNiwxNi44SDE2LjJWMTcuNEgxNS42ek0xNi4yLDE2LjhIMTYuOFYxNy40SDE2LjJ6TTE2LjgsMTYuOEgxNy40VjE3LjRIMTYuOHpNMTguNiwxNi44SDE5LjJWMTcuNEgxOC42ek0xOS4yLDE2LjhIMTkuOFYxNy40SDE5LjJ6TTIuNCwxNy40SDNWMThIMi40ek0zLjYsMTcuNEg0LjJWMThIMy42ek00LjIsMTcuNEg0LjhWMThINC4yek00LjgsMTcuNEg1LjRWMThINC44ek02LDE3LjRINi42VjE4SDZ6TTguNCwxNy40SDlWMThIOC40ek0xMC4yLDE3LjRIMTAuOFYxOEgxMC4yek0xMC44LDE3LjRIMTEuNFYxOEgxMC44ek0xMiwxNy40SDEyLjZWMThIMTJ6TTEyLjYsMTcuNEgxMy4yVjE4SDEyLjZ6TTEzLjIsMTcuNEgxMy44VjE4SDEzLjJ6TTE0LjQsMTcuNEgxNVYxOEgxNC40ek0xNi4yLDE3LjRIMTYuOFYxOEgxNi4yek0xNi44LDE3LjRIMTcuNFYxOEgxNi44ek0xOCwxNy40SDE4LjZWMThIMTh6TTE4LjYsMTcuNEgxOS4yVjE4SDE4LjZ6TTE5LjIsMTcuNEgxOS44VjE4SDE5LjJ6TTIuNCwxOEgzVjE4LjZIMi40ek0zLjYsMThINC4yVjE4LjZIMy42ek00LjIsMThINC44VjE4LjZINC4yek00LjgsMThINS40VjE4LjZINC44ek02LDE4SDYuNlYxOC42SDZ6TTcuMiwxOEg3LjhWMTguNkg3LjJ6TTguNCwxOEg5VjE4LjZIOC40ek05LDE4SDkuNlYxOC42SDl6TTkuNiwxOEgxMC4yVjE4LjZIOS42ek0xMC4yLDE4SDEwLjhWMTguNkgxMC4yek0xMC44LDE4SDExLjRWMTguNkgxMC44ek0xMi42LDE4SDEzLjJWMTguNkgxMi42ek0xMy4yLDE4SDEzLjhWMTguNkgxMy4yek0xMy44LDE4SDE0LjRWMTguNkgxMy44ek0xNSwxOEgxNS42VjE4LjZIMTV6TTE2LjIsMThIMTYuOFYxOC42SDE2LjJ6TTE2LjgsMThIMTcuNFYxOC42SDE2Ljh6TTE3LjQsMThIMThWMTguNkgxNy40ek0xOS4yLDE4SDE5LjhWMTguNkgxOS4yek0yLjQsMTguNkgzVjE5LjJIMi40ek02LDE4LjZINi42VjE5LjJINnpNOC40LDE4LjZIOVYxOS4ySDguNHpNOS42LDE4LjZIMTAuMlYxOS4ySDkuNnpNMTAuMiwxOC42SDEwLjhWMTkuMkgxMC4yek0xMC44LDE4LjZIMTEuNFYxOS4ySDEwLjh6TTExLjQsMTguNkgxMlYxOS4ySDExLjR6TTEyLDE4LjZIMTIuNlYxOS4ySDEyek0xMi42LDE4LjZIMTMuMlYxOS4ySDEyLjZ6TTEzLjgsMTguNkgxNC40VjE5LjJIMTMuOHpNMTQuNCwxOC42SDE1VjE5LjJIMTQuNHpNMTUsMTguNkgxNS42VjE5LjJIMTV6TTE2LjgsMTguNkgxNy40VjE5LjJIMTYuOHpNMTguNiwxOC42SDE5LjJWMTkuMkgxOC42ek0yLjQsMTkuMkgzVjE5LjhIMi40ek0zLDE5LjJIMy42VjE5LjhIM3pNMy42LDE5LjJINC4yVjE5LjhIMy42ek00LjIsMTkuMkg0LjhWMTkuOEg0LjJ6TTQuOCwxOS4ySDUuNFYxOS44SDQuOHpNNS40LDE5LjJINlYxOS44SDUuNHpNNiwxOS4ySDYuNlYxOS44SDZ6TTcuMiwxOS4ySDcuOFYxOS44SDcuMnpNOSwxOS4ySDkuNlYxOS44SDl6TTEwLjgsMTkuMkgxMS40VjE5LjhIMTAuOHpNMTEuNCwxOS4ySDEyVjE5LjhIMTEuNHpNMTIsMTkuMkgxMi42VjE5LjhIMTJ6TTEyLjYsMTkuMkgxMy4yVjE5LjhIMTIuNnpNMTQuNCwxOS4ySDE1VjE5LjhIMTQuNHpNMTUuNiwxOS4ySDE2LjJWMTkuOEgxNS42ek0xNi44LDE5LjJIMTcuNFYxOS44SDE2Ljh6TTE4LjYsMTkuMkgxOS4yVjE5LjhIMTguNnpNMTkuMiwxOS4ySDE5LjhWMTkuOEgxOS4yeiIgaWQ9InFyLXBhdGgiIGZpbGw9IiMwMDAwMDAiIGZpbGwtb3BhY2l0eT0iMSIgZmlsbC1ydWxlPSJub256ZXJvIiBzdHJva2U9Im5vbmUiIC8+PC9zdmc+" alt="Scan to tip $christophermanlongat on Cash App" width="148" height="148" loading="lazy"><strong>Cash App ↗</strong><span>$christophermanlongat</span></a></div></section>`;
      s = { root, options, filter: { sport: 'all', status: 'open', query: '' }, peerGames: {}, peerBets: {}, summary: root.querySelector('.portfolio-summary'), notice: root.querySelector('.portfolio-notice'), list: root.querySelector('.portfolio-list') };
      states.set(root, s);
      const disclosure = root.querySelector('.portfolio-insights');
      if (disclosure) {
        disclosure.open = insightPreferences.expanded ?? Boolean(globalThis.matchMedia?.('(min-width: 760px)').matches);
        disclosure.addEventListener('toggle', () => { insightPreferences.expanded = disclosure.open; });
      }
      root.addEventListener('input', (ev) => {
        if (!ev.target.hasAttribute?.('data-pf-day')) return;
        const point = s.insightModel?.points[Number(ev.target.value)];
        if (point) updateInsightSelection(s, point.day);
      });
      root.addEventListener('click', (ev) => {
        const plot = ev.target.closest('[data-pf-plot]');
        if (plot && s.insightModel?.points.length) {
          const box = plot.getBoundingClientRect(), points = s.insightModel.points, geometry = chartGeometry(points);
          const x = (ev.clientX - box.left) / box.width * 640;
          const nearest = points.reduce((a, p) => Math.abs(geometry.x(p) - x) < Math.abs(geometry.x(a) - x) ? p : a);
          updateInsightSelection(s, nearest.day); return;
        }
        const b = ev.target.closest('button'); if (!b) return;
        if (b.dataset.pfExposure) { s.insightGroup = b.dataset.pfExposure; updateInsights(s, select(s.data?.tickets || [], { sport: s.filter.sport })); return; }
        if (b.dataset.pfDayStep) { updateInsightSelection(s, chooseInsightDay(s.insightModel?.points || [], s.insightDay, b.dataset.pfDayStep)); return; }
        if (b.hasAttribute('data-pf-new')) { const sport = root.querySelector('.portfolio-entry-sport').value; if (sport === s.options.sport) s.options.onNew?.(); else location.assign(`/${sport}/?portfolio=new#${sport === 'mlb' ? 'following' : 'bets'}`); }
        if (b.dataset.pfStatus) { s.filter.status = b.dataset.pfStatus; s.limit = 40; updateList(s); }
        if (b.hasAttribute('data-pf-more')) { s.limit = (s.limit || 40) + 40; updateList(s); }
        if (b.hasAttribute('data-pf-refresh') && !s.loading) { s.peerBets = {}; refresh(s, true); }
        if (b.hasAttribute('data-pf-results')) {
          const p = root.querySelector('.portfolio-analysis'); p.hidden = !p.hidden;
          b.setAttribute('aria-expanded', String(!p.hidden));
          if (!p.hidden) { p.innerHTML = s.options.resultsHTML?.() || ''; p.scrollIntoView({ behavior: 'auto', block: 'nearest' }); }
        }
      });
      root.querySelector('.portfolio-sport select').addEventListener('change', (e) => { s.filter.sport = e.target.value; s.limit = 40; updateList(s); });
      root.querySelector('input[type=search]').addEventListener('input', (e) => { s.filter.query = e.target.value; s.limit = 40; updateList(s); });
      s.timer = setInterval(() => {
        if (!root.isConnected) { s.disposed = true; clearInterval(s.timer); s.stop?.(); document.removeEventListener?.('visibilitychange', s.visibilityHandler); return; }
        if (!visible(s)) { s.stop?.(); s.stop = null; return; }
        if (!s.stop && typeof BoardPortfolio.subscribe === 'function') {
          s.stop = BoardPortfolio.subscribe({ sports: (s.options.sports || ['nfl','ncaaf','mlb','nhl']).filter((x) => x !== s.options.sport), basePaths: s.options.basePaths,
            onBets: (sport, bets) => { s.peerBets[sport] = bets; refresh(s); }, onGames: (sport, games) => { s.peerGames[sport] = games; refresh(s); },
            onStatus: (sport, info) => { (s.peerStatus ||= {})[sport] = info.status; if (['reconnecting','error','closed'].includes(info.status)) { delete s.peerBets[sport]; delete s.peerGames[sport]; BoardPortfolio.invalidate(sport); if (s.data) s.data.tickets = s.data.tickets.map((t) => t.sport === sport ? BoardPortfolio.normalizeTicket(sport, t.raw, { basePath: s.options.basePaths?.[sport] }) : t).filter(Boolean); } updateList(s); } });
        }
        refresh(s);
      }, 5000);
      s.visibilityHandler = () => { if (!visible(s)) { s.stop?.(); s.stop = null; } else refresh(s, true); };
      document.addEventListener('visibilitychange', s.visibilityHandler);
    }
    s.options = options;
    // The active sport arrives over its existing SSE connection, without another HTTP request.
    if (!s.data) s.data = { tickets: [], sources: [{sport: options.sport,status:'ok'}] };
    if (Array.isArray(options.currentBets)) {
      s.data.tickets = s.data.tickets.filter((t) => t.sport !== options.sport).concat(options.currentBets.map((b) => BoardPortfolio.normalizeTicket(options.sport, b, { gameOf: options.gameOf, games: options.currentGames, basePath: options.basePaths?.[options.sport] })).filter(Boolean));
      updateList(s);
    }
    refresh(s);
    return true;
  }
  return { mount, select, summarize, toWin, renderTicket, evidence, insightData, chooseInsightDay, renderInsights };
});
