'use strict';
/* ESPN's MLB scoreboard carries DraftKings' pregame numbers. Used as a fallback when Action Network is down.
   ESPN drops the odds once a game starts. */

const { getJSON, num, pairGames, cleanLine } = require('./util');

const { sourceTime, lineMeta, flipMeta } = require('./quote-evidence');
const { flipLine } = require('./util');

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard';

async function fetchEspn(date) {
  return getJSON(`${SITE}?dates=${date.replace(/-/g, '')}&limit=100`, { timeout: 15000 });
}

const n = (s) => num(String(s ?? '').replace(/^[ou]/i, '').replace(/^EVEN$/i, '100'));

function dkLine(o) {
  if (!o || !/draftkings/i.test(o.provider?.name || '')) return null;
  const ml = o.moneyline || {}, ps = o.pointSpread || {}, tot = o.total || {};
  const rlLine = n(ps.home?.close?.line);
  const L = {
    ml: [n(ml.home?.close?.odds), n(ml.away?.close?.odds)],
    rl: rlLine != null && Math.abs(rlLine) === 1.5 ? { line: rlLine, odds: [n(ps.home?.close?.odds), n(ps.away?.close?.odds)] } : null,
    t: { line: n(tot.over?.close?.line) ?? num(o.overUnder), odds: [n(tot.over?.close?.odds), n(tot.under?.close?.odds)] },
  };
  const cleaned = cleanLine(L);
  if (!cleaned) return null;
  const result = lineMeta(cleaned, { source_observed_at: sourceTime(o.updated_at ?? o.lastUpdated), market_status: 'active', is_live: false });
  // Each selection keeps its actual ESPN line. Inferring the away/under line here
  // would disguise a mismatched or missing pair as comparable pricing evidence.
  const fields = { rl: { home: ps.home?.close, away: ps.away?.close }, t: { over: tot.over?.close, under: tot.under?.close } };
  for (const [market, sides] of Object.entries(fields)) for (const [side, quote] of Object.entries(sides)) {
    if (result.quote_meta[market]?.[side]) result.quote_meta[market][side].line_value = n(quote?.line);
  }
  return lineMeta(result);
}

// Returns Map pk -> L (DraftKings, MLB orientation).
function parseEspn(j, games) {
  const feed = [];
  for (const e of j.events || []) {
    const c = e.competitions?.[0];
    if (!c) continue;
    const h = c.competitors?.find((x) => x.homeAway === 'home');
    const a = c.competitors?.find((x) => x.homeAway === 'away');
    if (!h || !a) continue;
    const L = dkLine((c.odds || []).find((o) => /draftkings/i.test(o.provider?.name || '')));
    if (!L) continue;
    feed.push({ key: e.id, home: h.team?.displayName, away: a.team?.displayName, homeAbbr: h.team?.abbreviation, awayAbbr: a.team?.abbreviation, start: e.date, L });
  }
  const pairs = pairGames(feed, games);
  const out = new Map();
  for (const f of feed) {
    const m = pairs.get(f.key);
    if (!m) continue;
    const L = f.L;
    out.set(m.pk, m.swap ? flipMeta(L, flipLine(L)) : L);
  }
  return out;
}

module.exports = { fetchEspn, parseEspn };
