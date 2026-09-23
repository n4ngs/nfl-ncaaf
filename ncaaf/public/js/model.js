'use strict';
/* Hook & Ladder — opener read (server: lib/vas-service.js). NCAAF only.

   Informational, never prescriptive (app rule 1). Describes one thing the market is doing: a Nevada book whose
   OPENING spread sits off where the other books opened, and still hanging that opener. In back-testing on the
   2023-25 seasons, openers like that tended to move toward the pack. Labelled Thin (rule 2) because historical
   opener timestamps can't be verified; the app's own recorded openers are now scoring every read against the
   close, which is what will firm it up or retire it. Fundamentals-only reads did not beat the close and are not shown. */
function modelPanel(g) {
  const m = g && g.model;
  if (!m || (m.status !== 'OK' && !m.note)) return '';
  const name = (k) => (S.books || []).find((b) => b.key === k)?.name || k;
  const pts = (v) => { const r = Math.round(v * 2) / 2; return r === 0 ? 'PK' : (r > 0 ? '+' : '') + r; };
  const team = (side) => g[side]?.abbr || side;
  const spread = (side, homeSpread) => `${team(side)} ${pts(side === 'home' ? homeSpread : -homeSpread)}`;
  let body;
  if (m.status === 'OK' && m.reads && m.reads.length) {
    body = m.reads.map((r) => {
      const label = r.tier === 'THIN' ? 'Thin' : 'Weak';
      const why = r.tier === 'THIN'
        ? 'Thin: openers this far from the pack moved toward it in 2023-25 testing, but when books posted their openers can\'t be verified historically. Being checked live against the close.'
        : 'Weak: a smaller gap than the tested threshold; context, not a tested pattern.';
      return `<div class="mr-read"><span class="tag">${label}</span><p><b>${esc(name(r.book))} opened ${esc(spread(r.side, r.bookOpen))}; the other books opened around ${esc(spread(r.side, r.consensusOpen))}.</b> It is still hanging that opener.</p><p class="mr-why">${esc(why)} An estimate, not advice.</p></div>`;
    }).join('');
  } else {
    body = `<p class="mr-quiet">${esc(m.note || `No Nevada book is sitting off the opening consensus (${m.books || 0} books opened).`)} Model fundamentals alone did not beat the closing line in testing, so they are not shown.</p>`;
  }
  return `<div class="gs-sec model-read"><div class="sub-h">Opener read <span class="bt-note">Estimates, not picks</span></div>${body}</div>`;
}
