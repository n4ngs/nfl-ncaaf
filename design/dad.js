/* The little dad. Every now and then a tiny 8-bit dad in red panties and high heels walks along the bottom of the
   screen, left to right or right to left, dragging a piece of sports gear behind him on a string: a baseball bat,
   a tennis ball, a water polo ball, a baseball, a football (that walk he wears a helmet), or a hockey stick.
   Owner's request, 2026-09-24. Tiny (about 50 x 32 px), rare (first walk 2-8 minutes in, then every 12-35 minutes),
   never while the tab is hidden, never for people who asked their system for reduced motion, and off with
   localStorage board.dad = "0". BoardDad.walk('football') from the console makes him walk now with that gear. */
(() => {
  'use strict';
  const PAL = { S: '#F1C27D', H: '#4A2E1A', W: '#F4F4F4', R: '#E0242B', K: '#111111', B: '#FAFAFA', L: '#D7263D', T: '#8A8A8A', G: '#B0B0B0',
    N: '#8B5A2B', D: '#5C3A1A', Y: '#C8E23A', P: '#F2C230', U: '#1E6FD9', F: '#7A3B12', M: '#1F3A93', C: '#DDDDDD' };
  // 12 x 16, two walk frames. S skin, H hair and moustache, W tank top, R panties, K heels.
  const FRAMES = [[
    '....HHHH....', '...HSSSSH...', '...SSSSSS...', '...SHHHHS...', '....SSSS....', '...WWWWWW...', '..SWWWWWWS..', '..S.WWWW.S..',
    '...RRRRRR...', '...RRRRRR...', '....S..S....', '....S..S....', '....S..S....', '....S..S....', '...KK..KK...', '..K.....K...',
  ], [
    '....HHHH....', '...HSSSSH...', '...SSSSSS...', '...SHHHHS...', '....SSSS....', '...WWWWWW...', '..SWWWWWWS..', '...SWWWWS...',
    '...RRRRRR...', '...RRRRRR...', '...S....S...', '...S....S...', '..S......S..', '..S......S..', '.KK......KK.', 'K..........K',
  ]];
  // the football walk: a helmet (M) with a facemask (C) instead of hair, drawn over the top four rows
  const HELMET = ['...MMMMMM...', '..MMMMMMMM..', '..MMSSSSMM..', '..MCSSSSCM..'];
  // the gear, each drawn behind him at ground level and dragged along on a string
  const GEAR = {
    bat:       ['.....NN', '....NN.', '...NN..', '..NN...', '.DD....', 'DD.....'],
    tennis:    ['.YY.', 'YBYY', 'YYBY', '.YY.'],
    waterpolo: ['.PPP.', 'PUPUP', 'PPPPP', 'PUPUP', '.PPP.'],
    baseball:  ['.BBB.', 'BLBLB', 'BBLBB', 'BLBLB', '.BBB.'],
    football:  ['..FFF..', '.FFWFF.', 'FFWWWFF', '.FFWFF.', '..FFF..'],
    hockey:    ['N.....', 'N.....', 'N.....', 'N.....', 'N.....', 'NNNNKK'],
  };
  const KINDS = Object.keys(GEAR);
  const SCALE = 2, W = 12, H = 16, CW = 26;
  let canvas, ctx, timer = null, walking = false;
  const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const off = () => { try { return localStorage.getItem('board.dad') === '0'; } catch { return false; } };
  const rand = (a, b) => a + Math.random() * (b - a);

  function paint(frame, dir, t, kind) {
    ctx.clearRect(0, 0, CW * SCALE, H * SCALE);
    const px = (x, y, c) => { ctx.fillStyle = PAL[c]; ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE); };
    const dx = 14;   // the dad stands at the right of the canvas; the gear trails behind at the left
    FRAMES[frame].forEach((row, y) => { for (let x = 0; x < W; x++) if (row[x] !== '.') px(dx + x, y, row[x]); });
    if (kind === 'football') { for (let y = 0; y < 4; y++) for (let x = 0; x < W; x++) if (HELMET[y][x] !== '.') px(dx + x, y, HELMET[y][x]); }
    const gear = GEAR[kind], gh = gear.length, gw = gear[0].length;
    const bob = kind === 'bat' || kind === 'hockey' ? 0 : Math.round(Math.abs(Math.sin(t / 90)) * 1.2);
    const gx = 1, gy = H - gh - bob;
    // string from the back hand (row 7) to the top of the gear
    const hx = dx + 1, hy = 7, ex = gx + gw - 1, ey = gy;
    const steps = Math.max(Math.abs(hx - ex), Math.abs(hy - ey));
    for (let i = 1; i < steps; i++) px(Math.round(hx + (ex - hx) * i / steps), Math.round(hy + (ey - hy) * i / steps), i % 2 ? 'T' : 'G');
    gear.forEach((row, y) => { for (let x = 0; x < gw; x++) if (row[x] !== '.') px(gx + x, gy + y, row[x]); });
    canvas.style.transform = dir < 0 ? 'scaleX(-1)' : '';
  }
  function walk(kind) {
    if (walking || off() || reduced() || document.hidden) return schedule();
    walking = true;
    if (!canvas) {
      canvas = document.createElement('canvas'); canvas.className = 'xdad'; canvas.width = CW * SCALE; canvas.height = H * SCALE;
      canvas.setAttribute('aria-hidden', 'true');
      ctx = canvas.getContext('2d'); document.body.appendChild(canvas);
    }
    const gear = GEAR[kind] ? kind : KINDS[Math.floor(Math.random() * KINDS.length)];
    const dir = Math.random() < 0.5 ? 1 : -1;
    const width = canvas.width, span = window.innerWidth + width * 2;
    const duration = rand(11000, 16000), start = performance.now();
    canvas.style.display = 'block';
    const step = (now) => {
      const t = Math.max(0, now - start), p = Math.min(1, t / duration);   // rAF can stamp the first frame just before start
      const x = dir > 0 ? -width + p * span : window.innerWidth + width - p * span;
      canvas.style.left = Math.round(x) + 'px';
      paint(Math.floor(t / 160) % 2, dir, t, gear);
      if (p < 1 && !document.hidden) requestAnimationFrame(step);
      else { canvas.style.display = 'none'; walking = false; schedule(); }
    };
    requestAnimationFrame(step);
  }
  function schedule(first = false) {
    clearTimeout(timer);
    if (off() || reduced()) return;
    timer = setTimeout(() => walk(), first ? rand(2, 8) * 60000 : rand(12, 35) * 60000);
  }
  // five quick taps on the mark in the top bar summon him (phones have no console)
  let taps = [];
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#xsport .brand')) return;
    const now = Date.now(); taps = taps.filter((t) => now - t < 2000); taps.push(now);
    if (taps.length >= 5) { taps = []; walking = false; clearTimeout(timer); walk(); }
  });
  window.BoardDad = { kinds: KINDS, walk: (kind) => { walking = false; clearTimeout(timer); walk(kind); }, stop: () => { clearTimeout(timer); if (canvas) canvas.style.display = 'none'; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => schedule(true), { once: true }); else schedule(true);
})();
