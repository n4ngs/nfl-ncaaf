(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoardPortfolioView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const states = new WeakMap();
  const names = { nfl: 'NFL', ncaaf: 'College', mlb: 'MLB' };
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
        <div class="portfolio-summary"></div><div class="portfolio-toolbar"><div class="portfolio-tabs" role="group" aria-label="Ticket status">${[['open','Open'],['live','Live'],['upcoming','Upcoming'],['settled','Settled'],['all','All']].map(([k,l])=>`<button type="button" data-pf-status="${k}" aria-pressed="${k==='open'}">${l}</button>`).join('')}</div><label class="portfolio-sport"><span class="sr-only">Sport</span><select aria-label="Filter tickets by sport"><option value="all">All sports</option><option value="nfl">NFL</option><option value="ncaaf">College</option><option value="mlb">MLB</option></select></label><label class="portfolio-search"><span class="sr-only">Search tickets</span><input type="search" aria-label="Search tickets" placeholder="Team, pick or book" autocomplete="off"></label></div>
        <div class="portfolio-tools"><p class="portfolio-notice" role="status"></p><button type="button" class="portfolio-manage" data-pf-refresh>Refresh</button><button type="button" class="portfolio-manage" data-pf-results>${names[options.sport]} results</button><details class="portfolio-export"><summary>Export CSV</summary>${Object.entries(names).map(([k,n]) => `<a class="portfolio-manage" href="/${k}/api/bets.csv" download>${n} CSV</a>`).join('')}</details></div><div class="portfolio-list"></div><div class="portfolio-analysis" hidden></div>`;
      s = { root, options, filter: { sport: 'all', status: 'open', query: '' }, peerGames: {}, peerBets: {}, summary: root.querySelector('.portfolio-summary'), notice: root.querySelector('.portfolio-notice'), list: root.querySelector('.portfolio-list') };
      states.set(root, s);
      root.addEventListener('click', (ev) => {
        const b = ev.target.closest('button'); if (!b) return;
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
          s.stop = BoardPortfolio.subscribe({ sports: (s.options.sports || ['nfl','ncaaf','mlb']).filter((x) => x !== s.options.sport), basePaths: s.options.basePaths,
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
  return { mount, select, summarize, toWin, renderTicket, evidence };
});
