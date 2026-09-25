'use strict';

// One upstream connection belongs to the terminal. Sport engines receive only data over IPC.
const SPORTS = ['nfl', 'ncaaf', 'mlb', 'nhl'];
const ORIGIN = 'https://api.owlsinsight.com';
const CHANNELS = ['odds', 'pinnacle-realtime', 'ps3838-realtime'];
const jsonClone = (value) => JSON.parse(JSON.stringify(value));

function createOwlsFeed(options = {}) {
  const apiKey = String(options.apiKey || '').trim();
  const now = options.now || Date.now;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const normalize = options.normalizeBoard || ((...args) => require('./owls-schema').normalizeBoard(...args));
  const ioFactory = options.ioFactory || ((...args) => require('socket.io-client').io(...args));
  const every = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  const pollMs = options.pollMs || 60000;
  const reconcileMs = options.reconcileMs || 300000;
  /* In play, a book's quote is fresh for 30 s (the boards' live budget). Polled once a minute, most in-play prices
     were already past it on arrival (measured 2026-09-24 on the NHL board: 2–39 s old at the poll, then a minute
     of nothing). A sport whose last odds payload carried in-play quotes is polled every liveMs instead, and its
     Pinnacle realtime channel every livePinMs; the others keep the hourly-budget cadence. The fast cadence stops
     when the month's remaining quota drops under liveBudgetFloor. */
  const liveMs = options.liveMs || 15000, livePinMs = options.livePinMs || 60000, liveBudgetFloor = options.liveBudgetFloor ?? 30000;
  const liveSports = new Set();
  /* The closing window: a sport with a game starting within closingMs is read at the live cadence too, so the
     board's own last-before-kickoff observation (the CLV close, PROVISIONAL in the ledger) lands within seconds of
     the true close instead of within a minute. */
  const closingMs = options.closingMs || 600000;
  const closingSports = new Set();
  const startsSoon = (e) => { const at = Date.parse(e && e.start); return Number.isFinite(at) && at > now() && at - now() <= closingMs; };
  const stores = Object.fromEntries(SPORTS.map(s => [s, Object.fromEntries(CHANNELS.map(c => [c, new Map()]))]));
  const versions = Object.fromEntries(SPORTS.map(s => [s, Object.fromEntries(CHANNELS.map(c => [c, 0]))]));
  const fullSnapshots = Object.fromEntries(SPORTS.map(s => [s, Object.fromEntries(CHANNELS.map(c => [c, 0]))]));
  const touches = Object.fromEntries(SPORTS.map(s => [s, Object.fromEntries(CHANNELS.map(c => [c, new Map()]))]));
  const views = {};
  const nextAt = Object.fromEntries(CHANNELS.map(channel => [channel, Object.fromEntries(SPORTS.map(sport => [sport, 0]))]));
  // The fast cadence is paid from the month's quota (the minute cadence alone is ~8k reads a day across four
  // sports and three channels). Plenty left: every liveMs. Under 120k: every 30 s. Under the floor: off.
  const liveCadence = () => (remainingMonth == null || remainingMonth > 120000 ? liveMs : remainingMonth > liveBudgetFloor ? Math.max(liveMs, 30000) : null);
  const budgetOk = () => liveCadence() != null;
  function intervalFor(channel, sport) {
    if (streamHealthy()) return reconcileMs;
    const live = (liveSports.has(sport) || closingSports.has(sport)) && budgetOk();
    if (channel === 'odds') return live ? liveCadence() : pollMs;
    if (channel === 'pinnacle-realtime') return live ? Math.max(livePinMs, liveCadence() * 4) : 180000;
    return 600000;
  }
  const restChannels = Object.fromEntries(CHANNELS.map(channel => [channel, { lastReceivedAt: null, requests: 0 }]));
  const timers = new Set();
  const controllers = new Set();
  const requestDisabled = new Set();
  let socket, running = false, timer, polling = false, blockedUntil = 0, failures = 0;
  let connected = false, connection = apiKey ? 'starting' : 'disabled', websocketAccess = 'unknown';
  let connectedAt = null;
  let lastReceivedAt = null, lastRestAt = null, lastStreamAt = null, transportLatencyMs = null, providerFrameAt = null;
  const frameCounts = Object.fromEntries(CHANNELS.map(c => [c, 0]));
  let requestCount = 0, retryAt = null, remainingMonth = null, remainingMinute = null;
  const streamHealthy = () => connected && lastStreamAt !== null && now() - lastStreamAt < 45000;
  const status = () => ({ enabled: !!apiKey, connection, connected, streamHealthy: streamHealthy(), websocketAccess, lastReceivedAt, lastRestAt, lastStreamAt,
    transportLatencyMs, providerFrameAt, frameCounts: { ...frameCounts }, restChannels: jsonClone(restChannels), retryAt, requests: requestCount, remainingMonth, remainingMinute,
    liveSports: [...liveSports], closingSports: [...closingSports], liveCadenceMs: liveCadence(),
    books: Object.fromEntries(SPORTS.map(s => [s, [...new Set((views[s]?.raw || []).flatMap(e => (e.bookmakers || []).map(b => e.__owlsChannel === 'ps3838-realtime' ? 'ps3838' : b.key)))].sort()])) });
  const report = () => { if (options.onStatus) options.onStatus(status()); };
  function later(fn, delay) { const id = every(() => { timers.delete(id); fn(); }, delay); id?.unref?.(); timers.add(id); return id; }
  function publish(sport, receivedAt) {
    const raw = CHANNELS.flatMap(channel => [...stores[sport][channel].values()].map(event => ({ ...event, __owlsChannel: channel })));
    const payload = { sports: { [sport]: raw } };
    let events;
    try { events = normalize(payload, sport); } catch { return; }
    if (!Array.isArray(events)) return;
    views[sport] = { events, raw, receivedAt };
    if (events.some(e => e && e.live && typeof e.live === 'object' && Object.keys(e.live).length)) liveSports.add(sport); else liveSports.delete(sport);
    if (events.some(startsSoon)) closingSports.add(sport); else closingSports.delete(sport);
    options.onUpdate?.(sport, { events, receivedAt, status: status() });
  }
  function rowsFrom(payload, sport, channel) {
    if (Array.isArray(payload?.sports?.[sport])) return payload.sports[sport];
    if (Array.isArray(payload?.[sport])) return payload[sport];
    if (Array.isArray(payload?.data)) return payload.data;
    if (channel === 'odds' && payload?.data && typeof payload.data === 'object') {
      return Object.values(payload.data).filter(Array.isArray).flat();
    }
    return null;
  }
  function keyFor(event, index, channel) {
    if (channel !== 'odds') return String(event.id || event.eventId || `${event.home_team}|${event.away_team}|${event.commence_time}|${index}`);
    // V1 REST has one event per book, while WS may fold many books into one event.
    // Preserve every raw book record until the schema normalizer joins canonical games.
    const books = (event.bookmakers || []).map(b => b.key).sort().join(',');
    return `${event.eventId || event.id || `${event.home_team}|${event.away_team}|${event.commence_time}|${index}`}|${books}`;
  }
  function accept(payload, sport, channel, replace, receivedAt, requestedVersion = null) {
    const rows = rowsFrom(payload, sport, channel);
    if (!rows) return false;
    // A later full WS snapshot is authoritative, including every absent event/book.
    // REST uses split book rows while WS can fold books into one event, so a per-key
    // overlay alone cannot safely reconcile these differently shaped full boards.
    if (requestedVersion != null && fullSnapshots[sport][channel] > requestedVersion) return false;
    const old = stores[sport][channel];
    const map = replace ? new Map() : new Map(old);
    const sequence = ++versions[sport][channel];
    rows.forEach((event, index) => {
      if (!event || typeof event !== 'object') return;
      const status = payload?.bookStatus;
      event = { ...event, ...(payload?.meta?.freshness?.stale === true ? { stale: true } : {}),
        bookmakers: (event.bookmakers || []).map(book => ({ ...book,
          ...(status?.[book.key]?.stale === true ? { stale: true } : {}),
          ...(status?.[book.key]?.available === false ? { available: false } : {}) })) };
      const key = keyFor(event, index, channel);
      if (requestedVersion == null) touches[sport][channel].set(key, sequence);
      if (['final', 'cancelled'].includes(event.status)) map.delete(key);
      else map.set(key, event);
    });
    if (requestedVersion == null && replace) {
      fullSnapshots[sport][channel] = sequence;
      for (const key of old.keys()) if (!map.has(key)) touches[sport][channel].set(key, sequence);
    }
    if (requestedVersion != null) {
      // Reconcile the snapshot while preserving every event changed after its request began.
      for (const [key, sequence] of touches[sport][channel]) if (sequence > requestedVersion) {
        if (old.has(key)) map.set(key, old.get(key)); else map.delete(key);
      }
    }
    if (requestedVersion != null) for (const [key, sequence] of touches[sport][channel]) {
      if (sequence <= requestedVersion) touches[sport][channel].delete(key);
    }
    stores[sport][channel] = map;
    lastReceivedAt = receivedAt;
    publish(sport, receivedAt);
    return true;
  }
  function observeFrame(payload) {
    lastStreamAt = now();
    const stamp = typeof payload?.timestamp === 'number' ? payload.timestamp : Date.parse(payload?.timestamp);
    providerFrameAt = Number.isFinite(stamp) ? stamp : null;
    transportLatencyMs = Number.isFinite(stamp) && stamp <= lastStreamAt ? lastStreamAt - stamp : null;
  }
  function stream(channel, payload) {
    if (!running) return;
    const valid = payload && SPORTS.some(sport => Array.isArray(payload?.sports?.[sport]) || Array.isArray(payload?.[sport]));
    if (!valid) return;
    frameCounts[channel]++;
    observeFrame(payload);
    if (connected) connection = 'streaming';
    for (const sport of SPORTS) {
      // Pinnacle emits sparse event deltas without markers. PS3838 marks deltas and periodic full snapshots.
      const replace = channel === 'odds' || (channel === 'ps3838-realtime' && payload?.delta !== true);
      accept(payload, sport, channel, replace, lastStreamAt);
    }
    report();
  }
  function headerNumber(headers, name) {
    const raw = headers?.get?.(name);
    return raw != null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
  }
  async function request(sport, channel) {
    if (!running || now() < blockedUntil || requestDisabled.has(channel)) return;
    const version = versions[sport][channel];
    const controller = new AbortController(); controllers.add(controller);
    const timeout = later(() => controller.abort(), 12000);
    const path = channel === 'odds' ? 'odds' : channel === 'pinnacle-realtime' ? 'realtime' : 'ps3838-realtime';
    try {
      requestCount++; restChannels[channel].requests++;
      const response = await fetchImpl(`${ORIGIN}/api/v1/${sport}/${path}`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'THE.BOARD/1.0', Accept: 'application/json' },
        signal: controller.signal, redirect: 'error',
      });
      remainingMonth = headerNumber(response.headers, 'x-ratelimit-remaining-month') ?? remainingMonth;
      remainingMinute = headerNumber(response.headers, 'x-ratelimit-remaining-minute') ?? remainingMinute;
      if ([401, 403].includes(response.status)) {
        requestDisabled.add(channel);
        if (response.status === 401) for (const disabled of CHANNELS) requestDisabled.add(disabled);
        if (channel === 'odds') connection = response.status === 401 ? 'unauthorized' : 'forbidden';
        report(); return;
      }
      if (response.status === 429) {
        const value = response.headers?.get?.('retry-after');
        const seconds = Number(value);
        const delay = value && Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(value) - now());
        blockedUntil = now() + Math.max(30000, Number.isFinite(delay) ? delay : 60000);
        retryAt = blockedUntil; report(); return;
      }
      if (!response.ok) throw new Error('upstream_unavailable');
      const payload = await response.json();
      if (!running || payload?.success === false) return;
      lastRestAt = now(); restChannels[channel].lastReceivedAt = lastRestAt; failures = 0; retryAt = null;
      accept(payload, sport, channel, true, lastRestAt, version);
      if (!connected && !requestDisabled.has('odds')) connection = 'polling';
      report();
    } catch {
      if (running) {
        failures++;
        blockedUntil = now() + Math.min(300000, 1000 * (2 ** Math.min(failures, 8)));
        retryAt = blockedUntil;
        if (!connected) connection = 'reconnecting';
        report();
      }
    } finally { cancel(timeout); timers.delete(timeout); controllers.delete(controller); }
  }
  async function poll() {
    if (!running || polling) return;
    polling = true;
    try {
      // Three parallel sport reads per channel minimize first-paint latency without
      // exceeding the plan's concurrency limit. All nine snapshots bootstrap once.
      for (const channel of CHANNELS) {
        if (requestDisabled.has(channel) || blockedUntil > now()) continue;
        const due = SPORTS.filter(sport => nextAt[channel][sport] <= now());
        if (!due.length) continue;
        await Promise.all(due.map(sport => request(sport, channel)));
        for (const sport of due) nextAt[channel][sport] = now() + intervalFor(channel, sport);
      }
    } finally {
      polling = false;
      if (running) {
        const due = CHANNELS.filter(channel => !requestDisabled.has(channel)).flatMap(channel => SPORTS.map(sport => nextAt[channel][sport]));
        const wait = due.length ? Math.min(...due) - now() : reconcileMs;
        timer = later(poll, Math.max(1000, wait, blockedUntil - now()));
      }
    }
  }
  function connect() {
    socket = ioFactory(ORIGIN, { query: { apiKey }, transports: ['websocket'], autoConnect: false,
      reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 30000,
      timeout: 12000, extraHeaders: { 'User-Agent': 'THE.BOARD/1.0', Accept: 'application/json' } });
    socket.on('connect', () => {
      connected = true; connectedAt = now(); connection = 'streaming'; websocketAccess = 'enabled';
      for (const channel of CHANNELS) for (const sport of SPORTS) nextAt[channel][sport] = 0;
      socket.emit('subscribe', { sports: SPORTS, alternates: false });
      if (timer) { cancel(timer); timers.delete(timer); }
      void poll(); report();
    });
    socket.on('disconnect', () => {
      connected = false;
      if (!running) return;
      connection = 'reconnecting'; report();
      if (timer) { cancel(timer); timers.delete(timer); }
      timer = later(poll, 1000);
    });
    const failure = error => {
      if (!running) return;
      connected = false;
      // Only classify locally; never echo an upstream error which may include its auth URL.
      const text = String(error?.message || error?.code || '').toLowerCase();
      if (/unauthor|forbidden|subscription|upgrade|api.?key|not.*allow|websocket.*(access|add.on|plan)|connection.*limit|maximum.*connection/.test(text)) {
        websocketAccess = /hall of fame|add.on|upgrade|subscription|plan/.test(text) ? 'not_included' : 'denied';
        socket.disconnect(); connection = 'polling';
        later(() => { if (running && !connected) { connection = 'connecting'; socket.connect(); report(); } }, reconcileMs);
      } else connection = 'reconnecting';
      report();
    };
    socket.on('connect_error', failure); socket.on('error', failure);
    socket.on('odds-update', p => stream('odds', p));
    socket.on('pinnacle-realtime', p => stream('pinnacle-realtime', p));
    socket.on('ps3838-realtime', p => stream('ps3838-realtime', p));
    socket.connect();
  }
  function watchSilence() {
    if (!running) return;
    const reference = lastStreamAt ?? connectedAt;
    if (connected && reference !== null && now() - reference >= 45000 && connection === 'streaming') {
      // Transport can remain connected while the upstream publisher is silent.
      // Resume quota-bounded snapshots without creating a second upstream socket.
      connection = 'polling';
      const intervals = { odds: pollMs, 'pinnacle-realtime': 120000, 'ps3838-realtime': 300000 };
      for (const channel of CHANNELS) for (const sport of SPORTS) nextAt[channel][sport] = Math.min(nextAt[channel][sport], (restChannels[channel].lastReceivedAt || 0) + intervals[channel]);
      if (timer) { cancel(timer); timers.delete(timer); }
      void poll(); report();
    }
    later(watchSilence, 15000);
  }
  function start() {
    if (running || !apiKey) { report(); return; }
    running = true; connection = 'connecting';
    connect(); void poll(); later(watchSilence, 15000);
  }
  function stop() {
    running = false; connected = false;
    for (const id of timers) cancel(id); timers.clear();
    for (const controller of controllers) controller.abort(); controllers.clear();
    socket?.removeAllListeners(); socket?.disconnect();
    connection = apiKey ? 'stopped' : 'disabled';
  }
  return { start, stop, status, snapshot(sport) { const view = views[sport]; return view ? jsonClone({ events: view.events, receivedAt: view.receivedAt, status: status() }) : { events: [], receivedAt: null, status: status() }; } };
}

module.exports = { createOwlsFeed, SPORTS };
