'use strict';
/* Bing Bong Live — the group: share links on the owner's side, a name on a friend's.

   A friend never types a code. The owner makes one link per person (or one for a whole crew), sends it, and
   opening it lets that phone in for good. Turning a link off locks out only the phones that used it.

   Guests see the same board and their own tickets, never each other's and never the owner's. Whoever runs the
   board can see the group's, and the guest's own Tools card says so in one line — keep it there.

   Every top-level name here starts with grp, except the entry points grpToolsCard / grpToolsPaint. */

const GRP = { links: null, people: null, loading: false, timer: 0 };

const grpIsOwner = () => S.me?.role !== 'guest';
const grpShared = () => !!S.me?.shared;
const grpOwnerLabel = () => (S.me?.owner ? S.me.owner : 'the person who runs this board');
const grpUrl = (t) => `${GRP.links?.base || location.origin}/j/${t}`;

// ------------------------------------------------------------ the Tools card
function grpToolsCard() {
  if (!grpShared()) return '';
  if (!grpIsOwner()) {
    return `<section class="card mlbt-card" aria-labelledby="grpYouH">
      <h3 id="grpYouH">You on this board</h3>
      <p>Your bet log is yours — the other people here can't see it. Whoever runs the board can.</p>
      <div class="mlbt-fgrid">
        <label class="mlbt-fld">Your name here<input class="mlbt-inp" id="grpName" autocomplete="off" maxlength="24" value="${esc(S.me?.name || '')}"></label>
      </div>
      <button type="button" class="bets-btn ghost" data-grp-name>Save</button>
      <p class="grp-err" id="grpErr" role="alert"></p>
    </section>`;
  }
  return `<section class="card mlbt-card grp-card" aria-labelledby="grpH">
    <h3 id="grpH">The group</h3>
    <p>Everyone on your board, what they have running, and the links that let them in.</p>
    <div id="grpSummary" class="grp-sum-s"></div>
    <button type="button" class="bets-btn" data-grp-open>Open the group</button>
  </section>`;
}

function grpToolsPaint() {
  const box = $('#grpSummary');
  if (!box || !grpIsOwner() || !grpShared()) return;
  if (!GRP.people && !GRP.loading) grpLoad();
  const P = GRP.people || [];
  const open = P.reduce((n, x) => n + x.open.length, 0);
  const html = P.length
    ? `<b>${P.length === 1 ? '1 person' : `${P.length} people`}</b> · ${open ? `${open} open ticket${open === 1 ? '' : 's'}` : 'nothing running'}`
    : '<b>Nobody yet</b> · make a link and send it';
  if (box.dataset.key !== html) { box.innerHTML = html; box.dataset.key = html; }
}

async function grpLoad() {
  GRP.loading = true;
  try {
    const [g, l] = await Promise.all([
      fetch('api/group').then((r) => (r.ok ? r.json() : { people: [] })),
      fetch('api/invites').then((r) => (r.ok ? r.json() : { base: '', links: [] })),
    ]);
    GRP.people = g.people || [];
    GRP.links = l;
  } catch { GRP.people = GRP.people || []; GRP.links = GRP.links || { base: '', links: [] }; }
  GRP.loading = false;
  grpToolsPaint();
  if (S.dlgKind === 'group') grpSheet();
}

// ------------------------------------------------------------ the group sheet (the owner's screen)
function grpSheet() {
  const P = GRP.people || [];
  const open = P.reduce((n, x) => n + x.open.length, 0);
  const atRisk = P.reduce((n, x) => n + x.open.reduce((t, b) => t + (b.stake || 0), 0), 0);
  const net = P.reduce((n, x) => n + (x.net || 0), 0);
  const here = P.filter((x) => x.last && serverNow() - x.last < 15 * 60e3).length;
  const stat = (k, v, sub, cls = '') => `<div class="grp-stat"><span class="grp-stat-k">${esc(k)}</span><b class="${cls}">${esc(v)}</b><span class="grp-stat-s">${esc(sub)}</span></div>`;
  openSheet(`<h2 id="dlgTitle">The group</h2>
    <p class="odds-lede">Everyone who joined on a link, and what they have running. They see the same board and their own tickets — not each other's, and not yours.</p>
    <div class="grp-sum">
      ${stat('On the board', String(P.length), here ? `${here} here now` : 'nobody on right now')}
      ${stat('Open tickets', String(open), open ? `${betsFmtMoney(atRisk)} at risk` : 'nothing running')}
      ${stat('Group net', betsFmtMoney(net, true), 'settled bets only', net > 0 ? 'w' : net < 0 ? 'l' : '')}
    </div>
    <h3 class="sub-h" style="margin-top:24px">People</h3>
    <div class="card grp-list">${P.length ? P.map(grpPersonHTML).join('') : '<p class="grp-none">Nobody has opened a link yet.</p>'}</div>
    <h3 class="sub-h" style="margin-top:24px">Share links</h3>
    <div class="card grp-share">
      <p class="grp-lede">Make a link and send it. They tap it once and they're in — no code to type. Turn a link off and only the phones that used it are out.</p>
      <div class="mlbt-fgrid"><label class="mlbt-fld">Who's it for?<input class="mlbt-inp" id="grpLabel" autocomplete="off" placeholder="e.g. Mike" maxlength="40"></label></div>
      <button type="button" class="bets-btn" data-grp-make>Make a link</button>
      <p class="grp-err" id="grpErr" role="alert"></p>
      ${(GRP.links?.links || []).map(grpLinkHTML).join('') || '<p class="grp-none">No links yet.</p>'}
    </div>`, 'group');
}

const grpLinkHTML = (l) => `<div class="grp-link">
  <div class="grp-link-m"><b>${esc(l.label)}</b><span>${l.uses ? `opened ${l.uses} time${l.uses === 1 ? '' : 's'}${l.last ? ` · last ${esc(oddsAgo(l.last))}` : ''}` : 'not opened yet'}</span></div>
  <div class="grp-link-go">
    <button type="button" class="bets-btn ghost sm" data-grp-copy="${esc(l.token)}">Copy link</button>
    <button type="button" class="grp-off" data-grp-revoke="${esc(l.id)}" aria-label="${esc(`Turn off ${l.label}'s link`)}">Turn off</button>
  </div></div>`;

function grpPersonHTML(P) {
  const done = P.won + P.lost;
  const roi = P.risk ? (P.net / P.risk) * 100 : null;
  const risk = P.open.reduce((t, b) => t + (b.stake || 0), 0);
  return `<button type="button" class="grp-p" data-grp-person="${esc(P.uid)}">
    <span class="grp-p-n">${esc(P.name || 'Someone')}${P.via ? `<small>${esc(P.via)}${P.last ? ` · ${esc(oddsAgo(P.last))}` : ''}</small>` : ''}</span>
    <span class="grp-p-o">${P.open.length ? `${P.open.length} open<small>${esc(betsFmtMoney(risk))} at risk</small>` : '<small>nothing open</small>'}</span>
    <span class="grp-p-r">${done ? `<b class="${P.net > 0 ? 'w' : P.net < 0 ? 'l' : ''}">${esc(betsFmtMoney(P.net, true))}</b><small>${P.won}-${P.lost}${roi != null ? ` · ${roi > 0 ? '+' : ''}${roi.toFixed(0)}%` : ''}</small>` : '<small>no results yet</small>'}</span>
  </button>`;
}

// Their full log, newest first. Read-only.
async function grpPersonSheet(uid) {
  const P = (GRP.people || []).find((x) => x.uid === uid);
  openSheet(`<h2 id="dlgTitle">${esc(P?.name || 'Someone')}</h2><div class="card empty"><b>Loading their log…</b></div>`, 'group-person');
  let d = null;
  try { d = await (await fetch(`api/group/${uid}`)).json(); } catch { d = null; }
  if (S.dlgKind !== 'group-person') return;
  if (!d || d.error) { openSheet(`<h2 id="dlgTitle">Couldn't load that</h2><p class="odds-lede">${esc(d?.error || 'Try again.')}</p>`, 'group-person'); return; }
  const open = d.bets.filter((b) => b.status === 'open');
  const done = d.bets.filter((b) => b.status !== 'open');
  const row = (b) => `<div class="grp-b">
    <span class="grp-b-m">${esc(grpLegs(b))}${b.book ? `<small>${esc(betsBookName(b.book))}</small>` : ''}</span>
    <span class="grp-b-r">${esc(betsFmtMoney(b.stake))}${b.status === 'open' ? '<small>open</small>' : `<b class="${b.net > 0 ? 'w' : b.net < 0 ? 'l' : ''}">${esc(betsFmtMoney(b.net || 0, true))}</b><small>${esc(b.status)}</small>`}</span></div>`;
  openSheet(`<h2 id="dlgTitle">${esc(d.name || P?.name || 'Someone')}</h2>
    <p class="odds-lede">${P?.via ? `Joined on ${esc(P.via)}'s link. ` : ''}${d.bets.length} ticket${d.bets.length === 1 ? '' : 's'} in their log.</p>
    ${open.length ? `<h3 class="sub-h" style="margin-top:20px">Running now</h3><div class="card grp-blist">${open.map(row).join('')}</div>` : ''}
    ${done.length ? `<h3 class="sub-h" style="margin-top:20px">Settled</h3><div class="card grp-blist">${done.slice(0, 60).map(row).join('')}</div>` : ''}
    ${d.bets.length ? '' : '<div class="card empty"><b>No tickets yet</b>They haven\'t logged a bet.</div>'}
    <button type="button" class="bets-btn ghost" data-grp-back>Back to the group</button>`, 'group-person');
}

const GRP_MKT = { ml: 'ML', rl: 'run line', t: 'total', f5ml: 'F5 ML', f5rl: 'F5 run line', f5t: 'F5 total' };
function grpLegs(b) {
  return b.legs.map((l) => `${l.team || (l.side === 'over' ? 'Over' : l.side === 'under' ? 'Under' : l.side || '')} ${l.line != null ? l.line : ''} ${betsFmtOdds(l.odds)} ${GRP_MKT[l.mkt] || ''}`.replace(/\s+/g, ' ').trim()).join(' + ');
}

// ------------------------------------------------------------ the first screen a guest sees
function grpWelcome() {
  openSheet(`<h2 id="dlgTitle">Welcome to the board</h2>
    <p class="odds-lede">${esc(S.me?.owner ? `${S.me.owner}'s` : 'This')} board: every home run as it lands, every book's number side by side, and a place to keep your tickets.</p>
    <div class="mlbt-fgrid" style="margin-top:20px"><label class="mlbt-fld">What should the board call you?<input class="mlbt-inp" id="grpWName" autocomplete="off" maxlength="24" placeholder="First name"></label></div>
    <p class="grp-err" id="grpWErr" role="alert"></p>
    <button type="button" class="bets-btn" data-grp-wsave>Start</button>
    <p class="grp-fine">Nothing you type here reaches a sportsbook — bets are placed at the book, in your own account.</p>`, 'welcome');
  setTimeout(() => $('#grpWName')?.focus(), 80);
}
function grpMaybeWelcome() {
  if (grpIsOwner() || !grpShared() || S.me?.named || S.dlgKind || store.get('welcomed', false)) return;
  store.set('welcomed', true);
  grpWelcome();
}

// ------------------------------------------------------------ clicks
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-grp-open],[data-grp-make],[data-grp-copy],[data-grp-revoke],[data-grp-person],[data-grp-back],[data-grp-name],[data-grp-wsave]');
  if (!t) return;
  const d = t.dataset;
  const err = (sel, m) => { const e = $(sel); if (e) e.textContent = m || ''; };

  if (d.grpOpen !== undefined) { if (!GRP.people) await grpLoad(); grpSheet(); return; }
  if (d.grpBack !== undefined) { grpSheet(); return; }
  if (d.grpPerson) { grpPersonSheet(d.grpPerson); return; }

  if (d.grpMake !== undefined) {
    err('#grpErr', '');
    const label = String($('#grpLabel')?.value || '').trim();
    try {
      const r = await fetch('api/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }) });
      const inv = await r.json();
      if (!r.ok) throw new Error(inv.error || 'Could not make a link');
      await grpLoad();
      grpSheet();
      grpCopy(grpUrl(inv.token), `Link for ${inv.label} copied. Send it to them.`);
    } catch (e) { err('#grpErr', e.message); }
    return;
  }
  if (d.grpCopy) { grpCopy(grpUrl(d.grpCopy), 'Link copied.'); return; }
  if (d.grpRevoke) {
    const label = GRP.links?.links.find((l) => l.id === d.grpRevoke)?.label || 'That link';
    try {
      await fetch(`api/invites/${d.grpRevoke}`, { method: 'DELETE' });
      await grpLoad();
      grpSheet();
      toastText(`${label}'s link is off. Anyone using it is signed out.`);
    } catch (e) { err('#grpErr', e.message); }
    return;
  }
  if (d.grpName !== undefined || d.grpWsave !== undefined) {
    const welcome = d.grpWsave !== undefined;
    const sel = welcome ? '#grpWName' : '#grpName';
    const esel = welcome ? '#grpWErr' : '#grpErr';
    const name = String($(sel)?.value || '').trim();
    if (!name) { err(esel, 'Type a name the board can call you.'); return; }
    err(esel, '');
    try {
      const r = await fetch('api/me/name', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not save that');
      S.me = { ...S.me, name: j.name, named: true };
      if (welcome) { closeSheet(); toastText(`You're in, ${j.name}.`); } else toastText('Saved.');
    } catch (e) { err(esel, e.message); }
  }
});

function grpCopy(url, msg) {
  const show = () => openSheet(`<h2 id="dlgTitle">Share link</h2><p class="odds-lede">Send this to one person. Anyone with it can open the board.</p>
    <div class="grp-url">${esc(url)}</div><button type="button" class="bets-btn ghost" data-grp-back>Back to the group</button>`, 'group');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => toastText(msg)).catch(show);
  else show();
}

// The group is re-read while its sheet is open, so a friend's ticket shows up without a reload.
setInterval(() => { if (S.dlgKind === 'group' && document.visibilityState === 'visible') grpLoad(); }, 20000);
