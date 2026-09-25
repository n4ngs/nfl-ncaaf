/* THE.BOARD masthead: one bar instead of five.
   Before this, a board opened under five stacked bars (sport switcher, workspace links, the subsecond
   target strip, the creator rail, then the board's own header) — about 250px on a desktop and a third
   of a phone screen before the first price. This moves the pieces that belong at the top (section tabs,
   status, alerts, theme, Edges, Admin) into the sport bar and folds the rest (Opportunities, Account,
   Focus mode, Open on iPhone, feed target, Support the creator) into one menu. Nodes are MOVED, never
   rebuilt, so every listener the boards and the other layers attached keeps working. */
(() => {
  'use strict';
  function mount() {
    const bar = document.getElementById('xsport');
    if (!bar || bar.dataset.masthead) return;
    bar.dataset.masthead = '1';
    document.documentElement.classList.add('xt');
    const $ = (s, r = document) => r.querySelector(s);

    // section tabs (Live · Board · My bets · Tools · Admin) sit beside the sport switcher on wide screens
    const nav = $('header.top .nav');
    if (nav) { nav.classList.add('xnav'); ($('.xseg', bar) || bar.firstElementChild).after(nav); }

    // the right cluster: Edges, feed status, live pill, alerts, theme, Admin, menu
    const right = document.createElement('div');
    right.className = 'xright';
    bar.appendChild(right);
    const edge = $('.xedge', bar); if (edge) right.appendChild(edge);
    const feed = $('#feed-monitor'); if (feed) right.appendChild(feed);
    for (const id of ['livePill', 'alertBtn', 'themeBtn']) { const el = document.getElementById(id); if (el) right.appendChild(el); }
    const adm = $('.xadm', bar); if (adm) right.appendChild(adm);

    // the menu
    const menu = document.createElement('details');
    menu.className = 'xmenu';
    menu.innerHTML = '<summary aria-label="Menu" title="Menu"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></summary><div class="xmenu-p" role="menu"></div>';
    const panel = $('.xmenu-p', menu);
    right.appendChild(menu);
    const ws = document.getElementById('board-workspace-nav'); if (ws) panel.appendChild(ws);
    const phone = document.getElementById('phoneBtn'); if (phone) panel.appendChild(phone);
    const target = $('.feed-target'); if (target) panel.appendChild(target);
    const rail = document.getElementById('creator-support-rail'); if (rail) panel.appendChild(rail);
    const close = () => { menu.open = false; };
    document.addEventListener('pointerdown', (e) => { if (menu.open && !menu.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) close(); });
    panel.addEventListener('click', (e) => { if (e.target.closest('a, button')) setTimeout(close, 0); });

    // the board's own header is now empty of everything but the hidden brand
    const top = $('header.top'); if (top) top.classList.add('xtop-empty');

    // "New to betting?" opens on request. The board re-renders that card, so the state lives on the section.
    const learn = document.getElementById('learn');
    if (learn) learn.addEventListener('click', (e) => { if (e.target.closest('.card.learn > h3')) learn.classList.toggle('open'); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})();
