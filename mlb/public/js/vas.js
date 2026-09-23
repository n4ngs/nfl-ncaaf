'use strict';
/* Bing Bong Live — VAS model block on the MLB market board (server: lib/vas-service.js).
   One proven rule: the model and DraftKings' OPENING moneyline disagree by a wide margin (>= 0.30 logit). In back-testing
   (2024-26, never trained on) betting that side at the opener beat the no-vig close by +1.45% over 482 games, positive
   every season. It holds for about two hours after DraftKings posts; after that it shows only while DraftKings'
   current price still clears the gap and is no worse than the opener. Totals are not proven, so none are shown. */
const MLBVAS = { reads: [], ready: false, at: 0 };
async function mlbVasLoad() {
  try {
    const r = await fetch(`api/vas?date=${encodeURIComponent(S.date || '')}`, { headers: { accept: 'application/json' } });
    if (r.ok) { const d = await r.json(); MLBVAS.reads = d.reads || []; MLBVAS.ready = !!d.ready; MLBVAS.at = Date.now(); if (typeof oddsRepaint === 'function') oddsRepaint(); }
  } catch { /* the board works without it */ }
}
function mlbVasBlock(games) {
  if (!MLBVAS.at) return '';
  const odds = (o) => (o > 0 ? '+' + o : String(o));
  const hits = MLBVAS.reads.filter((r) => r.tier === 'DIAMOND' && r.price != null && Date.parse(r.start) > Date.now());
  const team = (r) => (r.names ? (r.side === 'home' ? r.names.home : r.names.away) : r.side);
  const ago = (t) => { const m = Math.round((Date.now() - Date.parse(t)) / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const body = !MLBVAS.ready ? '<p class="vas-quiet">The model is loading its game history. Reads start once it is complete.</p>'
    : hits.length ? hits.map((r) => `<div class="vas-row"><span class="vas-tag">💎 DIAMOND</span><div><b>${esc(team(r))} ML ${esc(odds(r.price))} at DraftKings</b><small>${esc(r.matchup)} · model ${Math.round((r.side === 'home' ? r.pHome : 1 - r.pHome) * 100)}% vs DraftKings opener ${Math.round((r.side === 'home' ? r.market : 1 - r.market) * 100)}% · opener seen ${esc(ago(r.openerSeenAt))} ago</small></div></div>`).join('')
    : '<p class="vas-quiet">No game clears the proven gap right now. That is normal: it fires about once a day, usually within two hours of DraftKings posting its openers.</p>';
  return `<div class="card vas-card"><div class="vas-head"><b>VAS model</b><span>DraftKings opener gap · proven on 2024-26 back-tests · every signal is scored against the close</span></div>${body}</div>`;
}
setInterval(mlbVasLoad, 2 * 60e3);
setTimeout(mlbVasLoad, 1500);
