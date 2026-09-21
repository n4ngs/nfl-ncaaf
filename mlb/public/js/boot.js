'use strict';
/* Bing Bong Live — interactions and startup. */

// ------------------------------------------------------------ tabs
const TABS = ['live', 'homers', 'games', 'following', 'tools'];
function setTab(tab, { push = true } = {}) {
  if (!TABS.includes(tab)) tab = 'live';
  const changed = S.tab !== tab;
  S.tab = tab;
  if (push && location.hash !== `#${tab}`) history.replaceState(null, '', `${location.pathname}${location.search}#${tab}`);
  if (changed) window.scrollTo({ top: 0 });
  if (tab === 'following') refreshFollowing();
  if (tab === 'tools' && typeof mlbToolsHook === 'function') mlbToolsHook();
  invalidate();
}
window.addEventListener('hashchange', () => setTab(location.hash.slice(1), { push: false }));

// ------------------------------------------------------------ theme
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  if (S.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = S.theme;
  // Safari's toolbar and the Home Screen app's status bar take this color; match the theme actually shown.
  const dark = S.theme === 'dark' || (S.theme === 'auto' && darkQuery.matches);
  $$('meta[name="theme-color"]').forEach((m) => { m.removeAttribute('media'); m.content = dark ? '#000000' : '#F4F4F6'; });
}
darkQuery.addEventListener?.('change', () => { if (S.theme === 'auto') applyTheme(); });
$('#themeBtn').addEventListener('click', () => {
  S.theme = S.theme === 'auto' ? 'dark' : S.theme === 'dark' ? 'light' : 'auto';
  store.set('theme', S.theme);
  applyTheme();
  renderTopButtons();
  toastText(S.theme === 'auto' ? 'Theme follows your device' : S.theme === 'dark' ? 'Dark mode' : 'Light mode');
});

// ------------------------------------------------------------ alerts
$('#alertBtn').addEventListener('click', async () => {
  unlockAudio();
  S.alerts = S.alerts === 'off' ? 'all' : S.alerts === 'all' ? 'follow' : 'off';
  store.set('alerts', S.alerts);
  renderTopButtons();
  if (S.alerts === 'off') { toastText('Alerts off'); return; }
  crack();
  toastText(S.alerts === 'all' ? 'Alerts on for every home run' : 'Alerts only for players and teams you follow');
  if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { /* ignore */ } }
});
$('#phoneBtn').addEventListener('click', openPhone);

// ------------------------------------------------------------ one click handler for the whole app
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act],[data-follow],[data-team],[data-player],[data-open],[data-game],[data-tab],[data-seg],[data-seg-go],[data-sort],[data-kind],[data-day]');
  if (!t) return;
  const d = t.dataset;
  if (d.act) return act(d.act, t, ev);
  if (d.day) { // a day in the strip, or "See all" on a recap
    ev.preventDefault();
    if (d.day !== (S.loading || S.date)) { go(d.day); window.scrollTo({ top: 0 }); }
    if (d.to) setTab(d.to);
    return;
  }
  if (d.follow) {
    const on = toggleFollowPlayer(d.follow, d.name);
    if (t.classList.contains('fbtn')) { t.classList.toggle('on', on); t.textContent = on ? 'Following' : 'Follow'; }
    else if (t.classList.contains('btn') || t.classList.contains('lbtn')) t.textContent = `${on ? '★ Following' : '☆ Follow'}${t.classList.contains('lbtn') ? ` ${(d.name || '').split(' ').slice(-1)[0]}` : ''}`;
    toastText(on ? `Following ${d.name || 'player'}. You'll see when they're up.` : `Unfollowed ${d.name || 'player'}`);
    invalidate();
    return;
  }
  if (d.team) {
    const on = toggleFollowTeam(d.team);
    if (t.classList.contains('tm')) { t.classList.toggle('on', on); t.setAttribute('aria-pressed', String(on)); }
    else if (t.classList.contains('lbtn')) t.textContent = `${on ? '★' : '☆'} ${t.textContent.replace(/^[★☆]\s*/, '')}`;
    return;
  }
  if (d.player) { ev.preventDefault(); ev.stopPropagation(); openPlayer(d.player); return; }
  if (d.open) { ev.preventDefault(); if (t.classList.contains('toast')) t.remove(); openEvent(d.open, !!d.play); return; }
  if (d.game) { ev.preventDefault(); if (t.classList.contains('toast')) t.remove(); openGame(d.game); return; }
  if (d.tab) { ev.preventDefault(); closeSheet(); setTab(d.tab); return; }
  if (d.seg) { S.seg = d.seg; store.set('seg', S.seg); invalidate(); return; }
  if (d.segGo) { S.seg = d.segGo; store.set('seg', S.seg); setTab('homers'); return; }
  if (d.sort) { S.sort = d.sort; invalidate(); return; }
  if (d.kind) { S.kind = d.kind; invalidate(); }
});
function act(name, t, ev) {
  if (name === 'mute') {
    const v = $('#heroVideo');
    if (!v) return;
    S.muted = !v.muted;
    v.muted = S.muted;
    if (!S.muted) v.play().catch(() => {});
    t.innerHTML = S.muted ? ICON.muted : ICON.sound;
    t.setAttribute('aria-label', S.muted ? 'Unmute clip' : 'Mute clip');
    t.setAttribute('aria-pressed', String(!S.muted));
  } else if (name === 'today') go(S.today);
  else if (name === 'learn') { ev.preventDefault(); setTab('live'); requestAnimationFrame(() => $('#learn').scrollIntoView({ behavior: 'smooth', block: 'start' })); }
  else if (name === 'banner-off') { store.set('bannerDone', true); $('#banner').innerHTML = ''; }
  else if (name === 'share') shareLineup();
  else if (name === 'game-homers') { closeSheet(); S.seg = 'tonight'; S.sort = 'new'; setTab('homers'); }
  else if (name === 'import-yes' && S.importing) {
    S.follow.players = [...new Set([...S.follow.players, ...S.importing.players])];
    S.follow.teams = [...new Set([...S.follow.teams, ...S.importing.teams])];
    saveFollow();
    S.importing = null;
    clearImportParams();
    closeSheet();
    setTab('following');
    toastText('Lineup added');
  } else if (name === 'import-no') { S.importing = null; clearImportParams(); closeSheet(); }
}
document.addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[role="button"]')) { ev.preventDefault(); ev.target.click(); }
});
document.addEventListener('change', (ev) => { if (ev.target.id === 'dateInput' && ev.target.value) go(ev.target.value); });
// Hero layout moves the "In the air" card between phone and desktop positions.
let wasDesk = isDesk();
addEventListener('resize', () => { if (isDesk() !== wasDesk) { wasDesk = isDesk(); $('#heroSide').dataset.key = ''; $('#airSlot').dataset.key = ''; invalidate(); } });
// Relative times ("4 min ago", "updated 2s ago") keep moving.
setInterval(() => { renderPill(); if (S.tab === 'live' && homers()[0]) renderHero(); }, 1000);

// ------------------------------------------------------------ start
// Installable app (Android "Install app", iPhone Home Screen) and instant reopen. Needs https, or localhost.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
applyTheme();
S.tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'live';
const want = new URL(location.href).searchParams.get('date');
if (want && /^\d{4}-\d{2}-\d{2}$/.test(want)) { S.isToday = false; go(want); }
connect();
if (S.follow.players.length) refreshFollowing();
const imp = pendingImport();
if (imp) openImport(imp);
invalidate();
