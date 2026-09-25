/* The little dad. Every now and then a tiny 8-bit dad in red panties and high heels walks along the bottom of the
   screen, left to right or right to left, dragging his baseball on a string. Owner's request, 2026-09-24.
   Tiny (24 x 32 px), rare (first walk 2-8 minutes in, then every 12-35 minutes), never while the tab is hidden,
   never for people who asked their system for reduced motion, and off with localStorage board.dad = "0".
   BoardDad.walk() from the console makes him walk now. */
(() => {
  'use strict';
  const PAL = { S: '#F1C27D', H: '#4A2E1A', W: '#F4F4F4', R: '#E0242B', K: '#111111', B: '#FAFAFA', L: '#D7263D', T: '#8A8A8A', G: '#B0B0B0' };
  // 12 x 16, two walk frames. S skin, H hair and moustache, W tank top, R panties, K heels.
  const FRAMES = [[
    '....HHHH....',
    '...HSSSSH...',
    '...SSSSSS...',
    '...SHHHHS...',
    '....SSSS....',
    '...WWWWWW...',
    '..SWWWWWWS..',
    '..S.WWWW.S..',
    '...RRRRRR...',
    '...RRRRRR...',
    '....S..S....',
    '....S..S....',
    '....S..S....',
    '....S..S....',
    '...KK..KK...',
    '..K.....K...',
  ], [
    '....HHHH....',
    '...HSSSSH...',
    '...SSSSSS...',
    '...SHHHHS...',
    '....SSSS....',
    '...WWWWWW...',
    '..SWWWWWWS..',
    '...SWWWWS...',
    '...RRRRRR...',
    '...RRRRRR...',
    '...S....S...',
    '...S....S...',
    '..S......S..',
    '..S......S..',
    '.KK......KK.',
    'K..........K',
  ]];
  // the baseball, 5 x 5, with red stitches
  const BALL = ['.BBB.', 'BLBLB', 'BBLBB', 'BLBLB', '.BBB.'];
  const SCALE = 2, W = 12, H = 16;
  let canvas, ctx, timer = null, walking = false;
  const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const off = () => { try { return localStorage.getItem('board.dad') === '0'; } catch { return false; } };
  const rand = (a, b) => a + Math.random() * (b - a);

  function paint(frame, dir, t) {
    // canvas: ball + string behind the dad. Width: ball (5) + string (8) + dad (12) = 25 cells
    const cw = 25, chh = H;
    ctx.clearRect(0, 0, cw * SCALE, chh * SCALE);
    const px = (x, y, c) => { ctx.fillStyle = PAL[c]; ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE); };
    // the dad faces the direction of travel; drawn at the right of the canvas when walking right
    const dx = 13;
    FRAMES[frame].forEach((row, y) => { for (let x = 0; x < W; x++) if (row[x] !== '.') px(dx + x, y, row[x]); });
    // string from the back hand (x=dx+1, y=7) down to the ball, which bumps along the ground behind him
    const bob = Math.round(Math.abs(Math.sin(t / 90)) * 1.2);
    const bx = 0, by = H - 5 - bob;
    for (let i = 1; i < 9; i++) { const sx = dx + 1 - i, sy = 7 + Math.round((by + 2 - 7) * (i / 9)); px(sx, sy, i % 2 ? 'T' : 'G'); }
    BALL.forEach((row, y) => { for (let x = 0; x < 5; x++) if (row[x] !== '.') px(bx + x, by + y, row[x]); });
    canvas.style.transform = dir < 0 ? 'scaleX(-1)' : '';
  }
  function walk() {
    if (walking || off() || reduced() || document.hidden) return schedule();
    walking = true;
    if (!canvas) {
      canvas = document.createElement('canvas'); canvas.className = 'xdad'; canvas.width = 25 * SCALE; canvas.height = H * SCALE;
      canvas.setAttribute('aria-hidden', 'true'); canvas.title = '';
      ctx = canvas.getContext('2d'); document.body.appendChild(canvas);
    }
    const dir = Math.random() < 0.5 ? 1 : -1;
    const width = canvas.width, span = window.innerWidth + width * 2;
    const duration = rand(11000, 16000), start = performance.now();
    canvas.style.display = 'block';
    const step = (now) => {
      const t = now - start, p = Math.min(1, t / duration);
      const x = dir > 0 ? -width + p * span : window.innerWidth + width - p * span;
      canvas.style.left = Math.round(x) + 'px';
      paint(Math.floor(t / 160) % 2, dir, t);
      if (p < 1 && !document.hidden) requestAnimationFrame(step);
      else { canvas.style.display = 'none'; walking = false; schedule(); }
    };
    requestAnimationFrame(step);
  }
  function schedule(first = false) {
    clearTimeout(timer);
    if (off() || reduced()) return;
    timer = setTimeout(walk, first ? rand(2, 8) * 60000 : rand(12, 35) * 60000);
  }
  window.BoardDad = { walk: () => { walking = false; clearTimeout(timer); walk(); }, stop: () => { clearTimeout(timer); if (canvas) canvas.style.display = 'none'; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => schedule(true), { once: true }); else schedule(true);
})();
