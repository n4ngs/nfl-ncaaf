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
  return `<div class="gs-sec model-read"><div class="sub-h">Opener read <span class="bt-note">Estimates, not picks</span></div>${body}</div>${movePanel(g, m.move, spread, team)}`;
}

/* Why the line moved: the market's move from the opening consensus to now, next to the part the model can explain
   (its own number vs the opener, last week's result vs the spread, the starting QB, a lead back/receiver ruled out)
   and what is left over (news or money the model can't see). Research: these explain about 8 % of line-move
   variance in 2023-25; most moves are information the model does not have. */
function movePanel(g, mv, spread, team) {
  if (!mv || !Number.isFinite(mv.open)) return '';
  const toward = (pts) => (Math.abs(pts) < 0.05 ? 'no move' : `${Math.abs(pts).toFixed(1)} pt toward ${team(pts > 0 ? 'home' : 'away')}`);
  const src = mv.openSource ? ` <span class="bt-note">opener: ${esc(mv.openSource)}</span>` : '';
  const moved = Number.isFinite(mv.actual) ? `Opened ${esc(spread('home', mv.open))}, now ${esc(spread('home', mv.now))}: <b>${esc(toward(mv.actual))}</b>.${src}` : `Opened ${esc(spread('home', mv.open))}.${src}`;
  const rows = mv.parts.filter((p) => Math.abs(p.pts) >= 0.05).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))
    .map((p) => `<li><span>${esc(p.label)}</span><b>${esc(toward(p.pts))}</b></li>`).join('');
  const left = Number.isFinite(mv.unexplained) && Math.abs(mv.unexplained) >= 0.25
    ? `<p class="mr-why">Left unexplained: ${esc(toward(mv.unexplained))}. That is news or money the model can't see (an injury report, weather, a big bettor).</p>` : '';
  const ifs = (mv.whatIf || []).filter((w) => w.name).map((w) => `<li><span>If ${esc(team(w.side))} ${esc(w.role)} ${esc(w.name)} (${Math.round(w.share * 100)}% of ${w.role === 'lead back' ? 'carries' : 'catches'}) is ruled out</span><b>${esc(toward(w.pts))}</b></li>`).join('');
  return `<div class="gs-sec model-read"><div class="sub-h">Why the line moved <span class="bt-note">Estimate</span></div><p>${moved} Model number: ${esc(team(mv.margin >= 0 ? 'home' : 'away'))} by ${Math.abs(mv.margin).toFixed(1)}.</p>`
    + (rows ? `<p class="mr-why">What the model can see (expected move ${esc(toward(mv.predicted))}):</p><ul class="mv-list">${rows}</ul>` : '')
    + left + (ifs ? `<p class="mr-why">Injury news it would react to (college teams don't publish injury reports, so this isn't assumed):</p><ul class="mv-list">${ifs}</ul>` : '')
    + `<p class="mr-why">In 2023-25 testing these inputs explained about 8% of how lines move; the rest is information the model doesn't have. Not advice.</p></div>`;
}
