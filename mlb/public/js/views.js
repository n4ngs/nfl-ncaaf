'use strict';
/* Bing Bong Live — the four tabs: Live, Homers, Games, Following. */

const isDesk = () => matchMedia('(min-width:1024px)').matches;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

function renderAll() {
  renderPill();
  renderTopButtons();
  $$('.view').forEach((v) => v.classList.toggle('on', v.dataset.view === S.tab));
  $$('[data-tab]').forEach((a) => {
    if (!a.closest('.nav,.tabbar')) return;
    a.classList.toggle('on', a.dataset.tab === S.tab);
    if (a.dataset.tab === S.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const newHR = Math.max(0, homers().length - (S.hrSeen ?? homers().length));
  $('#hrBadge').hidden = !newHR || S.tab === 'homers';
  $('#hrBadge').textContent = newHR;
  renderDays();
  if (S.tab === 'live') renderLive();
  else if (S.tab === 'homers') { S.hrSeen = homers().length; renderHomers(); }
  else if (S.tab === 'games') renderGames();
  else if (S.tab === 'following') renderFollowing();
  else if (S.tab === 'tools' && typeof mlbToolsHook === 'function') mlbToolsHook();
  S.fresh.clear();
}

// ------------------------------------------------------------ top bar
function renderPill() {
  const el = $('#livePill');
  const txt = $('#liveText');
  const age = S.feedAt ? Math.max(0, Math.round((serverNow() - S.feedAt) / 1000)) : null;
  el.classList.remove('stale');
  let dot = true;
  const wide = isDesk();
  if (!S.connected) { el.classList.add('stale'); txt.textContent = wide ? 'Reconnecting' : 'Offline'; }
  else if (!S.isToday) {
    dot = false;
    const d = new Date(`${S.loading || S.date}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
    txt.textContent = wide ? `Replay · ${dayLabel(S.loading || S.date)}` : d;
  } else if (S.liveCount) {
    if (age != null && age > 20) el.classList.add('stale');
    txt.textContent = wide ? `Live · ${S.liveCount} game${S.liveCount === 1 ? '' : 's'}` : `${S.liveCount} live`;
  } else {
    dot = false;
    const next = [...S.games.values()].filter((g) => g.state === 'Preview').sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
    txt.textContent = next ? `${wide ? 'First pitch ' : ''}${timeLabel(next.start)}` : S.games.size ? 'Final' : 'No games';
  }
  el.querySelector('.dot').hidden = !dot;
  const m = $('#abMeta');
  if (m && S.tab === 'live' && S.isToday && S.liveCount) m.textContent = `${S.atbats.size} game${S.atbats.size === 1 ? '' : 's'}${age != null ? ` · updated ${age}s ago` : ''}`;
}
function renderTopButtons() {
  const a = $('#alertBtn');
  a.innerHTML = S.alerts === 'off' ? ICON.bell : ICON.bellOn;
  a.classList.toggle('on', S.alerts !== 'off');
  a.setAttribute('aria-label', `Home run alerts: ${S.alerts === 'all' ? 'every homer' : S.alerts === 'follow' ? 'players and teams you follow' : 'off'}`);
  a.title = a.getAttribute('aria-label');
  const t = $('#themeBtn');
  t.innerHTML = S.theme === 'dark' ? ICON.moon : S.theme === 'light' ? ICON.sun : ICON.auto;
  t.setAttribute('aria-label', `Theme: ${S.theme === 'auto' ? 'automatic' : S.theme}`);
  t.title = t.getAttribute('aria-label');
}

// ------------------------------------------------------------ day strip
// The last two weeks as big tappable days, today on the right, plus a calendar for anything older.
// Pinned under the top bar on Live, Homers and Games so switching days is always one tap away.
function renderDays() {
  const nav = $('#days');
  nav.hidden = S.tab === 'following' || !S.today;
  if (nav.hidden) return;
  const sel = S.loading || S.date || S.today;
  const days = Array.from({ length: 14 }, (_, i) => shiftDay(S.today, i - 13));
  if (sel && sel < days[0]) days.unshift(sel);
  const live = S.isToday && S.liveCount > 0;
  const html = days.map((d) => {
    const t = new Date(`${d}T12:00:00`);
    const today = d === S.today;
    const top = today ? 'Today' : d === shiftDay(S.today, -1) ? 'Yest.' : t.toLocaleDateString([], { weekday: 'short' });
    const full = `${today ? 'Today, ' : ''}${dayLabel(d, true)}`;
    return `<button type="button" class="day${today ? ' is-today' : ''}" data-day="${d}" aria-pressed="${d === sel}" aria-label="${esc(full)}">${today && live ? '<i class="ldot" aria-hidden="true"></i>' : ''}<span class="dw">${esc(top)}</span><span class="dn">${t.getDate()}</span></button>`;
  }).join('');
  const strip = $('#dayStrip');
  if (strip.dataset.key !== html) {
    strip.innerHTML = html;
    strip.dataset.key = html;
    // Keep the chosen day in view without moving the page.
    const on = strip.querySelector('[aria-pressed="true"]');
    if (on) strip.scrollLeft = on.offsetLeft - strip.clientWidth / 2 + on.offsetWidth / 2;
  }
  const input = $('#dateInput');
  if (document.activeElement !== input) { input.value = sel || ''; input.max = S.today; }
}

// ------------------------------------------------------------ LIVE
function renderLive() {
  renderBanner();
  renderHead();
  renderAir();
  renderHero();
  renderStrip();
  renderAtBats();
  renderGlance();
  if (typeof mlbHomeHook === 'function') mlbHomeHook(); // odds on the home page (mlbhome.js)
}
function renderBanner() {
  const el = $('#banner');
  const show = isIOS && !isStandalone() && !store.get('bannerDone', false);
  if (!show) { el.innerHTML = ''; return; }
  if (el.dataset.on) return;
  el.dataset.on = '1';
  el.innerHTML = `<div class="card banner"><span class="mark"><i></i></span><p><b>Put it on your Home Screen</b>Tap Share, then Add to Home Screen. It opens full-screen like an app.</p><button class="ibtn" data-act="banner-off" aria-label="Dismiss"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>`;
}
function renderHead() {
  const hrs = homers();
  const games = [...S.games.values()];
  const hits = [...S.events.values()].filter((e) => e.isHit).length;
  const day = S.loading || S.date;
  const next = [...S.games.values()].filter((g) => g.state === 'Preview').sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  const pregame = S.isToday && !S.loading && !hrs.length && games.length && !games.some((g) => g.state === 'Live' || g.state === 'Final');
  let h;
  if (S.loading) h = `Loading ${esc(dayLabel(S.loading))}…`;
  else if (!games.length) h = S.isToday ? 'No games today' : 'No games on this day';
  else if (pregame) h = `<span class="num">${games.length}</span> games today`;
  else if (!hrs.length) h = S.isToday ? 'No home runs yet' : 'No home runs';
  else h = `<span class="num">${hrs.length}</span> home run${hrs.length === 1 ? '' : 's'}${S.isToday ? ' tonight' : ''}`;
  if ($('#headline').innerHTML !== h) $('#headline').innerHTML = h;
  // Which day this page is about, stated above the headline so today and replays never look alike.
  const dl = S.isToday && !S.loading
    ? `${S.liveCount ? '<span class="dot pulse"></span>' : ''}Today · ${esc(dayLabel(day, true))}`
    : `<span class="tag replay">${S.loading ? 'Loading' : 'Replay'}</span>${esc(dayLabel(day, true))}`;
  const dlEl = $('#dayline');
  dlEl.className = `dayline${S.isToday && !S.loading ? ' today' : ''}`;
  if (dlEl.innerHTML !== dl) dlEl.innerHTML = dl;
  // Counts and the back-to-today chip are built once and only their text changes.
  if (!$('#subCounts')) $('#subline').innerHTML = '<span id="subCounts"></span><span id="todaySlot"></span>';
  const parts = S.loading ? [] : pregame
    ? [next && `First pitch ${timeLabel(next.start)}`, 'every home run lands here seconds after it\'s hit, with the video']
    : [`${games.length} game${games.length === 1 ? '' : 's'}`, hits ? `${hits} hits` : ''];
  $('#subCounts').textContent = parts.filter(Boolean).join(' · ');
  const chip = !S.isToday && S.today ? '<button class="today-chip" data-act="today">Back to today</button>' : '';
  if ($('#todaySlot').dataset.key !== chip) { $('#todaySlot').innerHTML = chip; $('#todaySlot').dataset.key = chip; }
  const ev = [...S.events.values()];
  const L = ev.filter((e) => e.dist).sort((a, b) => b.dist - a.dist)[0];
  const H = ev.filter((e) => e.ev).sort((a, b) => b.ev - a.ev)[0];
  const live = games.filter((g) => g.state === 'Live').length;
  S.glance = [
    { v: hrs.length, u: '', l: 'Home runs', s: `Across ${games.length} games`, tab: 'homers' },
    L && { v: L.dist, u: 'ft', l: 'Longest', s: `${L.batter.name}, ${L.team.abbr}`, open: L.id },
    H && { v: H.ev, u: 'mph', l: 'Hardest hit', s: `${H.batter.name}, ${H.team.abbr}`, open: H.id },
    { v: hits, u: '', l: 'Hits', s: live ? `${live} game${live === 1 ? '' : 's'} still going` : 'All games', seg: 'hits' },
  ].filter(Boolean);
  $('#glanceTop').innerHTML = S.loading || !S.events.size ? '' : S.glance.slice(1).map((g) => `<div role="button" tabindex="0" ${g.open ? `data-open="${esc(g.open)}"` : g.seg ? `data-seg-go="${g.seg}"` : ''}><div class="v num">${g.v}${g.u ? `<small>${g.u}</small>` : ''}</div><div class="l">${g.l} · ${esc(g.s.split(',')[0])}</div></div>`).join('');
}
function renderGlance() {
  $('#glanceTitle').textContent = S.isToday && !S.loading ? 'Today at a glance' : `${dayLabel(S.loading || S.date)} at a glance`;
  if (S.loading) { $('#glance').innerHTML = '<div class="empty" style="grid-column:1/-1"><b>Loading…</b></div>'; return; }
  const quiet = S.isToday && !S.events.size;
  $('.sec-glance').hidden = quiet;
  if (quiet) return;
  $('#glance').innerHTML = (S.glance || []).map((g) => `<div role="button" tabindex="0" ${g.open ? `data-open="${esc(g.open)}"` : g.seg ? `data-seg-go="${g.seg}"` : g.tab ? `data-tab="${g.tab}"` : ''}><div class="v num">${g.v}${g.u ? `<small>${g.u}</small>` : ''}</div><div class="l">${g.l}</div><div class="s">${esc(g.s)}</div></div>`).join('');
}

// In the air: Statcast measured the ball, MLB hasn't ruled.
function airHTML() {
  if (!S.isToday || S.loading) return '';
  const list = [...S.pending.values()].map((b) => ({ b, v: verdict(b) })).filter((x) => x.v).slice(0, 2);
  return list.map(({ b, v }) => `<div class="card air">
    <div class="air-top"><span class="lab"><span class="dot pulse"></span>In the air</span><span class="muted">${esc(inningLabel(b))} · ${esc(b.team.abbr)} vs ${esc(b.opp.abbr)}</span></div>
    <div class="air-main">
      ${face(b.batter.id, 40, b.batter.name)}
      <div class="who"><b>${esc(b.batter.name)}</b><span>Statcast has it. MLB hasn't ruled.</span></div>
      <div class="air-dist num">${b.dist ?? '—'}<small>ft</small></div>
    </div>
    <div class="air-foot">
      <span class="num">${b.ev ?? '—'} mph · ${b.la ?? '—'}°${v.wall ? ` · wall ${Math.round(v.wall)} ft` : ''}</span>
      <span style="display:flex;align-items:center;gap:10px"><span class="verdict-scale" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i <= v.k ? 'on' : ''}${i === 3 && v.k === 3 ? ' hot' : ''}"></i>`).join('')}</span><span class="verdict">${esc(v.label)}</span></span>
    </div>
    <div class="wait" aria-hidden="true"></div>
  </div>`).join('');
}
function renderAir() {
  const html = airHTML();
  const slot = isDesk() ? null : $('#airSlot');
  if (slot) { if (slot.dataset.key !== html) { slot.innerHTML = html; slot.dataset.key = html; } }
  else $('#airSlot').innerHTML = '';
  S.airHTML = html;
}

// ---- hero: the latest home run with its clip playing
// The recap's hero: its longest homer that has video, else its longest.
function recapPick(R) {
  const byDist = [...R.hrs].sort((a, b) => (b.dist || 0) - (a.dist || 0));
  return byDist.find((e) => e.video) || byDist[0];
}
function renderHero() {
  const hero = $('#hero');
  const side = $('#heroSide');
  let e = homers()[0];
  // Before today's first homer: show the last day that had some, under its own date.
  const R = !e && S.isToday && !S.loading ? S.recap : null;
  if (!e && S.isToday && !S.loading) {
    if (R?.hrs?.length) e = recapPick(R);
    else loadRecap();
  }
  const recap = !!(R?.hrs?.length && e);
  if (!e) {
    const upcoming = [...S.games.values()].filter((g) => g.state === 'Preview').sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
    const html = `<div class="card detail"><p class="plain">${S.loading ? 'Loading the day…' : S.isToday
      ? `${upcoming ? `First pitch at ${esc(timeLabel(upcoming.start))}.` : 'Waiting for the first one.'} <span class="muted">Leave this open. Every home run shows up here seconds after it's hit, with the video.</span>`
      : 'No home runs on this day.'}</p></div>`;
    if (hero.dataset.key !== html) { hero.innerHTML = html; hero.dataset.key = html; delete hero.dataset.id; }
    const sideHTML = isDesk() ? S.airHTML || '' : '';
    if (side.dataset.key !== sideHTML) { side.innerHTML = sideHTML; side.dataset.key = sideHTML; }
    return;
  }
  const rel = recap ? relDay(R.date) : '';
  const heroId = recap ? `recap:${R.date}:${S.liveCount ? 1 : 0}:${e.id}` : e.id;
  if (hero.dataset.id !== heroId) {
    hero.dataset.id = heroId;
    delete hero.dataset.key;
    // Games under way but no homer yet: say so first (before first pitch the subline already covers it).
    // Then a dated band, so nothing below it can be read as today's.
    const lead = recap ? `${S.liveCount ? `<div class="card pretoday"><span class="dot pulse"></span><p><b>No home runs yet today</b>${S.liveCount} game${S.liveCount === 1 ? '' : 's'} going. The first one shows up here seconds after it's hit.</p></div>` : ''}
      <div class="dayband"><span class="dchip">${esc(rel)}</span><span><b>${esc(dayLabel(R.date, true))}</b> · ${R.hrs.length} home run${R.hrs.length === 1 ? '' : 's'}</span><button type="button" class="more" data-day="${R.date}" data-to="homers">See all</button></div>` : '';
    const label = recap ? `Longest of the night` : S.isToday ? 'Latest home run' : 'Last home run of the day';
    hero.innerHTML = `${lead}<div class="hero-lab"><b>${recap || !S.isToday ? '' : '<span class="dot"></span>'}${label}</b><span class="eyebrow" id="heroWhen"></span></div>
      <div class="frame" id="heroFrame"></div>
      <div id="heroInfo"></div>`;
    setHeroMedia(e, recap ? `${rel} · ${dayLabel(R.date)}` : '');
  } else if (!recap && e.video && $('#heroFrame').dataset.src !== e.video.mp4 && $('#heroFrame').dataset.own !== '1') {
    setHeroMedia(e); // tonight's clip just arrived
  }
  const sp = spotted(e);
  const when = ago(e.t);
  $('#heroWhen').textContent = recap ? `${rel} · ${timeLabel(e.t)}` : S.isToday
    ? `${when}${when !== timeLabel(e.t) ? ` · ${timeLabel(e.t)}` : ''}${sp != null && sp < 120 ? ` · on screen ${sp}s after contact` : ''}`
    : `${dayLabel(S.date)} · ${timeLabel(e.t)}`;
  const tag = persona(e);
  const info = `<div class="who-row">
      <span data-player="${e.batter.id}">${face(e.batter.id, 44, e.batter.name)}</span>
      <div style="min-width:0"><div class="n" data-player="${e.batter.id}">${esc(e.batter.name)}</div><div class="m">${esc(hrKind(e))} · ${esc(e.team.abbr)} vs ${esc(e.opp.abbr)} · ${esc(inningLabel(e))}${e.seasonHR ? ` · No. ${e.seasonHR}` : ''}</div></div>
      ${tag ? `<span class="tag">${esc(tag)}</span>` : ''}
    </div>
    <div class="big3" data-open="${esc(e.id)}" role="button" tabindex="0" aria-label="Full breakdown">
      <div><div class="v num">${e.dist ?? '—'}</div><div class="l">Feet</div></div>
      <div><div class="v num">${e.ev ?? '—'}</div><div class="l">Exit mph<a class="info" href="#learn" data-act="learn" aria-label="What is exit velocity">i</a></div></div>
      <div><div class="v num">${e.la != null ? `${e.la}°` : '—'}</div><div class="l">Launch<a class="info" href="#learn" data-act="learn" aria-label="What is launch angle">i</a></div></div>
    </div>`;
  if ($('#heroInfo').dataset.key !== info) { $('#heroInfo').innerHTML = info; $('#heroInfo').dataset.key = info; }
  const g = game(e.pk);
  const wpTeam = g ? (e.half === 'top' ? g.away : g.home).name : e.team.abbr;
  const pitch = e.pitchMph ? `Off a ${e.pitchMph} mph ${pitchWord({ type: e.pitchName })} from ${esc(e.pitcher?.name || '')}.` : e.pitcher?.name ? `Off ${esc(e.pitcher.name)}.` : '';
  const pl = plainLine(e);
  const detail = `<div class="card detail" data-open="${esc(e.id)}" role="button" tabindex="0" aria-label="Full breakdown of ${esc(e.batter.name)}'s home run">
    <p class="plain">${esc(pl || `${scoreStory(e)}.`)}
      <span class="muted">${pitch} ${e.barrel ? 'Barreled.' : ''} ${pl ? `${esc(scoreStory(e))}.` : ''}</span></p>
    <div class="facts">
      ${miniField(e) || '<span></span>'}
      <div>
        <div class="fact"><div class="k">Parks<a class="info" href="#learn" data-act="learn" aria-label="What are parks">i</a></div><div class="v num">${e.parks != null ? `${e.parks}/30` : S.isToday && e.live ? '…' : '—'}</div>${e.parks != null ? `<div class="parks" aria-hidden="true">${Array.from({ length: 30 }, (_, i) => `<i class="${i < e.parks ? '' : 'off'}"></i>`).join('')}</div>` : `<div class="k">${S.isToday && e.live ? 'Statcast posts this within a minute' : 'Not measured'}</div>`}</div>
        ${e.wp ? `<div class="fact"><div class="k">${esc(wpTeam)} win chance</div><div class="v num">${e.wp.added >= 0 ? '+' : ''}${e.wp.added} <span class="muted" style="font-weight:500">→ ${Math.round(e.wp.after)}%</span></div></div>` : ''}
      </div>
    </div>
  </div>`;
  // The recap also lists the rest of that day's longest, still under its date.
  const more = recap ? [...R.hrs].filter((h) => h.id !== e.id).sort((a, b) => (b.dist || 0) - (a.dist || 0)).slice(0, 5) : [];
  const list = more.length ? `<div class="recap-list"><div class="sub-h">More from ${esc(rel === 'Yesterday' ? 'last night' : dayLabel(R.date))}<span>${esc(dayLabel(R.date))}</span></div>
    <div class="card feed">${more.map((h, i) => hrRow(h, i + 1)).join('')}</div>
    <button type="button" class="btn ghost" data-day="${R.date}" data-to="homers">All ${R.hrs.length} from ${esc(dayLabel(R.date))}</button></div>` : '';
  const sideHTML = (isDesk() ? S.airHTML || '' : '') + detail + list;
  if (side.dataset.key !== sideHTML) { side.innerHTML = sideHTML; side.dataset.key = sideHTML; }
}
// The clip: tonight's if MLB has posted it, otherwise this player's most recent homer, labeled.
async function setHeroMedia(e, dateTag = '') {
  const frame = $('#heroFrame');
  if (!frame) return;
  let clip = e.video ? { ...e.video, own: true } : null;
  if (!clip) {
    frame.innerHTML = `<div class="noclip"><div>${face(e.batter.id, 96, e.batter.name)}Finding the clip…</div></div>`;
    const v = await latestClip(e.batter.id);
    if (!($('#hero').dataset.id || '').endsWith(e.id)) return; // a newer homer (or day) took the hero meanwhile
    if (v && v.playId === e.id) clip = { ...v, own: true };
    else if (v) clip = { ...v, own: false };
  }
  if (!clip) {
    frame.dataset.src = '';
    frame.innerHTML = `<div class="noclip"><div>${face(e.batter.id, 96, e.batter.name)}MLB usually posts the video 10–20 minutes after the play.<br>It will start playing here on its own.</div></div>`;
    return;
  }
  if (frame.dataset.src === clip.mp4) return;
  frame.dataset.src = clip.mp4;
  frame.dataset.own = clip.own ? '1' : '0';
  const dur = (clip.dur || '').replace(/^00:0?/, '');
  // A clip from another day always says which day it's from.
  const label = dateTag ? `<span class="fallback">${esc(dateTag)}</span>` : clip.own ? '' : `<span class="fallback">Their last homer · ${esc(dayLabel(clip.date))}${clip.opp ? ` vs ${esc(clip.opp)}` : ''}</span>`;
  frame.innerHTML = `${clip.thumb ? `<img class="poster" src="${esc(clip.thumb)}" alt="">` : ''}
    <video id="heroVideo" autoplay ${S.muted ? 'muted' : ''} loop playsinline preload="auto" ${clip.thumb ? `poster="${esc(clip.thumb)}"` : ''} src="${esc(clip.mp4)}" aria-label="${esc(clip.title || 'Home run clip')}"></video>
    ${label}
    <button class="ctl watch" data-open="${esc(e.id)}" data-play="1">${ICON.play}Watch full clip${dur ? ` <span class="faint">${esc(dur)}</span>` : ''}</button>
    <button class="ctl mute" data-act="mute" aria-label="${S.muted ? 'Unmute clip' : 'Mute clip'}" aria-pressed="${!S.muted}">${S.muted ? ICON.muted : ICON.sound}</button>`;
  const v = $('#heroVideo');
  v.muted = S.muted;
  v.addEventListener('playing', () => { const p = frame.querySelector('.poster'); if (p) p.style.opacity = 0; });
  const tapToPlay = () => {
    // Autoplay blocked (e.g. Low Power Mode): offer a tap to play.
    if (frame.querySelector('.tapplay')) return;
    const b = document.createElement('button');
    b.className = 'tapplay';
    b.setAttribute('aria-label', 'Play clip');
    b.innerHTML = `<span>${ICON.play}</span>`;
    b.addEventListener('click', () => { v.play().then(() => b.remove()).catch(() => {}); });
    frame.appendChild(b);
  };
  v.play().catch((err) => {
    // Sound needs a tap on iPhone; a new clip arriving on its own has to start muted.
    if (!v.muted && err?.name === 'NotAllowedError') {
      v.muted = S.muted = true;
      const m = frame.querySelector('.mute');
      if (m) { m.innerHTML = ICON.muted; m.setAttribute('aria-label', 'Unmute clip'); m.setAttribute('aria-pressed', 'false'); }
      v.play().catch(tapToPlay);
      return;
    }
    tapToPlay();
  });
}

function renderStrip() {
  const order = [...S.games.values()].sort((a, b) => ({ Live: 0, Preview: 1, Final: 2 }[a.state] ?? 3) - ({ Live: 0, Preview: 1, Final: 2 }[b.state] ?? 3) || Date.parse(a.start) - Date.parse(b.start));
  const html = S.loading ? '<p class="muted" style="margin:0">Loading games…</p>' : order.map((g) => {
    const live = g.state === 'Live';
    const off = isOff(g);
    const fin = g.state === 'Final' && !off;
    const pre = g.state === 'Preview';
    const aw = g.away.score > g.home.score, hw = g.home.score > g.away.score;
    const sc = (v) => (pre || off || v == null ? '' : v);
    return `<button class="gm ${live ? 'live' : ''}" data-game="${g.pk}" aria-label="${esc(g.away.abbr)} at ${esc(g.home.abbr)}, ${esc(gameStatus(g))}">
      <div class="gm-h">${live ? '<span class="dot"></span>' : ''}${esc(gameStatus(g))}</div>
      <div class="gm-r ${fin && !aw ? 'lose' : ''}">${logo(g.away.id)}${esc(g.away.abbr)}<b class="num">${sc(g.away.score)}</b></div>
      <div class="gm-r ${fin && !hw ? 'lose' : ''}">${logo(g.home.id)}${esc(g.home.abbr)}<b class="num">${sc(g.home.score)}</b></div>
    </button>`;
  }).join('') || '<p class="muted" style="margin:0">No games scheduled.</p>';
  const strip = $('#strip');
  if (strip.dataset.key !== html) { strip.innerHTML = html; strip.dataset.key = html; }
  const live = order.filter((g) => g.state === 'Live').length;
  const fin = order.filter((g) => g.state === 'Final').length;
  $('#scoresTitle').textContent = S.isToday && !S.loading ? 'Today\'s games' : `Games · ${dayLabel(S.loading || S.date)}`;
  $('#scoreMeta').textContent = S.loading ? '' : [live && `${live} live`, fin && `${fin} final`, order.length - live - fin && `${order.length - live - fin} later`].filter(Boolean).join(' · ');
}

function abCard(pk, ab, i = 0) {
  const g = game(pk);
  if (!g || !ab) return '';
  const p = ab.pitches[ab.pitches.length - 1];
  const zone = ab.pitches.length ? zoneSVG(ab.pitches, false) : '<div class="zone-empty">No pitches yet</div>';
  const say = ab.result
    ? `<b style="font-weight:600">${esc(ab.result.event)}.</b> <span class="muted">${esc(story(ab))}</span>`
    : `${esc(lastPitch(p))} <span class="muted">${esc(story(ab))}</span>`;
  const s = ab.batter.season;
  const fol = followsPlayer(ab.batter.id);
  return `<article class="card ab" data-game="${pk}">
    <div class="ab-top">
      <span class="sc">${logo(g.away.id)}${esc(g.away.abbr)} <span class="num">${g.away.score ?? 0}</span></span>
      <span class="sc">${logo(g.home.id)}${esc(g.home.abbr)} <span class="num">${g.home.score ?? 0}</span></span>
      <span class="inn"><span class="dot${i === 0 ? ' pulse' : ''}"></span>${esc(inningLabel(ab))}</span>
    </div>
    <div class="ab-mid">
      <div class="l">
        <div class="bat"><span data-player="${ab.batter.id}">${face(ab.batter.id, 48, ab.batter.name)}</span><div style="min-width:0"><div class="n" data-player="${ab.batter.id}">${fol ? '★ ' : ''}${esc(ab.batter.name)}</div><div class="m">${esc(ab.batter.today || 'First time up')}${ab.batter.today ? ' today' : ''}</div>${s ? `<div class="m faint">${esc(s.avg)} · ${s.hr} HR · ${esc(s.ops)} OPS</div>` : ''}</div></div>
        <div class="pit">vs ${face(ab.pitcher.id, 24, ab.pitcher.name)}<span><b>${esc(ab.pitcher.name)}</b>${ab.pitcher.pitches ? ` · ${ab.pitcher.pitches} pitches` : ''}</span></div>
      </div>
      ${zone}
    </div>
    <div class="count"><span class="c num">${ab.balls}–${Math.min(ab.strikes, 2)}</span>${lights(ab)}${diamond(ab.bases)}</div>
    <p class="ab-say" style="margin-bottom:0">${say}</p>
    <div class="ab-foot"><span>${ab.onDeck ? `On deck: ${esc(ab.onDeck.name)}` : '&nbsp;'}</span><button class="more" data-game="${pk}" style="color:var(--ink);font-weight:500">Open game</button></div>
  </article>`;
}
// Followed batters first, then the tensest spots.
function abOrder() {
  const weight = ([pk, ab]) => {
    const g = game(pk);
    const diff = Math.abs((g?.away.score ?? 0) - (g?.home.score ?? 0));
    const on = ['first', 'second', 'third'].filter((k) => ab.bases?.[k]).length;
    return (followsPlayer(ab.batter?.id) || followsTeam(ab.team?.id) ? 100 : 0) + (ab.inning || 0) * 2 + (diff <= 1 ? 8 : diff <= 3 ? 3 : 0) + on * 2;
  };
  return [...S.atbats].filter(([pk]) => game(pk)?.state === 'Live').sort((a, b) => weight(b) - weight(a));
}
function renderAtBats() {
  const list = abOrder();
  const sec = $('#absSec');
  if (!S.isToday || S.loading || !list.length) { sec.hidden = true; $('#abMeta').textContent = ''; return; }
  sec.hidden = false;
  const html = list.length ? list.map(([pk, ab], i) => abCard(pk, ab, i)).join('')
    : `<div class="card empty"><b>No games live right now</b>${(() => { const n = [...S.games.values()].filter((g) => g.state === 'Preview').sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0]; return n ? `Next first pitch at ${esc(timeLabel(n.start))}: ${esc(n.away.abbr)} at ${esc(n.home.abbr)}.` : 'Every at-bat shows up here, pitch by pitch.'; })()}</div>`;
  const el = $('#abs');
  if (el.dataset.key !== html) { el.innerHTML = html; el.dataset.key = html; }
  if (!list.length) $('#abMeta').textContent = '';
}

// ------------------------------------------------------------ HOMERS
function hrRow(h, i) {
  return `<div class="hr ${i === 0 && S.sort === 'new' ? 'now' : ''} ${S.fresh.has(h.id) ? 'fresh' : ''}" data-open="${esc(h.id)}" role="button" tabindex="0">
    <div class="fw">${face(h.batter.id, 44, h.batter.name)}<span class="tdot" style="background:${TC[h.team.id] || 'var(--ink-3)'}"></span></div>
    <div style="min-width:0">
      <div class="n">${esc(h.batter.name)}</div>
      <div class="m">${esc(kindShort(h))} · ${esc(h.team.abbr)} vs ${esc(h.opp.abbr)} · ${esc(timeLabel(h.t))}</div>
      <div class="m m2 num" style="letter-spacing:0">${h.ev ?? '—'} mph · ${h.la ?? '—'}° · ${h.parks != null ? `${h.parks}/30 parks` : 'parks soon'}</div>
    </div>
    <div class="d"><div class="v num">${h.dist ?? '—'}<small>ft</small></div>${h.video ? `<span class="c">${ICON.play}Clip</span>` : ''}</div>
    <div class="cols"><span class="num dist">${h.dist ?? '—'} ft</span><span class="num">${h.ev ?? '—'} mph</span><span class="num">${h.la ?? '—'}°</span><span class="num">${h.parks != null ? `${h.parks}/30` : '…'}</span></div>
    <div class="clip">${h.video ? `<span class="tag" style="height:28px;padding:0 10px;gap:5px">${ICON.play.replace('<svg', '<svg style="width:10px;height:10px"')}${esc((h.video.dur || 'Clip').replace(/^00:0?/, ''))}</span>` : ''}</div>
  </div>`;
}
const SORTS = { new: byTime, long: (a, b) => (b.dist || 0) - (a.dist || 0), hard: (a, b) => (b.ev || 0) - (a.ev || 0) };
function pills(name, opts, cur) {
  return `<div class="pills" role="group">${opts.map(([k, l, dot]) => `<button class="pbtn" data-${name}="${k}" aria-pressed="${cur === k}">${dot ? `<i style="background:${dot}"></i>` : ''}${l}</button>`).join('')}</div>`;
}
function board(title, sub, rows, empty = 'Nothing yet.') {
  return `<section class="card board"><div class="bh"><h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
    ${rows.length ? rows.map((r, i) => `<div class="row2 ${r.hl ? 'hl' : ''}" ${r.attr ? `${r.attr} role="button" tabindex="0"` : ''}>${r.id ? face(r.id, 36, r.name) : `<span class="rk">${i + 1}</span>`}<div style="min-width:0"><div class="n">${esc(r.name)}</div><div class="m">${r.sub || ''}</div>${r.pct != null ? `<div class="bar"><i style="width:${clamp(r.pct, 0.04, 1) * 100}%"></i></div>` : ''}</div><div class="v num">${r.value}</div></div>`).join('') : `<div class="none">${esc(empty)}</div>`}
  </section>`;
}
function renderHomers() {
  $$('#homersSeg [data-seg]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.seg === S.seg)));
  if (S.loading && S.seg !== 'season') {
    const html = '<div class="card empty"><b>Loading…</b></div>';
    if ($('#homersBody').dataset.key !== html) { $('#homersBody').innerHTML = html; $('#homersBody').dataset.key = html; }
    $('#homersSub').textContent = '';
    return;
  }
  const ev = [...S.events.values()];
  const hrs = ev.filter((e) => e.isHR);
  const body = $('#homersBody');
  let html = '';
  if (S.seg === 'tonight') {
    $('#homersTitle').textContent = 'Home runs';
    $('#homersSub').textContent = hrs.length ? `${hrs.length} ${S.isToday ? 'so far today' : 'on the day'}. Tap one for the video and full breakdown.` : '';
    const list = [...hrs].sort(SORTS[S.sort]);
    html = pills('sort', [['new', 'Newest'], ['long', 'Longest'], ['hard', 'Hardest hit']], S.sort)
      + (list.length ? `<div class="card feed"><div class="feed-h"><span></span><span style="text-align:left">Player</span><span>Distance</span><span>Exit velo</span><span>Angle</span><span>Parks</span><span>Clip</span></div>${list.map(hrRow).join('')}</div>`
        : `<div class="card empty"><b>No home runs ${S.isToday ? 'yet' : 'this day'}</b>${S.isToday ? 'They show up here seconds after they land.' : ''}</div>`);
  } else if (S.seg === 'hits') {
    $('#homersTitle').textContent = 'All hits';
    const hits = ev.filter((e) => e.isHit && (S.kind === 'all' || e.kind === S.kind)).sort(SORTS[S.sort]);
    $('#homersSub').textContent = `${ev.filter((e) => e.isHit).length} hits. Singles, doubles, triples and homers as they happen.`;
    html = pills('kind', [['all', 'All'], ['single', 'Singles'], ['double', 'Doubles'], ['triple', 'Triples'], ['home_run', 'Homers']], S.kind)
      + (hits.length ? `<div class="card feed">${hits.slice(0, 200).map((e) => `<div class="row2" data-open="${esc(e.id)}" role="button" tabindex="0">${face(e.batter.id, 36, e.batter.name)}<div style="min-width:0"><div class="n">${esc(e.batter.name)}</div><div class="m"><span class="kdot k-${e.kind}"></span>${esc(kindLabel(e))} · ${esc(e.team.abbr)} vs ${esc(e.opp.abbr)} · ${esc(inningLabel(e))}</div></div><div class="v num">${e.ev ?? '—'}<small>mph</small></div></div>`).join('')}</div>` : '<div class="card empty"><b>No hits here yet</b></div>');
  } else if (S.seg === 'statcast') {
    $('#homersTitle').textContent = 'Statcast';
    $('#homersSub').textContent = 'The measurements behind every swing and pitch.';
    const bip = ev.filter((e) => e.ev || e.dist);
    const hard = bip.filter((e) => e.ev).sort((a, b) => b.ev - a.ev).slice(0, 8);
    const long = bip.filter((e) => e.dist).sort((a, b) => b.dist - a.dist).slice(0, 8);
    const almost = bip.filter((e) => !e.isHR && ((e.parks ?? 0) >= 1 || (e.parks == null && e.dist >= 385))).sort((a, b) => (b.parks ?? 0) - (a.parks ?? 0) || b.dist - a.dist).slice(0, 8);
    const per = {};
    hrs.forEach((e) => { per[e.batter.id] = per[e.batter.id] || { e, n: 0 }; per[e.batter.id].n++; });
    const multi = Object.values(per).filter((x) => x.n > 1).sort((a, b) => b.n - a.n);
    const evRow = (e, value, pct, sub) => ({ id: e.batter.id, name: e.batter.name, sub: `${esc(kindLabel(e))} · ${esc(e.team.abbr)}${sub ? ` · ${sub}` : ''}`, value, pct, hl: e.isHR, attr: `data-open="${esc(e.id)}"` });
    html = `<div class="boards" style="margin-top:var(--s2)">
      ${board('Hardest-hit balls', 'How fast the ball left the bat.', hard.map((e) => evRow(e, `${e.ev}<small>mph</small>`, (e.ev - 85) / ((hard[0]?.ev || 100) - 85), e.dist ? `${e.dist} ft` : '')))}
      ${board('Longest drives', 'Homers or not.', long.map((e) => evRow(e, `${e.dist}<small>ft</small>`, (e.dist - 300) / ((long[0]?.dist || 400) - 300), e.ev ? `${e.ev} mph` : '')))}
      ${board('Almost homers', 'Stayed in the park here, gone somewhere else.', almost.map((e) => evRow(e, e.parks != null ? `${e.parks}<small>/30</small>` : `${e.dist}<small>ft</small>`, e.parks != null ? e.parks / 30 : null, e.dist ? `${e.dist} ft` : '')), 'No near misses yet.')}
      ${board('Fastest pitches', '100 mph is elite.', S.pitches.slice(0, 8).map((p) => ({ id: p.pitcher.id, name: p.pitcher.name, sub: `${esc(p.team || '')} · ${esc(p.type || '')} to ${esc(p.batter.name || '')}`, value: `${p.mph}<small>mph</small>`, pct: (p.mph - 94) / ((S.pitches[0]?.mph || 100) - 94) })), 'Pitch speeds arrive a few seconds after each pitch.')}
      ${board('Fastest swings', 'Most big leaguers swing about 72 mph.', S.swings.slice(0, 8).map((w) => ({ id: w.batter.id, name: w.batter.name, sub: `${esc(w.team || '')} · ${esc(w.result || '')}`, value: `${w.mph}<small>mph</small>`, pct: (w.mph - 70) / ((S.swings[0]?.mph || 80) - 70), attr: `data-player="${w.batter.id}"` })), 'Bat speed arrives during games.')}
      ${board('Multi-homer games', 'Two in one game is a big night.', multi.map((x) => ({ id: x.e.batter.id, name: x.e.batter.name, sub: esc(x.e.team.abbr), value: `${x.n}<small>HR</small>`, hl: true, attr: `data-player="${x.e.batter.id}"` })), 'Nobody has two yet.')}
    </div>`;
  } else {
    $('#homersTitle').textContent = `Season ${(S.date || '').slice(0, 4)}`;
    $('#homersSub').textContent = 'The leaders, updated through tonight.';
    html = seasonHTML();
  }
  if (body.dataset.key !== html) { body.innerHTML = html; body.dataset.key = html; }
}
function seasonHTML() {
  const season = (S.date || '').slice(0, 4);
  if (!S.leaders || S.leaders.season !== season || Date.now() - S.leadersAt > 3 * 60e3) {
    if (!S.leadersLoading) {
      S.leadersLoading = true;
      fetch(`api/leaders?season=${season}`).then((r) => r.json()).then((d) => { S.leaders = d; S.leadersAt = Date.now(); })
        .catch(() => {}).finally(() => { S.leadersLoading = false; invalidate(); });
    }
    if (!S.leaders || S.leaders.season !== season) return '<div class="card empty"><b>Loading the leaders…</b></div>';
  }
  const todayHR = new Set(homers().map((e) => e.batter.id));
  const mk = (key, title, sub, unit) => {
    const rows = (S.leaders.cats?.[key] || []).slice(0, 10);
    const top = rows[0]?.value || 1;
    return board(title, sub, rows.map((l) => ({ id: l.id, name: l.name, sub: `${esc(l.abbr || '')}${key === 'homeRuns' && todayHR.has(l.id) && S.isToday ? ' · <b style="color:var(--accent);font-weight:600">homered today</b>' : ''}`, value: `${l.value}<small>${unit}</small>`, pct: l.value / top, attr: `data-player="${l.id}"` })));
  };
  return `<div class="boards" style="margin-top:var(--s2)">
    ${mk('homeRuns', 'Home runs', 'The home run race.', 'HR')}
    ${mk('hits', 'Hits', 'Reaching base on a batted ball.', 'H')}
    ${mk('runsBattedIn', 'Runs batted in', 'Runs that scored because of the batter.', 'RBI')}
    ${mk('stolenBases', 'Stolen bases', 'Taking the next base on a pitch.', 'SB')}
  </div>`;
}

// ------------------------------------------------------------ GAMES
function gameCard(g) {
  const off = isOff(g);
  const live = g.state === 'Live' && !/suspend/i.test(g.detail || ''), fin = g.state === 'Final' && !off, pre = g.state === 'Preview';
  const aw = g.away.score > g.home.score, hw = g.home.score > g.away.score;
  const n = [...S.events.values()].filter((e) => e.isHR && e.pk === g.pk).length;
  const ab = S.atbats.get(g.pk);
  const sc = (v) => (pre || off || v == null ? '' : v);
  const wp = g.wp != null && live ? (g.wp >= 50 ? `${g.home.abbr} ${Math.round(g.wp)}% to win` : `${g.away.abbr} ${Math.round(100 - g.wp)}% to win`) : '';
  return `<button class="card gcard" data-game="${g.pk}">
    <div class="gh">${live ? '<span class="dot"></span>' : ''}${esc(gameStatus(g))}${wp ? ` · ${esc(wp)}` : ''}${n ? `<span class="hrs" aria-label="${n} home runs">${'<i></i>'.repeat(Math.min(n, 6))}${n > 6 ? `+${n - 6}` : ''}</span>` : ''}</div>
    <div class="tr ${fin && !aw ? 'lose' : ''}">${logo(g.away.id)}<span class="nm">${esc(g.away.name || g.away.abbr)}</span><b class="num">${sc(g.away.score)}</b></div>
    <div class="tr ${fin && !hw ? 'lose' : ''}">${logo(g.home.id)}<span class="nm">${esc(g.home.name || g.home.abbr)}</span><b class="num">${sc(g.home.score)}</b></div>
    ${live && ab ? `<div class="now">${diamond(ab.bases)}<span><b>${esc(ab.batter.name)}</b> vs ${esc(ab.pitcher.name)} · ${ab.balls}–${Math.min(ab.strikes, 2)}, ${ab.outs} out</span></div>` : ''}
    ${pre ? `<div class="now"><span>${esc(g.venue?.name || '')}</span></div>` : ''}
  </button>`;
}
function renderGames() {
  const order = [...S.games.values()].sort((a, b) => ({ Live: 0, Preview: 1, Final: 2 }[a.state] ?? 3) - ({ Live: 0, Preview: 1, Final: 2 }[b.state] ?? 3) || Date.parse(a.start) - Date.parse(b.start));
  $('#gamesSub').textContent = S.loading ? 'Loading…' : `${dayLabel(S.date, true)} · ${order.length} game${order.length === 1 ? '' : 's'}. ${store.get('gamesView', 'scores') === 'odds' ? 'Prices from every book, best first. Tap a price to log a bet.' : 'Tap one for every at-bat.'}`;
  const html = S.loading ? '<div class="card empty"><b>Loading games…</b></div>'
    : order.map(gameCard).join('') || `<div class="card empty"><b>No games ${S.isToday ? 'today' : 'on this day'}</b>Pick another day from the Live tab.</div>`;
  const el = $('#gamesList');
  if (el.dataset.key !== html) { el.innerHTML = html; el.dataset.key = html; }
  if (typeof oddsGamesHook === 'function') oddsGamesHook(); // betting stack (odds.js / bets.js)
}

// ------------------------------------------------------------ FOLLOWING
function renderFollowing() {
  const body = $('#followBody');
  if (S.followData === null && S.follow.players.length) { refreshFollowing(); }
  if (!S.teamsList) loadTeams().then(invalidate);
  const players = (S.followData || []).map((p) => ({ ...p, live: liveStatus(p.id) }))
    .sort((a, b) => (b.live?.hot ? 2 : b.live ? 1 : 0) - (a.live?.hot ? 2 : a.live ? 1 : 0));
  const status = (p) => {
    if (p.live) return { text: p.live.text, hot: p.live.hot, pk: p.live.pk };
    const g = p.game;
    if (!g) return { text: 'No game today' };
    if (g.state === 'Live') return { text: gameStatus(g), dot: true, pk: g.pk };
    if (g.state === 'Preview') return { text: `Plays ${timeLabel(g.start)}`, pk: g.pk };
    return { text: gameStatus(g), pk: g.pk };
  };
  const cards = players.map((p) => {
    const st = status(p);
    const opp = p.game ? (p.game.away.id === p.teamId ? p.game.home : p.game.away) : null;
    const s = p.season || {};
    return `<div class="card fp" data-player="${p.id}" role="button" tabindex="0">
      ${face(p.id, 52, p.name)}
      <div style="min-width:0"><div class="n">${esc(p.name || S.follow.names[p.id] || 'Player')}</div><div class="m">${[p.abbr, p.pos, opp && `vs ${opp.abbr}`].filter(Boolean).map(esc).join(' · ')}</div></div>
      <span class="st ${st.hot ? 'hot' : ''}">${st.hot || st.dot ? '<span class="dot"></span>' : ''}${esc(st.text)}</span>
      <div class="line"><b class="num">${esc(p.line || (!p.game ? '—' : p.game.state === 'Final' ? (p.pos === 'P' ? 'Didn\'t bat' : 'Didn\'t play') : p.pos === 'P' ? (p.status === 'pitching' ? 'Pitching now' : 'Not in yet') : 'Not up yet'))}</b><span class="num">${p.pitching ? `${esc(p.pitching.era)} ERA · ${p.pitching.k} K` : s.avg ? `${esc(s.avg)} · ${s.hr} HR · ${esc(s.ops)} OPS` : ''}</span></div>
    </div>`;
  }).join('');
  const teams = S.teamsList || [];
  const mine = teams.filter((t) => followsTeam(t.id));
  const teamGames = [...S.games.values()].filter((g) => followsTeam(g.away.id) || followsTeam(g.home.id));
  const suggest = [...new Map(homers().map((e) => [e.batter.id, e])).values()].filter((e) => !followsPlayer(e.batter.id)).slice(0, 6);
  const html = `
    ${S.follow.players.length ? `<div class="fol">${cards || '<div class="card empty"><b>Loading your players…</b></div>'}</div>` : ''}
    ${suggest.length ? `<div class="card suggest" style="margin-top:12px"><h3>${S.follow.players.length ? 'More players to follow' : 'Start with tonight\'s home run hitters'}</h3><p>You'll see when they come up to bat, and get their homers first.</p>${suggest.map((e) => `<div class="row2">${face(e.batter.id, 36, e.batter.name)}<div style="min-width:0"><div class="n">${esc(e.batter.name)}</div><div class="m">${esc(e.team.abbr)} · ${e.dist ? `${e.dist} ft homer` : 'homered'}</div></div><button class="fbtn" data-follow="${e.batter.id}" data-name="${esc(e.batter.name)}">Follow</button></div>`).join('')}</div>` : ''}
    ${!S.follow.players.length && !suggest.length ? '<div class="card empty"><b>Follow your players</b>Tap any player, then Follow. You\'ll see when they\'re up to bat and get their homers first.</div>' : ''}
    <div class="card teams">
      <div class="sub-h" style="margin:0">Your teams<span>${mine.length ? `${mine.length} followed` : 'Tap a logo to follow'}</span></div>
      <div class="all">${teams.map((t) => `<button class="tm ${followsTeam(t.id) ? 'on' : ''}" data-team="${t.id}" aria-pressed="${followsTeam(t.id)}" title="${esc(t.name)}" aria-label="${esc(t.name)}">${logo(t.id, '', t.abbr)}</button>`).join('')}</div>
      ${S.follow.players.length || S.follow.teams.length ? `<button class="btn" data-act="share">${ICON.share}Share my lineup</button>` : ''}
    </div>
    ${teamGames.length ? `<div class="sec-h" style="margin-top:var(--s4)"><h2>Your teams today</h2></div><div class="games">${teamGames.map(gameCard).join('')}</div>` : ''}`;
  if (body.dataset.key !== html) { body.innerHTML = html; body.dataset.key = html; }
  if (typeof betsMineHook === 'function') betsMineHook(); // betting stack (odds.js / bets.js)
}
