'use strict';
/* Key numbers, measured instead of quoted: how often last season's FBS-vs-FBS games ended by exactly N points,
   and how often the combined score landed on each total. Built once from ESPN's final scores, then cached. */

const { getBody, readJSON, writeJSON, log, pool } = require('./util');
const { CONF } = require('./espn');

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';

async function build(season) {
  const cached = readJSON(`margins-${season}.json`, null);
  if (cached?.n > 300) return cached;
  const margin = {}, total = {};
  let n = 0;
  const weeks = [...Array.from({ length: 16 }, (_, i) => ({ type: 2, week: i + 1 })), { type: 3, week: 1 }];
  const seen = new Set();
  await pool(weeks, 3, async ({ type, week }) => {
    const j = await getBody(`${SITE}/scoreboard?groups=80&limit=400&week=${week}&seasontype=${type}&dates=${season}`, { timeout: 25000 });
    for (const e of j.events || []) {
      const c = e.competitions?.[0];
      if (!c?.status?.type?.completed || seen.has(e.id)) continue;
      const [a, b] = c.competitors || [];
      if (!a || !b || !CONF[a.team?.conferenceId] || !CONF[b.team?.conferenceId]) continue;
      const sa = Number(a.score), sb = Number(b.score);
      if (!Number.isFinite(sa) || !Number.isFinite(sb)) continue;
      seen.add(e.id);
      const m = Math.abs(sa - sb), t = sa + sb;
      margin[m] = (margin[m] || 0) + 1;
      total[t] = (total[t] || 0) + 1;
      n++;
    }
  });
  const out = { season, n, margin, total, built: Date.now() };
  if (n > 300) writeJSON(`margins-${season}.json`, out);
  log(`key numbers from ${season}: ${n} FBS games`);
  return out;
}

let current = null;
async function margins(season) {
  if (current?.season === season) return current;
  try { current = await build(season); } catch (e) { log('margins', e.message); }
  return current;
}

module.exports = { margins };
