'use strict';
/* Pick Six — model read + Injury Matrix (server: lib/vas-service.js). NFL only.

   Informational, never a pick. The research model did NOT beat the closing line on spreads, so there is no
   spread read. It did pass a pre-set bar on TOTALS, but only provisionally (not yet significant on modern
   book opens), so the totals read is labelled Provisional and explains itself. It describes where the model
   expects the total to settle from the open; it never says what to bet. The Injury Matrix is display only:
   ESPN's headline list, weighted by each player's snap share and the chance that status means a missed game. */
function modelPanel(g) {
  const m = g && g.model;
  const inj = S.game && S.game.injuries;
  const rows = [];
  if (m && m.status === 'OK' && m.total && m.total.tier && m.total.tier !== 'PASS') {
    const t = m.total, dir = t.direction === 'up' ? 'rise' : 'fall';
    const done = t.currentTotal != null && t.openTotal != null ? (t.currentTotal - t.openTotal) : null;
    const moved = done == null ? '' : Math.abs(done) < 0.25 ? ' It has not moved yet.'
      : (done > 0) === (t.direction === 'up') ? ` It has already moved ${Math.abs(done).toFixed(1)} points that way.` : ' It has moved the other way so far.';
    rows.push(`<div class="mr-read"><span class="tag">${esc(t.label || t.tier)}</span><p><b>Total: the model expects it to ${dir} from ${esc(String(t.openTotal))} (the line when both teams' last games were final), toward about ${esc(t.expected.toFixed(1))}.</b>${esc(moved)}</p>
      <p class="mr-why">${t.tier === 'PROVEN' ? "Provisional: in back-testing this kind of read beat the closing total (+1.96% expected value, 238 games, 2016 and 2023-25), and it held up with nothing refit on the owner's AusSportsBetting openers 2017-22 (+3.47%, 416 games, positive in all 6 seasons). Those openers are untimed (Pinnacle to Feb 2018, bet365 after), so it is not settled yet. Every read is being scored live against the close." : 'Lean: a smaller expected move. Shown for context; this size was not proven in back-testing.'} An estimate, not advice.</p></div>`);
  } else if (m && m.status === 'OK') {
    rows.push(`<p class="mr-quiet">No total read for this game${m.total && m.total.note ? ` (${esc(m.total.note)})` : ''}. Spreads get no read: in back-testing the model did not beat the closing spread.</p>`);
  } else if (m && m.note) {
    rows.push(`<p class="mr-quiet">${esc(m.note)}</p>`);
  }
  const side = (k) => {
    const list = inj && inj[k];
    if (!list || !list.length) return '';
    return `<div class="mr-inj"><div class="k">${esc(g[k].abbr)}</div><table><thead><tr><th>Player</th><th>Pos</th><th>Status</th><th>Snap share</th><th>Miss chance</th><th>Weight</th></tr></thead><tbody>${list.map((r) => `<tr><td>${esc(r.name || '—')}</td><td>${esc(r.pos || '')}</td><td>${esc(r.status || '')}</td><td>${r.share ? Math.round(r.share * 100) + '%' : '—'}</td><td>${Math.round((r.pMiss || 0) * 100)}%</td><td>${r.weight ? r.weight.toFixed(2) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  };
  const matrix = side('away') + side('home');
  if (!rows.length && !matrix) return '';
  return `<div class="gs-sec model-read"><div class="sub-h">Model read <span class="bt-note">Estimates, not picks</span></div>${rows.join('')}${matrix ? `<div class="sub-h" style="margin-top:14px">Injury Matrix <span class="bt-note">ESPN headline list · weighted by snap share</span></div><div class="mr-injs">${matrix}</div>` : ''}</div>`;
}
