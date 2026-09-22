/* THE.BOARD — private, read-only cross-sport tickets. No browser storage or identity merging. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoardPortfolio = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';

  const SPORTS = Object.freeze(['nfl', 'ncaaf', 'mlb']);
  const SETTLED = new Set(['won', 'lost', 'push', 'void']);
  const DEFAULT_TTL = 5000;
  const DEFAULT_TIMEOUT = 8000;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const text = (value) => (typeof value === 'string' ? value : '');
  function sportName(sport) {
    if (!SPORTS.includes(sport)) throw new TypeError('Unknown portfolio sport.');
    return sport;
  }
  function idOf(value) {
    return typeof value === 'string' && value.trim() ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  }
  // Avoid converting timezone-less historical data into a fictional UTC wager time.
  function utc(value) {
    if (typeof value === 'string' && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const ms = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null;
  }
  function baseFor(sport, value) {
    const base = value == null ? '/' + sport : value;
    if (typeof base !== 'string' || (base !== '' && !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(base))) {
      throw new TypeError('Portfolio base paths must be same-origin paths.');
    }
    return base.replace(/\/$/, '');
  }
  function sourceHref(sport, basePath) {
    const base = baseFor(sport, basePath);
    return base + (sport === 'mlb' ? '/?portfolio=mine#following' : '/#bets');
  }
  function gameGetter(games) {
    if (typeof games === 'function') return games;
    if (games && typeof games.get === 'function') return (id) => games.get(id) || games.get(Number(id)) || null;
    if (Array.isArray(games)) {
      const map = new Map(games.map((game) => [idOf(game?.id ?? game?.pk), game]));
      return (id) => map.get(id) || null;
    }
    if (games && typeof games === 'object') return (id) => own(games, id) ? games[id] : null;
    return () => null;
  }
  function legPhase(leg, game, now) {
    if (SETTLED.has(leg.state)) return 'settled';
    if (leg.state != null && leg.state !== 'open') return 'unknown';
    if (game) {
      if (/postpon|cancel|suspend/i.test(game.detail || '')) return 'unknown';
      if (game.state === 'in' || game.state === 'Live') return 'live';
      if (game.state === 'pre' || game.state === 'Preview') return 'upcoming';
      if (game.state) return 'unknown'; // A final game does not grade an open ticket.
    }
    const start = utc(game?.start ?? leg.start);
    return start && Date.parse(start) > now ? 'upcoming' : 'unknown';
  }


  // Score context comes only from the current sport's game evidence, never from a saved ticket.
  function liveContext(sport, game) {
    if (!game) return null;
    const parts = [];
    const home = number(game.home?.score), away = number(game.away?.score);
    if (home != null || away != null) parts.push(`${text(game.away?.abbr) || 'Away'} ${away ?? '—'} · ${text(game.home?.abbr) || 'Home'} ${home ?? '—'}`);
    if (/delay|warmup/i.test(game.detail || '')) parts.push(/delay/i.test(game.detail) ? 'Delayed' : 'Warming up');
    else if (sport === 'mlb') {
      const inning = number(game.inning), outs = number(game.outs), half = text(game.half).toLowerCase();
      const halfLabel = /^(top|bottom|middle|mid|end)$/.test(half) ? ({ top: 'Top', bottom: 'Bottom', middle: 'Mid', mid: 'Mid', end: 'End' })[half] : '';
      if (inning != null && Number.isInteger(inning) && inning > 0) {
        const label = outs === 3 && halfLabel ? (halfLabel === 'Top' || halfLabel === 'Mid' ? 'Mid' : 'End') : halfLabel;
        parts.push(`${label ? label + ' ' : 'Inning '}${inning}`);
      }
      if (outs != null && Number.isInteger(outs) && outs >= 0 && outs < 3 && halfLabel !== 'Mid' && halfLabel !== 'End') parts.push(`${outs} ${outs === 1 ? 'out' : 'outs'}`);
    } else if (game.half === true) parts.push('Halftime');
    else {
      const period = number(game.period), clock = text(game.clock);
      const quarter = period != null && Number.isInteger(period) && period > 0 ? period <= 4 ? `Q${period}` : period === 5 ? 'OT' : `${period - 4}OT` : '';
      if (quarter || clock) parts.push([quarter, clock].filter(Boolean).join(' '));
    }
    return parts.length ? parts.join(' · ') : null;
  }

  function normalizeTicket(sport, input, options = {}) {
    sportName(sport);
    if (!input || typeof input !== 'object' || Array.isArray(input) || !idOf(input.id) || !Array.isArray(input.legs) || !input.legs.length || input.legs.some((leg) => !leg || typeof leg !== 'object' || Array.isArray(leg))) {
      throw new TypeError('The ticket response has an invalid record.');
    }
    const raw = copy(input);
    const nativeId = idOf(raw.id);
    const status = raw.status === 'open' || SETTLED.has(raw.status) ? raw.status : 'unknown';
    const now = number(options.now) ?? Date.now();
    const getGame = gameGetter(options.gameOf || options.games);
    const legs = raw.legs.map((leg, index) => {
      const eventId = idOf(sport === 'mlb' ? leg.pk : leg.gid);
      const game = eventId == null ? null : getGame(eventId, leg);
      const phase = legPhase(leg, game, now);
      return { ...copy(leg), index, eventId, phase, liveText: status === 'open' && phase === 'live' ? liveContext(sport, game) : null, integrity: leg.integrity == null ? null : copy(leg.integrity) };
    });
    const remaining = legs.filter((leg) => leg.phase !== 'settled');
    const phase = SETTLED.has(status) ? 'settled' : status !== 'open' ? 'unknown'
      : remaining.some((leg) => leg.phase === 'live') ? 'live'
        : remaining.length && remaining.every((leg) => leg.phase === 'upcoming') ? 'upcoming' : 'unknown';
    return {
      id: sport + ':' + nativeId, key: sport + ':' + nativeId, nativeId, sport,
      sourceHref: sourceHref(sport, options.basePath), status, phase,
      placedAt: utc(raw.placed), createdAt: utc(raw.created), settledAt: utc(raw.settled),
      stake: number(raw.stake), odds: number(raw.odds), profit: number(raw.net),
      book: text(raw.book), note: text(raw.note), legs, raw,
    };
  }

  function validateRecords(value, sport) {
    if (!Array.isArray(value)) throw new TypeError('The ticket response is not a list.');
    const seen = new Map();
    for (const record of value) {
      const ticket = normalizeTicket(sport, record);
      const signature = JSON.stringify(ticket.raw);
      if (seen.has(ticket.nativeId) && seen.get(ticket.nativeId).signature !== signature) throw new TypeError('The ticket response contains conflicting IDs.');
      if (!seen.has(ticket.nativeId)) seen.set(ticket.nativeId, { signature, raw: ticket.raw });
    }
    return [...seen.values()].map((row) => row.raw);
  }
  function bounded(value, fallback, max) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, max) : fallback;
  }
  function createLoader(defaults = {}) {
    const clock = typeof defaults.now === 'function' ? defaults.now : Date.now;
    const cache = new Map();
    const inflight = new Map();
    const fetchIds = new WeakMap();
    let nextFetchId = 0;
    function invalidate(sport) {
      if (sport != null) sportName(sport);
      for (const [key, item] of cache) if (sport == null || item.sport === sport) cache.delete(key);
      for (const [key, item] of inflight) if (sport == null || item.sport === sport) {
        item.invalidated = true;
        item.controller?.abort();
        item.cancel?.();
        inflight.delete(key);
      }
    }
    async function read(sport, basePath, fetchImpl, ttl, timeout) {
      if (typeof fetchImpl !== 'function') throw new Error('Fetching tickets is unavailable.');
      if (!fetchIds.has(fetchImpl)) fetchIds.set(fetchImpl, ++nextFetchId);
      const key = fetchIds.get(fetchImpl) + ':' + sport + ':' + basePath;
      const saved = cache.get(key);
      if (saved && clock() - saved.updatedAt >= 0 && clock() - saved.updatedAt < ttl) return { ...saved, cached: true };
      if (saved) cache.delete(key);
      if (inflight.has(key)) return inflight.get(key).promise;
      const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      const item = { sport, controller, invalidated: false, promise: null, cancel: null };
      item.promise = (async () => {
        let timer;
        try {
          const response = await Promise.race([
            Promise.resolve().then(() => fetchImpl.call(root, basePath + '/api/bets', {
              method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
              headers: { accept: 'application/json' }, ...(controller ? { signal: controller.signal } : {}),
            })).then(async (response) => {
              if (!response || !response.ok) {
                const status = response?.status;
                throw new Error(status === 401 || status === 403 ? 'Open this sport to sign in.' : 'Tickets are unavailable' + (status ? ' (HTTP ' + status + ')' : '') + '.');
              }
              const type = response.headers?.get?.('content-type');
              if (type && !/\bapplication\/json\b/i.test(type)) throw new Error('The ticket response was not JSON.');
              const records = validateRecords(await response.json(), sport);
              return { sport, records, updatedAt: clock(), cached: false };
            }),
            new Promise((resolve, reject) => {
              item.cancel = () => reject(new Error('Ticket loading was invalidated.'));
              timer = root.setTimeout(() => { controller?.abort(); reject(new Error('Ticket loading timed out.')); }, timeout);
            }),
          ]);
          if (item.invalidated) throw new Error('Ticket loading was invalidated.');
          cache.set(key, response);
          return response;
        } finally {
          root.clearTimeout(timer);
          if (inflight.get(key) === item) inflight.delete(key);
        }
      })();
      inflight.set(key, item);
      return item.promise;
    }
    async function load(options = {}) {
      const currentSport = options.sport == null ? null : sportName(options.sport);
      const sports = [...new Set(options.sports == null ? SPORTS : options.sports)];
      sports.forEach(sportName);
      const ttl = bounded(options.ttlMs, bounded(defaults.ttlMs, DEFAULT_TTL, 30000), 30000);
      const timeout = Math.max(1, bounded(options.timeoutMs, bounded(defaults.timeoutMs, DEFAULT_TIMEOUT, 30000), 30000));
      const fetchImpl = options.fetchImpl || defaults.fetchImpl || root.fetch;
      const snapshots = await Promise.all(sports.map(async (sport) => {
        try {
          const basePath = baseFor(sport, options.basePaths?.[sport]);
          const current = sport === currentSport && own(options, 'currentBets');
          const supplied = current || (options.betsBySport && own(options.betsBySport, sport));
          const result = supplied ? { records: validateRecords(current ? options.currentBets : options.betsBySport[sport], sport), updatedAt: clock(), cached: false }
            : await read(sport, basePath, fetchImpl, ttl, timeout);
          const games = sport === currentSport ? options.gameOf || options.currentGames || options.gamesBySport?.[sport] : options.gamesBySport?.[sport];
          const tickets = result.records.map((record) => normalizeTicket(sport, record, { games, now: clock(), basePath }));
          return { tickets, source: { sport, status: 'ok', updatedAt: result.updatedAt, cached: result.cached } };
        } catch (error) {
          return { tickets: [], source: { sport, status: 'error', error: error instanceof TypeError ? error.message : /^(Open this sport|Tickets are unavailable|Ticket loading|The ticket response|Fetching tickets)/.test(error?.message || '') ? error.message : 'Unable to load tickets.', updatedAt: null, cached: false } };
        }
      }));
      const tickets = snapshots.flatMap((entry) => entry.tickets);
      tickets.sort((a, b) => (Date.parse(b.placedAt) || 0) - (Date.parse(a.placedAt) || 0) || a.id.localeCompare(b.id));
      return { tickets, sources: snapshots.map((entry) => entry.source), updatedAt: clock() };
    }
    return Object.freeze({ load, invalidate });
  }
  // The caller opens only the other sports while the portfolio is visible and owns the
  // returned stop function. Each sport keeps its existing path-scoped HttpOnly identity.
  function subscribe(options = {}) {
    const sports = [...new Set(options.sports || [])];
    if (sports.length > 2) throw new TypeError('Subscribe to at most two peer sports.');
    const destinations = sports.map((sport) => ({ sport: sportName(sport), basePath: baseFor(sport, options.basePaths?.[sport]) }));
    const EventSourceImpl = options.EventSourceImpl || root.EventSource;
    if (destinations.length && typeof EventSourceImpl !== 'function') throw new TypeError('Live ticket streams are unavailable.');
    let stopped = false;
    const connections = [];
    const notify = (sport, status, error) => options.onStatus?.(sport, { status, ...(error ? { error } : {}), updatedAt: Date.now() });
    for (const { sport, basePath } of destinations) {
      let games = new Map();
      let awaitingSnapshot = true;
      let stream;
      const gameId = (game) => idOf(sport === 'mlb' ? game?.pk : game?.id);
      const sendGames = () => options.onGames?.(sport, new Map([...games].map(([id, game]) => [id, copy(game)])));
      const clearGames = () => { games = new Map(); sendGames(); };
      notify(sport, 'connecting');
      try { stream = new EventSourceImpl(basePath + '/api/stream', { withCredentials: true }); }
      catch { notify(sport, 'error', 'Unable to open the live ticket stream.'); continue; }
      connections.push({ sport, stream });
      const listen = (type, handler) => stream.addEventListener(type, (event) => {
        if (stopped) return;
        let data;
        try { data = JSON.parse(event.data); handler(data); }
        catch {
          awaitingSnapshot = true;
          clearGames();
          stream.close();
          notify(sport, 'error', 'The live ticket stream returned an invalid update.');
        }
      });
      listen('snapshot', (data) => {
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Invalid snapshot');
        const records = validateRecords(data.bets, sport);
        const rows = sport === 'mlb' ? data.games : data.week == null ? [] : data.week.games;
        if (!Array.isArray(rows) || rows.some((game) => !gameId(game))) throw new TypeError('Invalid game state');
        games = new Map(rows.map((game) => [gameId(game), copy(game)]));
        awaitingSnapshot = false;
        loader.invalidate(sport);
        sendGames();
        options.onBets?.(sport, copy(records));
        notify(sport, 'connected');
      });
      listen('bets', (data) => {
        if (awaitingSnapshot) return;
        const records = validateRecords(data, sport);
        loader.invalidate(sport);
        options.onBets?.(sport, copy(records));
      });
      listen('game', (game) => {
        if (awaitingSnapshot) return;
        const id = gameId(game);
        if (!id) throw new TypeError('Invalid game state');
        games.set(id, copy(game));
        sendGames();
      });
      stream.onopen = () => { if (!stopped) notify(sport, awaitingSnapshot ? 'connecting' : 'connected'); };
      stream.onerror = () => {
        if (stopped) return;
        awaitingSnapshot = true;
        clearGames();
        notify(sport, 'reconnecting', 'Live ticket updates are reconnecting.');
      };
    }
    return function stop() {
      if (stopped) return;
      stopped = true;
      for (const { sport, stream } of connections) {
        stream.close();
        notify(sport, 'closed');
      }
    };
  }
  const loader = createLoader();
  return Object.freeze({ SPORTS, load: loader.load, invalidate: loader.invalidate, createLoader, normalizeTicket, subscribe });
});
