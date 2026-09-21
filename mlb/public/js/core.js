'use strict';
/* Bing Bong Live — core: state, baseball helpers, geometry. Classic scripts share these top-level names. */

// ------------------------------------------------------------ utils
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const store = {
  get(k, d) {
    try {
      let v = localStorage.getItem(`bbl.${k}`);
      if (v == null) v = localStorage.getItem(`moonshot.${k}`); // carry settings over from the old name
      return v == null ? d : JSON.parse(v);
    } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem(`bbl.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ------------------------------------------------------------ constants
const TC = {
  108: '#BA0021', 109: '#A71930', 110: '#DF4601', 111: '#BD3039', 112: '#0E3386', 113: '#C6011F', 114: '#00385D',
  115: '#333366', 116: '#0C2340', 117: '#EB6E1F', 118: '#004687', 119: '#005A9C', 120: '#AB0003', 121: '#002D72',
  133: '#003831', 134: '#FDB827', 135: '#2F241D', 136: '#005C5C', 137: '#FD5A1E', 138: '#C41E3A', 139: '#092C5C',
  140: '#003278', 141: '#134A8E', 142: '#002B5C', 143: '#E81828', 144: '#CE1141', 145: '#27251F', 146: '#00A3E0',
  147: '#0C2340', 158: '#12284B',
};
const HEAD = (id, w = 240) => `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_${w},q_auto:best/v1/people/${id}/headshot/67/current`;
const LOGO = (id) => `https://www.mlbstatic.com/team-logos/${id}.svg`;
const LOGO_DARK = (id) => `https://www.mlbstatic.com/team-logos/team-cap-on-dark/${id}.svg`;
const face = (id, size, alt = '', attrs = '') => `<img class="face" src="${HEAD(id, size >= 60 ? 360 : 240)}" width="${size}" height="${size}" style="width:${size}px;height:${size}px" alt="${esc(alt)}" loading="lazy" ${attrs}>`;
// Two versions; CSS shows the one that reads on the current theme (navy logos vanish on black otherwise).
const logo = (id, cls = 'logo', alt = '') => `<img class="${cls} lg-l" src="${LOGO(id)}" alt="${esc(alt)}" loading="lazy"><img class="${cls} lg-d" src="${LOGO_DARK(id)}" alt="${esc(alt)}" loading="lazy">`;
const isOff = (g) => /postponed|cancel/i.test(g?.detail || '') || (g?.state === 'Final' && g?.away?.score == null);
const ICON = {
  play: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.8v10.4c0 .6.7 1 1.2.7l8.3-5.2c.5-.3.5-1.1 0-1.4L5.7 2.1c-.5-.3-1.2.1-1.2.7z"/></svg>',
  muted: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor"/><path d="M11 6l3.5 4M14.5 6L11 10"/></svg>',
  sound: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor"/><path d="M10.8 5.6a3.4 3.4 0 0 1 0 4.8M12.8 3.8a6 6 0 0 1 0 8.4"/></svg>',
  chev: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>',
  down: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>',
  share: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 10V2.5M5 5.2L8 2.3l3 2.9M4 8H3.5v5.5h9V8H12"/></svg>',
  bell: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2a3.8 3.8 0 0 0-3.8 3.8v2.4L3 10.8h10l-1.2-2.4V6A3.8 3.8 0 0 0 8 2.2z"/><path d="M6.5 12.8a1.6 1.6 0 0 0 3 0"/></svg>',
  bellOn: '<svg viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2a3.8 3.8 0 0 0-3.8 3.8v2.4L3 10.8h10l-1.2-2.4V6A3.8 3.8 0 0 0 8 2.2z"/><path d="M6.5 12.8a1.6 1.6 0 0 0 3 0" fill="none"/></svg>',
  auto: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg>',
  sun: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>',
  moon: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.4 10.2A5.8 5.8 0 0 1 5.8 2.6a5.8 5.8 0 1 0 7.6 7.6z"/></svg>',
  star: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.9l1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 6.2l4-.6z"/></svg>',
  starOn: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.9l1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 6.2l4-.6z"/></svg>',
};

// ------------------------------------------------------------ state
function normFollow(f) {
  return { players: [...new Set((f?.players || []).map(Number))], teams: [...new Set((f?.teams || []).map(Number))], names: f?.names || {} };
}
const S = {
  date: null, today: null, isToday: true, loading: null,
  games: new Map(), events: new Map(), pending: new Map(), atbats: new Map(), pitches: [], swings: [],
  tab: 'live', seg: store.get('seg', 'tonight'), sort: 'new', kind: 'all',
  follow: normFollow(store.get('follow', {})), followData: null, teamsList: null,
  alerts: store.get('alerts', 'off'), theme: store.get('theme', 'auto'), muted: true,
  offset: 0, feedAt: 0, liveCount: 0, connected: false, lastMsg: Date.now(), feedMs: 2000,
  leaders: null, leadersAt: 0, fresh: new Set(), alerted: new Set(), unseen: 0,
  gameOpen: null, gameData: null, dlgKind: null,
  me: { role: 'owner', name: '', named: true, owner: '', shared: false },  // who you are on this board (server sets it)
  recap: null, // the last day with home runs, shown on today's page before the first one lands
};
const serverNow = () => Date.now() + S.offset;

// ------------------------------------------------------------ baseball helpers
const game = (pk) => S.games.get(pk);
const byTime = (a, b) => (Date.parse(b.t || 0) || b.seenAt || 0) - (Date.parse(a.t || 0) || a.seenAt || 0);
const homers = () => [...S.events.values()].filter((e) => e.isHR).sort(byTime);
const sprayAngle = (e) => (e.cx == null || e.cy == null ? null : (Math.atan2(e.cx - 125.42, 198.27 - e.cy) * 180) / Math.PI);
const direction = (a) => (a == null ? null : a < -30 ? 'left field' : a < -12 ? 'left-center' : a <= 12 ? 'center field' : a <= 30 ? 'right-center' : 'right field');
const halfWord = (h) => (/^t/i.test(h || '') ? 'Top' : /^b/i.test(h || '') ? 'Bot' : /^m/i.test(h || '') ? 'Mid' : /^e/i.test(h || '') ? 'End' : '');
const inningLabel = (x) => (x?.inning ? `${halfWord(x.half)} ${x.inning}` : '');
const timeLabel = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
function ago(iso) {
  if (!iso) return '';
  const m = Math.round((serverNow() - Date.parse(iso)) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  if (m < 360) return `${Math.floor(m / 60)} hr ago`;
  return timeLabel(iso);
}
// Seconds from bat-on-ball to this app knowing about it.
function spotted(e) {
  const base = Date.parse(e.contact || e.t || '');
  if (!e.live || !base || !e.seenAt) return null;
  const s = Math.round((e.seenAt - base) / 1000);
  return s >= 0 && s <= 300 ? s : null;
}
const HIT = { single: 'Single', double: 'Double', triple: 'Triple', home_run: 'Home run' };
function hrKind(e) {
  if (e.inside) return 'Inside-the-park HR';
  if (e.grandSlam || e.rbi === 4) return 'Grand slam';
  return e.rbi > 1 ? `${e.rbi}-run homer` : 'Solo homer';
}
const kindShort = (e) => (e.grandSlam || e.rbi === 4 ? 'Slam' : e.rbi > 1 ? `${e.rbi}-run` : 'Solo');
const kindLabel = (e) => (e.isHR ? hrKind(e) : HIT[e.kind] || e.label);
function scoreStory(e) {
  const top = e.half === 'top';
  const my = top ? e.score?.away : e.score?.home;
  const th = top ? e.score?.home : e.score?.away;
  if (my == null || th == null) return '';
  const before = my - (e.rbi || 0);
  if (e.walkoff) return `Walk-off, wins it ${my}–${th}`;
  if (my > th && before <= th && e.rbi) return before === th ? `Breaks the tie, ${my}–${th}` : `Takes the lead, ${my}–${th}`;
  if (my === th && before < th && e.rbi) return `Ties it ${my}–${th}`;
  if (my > th) return `${e.team.abbr} leads ${my}–${th}`;
  if (my < th) return `${e.team.abbr} trails ${my}–${th}`;
  return `Tied ${my}–${th}`;
}
function persona(e) {
  if (!e?.isHR) return null;
  if (e.inside) return 'Inside-the-park';
  if (e.dist >= 450) return 'Tape-measure shot';
  if (e.la != null && e.la >= 36) return 'Moonshot';
  if (e.la != null && e.la <= 22 && e.ev >= 103) return 'Line-drive laser';
  if (e.parks != null && e.parks <= 8) return 'Wall-scraper';
  if (e.parks === 30) return 'No-doubter';
  if (e.ev >= 110) return 'Scorcher';
  return null;
}
const fields = (d) => `${f1(d / 300)} football fields`;
const highway = (ev) => `${f1(ev / 70)}× highway speed`;
const pitchWord = (p) => (p?.type || p?.name || 'pitch').replace(/^Four-Seam Fastball$/i, 'four-seamer').replace(/^Two-Seam Fastball$/i, 'two-seamer').toLowerCase();
const lastPitch = (p) => (p ? `${p.mph ? `${p.mph} mph ` : ''}${pitchWord(p)}, ${(p.call || '').replace(/ \(Blocked\)/, '').toLowerCase()}.` : 'No pitches yet.');
function plainLine(e) {
  if (e.isHR) {
    const s = [];
    if (e.dist) s.push(`${e.dist} feet is about ${fields(e.dist)}`);
    if (e.parks != null) s.push(e.parks === 30 ? 'it would have left every ballpark in the majors' : `it would have cleared the wall in ${e.parks} of 30 ballparks`);
    return s.length ? `${s.join(', and ')}.` : '';
  }
  if (!e.isHit && e.parks >= 1) return `Caught, but it would have been a home run in ${e.parks} of 30 ballparks.`;
  const dir = e.traj !== 'ground_ball' ? direction(sprayAngle(e)) : null;
  const traj = { fly_ball: 'fly ball', line_drive: 'line drive', ground_ball: 'grounder', popup: 'pop-up' }[e.traj] || 'ball';
  const s = [];
  if (e.ev) s.push(`A ${e.ev} mph ${traj}${dir ? ` to ${dir}` : ''}.`);
  if (e.xba != null) s.push(`Contact like this falls for a hit ${Math.round(e.xba * 100)}% of the time.`);
  return s.join(' ');
}

// What's at stake in the at-bat right now.
function story(ab) {
  if (!ab) return '';
  if (ab.result) return (ab.result.desc || ab.result.event || '').replace('Pitching Change:', 'Pitching change:');
  const b = ab.bases || {};
  const on = ['first', 'second', 'third'].filter((k) => b[k]).length;
  const risp = !!(b.second || b.third);
  const top = ab.half === 'top';
  const my = (top ? ab.score?.away : ab.score?.home) ?? 0;
  const th = (top ? ab.score?.home : ab.score?.away) ?? 0;
  const diff = my - th;
  const two = ab.outs === 2;
  const out = [];
  if (on === 3) out.push(two ? 'Bases loaded, two outs.' : 'Bases loaded.');
  else if (risp) out.push(`${on === 2 ? 'Two on' : 'Runner in scoring position'}${two ? ', two outs' : ''}.`);
  else if (on === 1) out.push(two ? 'Runner on first, two outs.' : 'Runner on first.');
  if (diff < 0 && on + 1 === -diff) out.push('The tying run is at the plate.');
  else if (diff < 0 && on + 1 > -diff) out.push('The go-ahead run is at the plate.');
  else if (diff === 0) out.push(ab.inning >= 7 ? 'Late and tied.' : 'Tie game.');
  const cw = {
    '3-2': 'Full count: the next pitch decides it.', '3-0': 'The pitcher has to throw a strike.', '0-2': 'The pitcher is in control.',
    '1-2': 'Two strikes: the batter is fighting to stay alive.', '2-2': 'Two strikes: the batter is fighting to stay alive.',
    '2-0': "Hitter's count.", '3-1': "Hitter's count.", '0-0': 'New at-bat.',
  }[`${ab.balls}-${Math.min(ab.strikes, 2)}`];
  if (cw) out.push(cw);
  return out.slice(0, 3).join(' ');
}

// ------------------------------------------------------------ geometry
const PLATE = 0.708; // half the plate's width, in feet
function zoneSVG(pitches = [], big = false) {
  const shown = pitches.filter((p) => p.px != null && p.pz != null);
  const tops = pitches.map((p) => p.top).filter(Boolean), bots = pitches.map((p) => p.bot).filter(Boolean);
  const top = tops.length ? tops.reduce((a, b) => a + b) / tops.length : 3.4;
  const bot = bots.length ? bots.reduce((a, b) => a + b) / bots.length : 1.6;
  const X = (x) => (clamp(x, -1.75, 1.75) + 1.9).toFixed(3);
  const Y = (z) => (4.8 - clamp(z, 0.3, 4.7)).toFixed(3);
  const w = (2 * PLATE).toFixed(3);
  const grid = big ? [1, 2].map((i) => {
    const x = -PLATE + (i * 2 * PLATE) / 3, z = bot + (i * (top - bot)) / 3;
    return `<line x1="${X(x)}" x2="${X(x)}" y1="${Y(top)}" y2="${Y(bot)}"/><line x1="${X(-PLATE)}" x2="${X(PLATE)}" y1="${Y(z)}" y2="${Y(z)}"/>`;
  }).join('') : '';
  const r = big ? 0.19 : 0.15;
  const dots = shown.map((p, i) => `<g class="pd k${p.k || 'B'}${i === shown.length - 1 ? ' last' : ''}"><circle cx="${X(p.px)}" cy="${Y(p.pz)}" r="${r}"/>${big ? `<text x="${X(p.px)}" y="${(+Y(p.pz) + 0.012).toFixed(3)}">${p.n}</text>` : ''}</g>`).join('');
  return `<svg class="zone ${big ? 'big' : 'mini'}" viewBox="0 0 3.8 4.6" role="img" aria-label="Strike zone, catcher's view, ${shown.length} pitch${shown.length === 1 ? '' : 'es'}">
    <rect class="zbox" x="${X(-PLATE)}" y="${Y(top)}" width="${w}" height="${(top - bot).toFixed(3)}" rx=".04"/>
    <g class="zgrid">${grid}</g>
    <path class="plate" d="M${X(-PLATE)},4.4 h${w} v0.07 l-${PLATE.toFixed(3)},0.1 l-${PLATE.toFixed(3)},-0.1 z"/>
    ${dots}</svg>`;
}
function diamond(b = {}) {
  const r = (x, y, on) => `<rect class="${on ? 'on' : ''}" x="${x - 6}" y="${y - 6}" width="12" height="12" rx="2" transform="rotate(45 ${x} ${y})"/>`;
  const on = ['first', 'second', 'third'].filter((k) => b?.[k]);
  return `<svg class="dia" viewBox="0 0 46 38" role="img" aria-label="${on.length ? `Runner on ${on.join(' and ')}` : 'Bases empty'}">${r(23, 10, b?.second)}${r(36, 23, b?.first)}${r(10, 23, b?.third)}</svg>`;
}
function lights(ab) {
  const row = (n, max) => Array.from({ length: max }, (_, i) => `<i class="${n > i ? 'on' : ''}"></i>`).join('');
  return `<div class="lights" role="img" aria-label="${ab.balls} balls, ${Math.min(ab.strikes, 2)} strikes, ${ab.outs} outs"><b>B</b><span>${row(ab.balls, 3)}</span><b>S</b><span>${row(Math.min(ab.strikes, 2), 2)}</span><b>O</b><span>${row(ab.outs, 3)}</span></div>`;
}
// Small top-down field with the flight path to the landing spot.
function miniField(e) {
  if (e.cx == null || !e.dist) return '';
  const s = 0.3, P = { x: 100, y: 150 };
  const R = 385 * s, k = Math.SQRT1_2;
  const lp = [P.x - R * k, P.y - R * k], rp = [P.x + R * k, P.y - R * k];
  const b = 90 * s;
  const a = clamp(sprayAngle(e) ?? 0, -44, 44) * (Math.PI / 180);
  const d = Math.min(e.dist || 0, 470) * s;
  const L = [P.x + Math.sin(a) * d, P.y - Math.cos(a) * d];
  return `<svg class="field" viewBox="0 0 200 160" role="img" aria-label="Landing spot, ${e.dist} feet${direction(sprayAngle(e)) ? ` to ${direction(sprayAngle(e))}` : ''}">
    <path class="grass" d="M${P.x},${P.y} L${lp[0].toFixed(1)},${lp[1].toFixed(1)} A${R} ${R} 0 0 1 ${rp[0].toFixed(1)},${rp[1].toFixed(1)} Z"/>
    <path class="fl" d="M${P.x},${P.y} L${(P.x + b * k).toFixed(1)},${(P.y - b * k).toFixed(1)} L${P.x},${(P.y - 2 * b * k).toFixed(1)} L${(P.x - b * k).toFixed(1)},${(P.y - b * k).toFixed(1)} Z"/>
    <path class="path" d="M${P.x},${P.y} Q${((P.x + L[0]) / 2).toFixed(1)},${(Math.min(P.y, L[1]) - 34).toFixed(1)} ${L[0].toFixed(1)},${L[1].toFixed(1)}"/>
    <circle class="landring" cx="${L[0].toFixed(1)}" cy="${L[1].toFixed(1)}" r="8"/>
    <circle class="land" cx="${L[0].toFixed(1)}" cy="${L[1].toFixed(1)}" r="4"/>
  </svg>`;
}
// Park wall from its published distances (lines, gaps, center), as a smooth function of spray angle.
function wallFn(f) {
  f = f || {};
  const C = f.center || 400, LL = f.leftLine || 330, RL = f.rightLine || 330;
  const pts = [[-45, LL]];
  if (f.left) pts.push([-31, f.left]);
  pts.push([-20, f.leftCenter || Math.round((LL + C) / 2 + 10)], [0, C], [20, f.rightCenter || Math.round((RL + C) / 2 + 10)]);
  if (f.right) pts.push([31, f.right]);
  pts.push([45, RL]);
  const n = pts.length;
  return (a) => {
    a = clamp(a, -45, 45);
    let i = 0;
    while (i < n - 2 && a > pts[i + 1][0]) i++;
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const [x0, y0] = pts[i - 1] || pts[i], [x3, y3] = pts[i + 2] || pts[i + 1];
    const h = x2 - x1, t = (a - x1) / h, t2 = t * t, t3 = t2 * t;
    const m1 = ((y2 - y0) / (x2 - x0)) * h, m2 = ((y3 - y1) / (x3 - x1)) * h;
    return (2 * t3 - 3 * t2 + 1) * y1 + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * y2 + (t3 - t2) * m2;
  };
}
// Point-mass flight with drag, calibrated so it lands at the measured distance.
function simulate(ev, la, dist) {
  const v0 = ev * 1.46667, th = (la * Math.PI) / 180, g = 32.174, dt = 0.01;
  const run = (k, rec) => {
    let x = 0, y = 3, vx = v0 * Math.cos(th), vy = v0 * Math.sin(th), t = 0, apex = 3, ax = 0, step = 0;
    const path = rec ? [[0, 3]] : null;
    while (y > 0 && t < 14) {
      const v = Math.hypot(vx, vy);
      vx += -k * v * vx * dt; vy += (-g - k * v * vy) * dt;
      x += vx * dt; y += vy * dt; t += dt;
      if (y > apex) { apex = y; ax = x; }
      if (rec && ++step % 4 === 0) path.push([x, Math.max(0, y)]);
    }
    if (rec) path.push([x, 0]);
    return { x, t, apex, ax, path };
  };
  if (run(0).x <= dist) return run(0, true);
  let lo = 0, hi = 0.02;
  for (let i = 0; i < 28; i++) { const m = (lo + hi) / 2; if (run(m).x > dist) lo = m; else hi = m; }
  return run((lo + hi) / 2, true);
}
function flightSVG(e, wallAt, W = 640) {
  if (!e.ev || e.la == null || !e.dist || e.la <= 5) return '';
  const sim = simulate(e.ev, e.la, e.dist);
  const xMax = Math.max(e.dist, wallAt || 0) + (W < 500 ? 110 : 70), s = (W - 20) / xMax;
  const yTop = Math.max(sim.apex * 1.2 + 16, 50), H = Math.round(yTop * s + 22);
  const X = (x) => (10 + x * s).toFixed(1), Y = (y) => (yTop * s - y * s + 4).toFixed(1);
  const d = sim.path.map((p, i) => `${i ? 'L' : 'M'}${X(p[0])},${Y(p[1])}`).join(' ');
  return `<svg class="flight" viewBox="0 0 ${W} ${H + 4}" role="img" aria-label="Side view of the flight: about ${Math.round(sim.apex)} feet high, ${f1(sim.t)} seconds in the air">
    <line class="gnd" x1="0" x2="${W}" y1="${Y(0)}" y2="${Y(0)}"/>
    ${wallAt ? `<rect class="fence" x="${X(wallAt)}" y="${Y(10)}" width="3" height="${(10 * s).toFixed(1)}"/>` : ''}
    <path class="arc" d="${d}"/>
    <circle class="apex" cx="${X(sim.ax)}" cy="${Y(sim.apex)}" r="3.5"/>
    <text class="b" x="${clamp(+X(sim.ax), 50, W - 50)}" y="${(+Y(sim.apex) - 10).toFixed(0)}" text-anchor="middle">~${Math.round(sim.apex)} ft up</text>
    <text x="${(+X(e.dist) + 8).toFixed(0)}" y="${(+Y(0) - 6).toFixed(0)}">${e.dist} ft</text>
  </svg>`;
}
// Win probability: home team % after each plate appearance.
function wpSVG(wp, g, log = [], W = 640) {
  if (!wp?.length || !g) return '';
  const pts = [{ ab: -1, home: 50 }, ...wp];
  const Hh = W < 500 ? 190 : 210, Lf = 40, R = 66, T = 18, B = 26;
  const X = (i) => Lf + (i / Math.max(1, pts.length - 1)) * (W - Lf - R);
  const Y = (v) => T + (1 - v / 100) * (Hh - T - B);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.home).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const lead = last.home >= 50 ? g.home : g.away;
  const pct = Math.round(last.home >= 50 ? last.home : 100 - last.home);
  const idx = (ab) => pts.findIndex((p) => p.ab === ab);
  let lastLabelX = -1e9;
  const marks = log.filter((l) => l.kind === 'home_run').map((h) => {
    const i = idx(h.ab);
    if (i < 0) return '';
    const up = pts[i].home > 50;
    const x = X(i);
    const label = x - lastLabelX > 52; // skip a label that would collide with the previous one
    if (label) lastLabelX = x;
    return `<circle class="hrm" cx="${x.toFixed(1)}" cy="${Y(pts[i].home).toFixed(1)}" r="5"><title>${esc(h.batter.name)} home run</title></circle>${label ? `<text class="hrl" x="${clamp(x, 24, W - R + 20).toFixed(1)}" y="${(Y(pts[i].home) + (up ? -12 : 20)).toFixed(1)}" text-anchor="middle">${esc(h.batter.name.split(' ').slice(-1)[0])} HR</text>` : ''}`;
  }).join('');
  const inns = [];
  log.forEach((l) => { if (l.half === 'top' && !inns.find((x) => x.n === l.inning)) inns.push({ n: l.inning, ab: l.ab }); });
  const ticks = inns.filter((x, k) => W >= 500 || k % 2 === 0 || x === inns[inns.length - 1]).map((x) => { const i = idx(x.ab); return i < 0 ? '' : `<line class="tick" x1="${X(i).toFixed(1)}" x2="${X(i).toFixed(1)}" y1="${Hh - B}" y2="${Hh - B + 4}"/><text class="ax" x="${X(i).toFixed(1)}" y="${Hh - 6}" text-anchor="middle">${x.n}</text>`; }).join('');
  return `<svg class="wp" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Win probability over the game: ${esc(lead.abbr)} ${pct}%">
    <line class="mid" x1="${Lf}" x2="${W - R}" y1="${Y(50)}" y2="${Y(50)}"/>
    <line class="tick" x1="${Lf}" x2="${W - R}" y1="${Hh - B}" y2="${Hh - B}"/>
    <text class="tm" x="${Lf - 10}" y="${Y(100) + 4}" text-anchor="end">${esc(g.home.abbr)}</text>
    <text class="tm" x="${Lf - 10}" y="${Y(0)}" text-anchor="end">${esc(g.away.abbr)}</text>
    <text class="ax" x="${Lf - 10}" y="${Y(50) + 4}" text-anchor="end">50%</text>
    <path class="ar" d="${d} L${X(pts.length - 1).toFixed(1)},${Y(50)} L${X(0)},${Y(50)} Z"/>
    <path class="ln" d="${d}"/>
    ${ticks}${marks}
    <circle class="end" cx="${X(pts.length - 1).toFixed(1)}" cy="${Y(last.home).toFixed(1)}" r="4.5"/>
    <text class="tm" x="${(X(pts.length - 1) + 10).toFixed(1)}" y="${(Y(last.home) + 4).toFixed(1)}" style="fill:var(--ink)">${esc(lead.abbr)} ${pct}%</text>
  </svg>`;
}
// The biggest swing in the game, in words.
function wpNote(wp, g, log) {
  if (!wp?.length || !g) return '';
  let best = null, prev = 50;
  for (const w of wp) { const d = Math.abs(w.home - prev); if (!best || d > best.d) best = { d, w, from: prev }; prev = w.home; }
  if (!best || best.d < 8) return '';
  const pa = log.find((l) => l.ab === best.w.ab);
  if (!pa) return '';
  const team = pa.half === 'top' ? g.away : g.home;
  const from = pa.half === 'top' ? 100 - best.from : best.from, to = pa.half === 'top' ? 100 - best.w.home : best.w.home;
  return `${pa.batter.name}'s ${pa.event.toLowerCase()} in the ${ordinal(pa.inning)} moved ${team.abbr} from ${Math.round(from)}% to ${Math.round(to)}%.`;
}
function groupLog(log = [], g) {
  const groups = [];
  let cur = null;
  log.forEach((x) => { const key = `${x.inning}-${x.half}`; if (!cur || cur.key !== key) { cur = { key, inning: x.inning, half: x.half, items: [] }; groups.push(cur); } cur.items.push(x); });
  let prev = { away: 0, home: 0 };
  groups.forEach((gr) => {
    const end = gr.items[gr.items.length - 1].score || prev;
    const side = gr.half === 'top' ? 'away' : 'home';
    gr.runs = (end[side] ?? 0) - (prev[side] ?? 0);
    gr.team = g ? (gr.half === 'top' ? g.away.abbr : g.home.abbr) : '';
    prev = end;
  });
  return groups.reverse();
}
function halfSummary(gr) {
  const hits = gr.items.filter((x) => HIT[x.kind]).length;
  const hr = gr.items.find((x) => x.kind === 'home_run');
  if (!gr.runs && !hits && gr.items.length === 3) return '3 up, 3 down';
  const parts = [];
  if (gr.runs) parts.push(`${gr.runs} run${gr.runs > 1 ? 's' : ''}`);
  parts.push(`${hits} hit${hits === 1 ? '' : 's'}`);
  if (hr) parts.push(`${hr.batter.name.split(' ').slice(-1)[0]} HR`);
  return parts.join(' · ');
}
// "In the air" verdict from the park's wall in that direction.
function verdict(b) {
  const a = sprayAngle(b);
  if (a == null || b.dist == null || Math.abs(a) > 46) return b.ev >= 105 ? { k: 1, label: 'Rocket' } : null;
  const wall = wallFn(game(b.pk)?.venue?.field)(a);
  if (b.dist >= wall + 5) return { k: 3, label: 'Looks gone', wall };
  if (b.dist >= wall - 25) return { k: 2, label: 'Could be gone', wall };
  if (b.dist >= 320 && b.traj !== 'ground_ball') return { k: 1, label: 'Deep drive', wall };
  if (b.ev >= 105) return { k: 1, label: 'Rocket', wall };
  return null;
}
function gameStatus(g) {
  if (/postponed/i.test(g.detail)) return 'Postponed';
  if (/cancel/i.test(g.detail)) return 'Canceled';
  if (/suspended/i.test(g.detail)) return 'Suspended';
  if (g.state === 'Preview') return timeLabel(g.start);
  if (g.state === 'Final') return g.inning > 9 ? `Final · ${g.inning}` : 'Final';
  if (/delay/i.test(g.detail)) return 'Delayed';
  if (/warmup/i.test(g.detail)) return 'Warming up';
  if (g.outs >= 3 || /mid|end/i.test(g.half || '')) return `${/^t|^m/i.test(g.half || '') ? 'Mid' : 'End'} ${g.inning}`;
  return `${halfWord(g.half)} ${g.inning} · ${g.outs ?? 0} out`;
}

// ------------------------------------------------------------ following
const followsPlayer = (id) => S.follow.players.includes(Number(id));
const followsTeam = (id) => S.follow.teams.includes(Number(id));
const isFollowed = (e) => followsPlayer(e?.batter?.id) || followsTeam(e?.team?.id);
function saveFollow() { store.set('follow', S.follow); }
function liveStatus(id) {
  for (const [pk, ab] of S.atbats) {
    if (ab.batter?.id === id && !ab.result) return { pk, text: 'Batting now', hot: true };
    if (ab.onDeck?.id === id) return { pk, text: 'On deck', hot: false };
    if (ab.inHole?.id === id) return { pk, text: 'In the hole', hot: false };
    if (ab.pitcher?.id === id) return { pk, text: 'Pitching', hot: true };
  }
  return null;
}
