'use strict';
/* Bing Bong Live — sheets: home run breakdown, player, live game, phone, import. */

const dlg = $('#dlg');
function openSheet(html, kind) {
  // Only one sheet is open at a time; forget what the others were tracking.
  if (kind !== 'game') { S.gameOpen = null; S.gameData = null; }
  if (kind !== 'event') S.eventOpen = null;
  if (kind !== 'player') S.playerOpen = null;
  $('#dlgBody').innerHTML = html;
  S.dlgKind = kind;
  if (!dlg.open) dlg.showModal();
  $('#dlgIn').scrollTop = 0;
}
function closeSheet() { if (dlg.open) dlg.close(); }
dlg.addEventListener('close', () => {
  $$('#dlgBody video').forEach((v) => v.pause());
  $('#dlgBody').innerHTML = '';
  S.gameOpen = null; S.gameData = null; S.dlgKind = null; S.eventOpen = null; S.playerOpen = null;
});
// Remember which innings are expanded in a game's at-bat log, so live refreshes don't collapse them.
$('#dlgBody').addEventListener('toggle', (ev) => {
  const d = ev.target;
  if (!d.matches?.('details[data-key]') || !S.openInnings) return;
  if (d.open) S.openInnings.add(d.dataset.key); else S.openInnings.delete(d.dataset.key);
}, true);
const chartW = () => (isDesk() ? 640 : 360);
dlg.addEventListener('click', (ev) => { if (ev.target === dlg) closeSheet(); });
$('#dlgClose').addEventListener('click', closeSheet);
const kv = (k, v, x) => `<div><div class="k">${k}</div><div class="v num">${v ?? '—'}</div>${x ? `<div class="x">${x}</div>` : ''}</div>`;
const videoTag = (clip, { autoplay = false, muted = false } = {}) => `<div class="frame">${clip.thumb ? `<img class="poster" src="${esc(clip.thumb)}" alt="">` : ''}<video controls playsinline ${autoplay ? 'autoplay' : ''} ${muted ? 'muted loop' : ''} preload="metadata" ${clip.thumb ? `poster="${esc(clip.thumb)}"` : ''} src="${esc(clip.mp4)}" aria-label="${esc(clip.title || 'Home run clip')}"></video></div>`;
function wireVideos() {
  $$('#dlgBody video').forEach((v) => v.addEventListener('playing', () => { const p = v.parentElement.querySelector('.poster'); if (p) p.style.opacity = 0; }));
}

// ------------------------------------------------------------ one play, fully broken down
const eventMedia = (e, c, play) => (c
  ? `${videoTag(c, { autoplay: true, muted: !play })}${c.own ? '' : `<p class="wp-note">This play's clip isn't posted yet. This is ${esc(e.batter.name)}'s last homer, ${esc(dayLabel(c.date))}${c.opp ? ` vs ${esc(c.opp)}` : ''}.</p>`}`
  : `<div class="frame"><div class="noclip"><div>${face(e.batter.id, 96, e.batter.name)}MLB usually posts the video 10–20 minutes after the play. It will show up here.</div></div></div>`);
function eventDetailHTML(e) {
  const g = game(e.pk);
  const a = sprayAngle(e);
  const wall = a != null && e.dist >= 250 ? wallFn(g?.venue?.field)(clamp(a, -45, 45)) : null;
  const sim = e.ev && e.la != null && e.dist && e.la > 5 ? simulate(e.ev, e.la, e.dist) : null;
  const wpTeam = g ? (e.half === 'top' ? g.away : g.home).name : e.team.abbr;
  return `<p class="plain">${esc(plainLine(e) || e.desc)}${e.ev ? `<span class="muted">It left the bat at ${e.ev} mph, ${highway(e.ev)}.${sim ? ` It flew about ${Math.round(sim.apex)} feet high and hung in the air for about ${f1(sim.t)} seconds.` : ''}</span>` : ''}</p>
    ${sim ? flightSVG(e, wall, chartW()) : ''}
    <div class="facts">
      ${miniField(e) || '<span></span>'}
      <div>
        <div class="fact"><div class="k">Parks</div><div class="v num">${e.parks != null ? `${e.parks}/30` : e.isHR && S.isToday && e.live ? '…' : '—'}</div>${e.parks != null ? `<div class="parks" aria-hidden="true">${Array.from({ length: 30 }, (_, i) => `<i class="${i < e.parks ? '' : 'off'}"></i>`).join('')}</div>` : ''}</div>
        ${e.wp ? `<div class="fact"><div class="k">${esc(wpTeam)} win chance</div><div class="v num">${e.wp.added >= 0 ? '+' : ''}${e.wp.added} <span class="muted" style="font-weight:500">→ ${Math.round(e.wp.after)}%</span></div></div>` : ''}
      </div>
    </div>`;
}
const eventKvHTML = (e) => `${kv('xBA', e.xba != null ? e.xba.toFixed(3).replace(/^0/, '') : null, e.xba != null ? `A hit ${Math.round(e.xba * 100)}% of the time` : 'Expected batting average')}
  ${kv('Barrel', e.barrel == null ? null : e.barrel ? 'Yes' : 'No', 'Ideal speed and angle')}
  ${kv('Bat speed', e.bat ? `${e.bat} mph` : null, 'Average is about 72 mph')}
  ${kv('Pitch', e.pitchMph ? `${e.pitchMph} mph` : null, esc([e.pitchName, e.pitcher?.name && `from ${e.pitcher.name}`].filter(Boolean).join(' ')))}`;
// A play's numbers and clip keep arriving after it happens; fill them in while the sheet is open.
function updateEventSheet(e) {
  if (S.dlgKind !== 'event' || S.eventOpen !== e.id) return;
  const m = $('#evMedia');
  if (m && e.video && m.dataset.own !== '1') { m.innerHTML = eventMedia(e, { ...e.video, own: true }, false); m.dataset.own = '1'; wireVideos(); }
  const d = $('#evDetail'), k = $('#evKv');
  const dh = eventDetailHTML(e), kh = eventKvHTML(e);
  if (d && d.dataset.key !== dh) { d.innerHTML = dh; d.dataset.key = dh; }
  if (k && k.dataset.key !== kh) { k.innerHTML = kh; k.dataset.key = kh; }
}
async function openEvent(id, play = false) {
  const e = S.events.get(id) || T.events.get(id) || S.recap?.events?.get(id);
  if (!e) return;
  let clip = e.video ? { ...e.video, own: true } : null;
  const media = (c) => eventMedia(e, c, play);
  const tag = persona(e);
  const fol = followsPlayer(e.batter.id);
  openSheet(`
    <div class="hero-lab"><b><span class="dot"></span>${esc(kindLabel(e))}</b><span class="eyebrow">${esc(ago(e.t))} · ${esc(inningLabel(e))}</span></div>
    <div class="ev-grid">
      <div>
        <div id="evMedia" data-own="${clip ? '1' : '0'}">${media(clip)}</div>
        <div class="who-row">
          <span data-player="${e.batter.id}">${face(e.batter.id, 44, e.batter.name)}</span>
          <div style="min-width:0"><h2 id="dlgTitle" class="n" data-player="${e.batter.id}">${esc(e.batter.name)}</h2><div class="m">${esc(e.team.abbr)} vs ${esc(e.opp.abbr)} · ${esc(scoreStory(e))}${e.seasonHR ? ` · No. ${e.seasonHR} this season` : ''}</div></div>
          ${tag ? `<span class="tag">${esc(tag)}</span>` : ''}
        </div>
        <div class="big3">
          <div><div class="v num">${e.dist ?? '—'}</div><div class="l">Feet</div></div>
          <div><div class="v num">${e.ev ?? '—'}</div><div class="l">Exit mph</div></div>
          <div><div class="v num">${e.la != null ? `${e.la}°` : '—'}</div><div class="l">Launch</div></div>
        </div>
      </div>
      <div>
        <div class="card detail" id="evDetail" style="margin-top:var(--s3)">${eventDetailHTML(e)}</div>
      </div>
    </div>
    <div class="kv" id="evKv">${eventKvHTML(e)}</div>
    <p class="quote">“${esc(e.desc)}”</p>
    <div class="links">
      <button class="lbtn" data-follow="${e.batter.id}" data-name="${esc(e.batter.name)}">${fol ? '★ Following' : '☆ Follow'} ${esc(e.batter.name.split(' ').slice(-1)[0])}</button>
      <button class="lbtn" data-game="${e.pk}">Open the game</button>
      <a class="lbtn" href="https://baseballsavant.mlb.com/sporty-videos?playId=${encodeURIComponent(e.id)}" target="_blank" rel="noopener">Baseball Savant</a>
    </div>`, 'event');
  S.eventOpen = id;
  wireVideos();
  if (!clip) {
    const v = await latestClip(e.batter.id);
    if (S.eventOpen !== id || !v || !$('#evMedia') || $('#evMedia').dataset.own === '1') return;
    clip = v.playId === e.id ? { ...v, own: true } : { ...v, own: false };
    $('#evMedia').innerHTML = media(clip);
    $('#evMedia').dataset.own = clip.own ? '1' : '0';
    wireVideos();
  }
}

// ------------------------------------------------------------ player
async function openPlayer(id) {
  id = Number(id);
  openSheet('<h2 id="dlgTitle" class="sr-only">Player</h2><div class="empty"><b>Loading…</b></div>', 'player');
  S.playerOpen = id;
  let p;
  try {
    const r = await fetch(`api/player/${id}?season=${(S.date || '').slice(0, 4)}`);
    p = await r.json();
    if (!r.ok) throw new Error(p.error || r.status);
  } catch (err) {
    $('#dlgBody').innerHTML = `<div class="empty"><b>Couldn't load this player</b>${esc(err.message)}</div>`;
    return;
  }
  if (S.playerOpen !== id) return;
  const s = p.season || {};
  const avg = Number(s.avg);
  const pi = p.pitching;
  const pitcher = !!pi && (p.pos === 'P' || !s.ab);
  const ipNum = pi ? Number(String(pi.ip || '0').replace(/\.(\d)$/, (m, d) => `.${Math.round((d / 3) * 10)}`)) : 0;
  const mine = [...S.events.values()].filter((e) => e.batter.id === id).sort(byTime);
  const st = liveStatus(id);
  $('#dlgBody').innerHTML = `
    <div class="pl-head">${face(p.id, 72, p.name)}<div style="min-width:0">
      <h2 id="dlgTitle">${esc(p.name)}</h2>
      <div class="m">${[p.pos, p.team?.name, p.bats ? `Bats ${p.bats === 'L' ? 'left' : p.bats === 'R' ? 'right' : 'both'}` : '', p.age ? `Age ${p.age}` : ''].filter(Boolean).map(esc).join(' · ')}</div>
    </div></div>
    <div class="links" style="margin-top:var(--s2)">
      <button class="btn" style="width:auto;padding:0 20px;margin:0" data-follow="${p.id}" data-name="${esc(p.name)}">${followsPlayer(p.id) ? '★ Following' : '☆ Follow'}</button>
      ${st ? `<button class="lbtn" data-game="${st.pk}">${esc(st.text)} · open game</button>` : ''}
    </div>
    <div id="plClip" class="dlg-sec"></div>
    ${!pitcher ? `<div class="kv">
      ${kv('Home runs', s.hr, s.hr && s.g ? `One every ${f1(s.g / s.hr)} games` : '')}
      ${kv('Batting avg', s.avg, avg ? `A hit in ${Math.round(avg * 100)}% of at-bats` : '')}
      ${kv('OPS', s.ops, Number(s.ops) >= 0.9 ? 'Star level' : Number(s.ops) >= 0.75 ? 'Above average' : 'On-base plus power')}
      ${kv('Hits', s.h, s.d != null ? `${s.d} doubles, ${s.t} triples` : '')}
    </div>` : ''}
    ${pi && (pitcher || p.pos === 'TWP') ? `<div class="kv">
      ${kv('ERA', pi.era, 'Runs allowed per 9 innings. Under 3.00 is excellent.')}
      ${kv('Strikeouts', pi.k, ipNum ? `${f1((pi.k / ipNum) * 9)} per 9 innings` : '')}
      ${kv('Record', pi.w != null ? `${pi.w}–${pi.l}` : null, pi.sv ? `${pi.sv} saves` : pi.gs ? `${pi.gs} starts` : '')}
      ${kv('WHIP', pi.whip, 'Walks + hits per inning. Under 1.10 is elite.')}
    </div>` : ''}
    ${pitcher ? '' : raceChart(p)}
    ${mine.length ? `<div class="dlg-sec"><h3 class="sub-h">${S.isToday ? 'Today' : esc(dayLabel(S.date))}</h3><div class="card feed">${mine.map((e) => `<div class="row2" data-open="${esc(e.id)}" role="button" tabindex="0">${face(e.batter.id, 36, e.batter.name)}<div style="min-width:0"><div class="n"><span class="kdot k-${e.kind}"></span>${esc(kindLabel(e))}</div><div class="m">${esc(inningLabel(e))} · ${esc(e.team.abbr)} vs ${esc(e.opp.abbr)}</div></div><div class="v num">${e.dist ?? e.ev ?? '—'}<small>${e.dist ? 'ft' : 'mph'}</small></div></div>`).join('')}</div></div>` : ''}`;
  // Their latest home run, playing.
  if (pitcher) return;
  const v = await latestClip(id);
  if (S.playerOpen !== id || !$('#plClip')) return;
  if (v) {
    $('#plClip').innerHTML = `<h3 class="sub-h">Latest home run<span>${esc(dayLabel(v.date))}${v.opp ? ` vs ${esc(v.opp)}` : ''}</span></h3>${videoTag(v, { autoplay: true, muted: true })}`;
    wireVideos();
    $('#plClip video')?.play().catch(() => {});
  }
}
function raceChart(p) {
  const log = (p.log || []).filter((g) => g.date);
  if (!log.length || !p.season?.hr) return '';
  let c = 0;
  const pts = log.map((g) => ({ d: g.date, v: (c += g.hr) }));
  const W = chartW(), max = Math.max(1, c), H = W < 500 ? 150 : 170, L = 30, R = 44, T = 14, B = 24;
  const X = (i) => L + (i / Math.max(1, pts.length - 1)) * (W - L - R);
  const Y = (v) => T + (1 - v / max) * (H - T - B);
  const d = pts.map((q, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(q.v).toFixed(1)}`).join(' ');
  const mon = (s) => new Date(`${s}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `<div class="card race"><h3 class="sub-h">Home run race<span>${pts.length} games</span></h3>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${c} home runs over ${pts.length} games">
      ${[0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i).map((v) => `<line class="ax" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
      <path class="ar" d="${d} L${X(pts.length - 1).toFixed(1)},${Y(0)} L${X(0)},${Y(0)} Z"/><path class="ln" d="${d}"/>
      <circle class="end" cx="${X(pts.length - 1)}" cy="${Y(c)}" r="5"/><text class="endlab" x="${X(pts.length - 1) + 10}" y="${Y(c) + 5}">${c}</text>
      <text x="${L}" y="${H - 4}">${esc(mon(pts[0].d))}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${esc(mon(pts[pts.length - 1].d))}</text>
    </svg></div>`;
}

// ------------------------------------------------------------ a live game: at-bat now, win probability, every at-bat
async function openGame(pk) {
  pk = Number(pk);
  S.gameOpen = pk;
  S.openInnings = null; // the first render opens the two latest innings
  S.knownInnings = null;
  openSheet('<h2 id="dlgTitle" class="sr-only">Game</h2><div class="empty"><b>Loading the game…</b></div>', 'game');
  await refreshGameSheet(pk);
}
let gameFetch = 0;
// partial: keep the header and at-bat as they are (they update pitch by pitch) and reload the chart and the log.
async function refreshGameSheet(pk, { partial = false } = {}) {
  const ticket = ++gameFetch;
  try {
    const r = await fetch(`api/game/${pk}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    if (S.gameOpen !== pk || S.dlgKind !== 'game' || ticket !== gameFetch) return;
    S.gameData = d;
    if (partial && $('#gvHead')) renderGameParts(); else renderGameSheet();
  } catch (err) {
    if (S.gameOpen === pk && S.dlgKind === 'game' && !partial) $('#dlgBody').innerHTML = `<h2 id="dlgTitle" class="sr-only">Game</h2><div class="empty"><b>Couldn't load this game</b>${esc(err.message)}</div>`;
  }
}
function atBatNowHTML(g, ab) {
  if (!ab || g.state !== 'Live') return '';
  const b = ab.batter, pi = ab.pitcher;
  return `<div id="abNow">
    <h3 class="sub-h">At bat<span>${esc(inningLabel(ab))} · ${ab.outs} out</span></h3>
    <div class="abx-who"><span data-player="${b.id}">${face(b.id, 44, b.name)}</span><div style="min-width:0"><div class="n" data-player="${b.id}">${followsPlayer(b.id) ? '★ ' : ''}${esc(b.name)}</div><div class="m">${esc(b.today ? `${b.today} today` : 'First time up')}${b.season ? ` · ${esc(b.season.avg)}, ${b.season.hr} HR` : ''}</div></div></div>
    <div class="pit" style="margin:-4px 0 0">vs ${face(pi.id, 24, pi.name)}<span><b data-player="${pi.id}">${esc(pi.name)}</b>${pi.pitches ? ` · ${pi.pitches} pitches` : ''}${pi.season?.era ? ` · ${esc(pi.season.era)} ERA` : ''}</span></div>
    <div class="abx-state"><span class="c num">${ab.balls}–${Math.min(ab.strikes, 2)}</span>${lights(ab)}${diamond(ab.bases)}</div>
    <div class="atbat-now">
      ${ab.pitches.length ? zoneSVG(ab.pitches, true) : '<div class="zone-empty" style="width:150px;height:180px">No pitches yet</div>'}
      <ol class="pl">${ab.pitches.map((p) => `<li><span class="i">${p.n}</span><span class="t">${esc(p.type || 'Pitch')}<span>${esc((p.call || '').replace(/ \(Blocked\)/, ''))}${p.count ? ` · ${esc(p.count)}` : ''}</span></span><span class="mph num">${p.mph ?? ''}</span></li>`).join('') || '<li><span></span><span class="t">Waiting on the first pitch</span><span></span></li>'}</ol>
    </div>
    <div class="legend"><span><i class="b"></i>Ball</span><span><i class="s"></i>Strike</span><span><i class="x"></i>In play</span><span class="faint">Catcher's view</span></div>
    <p class="ab-say">${esc(story(ab))}</p>
    <p class="matchup" id="matchup"></p>
    ${ab.onDeck ? `<p class="matchup">On deck: <b>${esc(ab.onDeck.name)}</b>${ab.inHole ? ` · In the hole: ${esc(ab.inHole.name)}` : ''}</p>` : ''}
  </div>`;
}
const matchupCache = new Map();
async function fillMatchup(ab) {
  if (!ab || !$('#matchup')) return;
  const key = `${ab.batter.id}:${ab.pitcher.id}`;
  if (!matchupCache.has(key)) matchupCache.set(key, fetch(`api/matchup?b=${ab.batter.id}&p=${ab.pitcher.id}`).then((r) => r.json()).catch(() => null));
  const m = await matchupCache.get(key);
  const el = $('#matchup');
  if (!el || S.gameData?.ab?.batter?.id !== ab.batter.id && S.atbats.get(S.gameOpen)?.batter?.id !== ab.batter.id) return;
  el.innerHTML = !m || !m.pa ? `First career meeting between ${esc(ab.batter.name)} and ${esc(ab.pitcher.name)}.`
    : `Career vs ${esc(ab.pitcher.name.split(' ').slice(-1)[0])}: <b>${m.h}-for-${m.ab}</b>${m.hr ? `, ${m.hr} HR` : ''}${m.k ? `, ${m.k} K` : ''}${m.bb ? `, ${m.bb} BB` : ''}.`;
}
function gameLiveHTML(g, ab) {
  if (isOff(g)) return `<h3 class="sub-h">${esc(gameStatus(g))}</h3><p class="plain">This game didn't happen. MLB will make it up on another date.</p>`;
  const now = atBatNowHTML(g, ab);
  if (now) return now;
  if (g.state === 'Final') {
    const aw = g.away.score > g.home.score;
    return `<h3 class="sub-h">Final</h3><p class="plain">${esc(aw ? g.away.name : g.home.name)} won ${Math.max(g.away.score, g.home.score)}–${Math.min(g.away.score, g.home.score)}.</p>`;
  }
  return `<h3 class="sub-h">${esc(gameStatus(g))}</h3><p class="muted">Every pitch shows up here once the game starts.</p>`;
}
function gameWpHTML(g, d) {
  if (!d.wp?.length) return '';
  const lead = g.wp != null ? (g.wp >= 50 ? `${g.home.abbr} ${Math.round(g.wp)}%` : `${g.away.abbr} ${Math.round(100 - g.wp)}%`) : '';
  return `<h3 class="sub-h">Win probability<span>${esc(lead)}</span></h3>${wpSVG(d.wp, g, d.log || [], chartW())}<p class="wp-note">${esc(wpNote(d.wp, g, d.log || []))}</p>`;
}
function gameLogHTML(g, d) {
  const log = d.log || [];
  if (!log.length) return '';
  const groups = groupLog(log, g);
  if (!S.openInnings) { S.openInnings = new Set(groups.slice(0, 2).map((gr) => gr.key)); S.knownInnings = new Set(groups.map((gr) => gr.key)); }
  for (const gr of groups) if (!S.knownInnings.has(gr.key)) { S.knownInnings.add(gr.key); S.openInnings.add(gr.key); } // a new inning opens itself
  return `<h3 class="sub-h">Every at-bat<span>${log.length} plate appearances</span></h3><div class="log">${groups.map((gr) => `<details data-key="${gr.key}" ${S.openInnings.has(gr.key) ? 'open' : ''}>
    <summary>${ICON.chev}${gr.half === 'top' ? 'Top' : 'Bottom'} ${gr.inning}<span class="sm">${esc(gr.team)} · ${esc(halfSummary(gr))}</span></summary>
    ${[...gr.items].reverse().map((x) => { const open = x.id && (S.events.has(x.id) || T.events.has(x.id)); return `<div class="pa" ${open ? `data-open="${esc(x.id)}" role="button" tabindex="0"` : ''}><span class="e ${x.kind === 'home_run' ? 'hr' : ''}">${esc(x.event)} · <span style="font-weight:500">${esc(x.batter.name)}</span></span><span class="sc num">${x.rbi ? `${esc(g.away.abbr)} ${x.score.away}–${x.score.home} ${esc(g.home.abbr)}` : ''}</span><span class="ds">${esc(x.desc.replace(/^.*?challenged \(pitch result\), call on the field was (overturned|confirmed): /, 'Challenge $1: '))}</span></div>`; }).join('')}
  </details>`).join('')}</div>`;
}
function renderGameSheet() {
  const d = S.gameData;
  if (!d) return;
  const g = S.games.get(d.game.pk) || d.game;
  const ab = g.state === 'Live' ? S.atbats.get(g.pk) || d.ab : null;
  const n = (d.log || []).filter((l) => l.kind === 'home_run').length;
  $('#dlgBody').innerHTML = `<div class="sheet">
    <h2 id="dlgTitle" class="sr-only">${esc(g.away.name || g.away.abbr)} at ${esc(g.home.name || g.home.abbr)}</h2>
    <div class="gv-head" id="gvHead">${gvHead(g)}</div>
    <div class="links" style="justify-content:center">
      <button class="lbtn" data-team="${g.away.id}">${followsTeam(g.away.id) ? '★' : '☆'} ${esc(g.away.abbr)}</button>
      <button class="lbtn" data-team="${g.home.id}">${followsTeam(g.home.id) ? '★' : '☆'} ${esc(g.home.abbr)}</button>
      ${n ? `<button class="lbtn" data-act="game-homers">${n} home run${n === 1 ? '' : 's'}</button>` : ''}
    </div>
    <div class="gv-grid">
      <div id="gvLive">${gameLiveHTML(g, ab)}</div>
      <div id="gvWp">${gameWpHTML(g, d)}</div>
      <div class="log-wrap" id="gvLog">${gameLogHTML(g, d)}</div>
    </div></div>`;
  fillMatchup(ab);
}
function renderGameParts() {
  const d = S.gameData;
  const g = S.games.get(d.game.pk) || d.game;
  $('#gvWp').innerHTML = gameWpHTML(g, d);
  $('#gvLog').innerHTML = gameLogHTML(g, d);
  updateGameSheet();
}
function gvHead(g) {
  const off = isOff(g), fin = g.state === 'Final' && !off;
  const aw = g.away.score > g.home.score;
  const sc = (v) => (off || v == null ? '–' : v);
  return `<div class="gv-team ${fin && !aw ? 'lose' : ''}">${logo(g.away.id)}<div><div class="a">${esc(g.away.name || g.away.abbr)}</div><div class="s num">${sc(g.away.score)}</div></div></div>
    <div class="gv-mid"><b>${g.state === 'Live' && !off ? '<span class="dot pulse"></span>' : ''}${esc(gameStatus(g))}</b>${esc(g.venue?.name || '')}</div>
    <div class="gv-team ${fin && aw ? 'lose' : ''}" style="flex-direction:row-reverse;text-align:right">${logo(g.home.id)}<div><div class="a">${esc(g.home.name || g.home.abbr)}</div><div class="s num">${sc(g.home.score)}</div></div></div>`;
}
// Pitch-by-pitch updates without rebuilding the sheet (keeps scroll and open innings).
function updateGameSheet() {
  if (!S.gameOpen || !S.gameData || S.dlgKind !== 'game' || !$('#gvHead')) return;
  const g = S.games.get(S.gameOpen) || S.gameData.game;
  const head = gvHead(g);
  if ($('#gvHead').dataset.key !== head) { $('#gvHead').innerHTML = head; $('#gvHead').dataset.key = head; }
  const ab = g.state === 'Live' ? S.atbats.get(S.gameOpen) : null;
  const html = gameLiveHTML(g, ab);
  if ($('#gvLive').dataset.key !== html) { $('#gvLive').innerHTML = html; $('#gvLive').dataset.key = html; fillMatchup(ab); }
}

// ------------------------------------------------------------ phone, import
async function openPhone() {
  let urls = [];
  try { urls = (await (await fetch('api/lan')).json()).urls || []; } catch { /* offline */ }
  const url = urls[0];
  openSheet(`<h2 id="dlgTitle">Open on your iPhone</h2>
    <p class="muted" style="margin:8px 0 0">Your iPhone needs to be on the same Wi-Fi as this Mac, and the app needs to stay running here.</p>
    ${url ? `<div class="qr" id="qr"></div><div class="url">${esc(url)}</div>` : '<div class="card empty" style="margin-top:var(--s3)"><b>No Wi-Fi address found</b>Connect this Mac to Wi-Fi and try again.</div>'}
    <ol class="steps">
      <li><b>1</b><span>Point your iPhone's camera at the code, or type the address into Safari.</span></li>
      <li><b>2</b><span>In Safari, tap Share, then <b style="all:unset;font-weight:600">Add to Home Screen</b>.</span></li>
      <li><b>3</b><span>Open Bing Bong Live from your Home Screen. It runs full-screen, like an app.</span></li>
    </ol>`, 'phone');
  if (!url) return;
  const draw = () => { try { new QRCode($('#qr'), { text: url, width: 200, height: 200, colorDark: '#0B0B0D', colorLight: '#FFFFFF' }); } catch { $('#qr').remove(); } };
  if (window.QRCode) return draw();
  const sc = document.createElement('script');
  sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  sc.onload = draw;
  sc.onerror = () => $('#qr')?.remove();
  document.head.appendChild(sc);
}
async function openImport(imp) {
  let players = [];
  try { players = imp.players.length ? (await (await fetch(`api/players/today?ids=${imp.players.join(',')}`)).json()).players : []; } catch { /* names optional */ }
  openSheet(`<h2 id="dlgTitle">Add this lineup?</h2>
    <p class="muted" style="margin:8px 0 0">Someone shared ${imp.players.length ? `${imp.players.length} player${imp.players.length === 1 ? '' : 's'}` : ''}${imp.players.length && imp.teams.length ? ' and ' : ''}${imp.teams.length ? `${imp.teams.length} team${imp.teams.length === 1 ? '' : 's'}` : ''} with you.</p>
    ${players.length ? `<div class="card feed" style="margin-top:var(--s3)">${players.map((p) => `<div class="row2">${face(p.id, 36, p.name)}<div style="min-width:0"><div class="n">${esc(p.name || 'Player')}</div><div class="m">${esc(p.abbr || '')}</div></div><span></span></div>`).join('')}</div>` : ''}
    ${imp.teams.length ? `<div class="teams" style="padding:0;margin-top:var(--s2)"><div class="row">${imp.teams.map((t) => `<span class="tm">${logo(t)}</span>`).join('')}</div></div>` : ''}
    <button class="btn" data-act="import-yes">Add to my follows</button>
    <button class="lbtn" style="width:100%;justify-content:center;margin-top:8px" data-act="import-no">No thanks</button>`, 'import');
  S.importing = imp;
}
