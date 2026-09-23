/* First-party activity: named board actions only, never general browser history. */
(function () {
  'use strict';
  var match = /^\/(nfl|ncaaf|mlb|nhl)\/(?:index\.html)?$/.exec(location.pathname);
  if (!match || (window.tel && window.tel.activityVersion === 1)) return;
  var sport = match[1], endpoint = '/' + sport + '/api/telemetry';
  var routes = new Set(['board', 'live', 'bets', 'tools', 'games', 'homers', 'following', 'mine', 'odds', 'edges', 'week', 'game', 'replays']);
  var actions = new Set(['APP_FOREGROUND', 'APP_BACKGROUND', 'PAGE_EXIT', 'ONLINE', 'OFFLINE']);
  var clicks = new Set(['OPEN_GAME', 'OPEN_REPLAYS', 'PLAY_REPLAY', 'REPLAY_SPEED', 'OPEN_TICKET', 'OPEN_SPORTSBOOK', 'CLOSE_DIALOG', 'CHANGE_MARKET', 'CHANGE_FILTER', 'CHANGE_WEEK', 'CHANGE_THEME', 'CHANGE_ALERTS', 'OPEN_PHONE', 'OPEN_SUPPORT', 'OPEN_RESULTS']);
  var queue = [], timer = 0, rateStart = Date.now(), count = 0, route = '', lastView = '', lastErrorAt = -Infinity;
  var visit;
  try {
    var random = new Uint32Array(3); crypto.getRandomValues(random);
    visit = 'v_' + Array.from(random, function (n) { return n.toString(36); }).join('_');
  } catch (_) { visit = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12); }

  function currentRoute() {
    var hash = location.hash.slice(1);
    if (!hash) return sport === 'nhl' ? 'board' : 'live';
    if (routes.has(hash)) return hash;
    // Identifiers in game links never leave the page.
    if (/^game\/[a-z0-9_-]+$/i.test(hash)) return 'game';
    return '';
  }
  function context() {
    var c = { visible: document.visibilityState === 'visible' };
    function number(key, value, min, max) { if (Number.isFinite(value) && value >= min && value <= max) c[key] = value; }
    try {
      number('vw', innerWidth, 1, 16384); number('vh', innerHeight, 1, 16384);
      number('sw', screen.width, 1, 16384); number('sh', screen.height, 1, 16384);
      number('dpr', Math.round((devicePixelRatio || 1) * 100) / 100, 0.1, 10);
      number('tzo', new Date().getTimezoneOffset(), -840, 840);
      number('touch', navigator.maxTouchPoints, 0, 20);
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (typeof tz === 'string' && tz.length <= 60 && /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)) c.tz = tz;
      var langs = Array.from(navigator.languages || [navigator.language || '']).slice(0, 4)
        .filter(function (s) { return typeof s === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(s) && s.length <= 24; });
      if (langs.length) { c.locale = langs[0]; c.langs = langs.join(',').slice(0, 60); }
      c.standalone = navigator.standalone === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
    } catch (_) { /* Optional browser context must never interrupt the board. */ }
    return c;
  }
  function schedule() { if (!timer && queue.length) timer = setTimeout(flush, 4000); }
  function push(kind, data) {
    if (!route) return;
    var now = Date.now();
    if (now - rateStart >= 60000) { rateStart = now; count = 0; }
    if (count >= 120 || queue.length >= 60) return;
    count++;
    var event = { kind: kind, t: now, route: route, vid: visit };
    if (data) event.data = data;
    queue.push(event);
    if (queue.length >= 20) flush(); else schedule();
  }
  function flush(sync) {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (!queue.length) return;
    var body = JSON.stringify({ events: queue.splice(0, 20) });
    try {
      if (sync === true && navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
      } else {
        fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true, credentials: 'same-origin' })
          .catch(function () { /* Drop the batch; never retry activity. */ });
      }
    } catch (_) { /* Drop the batch. */ }
    schedule();
  }
  function view(value) {
    var next = value === undefined ? currentRoute() : value;
    if (!routes.has(next)) { if (value === undefined) route = ''; return; }
    route = next;
    if (next === lastView) return;
    lastView = next; push('page_view');
  }
  function action(name) { if (actions.has(name)) push('app_action', { action: name }); }
  function applicationError() {
    var now = Date.now();
    if (!route || now - lastErrorAt < 60000) return;
    lastErrorAt = now;
    // Presence only: never inspect messages, stacks, rejected values, or resource URLs.
    push('client_error');
  }
  function click(label) {
    if (clicks.has(label) || (typeof label === 'string' && label.startsWith('tab:') && routes.has(label.slice(4)))) push('click', { label: label });
  }
  window.tel = { activityVersion: 1, view: view, act: action, click: click, flush: flush };

  addEventListener('hashchange', function () { view(); });
  addEventListener('popstate', function () { view(); });
  addEventListener('click', function (event) {
    var el = event.target && event.target.closest && event.target.closest('button,a,[data-tab],[data-open],[data-game],[data-bet]');
    if (!el) return;
    var tab = el.getAttribute('data-tab');
    if (tab !== null) { if (routes.has(tab)) { click('tab:' + tab); view(tab); } return; }
    if (el.tagName === 'A') {
      // Native NHL tabs are local fragment links. Other link destinations are never captured.
      var href = el.getAttribute('href');
      if (href && /^#[a-z]+$/.test(href) && routes.has(href.slice(1))) { click('tab:' + href.slice(1)); view(href.slice(1)); return; }
    }
    var room = el.getAttribute('data-room-tab');
    if (room === 'replays' || room === 'overview') { click(room === 'replays' ? 'OPEN_REPLAYS' : 'OPEN_GAME'); view(room === 'replays' ? 'replays' : 'game'); return; }
    var controls = [
      ['[data-goals]', 'OPEN_REPLAYS', 'replays'], ['[data-replay]', 'PLAY_REPLAY', 'replays'],
      ['[data-game],[data-open]', 'OPEN_GAME', 'game'], ['[data-ticket],[data-bet],[data-pf-new]', 'OPEN_TICKET'],
      ['[data-bet-handoff],[data-mgmgo],[data-mgmbet]', 'OPEN_SPORTSBOOK'], ['[data-rate]', 'REPLAY_SPEED'],
      ['[data-market],[data-mkt]', 'CHANGE_MARKET'], ['[data-filter],[data-phbook]', 'CHANGE_FILTER'],
      ['[data-week]', 'CHANGE_WEEK'], ['#themeBtn', 'CHANGE_THEME'], ['#alertBtn', 'CHANGE_ALERTS'],
      ['#phoneBtn,#phoneBtn2', 'OPEN_PHONE'], ['[data-creator-open]', 'OPEN_SUPPORT'],
      ['[data-manage],[data-pf-results]', 'OPEN_RESULTS'], ['[data-close],#dlgClose', 'CLOSE_DIALOG']
    ];
    for (var i = 0; i < controls.length; i++) {
      if (el.matches(controls[i][0])) { click(controls[i][1]); if (controls[i][2]) view(controls[i][2]); return; }
    }
  }, true);
  addEventListener('visibilitychange', function () {
    action(document.visibilityState === 'visible' ? 'APP_FOREGROUND' : 'APP_BACKGROUND');
    flush(document.visibilityState !== 'visible');
  });
  addEventListener('pagehide', function () { action('PAGE_EXIT'); flush(true); });
  addEventListener('online', function () { action('ONLINE'); });
  addEventListener('offline', function () { action('OFFLINE'); });
  addEventListener('error', applicationError, true);
  addEventListener('unhandledrejection', applicationError);
  // Native dialogs emit close without a route/hash change.
  document.addEventListener('close', function (event) {
    if (event.target && ['dlg', 'game-dialog', 'ticket-dialog'].includes(event.target.id)) view();
  }, true);
  route = currentRoute();
  push('visit_open', { ctx: context() });
  view();
})();
