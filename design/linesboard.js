'use strict';
/* THE.BOARD shared, loaded by all four boards: LinesBoard, the "Openers and closes" panel of a game sheet.

   One row per book. A dumbbell chart shows where each book OPENED (hollow ring, neutral) and where it is NOW or
   CLOSED (filled amber; a diamond once the close is frozen at kickoff), on one shared axis, so a steam move across
   the market reads at a glance. Summary tiles give the market's median open, now/close and the biggest mover. The
   same numbers sit in a table under the chart (the accessible view, and the exact prices). Market tabs switch
   spread / total / moneyline; "Expand" opens the panel full screen because there are many books.

   Data (built by each board from the server's `reference` + its current books):
     LinesBoard.html(id, { markets: { s|t|ml: { label, rows: [{ key, name, open, now, close }] } }, home, away })
     where open/now/close = { line, price, pHome?, at? } (line: home spread or total; ml uses pHome, the no-vig
     home win chance, as the axis value).
   Classic script; also exports for node tests. */
(function (root) {
  const MINUS = '−';
  const state = { market: null, wide: false };
  // Readable names when a board has not loaded its book list yet.
  const NAMES = { pin: 'Pinnacle', ps3838: 'PS3838', dk: 'DraftKings', fd: 'FanDuel', mgm: 'BetMGM', czr: 'Caesars', circa: 'Circa', sp: 'South Point',
    wg: 'Westgate', wynn: 'Wynn', stn: 'Station', bovada: 'Bovada', betonline: 'BetOnline', betrivers: 'BetRivers', fanatics: 'Fanatics', hardrock: 'Hard Rock', thescore: 'theScore' };
  const nameOf = (r) => (r.name && r.name !== r.key ? r.name : NAMES[r.key] || String(r.key || r.name || '').toUpperCase());
  const store = new Map();
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const odds = (o) => (o == null || !Number.isFinite(o) ? '' : o === 100 ? 'EV' : o > 0 ? `+${o}` : `${MINUS}${Math.abs(o)}`);
  const pts = (v) => (v == null ? '' : v === 0 ? 'PK' : `${v > 0 ? '+' : MINUS}${Math.abs(v)}`);
  const pct = (p) => (p == null ? '' : `${Math.round(p * 1000) / 10}%`);
  const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const when = (t) => { const x = Date.parse(t); return Number.isFinite(x) ? new Date(x).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };
  const prob = (a) => (a < 0 ? -a / (100 - a) : 100 / (100 + a));
  // No-vig home win chance from a moneyline pair [home, away].
  function noVig(prices) {
    if (!Array.isArray(prices) || !prices.every((p) => Number.isFinite(p) && Math.abs(p) >= 100)) return null;
    const h = prob(prices[0]), a = prob(prices[1]); return h / (h + a);
  }
  const axisValue = (m, q) => (!q ? null : m === 'ml' ? (Number.isFinite(q.pHome) ? q.pHome * 100 : null) : Number.isFinite(q.line) ? q.line : null);
  function label(m, q, home) {
    if (!q) return '—';
    if (m === 'ml') return `${odds(q.price)}${Number.isFinite(q.pHome) ? ` <small>${pct(q.pHome)}</small>` : ''}`;
    if (m === 's') return `${esc(home)} ${pts(q.line)} <small>${odds(q.price)}</small>`;
    return `${q.line ?? ''} <small>o ${odds(q.price)}</small>`;
  }
  function niceTicks(lo, hi, n = 5) {
    const span = hi - lo || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n) || 10 * mag;
    const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
    return out;
  }

  function chart(m, rows, home, away, W = 720, left = 120, cls = 'lb-svg') {
    const vals = rows.flatMap((r) => [axisValue(m, r.open), axisValue(m, r.now), axisValue(m, r.close)]).filter(Number.isFinite);
    if (!vals.length) return '';
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.08, m === 'ml' ? 1 : 0.5); lo -= pad; hi += pad;
    const rowH = 30, top = 28, right = W < 500 ? 14 : 24, H = top + rows.length * rowH + 8;
    const x = (v) => left + (v - lo) / (hi - lo) * (W - left - right);
    const ticks = niceTicks(lo, hi, W < 500 ? 4 : 5);
    const fmt = (v) => (m === 'ml' ? `${v}%` : m === 's' ? pts(v) : String(v));
    const grid = ticks.map((t) => `<line class="lb-grid" x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${H - 8}"/><text class="lb-tick" x="${x(t)}" y="${top - 12}" text-anchor="middle">${esc(fmt(t))}</text>`).join('');
    const body = rows.map((r, i) => {
      const y = top + i * rowH + rowH / 2;
      const o = axisValue(m, r.open), n = axisValue(m, r.now), c = axisValue(m, r.close), end = Number.isFinite(c) ? c : n;
      const tip = `${r.name}: opened ${stripTags(label(m, r.open, home))}${r.open?.at ? ` (${when(r.open.at)})` : ''}` +
        `${r.now ? `, now ${stripTags(label(m, r.now, home))}` : ''}${r.close ? `, closed ${stripTags(label(m, r.close, home))}` : ''}`;
      const seg = Number.isFinite(o) && Number.isFinite(end) && o !== end ? `<line class="lb-seg" x1="${x(o)}" x2="${x(end)}" y1="${y}" y2="${y}"/>` : '';
      const ring = Number.isFinite(o) ? `<circle class="lb-open" cx="${x(o)}" cy="${y}" r="5"/>` : '';
      const now = Number.isFinite(n) && Number.isFinite(c) && n !== c ? `<circle class="lb-now2" cx="${x(n)}" cy="${y}" r="3.5"/>` : '';
      const endMark = !Number.isFinite(end) ? '' : Number.isFinite(c)
        ? `<rect class="lb-close" x="${x(c) - 5}" y="${y - 5}" width="10" height="10" rx="1.5" transform="rotate(45 ${x(c)} ${y})"/>`
        : `<circle class="lb-now" cx="${x(n)}" cy="${y}" r="5.5"/>`;
      const same = Number.isFinite(o) && Number.isFinite(end) && o === end ? `<circle class="lb-same" cx="${x(o)}" cy="${y}" r="8.5"/>` : '';
      return `<g class="lb-row"><title>${esc(tip)}</title><rect class="lb-hit" x="0" y="${y - rowH / 2}" width="${W}" height="${rowH}"/>` +
        `<text class="lb-book" x="${left - 10}" y="${y + 4}" text-anchor="end">${esc(r.name)}</text>${seg}${ring}${now}${endMark}${same}</g>`;
    }).join('');
    const axisName = m === 'ml' ? `${esc(home)} win chance (no vig)` : m === 's' ? `${esc(home)} spread` : 'Total points';
    return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${axisName}: each book's opener and latest number">${grid}${body}</svg>`;
  }
  // A move in words: spreads say which side the number moved toward, totals up/down, moneylines the home win chance.
  function moveText(m, d, home, away) {
    if (d == null) return '';
    if (Math.abs(d) < 1e-9) return 'No move';
    const n = Math.abs(Math.round(d * 10) / 10);
    if (m === 's') return `${n} toward ${d > 0 ? away : home}`;
    if (m === 't') return `${d > 0 ? 'Up' : 'Down'} ${n}`;
    return `${home} ${d > 0 ? '+' : MINUS}${n} pts`;
  }
  const stripTags = (h) => String(h).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  function tiles(m, rows, home, away) {
    const med = (k) => median(rows.map((r) => axisValue(m, r[k])));
    const o = med('open'), n = med('now'), c = med('close');
    const fmt = (v) => (v == null ? '—' : m === 'ml' ? `${Math.round(v * 10) / 10}%` : m === 's' ? `${esc(home)} ${pts(Math.round(v * 2) / 2)}` : String(Math.round(v * 2) / 2));
    const movers = rows.map((r) => { const a = axisValue(m, r.open), b = axisValue(m, r.close) ?? axisValue(m, r.now); return Number.isFinite(a) && Number.isFinite(b) ? { r, d: b - a } : null; }).filter(Boolean).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    const top = movers[0];
    const moveTxt = top && Math.abs(top.d) > 1e-9 ? `${esc(top.r.name)} <small>${esc(moveText(m, top.d, home, away))}</small>` : 'No moves';
    const t = (k, v, sub) => `<div class="lb-tile"><div class="lb-k">${k}</div><div class="lb-v">${v}</div>${sub ? `<div class="lb-s">${sub}</div>` : ''}</div>`;
    return `<div class="lb-tiles">${t('Market opened', fmt(o), 'median of the books')}${t(c != null ? 'Market closed' : 'Market now', fmt(c ?? n), c != null ? 'last price before kickoff' : 'median of the books')}${t('Biggest mover', moveTxt, 'open to latest')}${t('Books', String(rows.length), '')}</div>`;
  }

  function table(m, rows, home, away) {
    const body = rows.map((r) => {
      const a = axisValue(m, r.open), b = axisValue(m, r.close) ?? axisValue(m, r.now);
      const d = Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
      const mv = d == null ? '' : Math.abs(d) < 1e-9 ? '—' : esc(moveText(m, d, home, away));
      return `<tr><th scope="row">${esc(r.name)}</th><td class="num">${label(m, r.open, home)}</td><td class="lb-when">${esc(when(r.open?.at))}</td><td class="num">${r.now ? label(m, r.now, home) : '—'}</td><td class="num">${r.close ? label(m, r.close, home) : '—'}</td><td class="num">${mv}</td></tr>`;
    }).join('');
    return `<div class="lb-tablewrap"><table class="lb-table"><thead><tr><th scope="col">Book</th><th scope="col">Opened</th><th scope="col">Posted</th><th scope="col">Now</th><th scope="col">Closed</th><th scope="col">Move</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function inner(id) {
    const d = store.get(id); if (!d) return '';
    const keys = Object.keys(d.markets).filter((k) => ['s', 't', 'ml'].includes(k) && d.markets[k]?.rows?.length);   // the board's own order: MLB/NHL lead with moneyline
    if (!keys.length) return '';
    const m = keys.includes(state.market) ? state.market : keys[0];
    const rows = d.markets[m].rows.slice().sort((a, b) => (axisValue(m, a.open) ?? Infinity) - (axisValue(m, b.open) ?? Infinity));
    const tabs = keys.map((k) => `<button type="button" class="lb-tab" data-lb-m="${k}" aria-pressed="${k === m}">${esc(d.markets[k].label)}</button>`).join('');
    const legend = `<div class="lb-legend"><span><svg width="14" height="14" aria-hidden="true"><circle class="lb-open" cx="7" cy="7" r="5"/></svg>Opened</span><span><svg width="14" height="14" aria-hidden="true"><circle class="lb-now" cx="7" cy="7" r="5.5"/></svg>Now</span><span><svg width="14" height="14" aria-hidden="true"><rect class="lb-close" x="2" y="2" width="10" height="10" rx="1.5" transform="rotate(45 7 7)"/></svg>Closed (last price before kickoff)</span></div>`;
    return `<div class="lb-head"><div><h3 class="lb-title">Openers and closes <span>${rows.length} books</span></h3><p class="lb-sub">Where every book opened, when it posted, and where it is now or closed.</p></div>` +
      `<div class="lb-ctl"><div class="lb-tabs" role="group" aria-label="Market">${tabs}</div><button type="button" class="lb-wide" data-lb-wide aria-pressed="${state.wide}">${state.wide ? 'Close' : 'Expand'}</button></div></div>` +
      `${tiles(m, rows, d.home, d.away)}${legend}<div class="lb-chart">${chart(m, rows, d.home, d.away)}${chart(m, rows, d.home, d.away, 360, 78, 'lb-svg lb-svg-n')}${chart(m, rows, d.home, d.away, 1200, 150, 'lb-svg lb-svg-w')}</div>${table(m, rows, d.home, d.away)}`;
  }

  function html(id, data) {
    for (const k of Object.keys(data.markets || {})) for (const r of data.markets[k].rows || []) r.name = nameOf(r);
    store.set(id, data);
    const body = inner(id);
    return body ? `<section class="lb${state.wide ? ' is-wide' : ''}" data-lb="${esc(id)}">${body}</section>` : '';
  }
  function repaint(el) { const id = el.getAttribute('data-lb'); el.classList.toggle('is-wide', state.wide); el.innerHTML = inner(id); document.body.classList.toggle('lb-lock', state.wide); }
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('[data-lb-m],[data-lb-wide]'); if (!t) return;
      const el = t.closest('[data-lb]'); if (!el) return;
      if (t.hasAttribute('data-lb-wide')) state.wide = !state.wide; else state.market = t.getAttribute('data-lb-m');
      repaint(el);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.wide) { state.wide = false; document.querySelectorAll('[data-lb]').forEach(repaint); } });
  }
  const api = { html, noVig, niceTicks, moveText, _state: state };
  root.LinesBoard = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
