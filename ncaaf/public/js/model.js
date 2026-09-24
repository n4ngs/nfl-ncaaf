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
  return `${fairPanel(g, m.fair, spread, team)}<div class="gs-sec model-read"><div class="sub-h">Opener read <span class="bt-note">Estimates, not picks</span></div>${body}</div>${movePanel(g, m.move, spread, team)}`;
}

/* The model's own number (research model ncaaf-vas-portable-v1, lib/vas-service.js fairRead): each team's win chance
   from the model margin (normal, sigma 16), next to the market's no-vig win chance, and a LEAN when the model's win %
   beats the market's by 6+ points. Fundamentals-only numbers did not beat the closing line in 2023-25 testing, so
   every lean is a Weak read, never green, and the wording is "lean", never a pick. Leans are scored in their own
   record on the Proof page. */
const pctTxt = (p) => `${(p * 100).toFixed(1)}%`;
function modelLean(g) {
  const f = g && g.model && g.model.fair;
  return f && f.lean ? f.lean : null;
}
function fairPanel(g, f, spread, team) {
  if (!f || !f.win) return '';
  const nm = (side) => g[side]?.short || team(side);
  const fav = f.margin >= 0 ? 'home' : 'away';
  const banner = '';   // the lean banner leads the game sheet (leanBanner, sheets.js)
  const mk = f.market ? `<li><span>Market, no-vig (${esc(f.market.source)})</span><b>${esc(team('away'))} ${pctTxt(f.market.away)} · ${esc(team('home'))} ${pctTxt(f.market.home)}</b></li>` : '';
  const side = f.side ? `<li><span>Model side vs the spread (${esc(spread('home', f.side.marketSpread))})</span><b>${esc(spread(f.side.side, f.side.side === 'home' ? f.side.line : -f.side.line))} · Weak read</b></li>` : '';
  const ctx = [];
  if (f.newStaff) ctx.push(`<li><span>New head coach (${esc(f.newStaff.teams.map(nm).join(' and '))}): faster in-season updating</span><b>${Math.abs(f.newStaff.pts).toFixed(1)} pt toward ${esc(team(f.newStaff.pts > 0 ? 'home' : 'away'))}</b></li>`);
  if (f.letdown) ctx.push(`<li><span>Letdown / bounce-back spot</span><b>${Math.abs(f.letdown.pts).toFixed(1)} pt toward ${esc(team(f.letdown.pts > 0 ? 'home' : 'away'))}</b></li>`);
  const notes = [f.newStaff && f.newStaff.note, f.letdown && f.letdown.note].filter(Boolean).map((t) => `<p class="mr-why">${esc(t)}</p>`).join('');
  const venue = f.venue ? `<p class="mr-why">Home field at ${esc(g.venue?.name || nm('home'))}: closing lines have priced it at about ${f.venue.pts.toFixed(1)} pts (league average ${f.venue.league.toFixed(1)}). ${esc(f.venue.note)}</p>` : '';
  const base = f.baseRate ? `<p class="mr-why">${esc(f.baseRate.note)}</p>` : '';
  return `<div class="gs-sec model-read"><div class="sub-h">Model number <span class="bt-note">Estimates, not picks</span></div>${banner}`
    + `<p>Model: <b>${esc(nm(fav))} by ${Math.abs(f.margin).toFixed(1)}</b> (fair line ${esc(spread('home', f.fairLine))}).</p>`
    + `<ul class="mv-list"><li><span>Model win chance</span><b>${esc(team('away'))} ${pctTxt(f.win.away)} · ${esc(team('home'))} ${pctTxt(f.win.home)}</b></li>${mk}${side}${ctx.join('')}</ul>`
    + notes + venue + base
    + `<p class="mr-why">Win chance = the model margin on a normal curve (sigma ${f.sigma}). Fundamentals-only numbers did not beat the closing line in 2023-25 testing. Not advice.</p></div>`;
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
    + left + injuryList(mv, team) + flowLine(mv, team)
    + (ifs ? `<p class="mr-why">Injury news it would react to (college teams don't publish injury reports, so this isn't assumed):</p><ul class="mv-list">${ifs}</ul>` : '')
    + `<p class="mr-why">In 2023-25 testing these inputs explained about 8% of how lines move; the rest is information the model doesn't have. Not advice.</p></div>`;
}

// Availability report the owner entered (lib/ncaaf-player-status.json): status as a chance he sits, valued only for
// backs and receivers (share of carries / catches x the tested coefficient). Other positions are listed, not valued.
function injuryList(mv, team) {
  const list = (mv.injuries || []);
  if (!list.length) return '';
  const toward = (pts) => (Math.abs(pts) < 0.05 ? 'under 0.1 pt' : `${Math.abs(pts).toFixed(1)} pt toward ${team(pts > 0 ? 'home' : 'away')}`);
  const rows = list.map((p) => `<li><span>${esc(team(p.side))} ${esc(p.pos)} ${esc(p.name)}: ${esc(p.status)}${p.valued ? ` (${Math.round(p.pOut * 100)}% out x ${Math.round(p.share * 100)}% of ${p.pos === 'RB' ? 'carries' : 'catches'})` : ''}${p.note ? ` <small>${esc(p.note)}</small>` : ''}</span><b>${p.valued ? esc(toward(p.pts)) : p.pOut ? 'not valued' : 'no effect'}</b></li>`).join('');
  return `<p class="mr-why">Injury / availability report (entered by hand; college football has no official feed). Only backs and receivers have a tested value:</p><ul class="mv-list">${rows}</ul>`;
}
// Public splits vs the move: labelled, not in the model (no historical splits exist to test it; recorded from now on).
function flowLine(mv, team) {
  const f = mv.flow;
  if (!f) return '';
  const pubSide = f.homeTix >= 50 ? 'home' : 'away', pub = pubSide === 'home' ? f.homeTix : 100 - f.homeTix;
  const ml = f.mlHomeMoney != null ? ` Moneyline money: ${100 - f.mlHomeMoney}% on ${esc(team('away'))}.` : '';
  const what = f.rlm ? ` <b>Reverse line move:</b> ${pub}% of spread tickets are on ${esc(team(pubSide))}, yet the line moved toward ${esc(team(f.toward))}.` : '';
  return `<p class="mr-why">${esc(f.label)}:${what} Spread tickets ${pub}% on ${esc(team(pubSide))}${f.homeMoney != null ? `, money ${pubSide === 'home' ? f.homeMoney : 100 - f.homeMoney}%` : ''}.${ml} ${esc(f.note)}</p>`;
}

// ------------------------------------------------------------ lean prominence (numbers unchanged: display only)
// Team colour for a lean, never green (green is reserved for a winning ticket) and never too dark on the navy board.
function leanColor(t) {
  const hsl = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return null; const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn; if (!d) return { h: 0, s: 0, l };
    const s2 = d / (1 - Math.abs(2 * l - 1)); let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; return { h, s: s2, l }; };
  for (const c of [t && t.color, t && t.alt]) { const x = hsl(c); if (x && !(x.h > 70 && x.h < 170 && x.s > 0.2) && x.l >= 0.22 && x.s > 0.15) return '#' + String(c).replace('#', ''); }
  return 'var(--ink)';
}
const signed = (v) => (v === 0 ? 'PK' : (v > 0 ? '+' : '') + v);
function modelLineTxt(g, f) { const fav = f.margin >= 0 ? 'home' : 'away'; return `${g[fav].abbr} ${Math.abs(f.margin) < 0.05 ? 'PK' : '−' + Math.abs(f.margin).toFixed(1)}`; }
// Game sheet, first thing under the header: the model lean with the team's colours, the two win chances, the side.
function leanBanner(g) {
  if (g && g.model && g.model.pin && isPre(g)) return pinCard(g, 'sheet');
  const f = g && g.model && g.model.fair, L = f && f.lean;
  if (!L) return '';
  const t = g[L.side], c = leanColor(t);
  return `<div class="gs-sec lean-top" style="--lc:${c}">${logo(t, 'logo lean-logo')}<div><p class="lean-h">Model lean: ${esc(t.short || t.abbr)}</p>`
    + `<p>More likely to win than the odds say: <b>${pctTxt(L.model)}</b> model vs <b>${pctTxt(L.market)}</b> market${Number.isFinite(L.spread) ? ` · ${esc(t.short || t.abbr)} ${esc(signed(L.spread))}` : ''} · <span class="tag">Weak read</span></p>`
    + `${winBar(g, f)}<p class="mr-why">${esc(L.caveat)} <button type="button" class="linkish" data-leans>See the model's record</button></p></div></div>`;
}
function winBar(g, f) {
  if (!f.market) return '';
  const row = (label, a) => `<div class="wb-row"><span>${label}</span><div class="wb"><i style="width:${(a * 100).toFixed(1)}%;background:${leanColor(g.away)}"></i><i style="background:${leanColor(g.home)}"></i></div><span class="num">${esc(g.away.abbr)} ${Math.round(a * 100)}% · ${esc(g.home.abbr)} ${Math.round((1 - a) * 100)}%</span></div>`;
  return `<div class="wbars">${row('Model', f.win.away)}${row('Market', f.market.away)}</div>`;
}
// Wide board: the "Model" column. Narrow board: a chip under the teams. Both read the cached model read only.
function modelCell(g) {
  const f = isPre(g) && g.model && g.model.fair;
  if (!f || !f.win) return '<span class="faint">—</span>';
  const L = f.lean;
  const pinMark = g.model.pin ? ' <span class="tag pin-tag">Pinned</span>' : '';
  if (!L) return `<span class="mdl-q">${esc(modelLineTxt(g, f))}</span>${pinMark}`;
  const t = g[L.side];
  return `<div class="mdl" style="--lc:${leanColor(t)}"><span class="mdl-line">${esc(modelLineTxt(g, f))}${pinMark}</span><span class="mdl-lean">${logo(t, 'logo mdl-logo')}Lean: ${esc(t.abbr)}</span><span class="mdl-n num">${Math.round(L.model * 100)}% vs ${Math.round(L.market * 100)}%</span><span class="tag">Weak</span></div>`;
}
function modelChip(g) {
  const f = isPre(g) && g.model && g.model.fair;
  if (!f || !f.win) return '';
  const L = f.lean;
  const pinMark = g.model.pin ? '<span class="tag pin-tag">Pinned</span>' : '';
  if (!L) return `<div class="br-mdl q" data-open="${g.id}">Model ${esc(modelLineTxt(g, f))}${pinMark}</div>`;
  const t = g[L.side];
  return `<div class="br-mdl" data-open="${g.id}" style="--lc:${leanColor(t)}">${logo(t, 'logo mdl-logo')}<b>Lean: ${esc(t.short || t.abbr)}</b><span class="num">${pctTxt(L.model)} vs ${pctTxt(L.market)}</span>${Number.isFinite(L.spread) ? `<span class="num">${esc(t.abbr)} ${esc(signed(L.spread))}</span>` : ''}<span class="tag">Weak</span>${pinMark}</div>`;
}
// Top of the board: the week's biggest model-vs-market win-chance gap(s). Same numbers as the game sheet.
function featuredLeans(games) {
  const pinned = games.filter((g) => isPre(g) && g.model && g.model.pin);
  const pinHtml = pinned.length ? `<div class="card lean-feat">${pinned.map((g) => pinCard(g, 'board')).join('')}</div>` : '';
  const list = games.filter((g) => isPre(g) && g.model && g.model.fair && g.model.fair.lean && !g.model.pin).sort((a, b) => b.model.fair.lean.gap - a.model.fair.lean.gap);
  if (!list.length) return pinHtml;
  return pinHtml + featuredModelLean(list);
}
function featuredModelLean(list) {
  const top = list.filter((g) => g.model.fair.lean.gap >= list[0].model.fair.lean.gap - 0.005).slice(0, 2);
  return `<div class="card lean-feat">${top.map((g) => { const f = g.model.fair, L = f.lean, t = g[L.side];
    return `<div class="lf" style="--lc:${leanColor(t)}"><div class="lf-h">${logo(t, 'logo lean-logo')}<div><small>Featured model lean · ${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</small><p class="lean-h">Model lean: ${esc(t.short || t.abbr)}${Number.isFinite(L.spread) ? ` <span class="num">${esc(t.abbr)} ${esc(signed(L.spread))}</span>` : ''} <span class="tag">Weak read</span></p></div></div>`
      + `${winBar(g, f)}<p class="mr-why">${esc(L.caveat)}</p><div class="lf-a"><button type="button" class="btn ghost" data-open="${g.id}">Open game</button><button type="button" class="linkish" data-leans>Model leans: record</button></div></div>`; }).join('')}</div>`;
}
// Public record of every lean the banner showed (GET api/model/leans). Guests see it; nothing owner-related in it.
async function openLeanRecord() {
  S.sheet = { kind: 'leans' };
  $('#dlgBody').innerHTML = '<div class="empty"><b>Loading…</b></div>';
  showSheet('leans', true);
  let d;
  try { const r = await fetch('api/model/leans', { credentials: 'same-origin' }); d = await r.json(); } catch (e) { $('#dlgBody').innerHTML = `<div class="empty"><b>Couldn't load the record</b>${esc(e.message)}</div>`; return; }
  const T = d.totals || {}, pc = (v, n = 1) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(n)}`);
  const rows = (d.rows || []).map((r) => `<tr><td class="l">${esc(r.opp && !r.home ? `${r.team} at ${r.opp}` : `${r.opp} at ${r.team}`)}<br><small>${esc(new Date(r.at).toLocaleString())}</small></td>`
    + `<td><b>${esc(r.team)}</b> <span class="tag">${esc(r.label === 'WEAK' ? 'Weak' : r.label)}</span></td><td class="num">${pctTxt(r.modelWin)} vs ${pctTxt(r.marketWin)}</td>`
    + `<td class="num">${r.spreadLine != null ? `${esc(signed(r.spreadLine))} (${esc(fmtOdds(r.spreadPrice))})` : '—'}<br><small>ML ${esc(fmtOdds(r.mlPrice))}</small></td>`
    + `<td class="num">${r.closeSpread != null ? esc(signed(r.closeSpread)) : '—'}<br><small>${r.clvEv != null ? `CLV ${pc(r.clvEv * 100)}%` : 'at kickoff'}</small></td>`
    + `<td>${r.result ? `${esc(r.result)}${r.score ? ` <small>${r.score.away}-${r.score.home}</small>` : ''}<br><small>${esc(r.cover === 'covered' ? 'covered' : r.cover === 'push' ? 'push' : r.cover ? 'did not cover' : '')}</small>` : '<span class="faint">pending</span>'}</td></tr>`).join('');
  $('#dlgBody').innerHTML = `<h2 id="dlgTitle">Model leans: record</h2>
    <p class="lede">Every "Model lean" the board has shown: a game where the model's win chance for a team beat the market's no-vig win chance by ${Math.round((d.threshold || 0.06) * 100)}+ points. Each one is recorded, with its price, the moment it first appears, and is never edited.</p>
    <div class="lr-tot"><div><b class="num">${T.won ?? 0}-${T.lost ?? 0}</b><small>won-lost (${T.settled ?? 0} settled)</small></div><div><b class="num">${T.coverN ? Math.round(T.covered / T.coverN * 100) + '%' : '—'}</b><small>covered (${T.covered ?? 0} of ${T.coverN ?? 0})</small></div><div><b class="num">${pc(T.avgClvEvPct)}%</b><small>avg CLV vs close (${T.closed ?? 0})</small></div><div><b class="num">${T.leans ?? 0}</b><small>leans shown</small></div></div>
    <p class="mr-why">${esc(d.caveat || '')}</p>
    ${rows ? `<div class="bt-wrap"><table class="bt lr"><thead><tr><th class="l">Game</th><th>Lean</th><th>Model vs market</th><th>Spread (price)</th><th>Close</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="mr-quiet">No leans recorded yet.</p>'}
    ${(d.pinned || []).length ? `<h3 style="margin-top:22px">Pinned <span class="tag pin-tag">Not the model</span></h3><p class="mr-why">${esc(d.pinnedNote || '')}</p><div class="bt-wrap"><table class="bt lr"><thead><tr><th class="l">Game</th><th>Pinned team</th><th>Model vs market when pinned</th><th>Close</th><th>Result</th></tr></thead><tbody>${d.pinned.map((r) => `<tr><td class="l">${esc(r.matchup || r.gid)}<br><small>${esc(r.at ? new Date(r.at).toLocaleString() : '')}</small></td><td><b>${esc(r.team)}</b></td><td class="num">${r.entry && r.entry.modelWin != null ? `${pctTxt(r.entry.modelWin)} vs ${pctTxt(r.entry.marketWin)}` : '—'}</td><td class="num">${r.close ? esc(signed(r.close.spread)) : '—'}</td><td>${r.result ? `${esc(r.result)}${r.cover ? `<br><small>${esc(r.cover === 'covered' ? 'covered' : r.cover === 'push' ? 'push' : 'did not cover')}</small>` : ''}` : '<span class="faint">pending</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
document.addEventListener('click', (ev) => { const t = ev.target.closest && ev.target.closest('[data-leans]'); if (!t) return; ev.preventDefault(); ev.stopPropagation(); openLeanRecord(); }, true);

// ------------------------------------------------------------ owner pins (the owner's call, tagged "Pinned")
// The headline is the owner's pick. The line under it is ALWAYS what the model computes for this game (it can say
// "no lean" or lean the other way). Pins are kept out of the model record (own section in the public record).
function pinModelLine(g, P) {
  const M = P.model || {}, t = g[M.side] || g[P.side], nm = t.short || t.abbr;
  if (M.kind === 'lean') return `Model lean: ${esc(nm)} · ${pctTxt(M.model)} vs ${pctTxt(M.market)} market${Number.isFinite(M.spread) ? ` · ${esc(nm)} ${esc(signed(M.spread))}` : ''} · <span class="tag">Weak</span>`;
  if (M.kind === 'above') return `Model: ${esc(nm)} ${pctTxt(M.model)} vs ${pctTxt(M.market)} market, under the ${Math.round(M.threshold * 100)}-point lean threshold · no lean`;
  return `Model: no lean${Number.isFinite(M.model) && Number.isFinite(M.market) ? ` (${esc(nm)} ${pctTxt(M.model)} vs ${pctTxt(M.market)} market)` : ''}`;
}
function pinCard(g, where = 'sheet') {
  const P = g && g.model && g.model.pin;
  if (!P || !isPre(g)) return '';
  const t = g[P.side], f = g.model.fair;
  const ctl = where === 'sheet' && typeof isOwner === 'function' && isOwner() && S.me?.shared ? pinControl(g) : '';
  return `<div class="${where === 'sheet' ? 'gs-sec ' : ''}lean-top pin-card" style="--lc:${leanColor(t)}">${logo(t, 'logo lean-logo')}<div>`
    + `<p class="lean-h">${esc(t.short || t.abbr)} lean <span class="tag pin-tag">Pinned</span></p>`
    + `<p class="pin-model">${pinModelLine(g, P)}</p>${f ? winBar(g, f) : ''}`
    + `<p class="mr-why">Pinned by the board owner: an opinion, not the model. The model line above is computed on its own. Fundamentals-only leans have not beaten the closing line in 2023-25 testing. Not advice.${where === 'board' ? ` <button type="button" class="linkish" data-open="${g.id}">Open game</button>` : ''} <button type="button" class="linkish" data-leans>See the record</button></p>${ctl}</div></div>`;
}
function pinControl(g) {
  const cur = g.model && g.model.pin && g.model.pin.side;
  return `<div class="pin-ctl" role="group" aria-label="Owner pin">${['away', 'home'].map((sd) => `<button type="button" class="chip" data-pin="${g.id}|${sd}" aria-pressed="${cur === sd}">Pin ${esc(g[sd].abbr)}</button>`).join('')}<button type="button" class="chip" data-pin="${g.id}|" ${cur ? '' : 'disabled'}>Unpin</button></div>`;
}
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest && ev.target.closest('[data-pin]'); if (!t) return;
  ev.preventDefault(); ev.stopPropagation();
  const [gid, side] = t.dataset.pin.split('|');
  try { await fetch('api/model/pin', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gid, side: side || null }) }); toastText && toastText(side ? 'Pinned.' : 'Pin removed.'); } catch (e) { /* offline */ }
}, true);
