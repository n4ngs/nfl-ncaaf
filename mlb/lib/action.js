'use strict';
/* Action Network's public web scoreboard for MLB: pregame moneyline, run line and total from several books,
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

// One book's full-game pregame line, with sides named from Action Network's own home team.
function readMarkets(ev, homeId, awayId) {
  const pre = (list) => (list || []).filter((o) => !o.is_live && !o.is_alt_market && (o.period == null || o.period === 'event'));
  const L = { ml: [null, null], rl: { line: null, odds: [null, null] }, t: { line: null, odds: [null, null] } };
  for (const o of pre(ev.moneyline)) {
    if (o.team_id === homeId) L.ml[0] = num(o.odds);
    else if (o.team_id === awayId) L.ml[1] = num(o.odds);
  }
  for (const o of pre(ev.spread)) {
    const v = num(o.value);
    if (v == null || Math.abs(v) !== 1.5) continue; // the run line only
    if (o.team_id === homeId) { L.rl.line = v; L.rl.odds[0] = num(o.odds); } else if (o.team_id === awayId) { if (L.rl.line == null) L.rl.line = -v; L.rl.odds[1] = num(o.odds); }
  }
  for (const o of pre(ev.total)) {
    if (o.side === 'over') { L.t.line = num(o.value); L.t.odds[0] = num(o.odds); }
    if (o.side === 'under') { if (L.t.line == null) L.t.line = num(o.value); L.t.odds[1] = num(o.odds); }
  }
  return cleanLine(L);
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

// Returns Map pk -> { books: { key: L }, anId, splits } (L without seen/src; the caller stamps them).
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
    const books = {};
    for (const b of BOOKS) {
      for (const id of b.an || []) {
        if (books[b.key]) break;
        const ev = ag.markets?.[id]?.event;
        if (!ev) continue;
        const L = readMarkets(ev, ag.home_team_id, ag.away_team_id);
        if (L) books[b.key] = m.swap ? flipLine(L) : L;
      }
    }
    const consEv = ag.markets?.[15]?.event;
    out.set(m.pk, {
      books, anId: ag.id, swap: m.swap,
      splits: consEv ? readSplits(consEv, ag.home_team_id, m.swap) : null,
      tt: readTeamTotals(consEv, ag.home_team_id, ag.away_team_id, m.swap),
    });
  }
  return out;
}

module.exports = { fetchAN, parseAN, fetchAN1, parseAN1 };
