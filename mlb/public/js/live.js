'use strict';
/* Bing Bong Live — live data: the event stream, day loading, alerts, following data, clips. */

// ------------------------------------------------------------ render scheduling
let raf = 0;
function invalidate() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderAll(); }); }

// Today's plays and batters, kept even while another day is on screen, so alerts never miss.
const T = { hr: new Map(), events: new Map(), batter: new Map() };
function trackToday(d) {
  T.hr = new Map(d.events.map((e) => [e.id, e.isHR]));
  T.events = new Map(d.events.map((e) => [e.id, e]));
  T.batter = new Map(Object.entries(d.atbats || {}).map(([pk, ab]) => [Number(pk), ab?.batter?.id]));
}

// ------------------------------------------------------------ snapshot
function recount() {
  const live = [...S.games.values()].filter((g) => g.state === 'Live' && !/suspend/i.test(g.detail || ''));
  S.liveCount = live.length;
  S.feedAt = Math.max(S.feedAt || 0, ...live.map((g) => g.feedAt || 0));
}
function loadSnapshot(d) {
  const dayChanged = d.date !== S.date;
  if (d.today) trackToday(d);
  S.date = d.date;
  if (d.today) S.today = d.date;
  S.isToday = !!d.today;
  S.games = new Map(d.games.map((g) => [g.pk, g]));
  S.events = new Map(d.events.map((e) => [e.id, e]));
  S.pending = new Map((d.pending || []).map((b) => [b.id, b]));
  S.atbats = new Map(Object.entries(d.atbats || {}).map(([pk, ab]) => [Number(pk), ab]));
  S.pitches = d.pitches || [];
  S.swings = d.swings || [];
  S.feedMs = d.feedMs || S.feedMs;
  S.offset = d.now - Date.now();
  if (d.me) S.me = d.me;
  if (typeof grpMaybeWelcome === 'function') grpMaybeWelcome();
  recount();
  if (dayChanged) S.hrSeen = homers().length; // the "new homers" badge starts fresh each day
  if (S.gameOpen) refreshGameSheet(S.gameOpen, { partial: true });
  const url = new URL(location.href);
  if (S.isToday) url.searchParams.delete('date'); else url.searchParams.set('date', S.date);
  if (url.href !== location.href) history.replaceState(null, '', url);
  invalidate();
}

// ------------------------------------------------------------ event stream
let es = null;
function connect() {
  es = new EventSource('api/stream');
  const on = (type, fn) => es.addEventListener(type, (m) => { S.lastMsg = Date.now(); S.connected = true; fn(JSON.parse(m.data)); });
  es.onopen = () => { S.connected = true; S.lastMsg = Date.now(); renderPill(); };
  es.onerror = () => { S.connected = false; renderPill(); };
  on('snapshot', (d) => { S.today = d.date; if (S.isToday && !S.loading) loadSnapshot(d); else invalidate(); document.dispatchEvent(new CustomEvent('bbl:snapshot', { detail: d })); });
  // Betting stack (odds.js, bets.js) listens for these as DOM events.
  for (const t of ['odds', 'odds_status', 'move', 'bets']) on(t, (d) => document.dispatchEvent(new CustomEvent(`bbl:${t}`, { detail: d })));
  on('tick', (d) => { S.offset = d.now - Date.now(); if (S.isToday) { S.liveCount = d.live; S.feedAt = d.feedAt; } renderPill(); });
  on('event', (e) => {
    const wasHR = T.hr.get(e.id);
    T.hr.set(e.id, e.isHR);
    T.events.set(e.id, e);
    if (e.isHR && e.live && !wasHR) announce(e);
    else if (wasHR === undefined && !e.isHR && S.alerted.has(e.id)) toast(e, `Stayed in the park · ${kindLabel(e)}`, [e.dist && `${e.dist} ft`, `${e.team.abbr} vs ${e.opp.abbr}`].filter(Boolean).join(' · '), { open: e.id });
    if (S.eventOpen === e.id) updateEventSheet(e);
    if (!S.isToday || S.loading) return;
    const prev = S.events.get(e.id);
    S.pending.delete(e.id);
    S.events.set(e.id, e);
    if (!prev) S.fresh.add(e.id);
    invalidate();
  });
  on('pending', (b) => {
    if (T.hr.has(b.id)) return;
    onPending(b);
    if (!S.isToday || S.loading) return;
    S.pending.set(b.id, b);
    invalidate();
  });
  on('unpending', (d) => { if (S.isToday && !S.loading) { S.pending.delete(d.id); invalidate(); } });
  on('remove', (d) => { if (S.isToday && !S.loading) { S.events.delete(d.id); invalidate(); } });
  on('game', (g) => {
    if (!S.isToday || S.loading) return;
    S.games.set(g.pk, g);
    recount();
    if (S.gameOpen === g.pk) {
      const d = S.gameData;
      // New plate appearance logged, new win probability, or the game just ended: reload those parts.
      if (d && (g.logN !== (d.log?.length ?? 0) || g.wpN !== (d.wp?.length ?? 0) || g.state !== d.game?.state)) refreshGameSheet(g.pk, { partial: true });
      else updateGameSheet();
    }
    invalidate();
  });
  on('atbat', ({ pk, ab }) => {
    const prevBatter = T.batter.get(pk);
    T.batter.set(pk, ab?.batter?.id);
    if (ab && ab.batter?.id !== prevBatter && followsPlayer(ab.batter.id) && !ab.result) upToBat(ab, pk);
    if (!S.isToday || S.loading) return;
    if (ab) S.atbats.set(pk, ab); else S.atbats.delete(pk);
    if (S.gameOpen === pk) updateGameSheet();
    if (S.tab === 'live' || S.tab === 'games' || S.tab === 'odds' || S.tab === 'following') invalidate();
  });
  on('extras', (d) => { if (S.isToday && !S.loading) { S.pitches = d.pitches; S.swings = d.swings; if (S.tab === 'homers') invalidate(); } });
}
function reconnect() {
  try { es?.close(); } catch { /* already closed */ }
  S.connected = false;
  renderPill();
  connect();
}
// iOS suspends background pages and can leave a dead connection behind; reconnect when it goes quiet.
setInterval(() => { if (!document.hidden && Date.now() - S.lastMsg > 12000) reconnect(); }, 4000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  S.unseen = 0;
  document.title = 'Bing Bong Live';
  if (Date.now() - S.lastMsg > 6000) reconnect();
});
window.addEventListener('pageshow', (ev) => { if (ev.persisted) reconnect(); });

// ------------------------------------------------------------ other days
async function go(date) {
  if (!date) return;
  if (date === S.today) {
    S.loading = date;
    invalidate();
    const r = await fetch(`api/day?date=${date}`).catch(() => null);
    S.loading = null;
    if (r?.ok) loadSnapshot(await r.json());
    return;
  }
  S.loading = date;
  S.isToday = false;
  S.events = new Map(); S.games = new Map(); S.pending = new Map(); S.atbats = new Map(); S.pitches = []; S.swings = [];
  invalidate();
  try {
    const r = await fetch(`api/day?date=${date}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    if (S.loading !== date) return;
    S.loading = null;
    loadSnapshot(d);
  } catch (err) {
    if (S.loading !== date) return;
    S.loading = null;
    S.date = date;
    invalidate();
    toastText(`Couldn't load ${dayLabel(date)}. ${err.message}`);
  }
}
function dayLabel(d, long = false) {
  if (!d) return '';
  return new Date(`${d}T12:00:00`).toLocaleDateString([], long ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' });
}
// "2026-09-19" moved by n days, same format.
function shiftDay(d, n) {
  const t = new Date(`${d}T12:00:00`);
  t.setDate(t.getDate() + n);
  return t.toLocaleDateString('en-CA');
}
// "Yesterday" or "Thu, Sep 17", relative to today's slate.
const relDay = (d) => (d === S.today ? 'Today' : S.today && d === shiftDay(S.today, -1) ? 'Yesterday' : dayLabel(d));

// ------------------------------------------------------------ the last day with home runs
// Before today's first homer the Live page would be empty, so it shows the most recent day that had some,
// clearly labeled with its date. Loaded once per day, and never mixed into today's events.
let recapBusy = false;
async function loadRecap() {
  if (recapBusy || !S.today) return;
  if (S.recap?.for === S.today && (S.recap.hrs || Date.now() - S.recap.at < 60e3)) return;
  recapBusy = true;
  let found = null;
  try {
    for (let back = 1; back <= 5 && !found; back++) {
      const date = shiftDay(S.today, -back);
      const r = await fetch(`api/day?date=${date}`);
      if (!r.ok) continue;
      const d = await r.json();
      const events = new Map((d.events || []).map((e) => [e.id, e]));
      const hrs = [...events.values()].filter((e) => e.isHR);
      if (hrs.length) found = { date: d.date || date, events, hrs, hits: [...events.values()].filter((e) => e.isHit).length, games: (d.games || []).length };
    }
  } catch { /* offline: the plain pregame card stays up and this retries in a minute */ }
  recapBusy = false;
  S.recap = { for: S.today, at: Date.now(), ...(found || {}) };
  if (found) invalidate();
}

// ------------------------------------------------------------ alerts
let audio = null;
function unlockAudio() {
  try {
    if (!audio) {
      audio = new (window.AudioContext || window.webkitAudioContext)();
      // Play one silent sample inside the gesture; iOS then lets the page make sound later.
      const b = audio.createBuffer(1, 1, 22050), src = audio.createBufferSource();
      src.buffer = b; src.connect(audio.destination); src.start(0);
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    }
    if (audio.state !== 'running') audio.resume();
  } catch { audio = null; }
}
// iOS only counts touchend and click as gestures (not pointerdown).
['touchend', 'click'].forEach((t) => document.addEventListener(t, () => { if (S.alerts !== 'off') unlockAudio(); }, { capture: true, passive: true }));
// A short "crack of the bat" and a rising tone.
function crack() {
  if (!audio) return;
  try {
    if (audio.state !== 'running') audio.resume();
    const t = audio.currentTime, len = 0.14;
    const buf = audio.createBuffer(1, Math.floor(audio.sampleRate * len), audio.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 5);
    const src = audio.createBufferSource(); src.buffer = buf;
    const bp = audio.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.8;
    const g = audio.createGain(); g.gain.value = 0.9;
    src.connect(bp).connect(g).connect(audio.destination); src.start(t);
    const o = audio.createOscillator(), og = audio.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(440, t + 0.08); o.frequency.exponentialRampToValueAtTime(1320, t + 0.7);
    og.gain.setValueAtTime(0.0001, t + 0.08); og.gain.exponentialRampToValueAtTime(0.12, t + 0.18); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(og).connect(audio.destination); o.start(t + 0.08); o.stop(t + 0.95);
  } catch { /* audio unavailable */ }
}
function notify(title, body, pid, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  const opts = { body, icon: HEAD(pid, 120), badge: '/icons/icon-192.png', tag };
  // Android only allows notifications through the service worker; desktop browsers allow both.
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch(() => {});
    return;
  }
  try {
    const n = new Notification(title, opts);
    n.onclick = () => { window.focus(); if (S.events.has(tag)) openEvent(tag); };
  } catch { /* not allowed here */ }
}
function toastText(msg) {
  const t = document.createElement('div');
  t.className = 'toast text';
  t.textContent = msg;
  $('#toasts').prepend(t);
  setTimeout(() => t.remove(), 5000);
}
function toast(x, kicker, line, { open, gamePk } = {}) {
  const t = document.createElement(open || gamePk ? 'button' : 'div');
  t.className = 'toast';
  if (open) t.dataset.open = open;
  if (gamePk) t.dataset.game = gamePk;
  t.innerHTML = `${face(x.batter.id, 40, x.batter.name)}<div><div class="t1"><span class="dot"></span>${esc(kicker)}</div><div class="t2">${esc(x.batter.name)}</div><div class="t3">${esc(line)}</div></div>`;
  $('#toasts').prepend(t);
  while ($('#toasts').children.length > 3) $('#toasts').lastElementChild.remove();
  setTimeout(() => t.remove(), 12000);
}
const wants = (x) => S.alerts === 'all' || (S.alerts === 'follow' && isFollowed(x));
function announce(e) {
  const early = S.alerted.has(e.id);
  S.alerted.add(e.id);
  const line = [e.dist && `${e.dist} ft`, e.ev && `${e.ev} mph`, scoreStory(e)].filter(Boolean).join(' · ');
  toast(e, `${early ? 'Confirmed · ' : ''}${hrKind(e)}`, line, { open: e.id });
  if (document.hidden) { S.unseen++; document.title = `(${S.unseen}) Home run! · Bing Bong Live`; }
  if (!wants(e)) return;
  if (!early) crack();
  notify(`Home run: ${e.batter.name}`, `${hrKind(e)} · ${line}`, e.batter.id, e.id);
}
function onPending(b) {
  const v = verdict(b);
  if (v?.k !== 3 || S.alerted.has(b.id)) return;
  S.alerted.add(b.id);
  toast(b, 'Looks gone · waiting on the call', [b.dist && `${b.dist} ft`, b.ev && `${b.ev} mph`, `${b.team.abbr} vs ${b.opp.abbr}`].filter(Boolean).join(' · '));
  if (wants(b)) { crack(); notify(`Looks gone: ${b.batter.name}`, `${b.dist} ft · ${b.ev} mph. Waiting on the official call.`, b.batter.id, b.id); }
}
function upToBat(ab, pk) {
  const on = ['first', 'second', 'third'].filter((k) => ab.bases?.[k]).length;
  const line = [`${ab.team.abbr} vs ${ab.opp.abbr}`, inningLabel(ab), on ? `${on} on` : 'bases empty', `${ab.outs} out`].join(' · ');
  toast(ab, 'Now batting', line, { gamePk: pk });
  if (S.alerts !== 'off') notify(`${ab.batter.name} is up`, line, ab.batter.id, `ab-${pk}-${ab.ab}`);
}

// ------------------------------------------------------------ following data
let followBusy = false;
async function refreshFollowing() {
  if (followBusy) return;
  if (!S.follow.players.length) { S.followData = []; invalidate(); return; }
  followBusy = true;
  try {
    const r = await fetch(`api/players/today?ids=${S.follow.players.join(',')}`);
    const d = await r.json();
    S.followData = d.players || [];
    for (const p of S.followData) if (p.name) S.follow.names[p.id] = p.name;
    saveFollow();
  } catch { /* keep the last good data */ }
  followBusy = false;
  invalidate();
}
setInterval(() => { if (S.tab === 'following' && !document.hidden && S.isToday) refreshFollowing(); }, 10000);
async function loadTeams() {
  if (S.teamsList) return S.teamsList;
  try { S.teamsList = await (await fetch('api/teams')).json(); } catch { S.teamsList = []; }
  return S.teamsList;
}
function toggleFollowPlayer(id, name) {
  id = Number(id);
  S.follow.players = followsPlayer(id) ? S.follow.players.filter((x) => x !== id) : [...S.follow.players, id];
  if (name) S.follow.names[id] = name;
  saveFollow();
  refreshFollowing();
  return followsPlayer(id);
}
function toggleFollowTeam(id) {
  id = Number(id);
  S.follow.teams = followsTeam(id) ? S.follow.teams.filter((x) => x !== id) : [...S.follow.teams, id];
  saveFollow();
  invalidate();
  return followsTeam(id);
}
// Share links carry ids only: /?players=1,2&teams=3
let lanBase = null;
async function shareBase() {
  if (!/^(localhost|127\.|\[::1\])/.test(location.hostname)) return location.origin;
  if (lanBase) return lanBase;
  try { lanBase = (await (await fetch('api/lan')).json()).urls?.[0] || location.origin; } catch { lanBase = location.origin; }
  return lanBase;
}
function copyText(text) {
  const ta = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
  ta.style.cssText = 'position:fixed;top:0;opacity:0';
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
  ta.remove();
  return ok;
}
async function shareLineup() {
  // Keep this synchronous where possible so the tap still counts as a gesture for the share sheet.
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  const base = local ? await shareBase() : location.origin;
  const url = `${base}/?players=${S.follow.players.join(',')}&teams=${S.follow.teams.join(',')}`;
  const note = local ? ' Anyone on your Wi-Fi can open it.' : '';
  if (navigator.share) {
    try { await navigator.share({ title: 'My Bing Bong Live lineup', url }); return; } catch (err) { if (err?.name === 'AbortError') return; }
  }
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(url); toastText(`Link copied.${note}`); return; } catch { /* fall through */ }
  }
  toastText(copyText(url) ? `Link copied.${note}` : url);
}
function pendingImport() {
  const q = new URL(location.href).searchParams;
  const ids = (k) => (q.get(k) || '').split(',').filter((x) => /^\d+$/.test(x)).map(Number);
  const players = ids('players'), teams = ids('teams');
  return players.length || teams.length ? { players, teams } : null;
}
function clearImportParams() {
  const url = new URL(location.href);
  url.searchParams.delete('players');
  url.searchParams.delete('teams');
  history.replaceState(null, '', url);
}

// ------------------------------------------------------------ a player's latest home run clip
const clipCache = new Map(); // playerId -> Promise<video|null>
function latestClip(id) {
  if (!clipCache.has(id)) {
    clipCache.set(id, fetch(`api/player/${id}/hr-video?season=${(S.date || '').slice(0, 4)}`)
      .then((r) => r.json()).then((d) => d.video || null).catch(() => null));
    setTimeout(() => clipCache.delete(id), 5 * 60e3);
  }
  return clipCache.get(id);
}
