/* THE.BOARD — broadcast layer: puts each game's real team colours onto its cards.

   Every game card on all three boards already carries its game id (data-open on NFL/NCAAF, data-game on
   MLB). This watches the page, looks each game up in the board's own state, and sets two CSS variables on
   the card: --ta (away) and --th (home). broadcast.css does the rest. Nothing about the data changes, and
   nothing is sent anywhere.

   Team colours come from ESPN for football (t.color / t.alt). MLB's feed has none, so they are listed here.
   A colour too dark to read on the navy board (the Yankees' navy, say) is lifted until it shows. */
(function () {
  'use strict';
  var MLB = { ARI: '#A71930', AZ: '#A71930', ATL: '#CE1141', BAL: '#DF4601', BOS: '#BD3039', CHC: '#0E3386', CWS: '#C4CED4', CHW: '#C4CED4',
    CIN: '#C6011F', CLE: '#E31937', COL: '#5E3FA3', DET: '#FA4616', HOU: '#EB6E1F', KC: '#004687', KCR: '#004687', LAA: '#BA0021',
    LAD: '#005A9C', MIA: '#00A3E0', MIL: '#FFC52F', MIN: '#D31145', NYM: '#FF5910', NYY: '#1C3F7A', ATH: '#EFB21E', OAK: '#EFB21E',
    PHI: '#E81828', PIT: '#FDB827', SD: '#FFC425', SDP: '#FFC425', SF: '#FD5A1E', SFG: '#FD5A1E', SEA: '#00857C', STL: '#C41E3A',
    TB: '#8FBCE6', TBR: '#8FBCE6', TEX: '#1E4FA0', TOR: '#1D5BB0', WSH: '#AB0003', WSN: '#AB0003' };

  function rgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function lum(c) {
    var a = c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function hex(c) { return '#' + c.map(function (v) { return ('0' + Math.round(v).toString(16)).slice(-2); }).join(''); }
  // Lift a colour toward white just enough that it reads on the dark board. Hue is kept.
  function lift(c) {
    var out = c.slice(), i = 0;
    while (lum(out) < 0.13 && i++ < 14) out = out.map(function (v) { return v + (255 - v) * 0.12; });
    return out;
  }
  function pick(t) {
    if (!t) return null;
    var a = rgb(t.color || MLB[t.abbr]), b = rgb(t.alt);
    if (!a && !b) return null;
    // Pure black/white/grey primaries (Raiders, Nets-style) say nothing on a board; prefer a real alt colour.
    var grey = function (c) { return Math.max.apply(null, c) - Math.min.apply(null, c) < 24; };
    if (a && grey(a) && b && !grey(b)) a = b;
    return hex(lift(a || b));
  }

  function lookup(el) {
    try {
      var id = el.getAttribute('data-open');
      if (id != null && typeof gameById === 'function') return gameById(id);
      id = el.getAttribute('data-game');
      // eslint-disable-next-line no-undef
      if (id != null && typeof S !== 'undefined' && S.games && S.games.get) return S.games.get(Number(id)) || S.games.get(id);
    } catch (e) { /* a board that has not loaded yet */ }
    return null;
  }

  var SEL = '.hcard[data-open],.lc[data-open],.gm[data-open],.br[data-open],.mv[data-open],.li[data-open],'
    + '.gm[data-game],.gcard[data-game],.ab[data-game],.bt tr[data-open]';
  function paint() {
    var els = document.querySelectorAll(SEL);
    for (var i = 0; i < els.length; i++) {
      var el = els[i], g = lookup(el);
      if (!g || !g.home || !g.away) continue;
      var a = pick(g.away), h = pick(g.home);
      if (!a && !h) continue;
      var key = (a || '') + (h || '');
      if (el.getAttribute('data-tint') === key) continue;
      el.style.setProperty('--ta', a || h);
      el.style.setProperty('--th', h || a);
      el.setAttribute('data-tint', key);
    }
  }
  var queued = false;
  function soon() { if (queued) return; queued = true; requestAnimationFrame(function () { queued = false; paint(); }); }
  new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState !== 'loading') soon(); else document.addEventListener('DOMContentLoaded', soon);
})();
