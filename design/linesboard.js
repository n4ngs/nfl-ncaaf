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
  const state = { market: null, wide: false, view: 'books', range: 7, book: null };
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

  // The model's own number on the same axis (data.model: { s: home spread, t: total, ml: home win chance 0-1 }).
  const modelValue = (m, model) => { const v = model && model[m]; return !Number.isFinite(v) ? null : m === 'ml' ? v * 100 : v; };
  const modelText = (m, v, home) => (v == null ? '' : m === 'ml' ? `${Math.round(v * 10) / 10}%` : m === 's' ? `${home} ${pts(Math.round(v * 10) / 10)}` : String(Math.round(v * 10) / 10));
  function chart(m, rows, home, away, W = 720, left = 120, cls = 'lb-svg', model = null) {
    const mv = modelValue(m, model);
    const vals = rows.flatMap((r) => [axisValue(m, r.open), axisValue(m, r.now), axisValue(m, r.close)]).concat(mv == null ? [] : [mv]).filter(Number.isFinite);
    if (!vals.length) return '';
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.08, m === 'ml' ? 1 : 0.5); lo -= pad; hi += pad;
    const rowH = 30, top = 28, right = W < 500 ? 14 : 24, H = top + rows.length * rowH + 8 + (mv == null ? 0 : 24);
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
    // the model: a blue line down the chart at its fair number, labelled, so every book reads against it
    const mline = mv == null ? '' : `<g class="lb-model"><title>${esc(`Model (mine): ${modelText(m, mv, home)}. An estimate, not a price.`)}</title><line x1="${x(mv)}" x2="${x(mv)}" y1="${top - 4}" y2="${H - 22}"/><rect x="${x(mv) - 44}" y="${H - 20}" width="88" height="18" rx="9"/><text x="${x(mv)}" y="${H - 7.5}" text-anchor="middle">Model ${esc(modelText(m, mv, '').trim())}</text></g>`;
    return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${axisName}: each book's opener and latest number${mv == null ? '' : ', and the model at ' + esc(modelText(m, mv, home))}">${grid}${mline}${body}</svg>`;
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

  // Timeline: every book's number over time as a step line (neutral), the market median (ink) and one chosen book
  // (amber). Values: the home spread, the total, or the home moneyline's implied win chance (vig included).
  function series(m, d, rows) {
    const H = d.history || {}, out = [];
    for (const r of rows) {
      const pts = (H[r.key] && H[r.key][m]) || [];
      const v = (p) => (m === 'ml' ? (Math.abs(p[2]) >= 100 ? prob(p[2]) * 100 : null) : p[1]);
      const list = pts.map((p) => [p[0], v(p)]).filter((p) => Number.isFinite(p[1]));
      if (list.length) out.push({ key: r.key, name: r.name, pts: list });
    }
    return out;
  }
  function timeline(m, d, rows, W, cls) {
    const S = series(m, d, rows); if (!S.length) return '';
    const end = Math.min(Date.now(), Number.isFinite(d.start) ? d.start : Infinity);
    const first = Math.min(...S.map((x) => x.pts[0][0]));
    const from = state.range ? Math.max(first, end - state.range * 86400e3) : first;
    if (!(end > from)) return '';
    // value of a series at time t (last change at or before t)
    const at = (x, t) => { let v = null; for (const p of x.pts) { if (p[0] <= t) v = p[1]; else break; } return v; };
    const clip = (x) => { const inside = x.pts.filter((p) => p[0] > from && p[0] <= end); const v0 = at(x, from); return (v0 == null ? inside : [[from, v0], ...inside]).concat([[end, at(x, end)]]).filter((p) => p[1] != null); };
    const lines = S.map((x) => ({ ...x, c: clip(x) })).filter((x) => x.c.length);
    // The median on an even grid (240 steps), so quick back-and-forth juice flips at one book do not draw as noise.
    const times = Array.from({ length: 241 }, (_, i) => from + (end - from) * i / 240);
    const med = times.map((t) => [t, median(lines.map((x) => at({ pts: x.c }, t)))]).filter((p) => p[1] != null)
      .filter((p, i, a) => i === 0 || i === a.length - 1 || p[1] !== a[i - 1][1]);
    const vals = lines.flatMap((x) => x.c.map((p) => p[1])); let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.1, m === 'ml' ? 1 : 0.5); lo -= pad; hi += pad;
    const H = W < 500 ? 220 : W > 1000 ? 380 : 280, L = W < 500 ? 40 : 56, R = 16, T = 14, B = 26;
    const x = (t) => L + (t - from) / (end - from) * (W - L - R), y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
    const step = (c) => c.map((p, i) => (i ? `H${x(p[0]).toFixed(1)}V${y(p[1]).toFixed(1)}` : `M${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`)).join('');
    const fmt = (v) => (m === 'ml' ? `${v}%` : m === 's' ? pts(v) : String(v));
    const yt = niceTicks(lo, hi, 4).map((v) => `<line class="lb-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="lb-tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`).join('');
    const span = end - from, dayMs = 86400e3, stepDays = span > 60 * dayMs ? 14 : span > 20 * dayMs ? 7 : span > 6 * dayMs ? 2 : 1;
    const xt = []; for (let t = Math.ceil(from / dayMs) * dayMs; t <= end; t += stepDays * dayMs) xt.push(t);
    const xl = xt.slice(0, W < 500 ? 4 : 10).map((t) => `<text class="lb-tick" x="${x(t)}" y="${H - 6}" text-anchor="middle">${esc(new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</text>`).join('');
    const pick = lines.find((z) => z.key === state.book) || null;
    const ctx = lines.filter((z) => z !== pick).map((z) => `<path class="lb-tl-ctx" d="${step(z.c)}"><title>${esc(z.name)}</title></path>`).join('');
    const mline = med.length > 1 ? `<path class="lb-tl-med" d="${step(med)}"><title>Market median</title></path>` : '';
    const sel = pick ? `<path class="lb-tl-pick" d="${step(pick.c)}"><title>${esc(pick.name)}</title></path>${pick.c.filter((p, i, a) => i > 0 && i < a.length - 1 && p[1] !== a[i - 1][1]).map((p) => `<circle class="lb-tl-dot" cx="${x(p[0])}" cy="${y(p[1])}" r="3"><title>${esc(pick.name)} ${esc(fmt(Math.round(p[1] * 10) / 10))} · ${esc(when(new Date(p[0]).toISOString()))}</title></circle>`).join('')}` : '';
    const label = m === 'ml' ? `${esc(d.home)} win chance (implied, with vig)` : m === 's' ? `${esc(d.home)} spread` : 'Total points';
    return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} over time for every book">${yt}${xl}${ctx}${mline}${sel}</svg>`;
  }
  function timelineBlock(m, d, rows) {
    const S = series(m, d, rows);
    if (!S.length) return '<p class="lb-empty">No line history saved for this game yet. It fills in as the books are read.</p>';
    if (state.book && !S.some((x) => x.key === state.book)) state.book = null;
    const chips = S.map((x) => `<button type="button" class="lb-chip" data-lb-b="${esc(x.key)}" aria-pressed="${x.key === state.book}">${esc(x.name)}</button>`).join('');
    const ranges = [[1, '24 h'], [3, '3 days'], [7, '7 days'], [0, 'All']].map(([v, l]) => `<button type="button" class="lb-tab" data-lb-r="${v}" aria-pressed="${state.range === v}">${l}</button>`).join('');
    const legend = `<div class="lb-legend"><span><svg width="18" height="10" aria-hidden="true"><line class="lb-tl-med" x1="1" x2="17" y1="5" y2="5"/></svg>Market median</span>${state.book ? `<span><svg width="18" height="10" aria-hidden="true"><line class="lb-tl-pick" x1="1" x2="17" y1="5" y2="5"/></svg>${esc(S.find((x) => x.key === state.book)?.name || '')}</span>` : ''}<span><svg width="18" height="10" aria-hidden="true"><line class="lb-tl-ctx" x1="1" x2="17" y1="5" y2="5"/></svg>Each book</span>${modelValue(m, d.model) != null ? '<span><svg width="14" height="14" aria-hidden="true"><line class="lb-model-key" x1="7" x2="7" y1="1" y2="13"/></svg>Model (mine)</span>' : ''}</div>`;
    return `<div class="lb-tlctl"><div class="lb-tabs" role="group" aria-label="Time range">${ranges}</div><div class="lb-chips" role="group" aria-label="Highlight a book">${chips}</div></div>${legend}` +
      `<div class="lb-chart">${timeline(m, d, rows, 720, 'lb-svg')}${timeline(m, d, rows, 360, 'lb-svg lb-svg-n')}${timeline(m, d, rows, 1200, 'lb-svg lb-svg-w')}</div>`;
  }

  function tiles(m, rows, home, away, model = null) {
    const med = (k) => median(rows.map((r) => axisValue(m, r[k])));
    const o = med('open'), n = med('now'), c = med('close');
    const fmt = (v) => (v == null ? '—' : m === 'ml' ? `${Math.round(v * 10) / 10}%` : m === 's' ? `${esc(home)} ${pts(Math.round(v * 2) / 2)}` : String(Math.round(v * 2) / 2));
    const movers = rows.map((r) => { const a = axisValue(m, r.open), b = axisValue(m, r.close) ?? axisValue(m, r.now); return Number.isFinite(a) && Number.isFinite(b) ? { r, d: b - a } : null; }).filter(Boolean).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    const top = movers[0];
    const moveTxt = top && Math.abs(top.d) > 1e-9 ? `${esc(top.r.name)} <small>${esc(moveText(m, top.d, home, away))}</small>` : 'No moves';
    const t = (k, v, sub) => `<div class="lb-tile"><div class="lb-k">${k}</div><div class="lb-v">${v}</div>${sub ? `<div class="lb-s">${sub}</div>` : ''}</div>`;
    const mv = modelValue(m, model), cur = c ?? n;
    const gap = mv != null && cur != null ? (m === 's' ? `${Math.abs(Math.round((mv - cur) * 10) / 10)} pts from the market` : m === 't' ? `${Math.abs(Math.round((mv - cur) * 10) / 10)} pts ${mv > cur ? 'over' : 'under'} the market` : `${Math.abs(Math.round((mv - cur) * 10) / 10)} pts vs the market`) : 'an estimate, not a price';
    const modelTile = mv == null ? '' : `<div class="lb-tile lb-tile-model"><div class="lb-k">Model <span>mine</span></div><div class="lb-v">${esc(modelText(m, mv, home))}</div><div class="lb-s">${esc(gap)}</div></div>`;
    return `<div class="lb-tiles${modelTile ? ' has-model' : ''}">${t('Market opened', fmt(o), 'median of the books')}${t(c != null ? 'Market closed' : 'Market now', fmt(c ?? n), c != null ? 'last price before kickoff' : 'median of the books')}${modelTile}${t('Biggest mover', moveTxt, 'open to latest')}${t('Books', String(rows.length), '')}</div>`;
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
    const hasHist = !!(d.history && Object.keys(d.history).length);
    if (!hasHist) state.view = 'books';
    const views = hasHist ? `<div class="lb-tabs" role="group" aria-label="View"><button type="button" class="lb-tab" data-lb-v="books" aria-pressed="${state.view === 'books'}">By book</button><button type="button" class="lb-tab" data-lb-v="time" aria-pressed="${state.view === 'time'}">Over time</button></div>` : '';
    const legend = `<div class="lb-legend"><span><svg width="14" height="14" aria-hidden="true"><circle class="lb-open" cx="7" cy="7" r="5"/></svg>Opened</span><span><svg width="14" height="14" aria-hidden="true"><circle class="lb-now" cx="7" cy="7" r="5.5"/></svg>Now</span><span><svg width="14" height="14" aria-hidden="true"><rect class="lb-close" x="2" y="2" width="10" height="10" rx="1.5" transform="rotate(45 7 7)"/></svg>Closed (last price before kickoff)</span>${modelValue(m, d.model) != null ? '<span><svg width="14" height="14" aria-hidden="true"><line class="lb-model-key" x1="7" x2="7" y1="1" y2="13"/></svg>Model (mine)</span>' : ''}</div>`;
    return `<div class="lb-head"><div><h3 class="lb-title">Openers and closes <span>${rows.length} books</span></h3><p class="lb-sub">Where every book opened, when it posted, and where it is now or closed.</p></div>` +
      `<div class="lb-ctl">${views}<div class="lb-tabs" role="group" aria-label="Market">${tabs}</div><button type="button" class="lb-wide" data-lb-wide aria-pressed="${state.wide}">${state.wide ? 'Close' : 'Expand'}</button></div></div>` +
      `${tiles(m, rows, d.home, d.away, d.model)}${state.view === 'time' ? timelineBlock(m, d, rows) + table(m, rows, d.home, d.away) : `${legend}<div class="lb-chart">${chart(m, rows, d.home, d.away, 720, 120, 'lb-svg', d.model)}${chart(m, rows, d.home, d.away, 360, 78, 'lb-svg lb-svg-n', d.model)}${chart(m, rows, d.home, d.away, 1200, 150, 'lb-svg lb-svg-w', d.model)}</div>${table(m, rows, d.home, d.away)}`}`;
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
      const t = e.target.closest && e.target.closest('[data-lb-m],[data-lb-wide],[data-lb-v],[data-lb-r],[data-lb-b]'); if (!t) return;
      const el = t.closest('[data-lb]'); if (!el) return;
      if (t.hasAttribute('data-lb-wide')) state.wide = !state.wide;
      else if (t.hasAttribute('data-lb-v')) state.view = t.getAttribute('data-lb-v');
      else if (t.hasAttribute('data-lb-r')) state.range = Number(t.getAttribute('data-lb-r'));
      else if (t.hasAttribute('data-lb-b')) { const b = t.getAttribute('data-lb-b'); state.book = state.book === b ? null : b; }
      else state.market = t.getAttribute('data-lb-m');
      repaint(el);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.wide) { state.wide = false; document.querySelectorAll('[data-lb]').forEach(repaint); } });
  }
  const api = { html, noVig, niceTicks, moveText, _state: state };
  root.LinesBoard = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* SheetNav: a game sheet you can move around in (NFL and NCAAF game sheets; any sheet with a .gs-h header and three or
   more .sub-h section headings). A sheet runs thousands of pixels, so:
     - a sticky "Jump to" bar of chips, one per section (VAS, Model, Injuries, Movement, Numbers, Books, ...), plus
       "Collapse all" / "Expand all";
     - every section heading folds its section (tap, Enter or Space), and the choice is remembered per sport on this
       device (localStorage tb_sheetFold);
     - the long reference sections start folded the first time (injury report text, Injury Matrix, public money, key
       numbers, first half and team totals); jumping to a folded section opens it.
   It works on the DOM the sheet already renders, and re-applies itself when the sheet repaints. */
(function (root) {
  const KEY = 'tb_sheetFold';
  const SHORT = { 'VAS': 'VAS', 'Model read': 'Model', 'Injury Matrix': 'Matrix', 'Injury report': 'Injuries', 'Line movement': 'Movement',
    'The numbers': 'Numbers', 'Every book': 'Books', 'Where the money is': 'Money', 'Key numbers': 'Keys', 'First half & team totals': '1st half',
    'Your bets here': 'Your bets', 'Openers and closes': 'Openers', 'Opener read': 'Opener', 'Why the line moved': 'Why it moved' };
  const SHUT_FIRST = new Set(['Injury report', 'Injury Matrix', 'Where the money is', 'Key numbers', 'First half & team totals']);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const titleOf = (h) => (h.classList.contains('vas-head') ? 'VAS' : String((h.firstChild && h.firstChild.nodeType === 3 ? h.firstChild.textContent : h.textContent) || '').trim());
  const shortOf = (t) => SHORT[t] || (t.length > 14 ? t.slice(0, 13) + '…' : t);
  const isOpen = (saved, title) => (Object.prototype.hasOwnProperty.call(saved, title) ? saved[title] !== false : !SHUT_FIRST.has(title));
  const api = { SHORT, SHUT_FIRST, shortOf, isOpen };
  root.SheetNav = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports.SheetNav = api; }
  if (!root.document || !root.MutationObserver) return;
  const doc = root.document;
  const sport = () => ((root.location && root.location.pathname.match(/^\/(nfl|ncaaf|mlb|nhl)\//)) || [])[1] || 'board';
  const readAll = () => { try { const v = JSON.parse(root.localStorage.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
  const saved = () => { const v = readAll()[sport()]; return v && typeof v === 'object' ? v : {}; };
  const save = (m) => { try { const all = readAll(); all[sport()] = m; root.localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage blocked: folds last this visit */ } };

  function heads(body) { return [...body.querySelectorAll('.vas-panel > .vas-head, .sub-h')].filter((h) => titleOf(h)); }
  function apply(body) {
    if (!body) return;
    const nav0 = body.querySelector(':scope > .tb-jump');
    const hs = body.querySelector('.gs-h') ? heads(body) : [];
    if (hs.length < 3) { if (nav0) nav0.remove(); return; }
    const m = saved(), seen = new Set(), chips = [];
    let anyOpen = false;
    for (const h of hs) {
      const title = titleOf(h), open = isOpen(m, title);
      if (open) anyOpen = true;
      if (!h.classList.contains('tb-fold-h')) { h.classList.add('tb-fold-h'); h.setAttribute('role', 'button'); h.tabIndex = 0; }
      if (h.getAttribute('aria-expanded') !== String(open)) h.setAttribute('aria-expanded', String(open));
      if (h.dataset.tbFold !== title) h.dataset.tbFold = title;
      for (let n = h.nextElementSibling; n && !n.matches('.sub-h'); n = n.nextElementSibling) if (n.classList.contains('tb-fold-x') === open) n.classList.toggle('tb-fold-x', !open);
      if (!seen.has(title)) { seen.add(title); chips.push(`<button type="button" class="tb-jump-c${open ? '' : ' is-shut'}" data-tb-jump="${esc(title)}">${esc(shortOf(title))}</button>`); }
    }
    const html = chips.join('') + `<button type="button" class="tb-jump-c tb-jump-all" data-tb-all="${anyOpen ? 'shut' : 'open'}">${anyOpen ? 'Collapse all' : 'Expand all'}</button>`;
    let nav = nav0;
    if (!nav) {
      nav = doc.createElement('nav'); nav.className = 'tb-jump'; nav.setAttribute('aria-label', 'Jump to a section');
      const meta = body.querySelector(':scope > .gs-meta') || body.querySelector(':scope > .gs-h');
      if (meta) meta.after(nav); else body.prepend(nav);
    }
    if (nav.innerHTML !== html) nav.innerHTML = html;
  }
  function set(title, open) { const m = saved(); m[title] = open; save(m); }
  function headFor(body, title) { return heads(body).find((h) => titleOf(h) === title) || null; }

  let body = null, queued = false;
  const later = () => { if (queued) return; queued = true; (root.requestAnimationFrame || setTimeout)(() => { queued = false; apply(body); }); };
  const mo = new root.MutationObserver(later);
  function attach() {
    const b = doc.getElementById('dlgBody');
    if (!b || b === body) return !!b;
    body = b; mo.observe(b, { childList: true, subtree: true }); later(); return true;
  }
  if (!attach()) doc.addEventListener('DOMContentLoaded', attach, { once: true });

  function toggle(h) {
    const title = titleOf(h);
    set(title, h.getAttribute('aria-expanded') !== 'true');
    apply(body);
  }
  doc.addEventListener('click', (e) => {
    if (!body || !e.target.closest) return;
    const j = e.target.closest('[data-tb-jump]');
    if (j && body.contains(j)) {
      const title = j.dataset.tbJump;
      if (!isOpen(saved(), title)) { set(title, true); apply(body); }
      const h = headFor(body, title);
      if (h) h.scrollIntoView({ behavior: root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      return;
    }
    const all = e.target.closest('[data-tb-all]');
    if (all && body.contains(all)) {
      const open = all.dataset.tbAll === 'open', m = saved();
      for (const h of heads(body)) m[titleOf(h)] = open;
      save(m); apply(body); return;
    }
    const h = e.target.closest('.tb-fold-h');
    // controls inside a heading (a market switch, a link) keep working; the rest of the heading folds
    if (h && body.contains(h) && !e.target.closest('button, a, input, select, label, summary')) toggle(h);
  });
  doc.addEventListener('keydown', (e) => {
    const h = e.target && e.target.classList && e.target.classList.contains('tb-fold-h') ? e.target : null;
    if (h && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(h); }
  });
})(typeof window !== 'undefined' ? window : globalThis);

/* BoardFX, on all four boards:
   1. Frozen columns. When a wide board (NFL/NCAAF .bt, MLB .odds-bt, NHL .nb-table) runs past FREEZE_AT pixels, the
      columns right after Matchup (Model, Open, Market; on NHL Model, Market, Best) freeze beside it, so the model and
      the market stay in view while you scroll across the books. Offsets come from the live column widths (a column
      focus mode hides counts as zero), re-measured whenever the board repaints or the window resizes.
   2. Model flash. When the model's number for a game changes (a new read, a line the model now prices), that number
      flashes once. Changing market, day or week is not a change; neither is a number appearing for the first time. */
(function (root) {
  const FREEZE_AT = 3000, FROZEN = 3;   // columns 2..4
  const TABLES = '.bt, .odds-bt, .nb-table';
  const MODEL = '.bt .px.mdl, .odds-bt .odds-px.mdl, .nb-table .px.mdl, .mdl-b b';
  const isNum = (t) => (/\d/.test(t) || /\bPK\b/.test(t)) && !/^[—–-]+$/.test(t.trim());   // PK (a pick'em) is a number too
  const api = { FREEZE_AT, FROZEN, isNum };
  root.BoardFX = api;
  if (typeof module !== 'undefined' && module.exports) module.exports.BoardFX = api;
  if (!root.document || !root.MutationObserver) return;
  const doc = root.document;

  function freeze() {
    for (const t of doc.querySelectorAll(TABLES)) {
      const head = t.tHead && t.tHead.rows[0];
      if (!head) continue;
      const on = t.scrollWidth > FREEZE_AT && head.cells.length > FROZEN + 2;
      if (t.classList.contains('tb-freeze') !== on) t.classList.toggle('tb-freeze', on);
      if (!on) continue;
      let left = 0;
      for (let i = 0; i <= FROZEN; i++) {
        const c = head.cells[i];
        if (i > 0) { const v = `${Math.round(left)}px`; if (t.style.getPropertyValue(`--fz${i + 1}`) !== v) t.style.setProperty(`--fz${i + 1}`, v); }
        left += c ? c.getBoundingClientRect().width : 0;
      }
    }
  }

  const seen = new Map();
  let primed = false;
  function flash() {
    const now = new Map();
    for (const el of doc.querySelectorAll(MODEL)) {
      const row = el.closest('[data-open],[data-odds-open],[data-game-row],[data-game-id],tr');
      if (!row) continue;
      const id = row.getAttribute('data-open') || row.getAttribute('data-odds-open') || row.getAttribute('data-game-row') || row.getAttribute('data-game-id') || row.querySelector('[data-open],[data-odds-open],[data-game]')?.getAttribute('data-open') || row.querySelector('[data-odds-open]')?.getAttribute('data-odds-open') || row.querySelector('[data-game]')?.getAttribute('data-game');
      if (!id) continue;
      const tbl = el.closest('table'), card = el.closest('.brd,.odds-brd,.card');
      const ctx = tbl ? tbl.querySelector('th.mdl-th')?.title || '' : (card && card.firstElementChild ? card.firstElementChild.textContent : '') + (el.closest('[title]')?.title || '');
      const idx = [...row.querySelectorAll(MODEL)].indexOf(el);
      const key = `${location.pathname}|${tbl ? 't' : 'p'}|${ctx}|${id}|${idx}`, text = el.textContent.trim();
      now.set(key, text);
      const was = seen.get(key);
      if (primed && was !== undefined && was !== text && isNum(was) && isNum(text)) {
        el.classList.remove('mdl-flash'); void el.offsetWidth; el.classList.add('mdl-flash');
        setTimeout(() => el.classList.remove('mdl-flash'), 1600);
      }
    }
    for (const [k, v] of now) seen.set(k, v);
    if (seen.size > 4000) { for (const k of [...seen.keys()].slice(0, seen.size - 3000)) seen.delete(k); }
    primed = true;
  }

  let queued = false;
  const run = () => { queued = false; try { freeze(); } catch { /* layout only */ } try { flash(); } catch { /* cosmetic */ } };
  const later = () => { if (queued) return; queued = true; (root.requestAnimationFrame || setTimeout)(run); };
  const start = () => { new root.MutationObserver(later).observe(doc.body, { childList: true, subtree: true, characterData: true }); root.addEventListener('resize', later); later(); };
  if (doc.body) start(); else doc.addEventListener('DOMContentLoaded', start, { once: true });
})(typeof window !== 'undefined' ? window : globalThis);

/* BoardGrid, on all four boards (the owner's reference: a strip of games across the top, sortable columns, heat pills):
   1. Game strip. One chip per game (both logos, day and time) above the board; tap one to jump to that game, which
      flashes. Built from the board the page already drew, rebuilt only when the games change.
   2. Sort by gap. The Model column header sorts each table by how far the model sits from the market (largest first);
      tap again to go back to kickoff order. Remembered per sport on this device.
   3. Heat. The model's number is shaded by that gap, so the big disagreements stand out without reading every cell. */
(function (root) {
  const MINUS = /[−–]/g;
  const num = (t) => { const m = String(t || '').replace(MINUS, '-').match(/[+-]?\d+(?:\.\d+)?/); return m ? Number(m[0]) : (/\bPK\b/.test(t || '') ? 0 : null); };
  const prob = (a) => (a < 0 ? -a / (100 - a) : 100 / (100 + a));
  // gap between the model and the market in one side's cell; kind from the column's content
  function gap(modelText, marketText) {
    const a = num(modelText), b = num(marketText);
    if (a == null || b == null) return null;
    const isOdds = Math.abs(a) >= 100 && Math.abs(b) >= 100;
    return isOdds ? Math.abs(prob(a) - prob(b)) * 100 : Math.abs(a - b);
  }
  // heat level 0-3: points for spreads/totals (1.5 / 3 / 5), percentage points of win chance for moneylines (3 / 6 / 10)
  const heat = (g, isOdds) => (g == null ? 0 : isOdds ? (g >= 10 ? 3 : g >= 6 ? 2 : g >= 3 ? 1 : 0) : (g >= 5 ? 3 : g >= 3 ? 2 : g >= 1.5 ? 1 : 0));
  const api = { num, gap, heat };
  root.BoardGrid = api;
  if (typeof module !== 'undefined' && module.exports) module.exports.BoardGrid = api;
  if (!root.document || !root.MutationObserver) return;
  const doc = root.document;
  const HOST = '#boardBody, .odds-boards, #game-list';
  const TABLE = '.bt, .odds-bt, .nb-table';
  const idOf = (el) => el.getAttribute('data-open') || el.getAttribute('data-odds-open') || el.getAttribute('data-game-row');
  const sport = () => ((root.location && root.location.pathname.match(/^\/(nfl|ncaaf|mlb|nhl)\//)) || [])[1] || 'board';
  const SORT_KEY = 'tb_boardSort';
  const readSort = () => { try { return (JSON.parse(root.localStorage.getItem(SORT_KEY) || '{}') || {})[sport()] || 'time'; } catch { return 'time'; } };
  const saveSort = (v) => { try { const all = JSON.parse(root.localStorage.getItem(SORT_KEY) || '{}') || {}; all[sport()] = v; root.localStorage.setItem(SORT_KEY, JSON.stringify(all)); } catch { /* storage blocked */ } };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function colIndex(table, test) { const h = table.tHead && table.tHead.rows[0]; if (!h) return -1; return [...h.cells].findIndex(test); }
  function sideTexts(cell) {
    if (!cell) return [];
    const parts = [...cell.querySelectorAll('.px, .odds-px')];
    return (parts.length ? parts : [cell]).map((p) => (p.querySelector('.num') || p).firstChild ? (p.querySelector('.num') || p).textContent.trim().split(/\s+/)[0] : '');
  }
  function shade(table) {
    const mi = colIndex(table, (c) => c.classList.contains('mdl-th')), ki = colIndex(table, (c) => /^market$/i.test(c.textContent.trim()));
    if (mi < 0 || ki < 0) return;
    for (const tr of table.tBodies[0] ? table.tBodies[0].rows : []) {
      const mc = tr.cells[mi], kc = tr.cells[ki];
      const m = sideTexts(mc)[0], k = sideTexts(kc)[0];
      const g = gap(m, k), lvl = heat(g, Math.abs(num(m) || 0) >= 100);
      tr.dataset.gap = g == null ? '' : String(Math.round(g * 10) / 10);
      if (mc && mc.dataset.heat !== String(lvl)) mc.dataset.heat = String(lvl);
    }
  }
  function sortTable(table, mode) {
    const body = table.tBodies[0]; if (!body) return;
    const rows = [...body.rows];
    rows.forEach((r, i) => { if (r.dataset.ord == null) r.dataset.ord = String(i); });
    const want = rows.slice().sort((a, b) => mode === 'gap' ? ((Number(b.dataset.gap) || -1) - (Number(a.dataset.gap) || -1)) || (a.dataset.ord - b.dataset.ord) : a.dataset.ord - b.dataset.ord);
    if (want.some((r, i) => r !== rows[i])) for (const r of want) body.appendChild(r);
    const th = table.tHead && [...table.tHead.rows[0].cells].find((c) => c.classList.contains('mdl-th'));
    if (th) {
      if (!th.hasAttribute('data-tb-sort')) { th.setAttribute('data-tb-sort', ''); th.tabIndex = 0; th.setAttribute('role', 'button'); }
      const label = mode === 'gap' ? 'Sorted by the model’s gap to the market. Tap for kickoff order.' : 'Sort by the model’s gap to the market';
      if (th.getAttribute('aria-sort') !== (mode === 'gap' ? 'descending' : 'none')) th.setAttribute('aria-sort', mode === 'gap' ? 'descending' : 'none');
      if (th.getAttribute('aria-label') !== label) th.setAttribute('aria-label', label);
      th.classList.toggle('is-sorted', mode === 'gap');
    }
  }

  function chips(host) {
    const seen = new Map();
    for (const el of host.querySelectorAll('tr[data-open], tr[data-odds-open], tr[data-game-row], .br[data-open], .nb-card[data-game-id], .odds-br[data-odds-open]')) {
      const id = idOf(el) || el.getAttribute('data-game-id'); if (!id || seen.has(id)) continue;
      const imgs = [...el.querySelectorAll('img')].filter((i) => !i.classList.contains('lg-d')).slice(0, 2).map((i) => i.getAttribute('src'));
      const b = el.querySelector('.meta b, .odds-bt-st b, .nb-st b');
      // phone cards: the time is one of the footer's own bits (a node whose whole text is a time, Final or Live)
      const TIME = /^(\d{1,2}:\d{2}\s?[AP]M|Final.*|Time TBA|Q\d.*|Half.*|Top \d.*|Bot \d.*|P\d.*|Live)$/i;
      const bit = [...el.querySelectorAll('span, b, small')].find((x) => !x.children.length && TIME.test(x.textContent.replace(/\s+/g, ' ').trim()));
      const time = (b || bit) ? (b || bit).textContent.replace(/\s+/g, ' ').trim() : '';
      let day = '', p = el.closest('.bt-wrap, .odds-btwrap, .nb-wrap, .card, .odds-brd, table') || el;
      for (let s = p.previousElementSibling; s; s = s.previousElementSibling) { const h = s.matches('.win-h, .odds-grp, .nb-grp') ? s : null; if (h) { day = (h.querySelector('h2, h3') || h).textContent.trim().split(/[\s,·]+/)[0]; break; } }
      const live = !!el.querySelector('.hot, .dot, .nb-live, .odds-br-live');
      seen.set(id, { id, imgs, time, day, live });
    }
    return [...seen.values()];
  }
  function strip(host) {
    const list = chips(host);
    let bar = host.querySelector(':scope > .tb-strip');
    if (list.length < 2) { if (bar) bar.remove(); return; }
    const sig = list.map((c) => `${c.id}|${c.time}|${c.live}`).join(',');
    if (bar && bar.dataset.sig === sig) return;
    const html = list.map((c) => `<button type="button" class="tb-chip${c.live ? ' is-live' : ''}" data-tb-go="${esc(c.id)}"><span class="tb-lg">${c.imgs.map((s) => `<img src="${esc(s)}" alt="" loading="lazy">`).join('')}</span><span class="tb-tt"><small>${esc(c.live ? 'Live' : c.day)}</small>${esc(c.live ? '' : c.time)}</span></button>`).join('');
    if (!bar) { bar = doc.createElement('nav'); bar.className = 'tb-strip'; bar.setAttribute('aria-label', 'Jump to a game'); host.prepend(bar); }
    bar.dataset.sig = sig; bar.innerHTML = html;
  }
  let hl = null;   // the game just jumped to: its highlight survives a board repaint for a moment
  const rowsFor = (id) => [...doc.querySelectorAll(`[data-open="${CSS.escape(id)}"], [data-odds-open="${CSS.escape(id)}"], [data-game-row="${CSS.escape(id)}"], [data-game-id="${CSS.escape(id)}"]`)]
    .filter((el) => el.matches('tr, .br, .nb-card, .odds-br') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  function apply() {
    if (hl && Date.now() < hl.until) for (const el of rowsFor(hl.id)) el.classList.add('tb-hl'); else hl = null;
    const mode = readSort();
    for (const t of doc.querySelectorAll(TABLE)) { shade(t); sortTable(t, mode); }
    for (const h of doc.querySelectorAll(HOST)) strip(h);
  }
  let queued = false, busy = false;
  const later = () => { if (queued || busy) return; queued = true; (root.requestAnimationFrame || setTimeout)(() => { queued = false; busy = true; try { apply(); } catch { /* display only */ } finally { setTimeout(() => { busy = false; }, 0); } }); };
  const start = () => { new root.MutationObserver(later).observe(doc.body, { childList: true, subtree: true }); later(); };
  if (doc.body) start(); else doc.addEventListener('DOMContentLoaded', start, { once: true });

  function jump(id) {
    const el = rowsFor(id)[0]; if (!el) return;
    hl = { id, until: Date.now() + 1800 };
    el.scrollIntoView({ behavior: root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    el.classList.remove('tb-hl'); void el.offsetWidth; el.classList.add('tb-hl');
    setTimeout(() => { hl = null; for (const x of doc.querySelectorAll('.tb-hl')) x.classList.remove('tb-hl'); }, 1900);
  }
  doc.addEventListener('click', (e) => {
    const g = e.target.closest && e.target.closest('[data-tb-go]');
    if (g) { e.preventDefault(); e.stopPropagation(); jump(g.getAttribute('data-tb-go')); return; }
    const th = e.target.closest && e.target.closest('th[data-tb-sort]');
    if (th) { e.preventDefault(); saveSort(readSort() === 'gap' ? 'time' : 'gap'); apply(); }
  }, true);
  doc.addEventListener('keydown', (e) => { const th = e.target && e.target.closest && e.target.closest('th[data-tb-sort]'); if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); saveSort(readSort() === 'gap' ? 'time' : 'gap'); apply(); } });
})(typeof window !== 'undefined' ? window : globalThis);
