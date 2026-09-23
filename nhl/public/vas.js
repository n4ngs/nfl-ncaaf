'use strict';
// Goalie Matrix + VAS badges for the NHL board. Reads the `vas` object the server attaches to each game.
// DIAMOND is the proven tier (beat the no-vig close on the 2024-26 holdout); GOLD is a lean, not proven.
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const odds = o => Number.isFinite(o) ? (o > 0 ? '+' + o : String(o)) : '—';
  const pct = p => Number.isFinite(p) ? Math.round(p * 100) + '%' : '—';
  const time = s => { try { return new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
  const TIER = { DIAMOND: '💎 DIAMOND', GOLD: '🥇 GOLD', PASS: '⛔ PASS' };
  const bookName = key => (typeof NH !== 'undefined' && NH.books.find(b => b.key === key)?.name) || key;

  function goalie(v, side, g) {
    const x = v.goalies && v.goalies[side]; if (!x || !x.id) return '<span class="vm-muted">Unknown</span>';
    const conf = v.confirmed && v.confirmed[side];
    const status = conf ? (conf === x.id ? '<span class="vm-ok" title="Confirmed by the NHL">✅</span>' : '<span class="vm-bad" title="NHL confirmed a different starter">⚠️</span>')
      : '<span class="vm-muted" title="Projected from recent starts">⏳</span>';
    const flags = [x.backToBack ? '<span class="vm-flag" title="Started last night">B2B</span>' : '', x.share10 < 0.6 ? '<span class="vm-flag" title="Split crease: started under 60% of the last 10">Split</span>' : ''].join('');
    const gs = Number.isFinite(x.gsax100) ? (x.gsax100 > 0 ? '+' : '') + x.gsax100.toFixed(2) : '—';
    return `<span class="vm-g"><strong>${esc(x.name || '#' + x.id)}</strong> ${status}${flags}<small>GSAx/100 ${gs} · ${Math.round((x.share10 || 0) * 10)}/10 starts</small></span>`;
  }
  function play(v, g) {
    if (!v.tier || v.tier === 'PASS' || !v.entry) return `<span class="vm-muted">${esc(v.reason || 'No edge')}</span>`;
    const team = v.side === 'home' ? g.home.abbr : g.away.abbr;
    return `<strong>${esc(team)} ML ${odds(v.entry.odds)}</strong><small>best at ${esc(bookName(v.entry.book))} · model ${pct(v.side === 'home' ? v.pHome : 1 - v.pHome)} vs market ${pct(v.market && (v.side === 'home' ? v.market.prob : 1 - v.market.prob))}</small>`;
  }
  function badge(g) {
    const v = g.vas; if (!v || (v.tier !== 'DIAMOND' && v.tier !== 'GOLD') || !v.entry) return '';
    const team = v.side === 'home' ? g.home.abbr : g.away.abbr;
    return `<div class="vas-badge vas-${v.tier.toLowerCase()}" title="${v.tier === 'DIAMOND' ? 'Proven tier: beat the closing line on the 2024-26 holdout' : 'Lean: not proven on its own'}">${TIER[v.tier]} · ${esc(team)} ML ${odds(v.entry.odds)} <span>${esc(bookName(v.entry.book))}</span></div>`;
  }
  function render(games) {
    const el = document.getElementById('goalie-matrix'); if (!el) return;
    const rows = games.filter(g => !g.final && g.vas && g.vas.status === 'OK');
    const off = games.find(g => g.vas && g.vas.status !== 'OK');
    let html;
    if (!rows.length) {
      html = `<div class="vm-empty"><strong>Goalie Matrix</strong><span>${esc(off ? off.vas.reason : 'No upcoming regular-season games on this slate.')} Signals start with the regular season.</span></div>`;
    } else {
      html = `<div class="vm-head"><div><strong>Full-slate Goalie Matrix</strong><span>Projected starters, GSAx and the VAS line-movement signal. 💎 = proven tier · 🥇 = lean · ⏳ projected · ✅ confirmed</span></div></div>
      <div class="vm-scroll"><table class="vm-table"><thead><tr><th>Time</th><th>Matchup</th><th>Away goalie</th><th>Home goalie</th><th>Goalie edge</th><th>VAS</th><th>Play</th></tr></thead><tbody>` +
        rows.map(g => { const v = g.vas; const edgeTeam = v.goalieEdge > 0 ? g.home.abbr : g.away.abbr;
          return `<tr class="vm-${(v.tier || 'pass').toLowerCase()}"><td>${esc(time(g.start))}</td><td><strong>${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</strong></td>
          <td>${goalie(v, 'away', g)}</td><td>${goalie(v, 'home', g)}</td>
          <td>${Math.abs(v.goalieEdge) < 0.05 ? 'Even' : esc(edgeTeam) + ' +' + Math.abs(v.goalieEdge).toFixed(2)}</td>
          <td class="vm-tier">${TIER[v.tier] || '—'}</td><td class="vm-play">${play(v, g)}</td></tr>`; }).join('') + '</tbody></table></div>';
    }
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }
  window.NHVas = { badge, render };
})();
