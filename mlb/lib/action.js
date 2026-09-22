'use strict';
/* Action Network's public web scoreboard for MLB: separate pregame/live moneyline, run line and total,
   plus the market consensus (book 15) and the opener (book 30). One request per baseball day (YYYYMMDD, Eastern).
   Games are matched to MLB gamePks by team names and start time; home and away are checked, never assumed. */

const { getJSON, num, pairGames, flipLine, cleanLine } = require('./util');
const { BOOKS, AN_IDS } = require('./books');

const AN = 'https://api.actionnetwork.com/web/v2/scoreboard/mlb';
const AN1 = 'https://api.actionnetwork.com/web/v1/scoreboard/publicbetting/mlb';
const url = (date) => `${AN}?bookIds=${AN_IDS.join(',')}&date=${date.replace(/-/g, '')}&periods=event`;
// The older public-betting feed is the one that carries first-five-innings lines.
const F5_IDS = [15, 30, 18, 68, 69, 75];
const F5_BOOK = { 15: 'cons', 30: 'open', 18: 'stn', 68: 'dk', 69: 'fd', 75: 'mgm' };
const url1 = (date) => `${AN1}?bookIds=${F5_IDS.join(',')}&date=${date.replace(/-/g, '')}`;

async function fetchAN(date) {
  return getJSON(url(date), { timeout: 20000, headers: { 'cache-control': 'no-cache' } });
}
async function fetchAN1(date) {
  return getJSON(url1(date), { timeout: 20000, headers: { 'cache-control': 'no-cache' } });
}

// How many runs each team is priced to score on its own.
function readTeamTotals(ev, homeId, awayId, swap) {
  const out = {};
  for (const o of (ev?.core_bet_type_6_team_score || []).filter((x) => !x.is_live)) {
    let side = o.team_id === homeId ? 'home' : o.team_id === awayId ? 'away' : null;
    if (!side) continue;
    if (swap) side = side === 'home' ? 'away' : 'home';
    const r = (out[side] ||= { pts: null, over: null, under: null });
    r.pts = num(o.value);
    r[o.side] = num(o.odds);
  }
  return out.home || out.away ? out : null;
}

// First five innings, from the public-betting feed. Returns Map pk -> { bookKey: L }.
function parseAN1(j, games) {
  const feed = [];
  for (const ag of j.games || []) {
    const th = ag.teams?.find((t) => t.id === ag.home_team_id);
    const ta = ag.teams?.find((t) => t.id === ag.away_team_id);
    if (!th || !ta) continue;
    feed.push({ key: ag.id, ag, home: th.full_name || th.display_name, away: ta.full_name || ta.display_name, start: ag.start_time });
  }
  const pairs = pairGames(feed, games);
  const out = new Map();
  for (const f of feed) {
    const m = pairs.get(f.key);
    if (!m) continue;
    const books = {};
    for (const o of f.ag.odds || []) {
      const key = F5_BOOK[o.book_id];
      if (!key || o.type !== 'firstfiveinnings') continue;
      const line = num(o.spread_home);
      const L = cleanLine({
        ml: [num(o.ml_home), num(o.ml_away)],
        rl: line != null && Math.abs(line) === 0.5 ? { line, odds: [num(o.spread_home_line), num(o.spread_away_line)] } : null,
        t: { line: num(o.total), odds: [num(o.over), num(o.under)] },
      });
      if (L) books[key] = m.swap ? flipLine(L) : L;
    }
    if (Object.keys(books).length) out.set(m.pk, books);
  }
  return out;
}

// A provider quote's own timestamp and state; never substitute the fetch clock.
function quoteMeta(o, live) {
  const raw = o.updated_at ?? o.updated ?? o.last_updated ?? o.inserted;
  const numeric = typeof raw === 'number' || (typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw));
  const at = raw == null ? NaN : numeric ? Number(raw) * (Number(raw) < 1e12 ? 1000 : 1) : Date.parse(raw);
  const status = String(o.market_status || o.status || '').toLowerCase();
  return { source_observed_at: Number.isFinite(new Date(at).getTime()) ? new Date(at).toISOString() : null,
    market_status: o.is_suspended || /suspend|lock|pause/.test(status) ? 'suspended'
      : /remove|closed|settled/.test(status) ? 'removed' : status && !/^(open|active|available)$/.test(status) ? 'unverified' : 'active',
    is_live: live, line_value: num(o.value), american_odds: num(o.odds),
    provider_quote_id: o.id ?? null };
}

// The live projection retains one-sided and suspended evidence; it never enters OddsDay history.
function readMarkets(ev, homeId, awayId, live = false) {
  const pick = (list) => (list || []).filter((o) => (live ? o.is_live === true : !o.is_live) && !o.is_alt_market && (o.period == null || o.period === 'event'));
  const L = { ml: [null, null], rl: { line: null, odds: [null, null] }, t: { line: null, odds: [null, null] } };
  const quote_meta = { ml: {}, rl: {}, t: {} };
  const put = (market, side, o) => {
    const q = quoteMeta(o, live), old = quote_meta[market][side];
    if (market === 'ml') q.line_value = null;
    if (old && Date.parse(old.source_observed_at) > Date.parse(q.source_observed_at)) return;
    if (old && old.source_observed_at === q.source_observed_at &&
      (old.conflicted || old.line_value !== q.line_value || old.american_odds !== q.american_odds || old.market_status !== q.market_status)) q.conflicted = true;
    quote_meta[market][side] = q;
  };
  for (const o of pick(ev.moneyline)) {
    if (o.team_id === homeId) put('ml', 'home', o);
    else if (o.team_id === awayId) put('ml', 'away', o);
  }
  for (const o of pick(ev.spread)) {
    const v = num(o.value);
    if (!live && (v == null || Math.abs(v) !== 1.5)) continue;
    if (o.team_id === homeId) put('rl', 'home', o);
    else if (o.team_id === awayId) put('rl', 'away', o);
  }
  for (const o of pick(ev.total)) if (['over', 'under'].includes(o.side)) put('t', o.side, o);
  const q = quote_meta;
  L.ml = [q.ml.home?.american_odds ?? null, q.ml.away?.american_odds ?? null];
  L.rl.line = q.rl.home?.line_value ?? (q.rl.away?.line_value == null ? null : -q.rl.away.line_value);
  L.rl.odds = [q.rl.home?.american_odds ?? null, q.rl.away?.american_odds ?? null];
  L.t.line = q.t.over?.line_value ?? q.t.under?.line_value ?? null;
  L.t.odds = [q.t.over?.american_odds ?? null, q.t.under?.american_odds ?? null];
  for (const [a, b, spread] of [[q.rl.home, q.rl.away, true], [q.t.over, q.t.under, false]]) {
    if (a?.line_value != null && b?.line_value != null && a.line_value !== (spread ? -b.line_value : b.line_value)) a.conflicted = b.conflicted = true;
  }
  if (!live) return cleanLine(L);
  if (!Object.values(q).some((market) => Object.keys(market).length)) return null;
  return { ...L, is_live: true, quote_meta: q };
}
function orientLive(L, swap) {
  if (!L || !swap) return L;
  const flipped = flipLine(L), q = L.quote_meta;
  return { ...flipped, quote_meta: { ...q,
    ml: Object.fromEntries(Object.entries(q.ml).map(([side, value]) => [side === 'home' ? 'away' : 'home', value])),
    rl: Object.fromEntries(Object.entries(q.rl).map(([side, value]) => [side === 'home' ? 'away' : 'home', value])),
  } };
}

// The public count on the consensus book: what share of tickets, and of the money, is on each side.
// Numbers are from the home team's (or the over's) point of view, flipped if the feed's home team isn't MLB's.
function readSplits(ev, homeId, swap) {
  const pre = (list) => (list || []).filter((o) => !o.is_live);
  const pct = (o, k) => (o?.bet_info?.[k]?.percent == null ? null : num(o.bet_info[k].percent));
  const one = (o) => {
    if (!o) return null;
    let tix = pct(o, 'tickets'), money = pct(o, 'money');
    if (!tix && !money) return null;          // no action yet reads as 0/0 on both sides
    if (swap) { tix = tix == null ? null : 100 - tix; money = money == null ? null : 100 - money; }
    return { tix, money };
  };
  const out = {
    ml: one(pre(ev.moneyline).find((o) => o.team_id === homeId)),
    rl: one(pre(ev.spread).find((o) => o.team_id === homeId && Math.abs(num(o.value)) === 1.5)),
    t: one(pre(ev.total).find((o) => o.side === 'over')),
  };
  return out.ml || out.rl || out.t ? out : null;
}

// Returns separate pregame and explicit live bookspaces; the caller adds receipt metadata.
function parseAN(j, games) {
  const feed = [];
  for (const ag of j.games || []) {
    const th = ag.teams?.find((t) => t.id === ag.home_team_id);
    const ta = ag.teams?.find((t) => t.id === ag.away_team_id);
    if (!th || !ta) continue;
    feed.push({ key: ag.id, ag, home: th.full_name || th.display_name, away: ta.full_name || ta.display_name, homeAbbr: th.abbr, awayAbbr: ta.abbr, start: ag.start_time });
  }
  const pairs = pairGames(feed, games);
  const out = new Map();
  for (const f of feed) {
    const m = pairs.get(f.key);
    if (!m) continue;
    const ag = f.ag;
    const books = {}, live = {};
    for (const b of BOOKS) {
      for (const id of b.an || []) {
        const ev = ag.markets?.[id]?.event;
        if (!ev) continue;
        if (!books[b.key]) {
          const L = readMarkets(ev, ag.home_team_id, ag.away_team_id);
          if (L) books[b.key] = m.swap ? flipLine(L) : L;
        }
        if (b.key !== 'open' && !live[b.key]) {
          const L = readMarkets(ev, ag.home_team_id, ag.away_team_id, true);
          if (L) live[b.key] = { ...orientLive(L, m.swap), provider_event_id: ag.id };
        }
      }
    }
    const consEv = ag.markets?.[15]?.event;
    out.set(m.pk, {
      books, live, anId: ag.id, swap: m.swap,
      splits: consEv ? readSplits(consEv, ag.home_team_id, m.swap) : null,
      tt: readTeamTotals(consEv, ag.home_team_id, ag.away_team_id, m.swap),
    });
  }
  return out;
}

module.exports = { fetchAN, parseAN, fetchAN1, parseAN1, readMarkets };
