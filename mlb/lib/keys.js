'use strict';
/* Key numbers, measured instead of quoted: how often last season's games ended by exactly N runs, and how
   often the two teams combined for exactly N. Built once from MLB's own final scores, then cached.
   Baseball's run line lives on 1.5 because about three games in ten are decided by a single run. */

const { getJSON, readJSON, writeJSON, log } = require('./util');

const MLB = 'https://statsapi.mlb.com/api/v1';

async function build(season) {
  const cached = readJSON(`keys-${season}.json`, null);
  if (cached?.n > 500) return cached;
  const margin = {}, total = {}, runs = {};
  let n = 0;
  // Month by month: one whole season in a single request comes back too trimmed to trust.
  for (let m = 3; m <= 10; m++) {
    const last = new Date(Date.UTC(season, m, 0)).getUTCDate();
    const from = `${season}-${String(m).padStart(2, '0')}-01`;
    const to = `${season}-${String(m).padStart(2, '0')}-${last}`;
    const j = await getJSON(`${MLB}/schedule?sportId=1&gameType=R&startDate=${from}&endDate=${to}`, { timeout: 25000 });
    for (const day of j.dates || []) {
      for (const g of day.games || []) {
        if (g.status?.codedGameState !== 'F' && g.status?.detailedState !== 'Final') continue;
        const a = g.teams?.away?.score, h = g.teams?.home?.score;
        if (a == null || h == null) continue;
        n++;
        margin[Math.abs(a - h)] = (margin[Math.abs(a - h)] || 0) + 1;
        total[a + h] = (total[a + h] || 0) + 1;
        runs[a] = (runs[a] || 0) + 1;
        runs[h] = (runs[h] || 0) + 1;
      }
    }
  }
  const out = { season, n, margin, total, runs, built: Date.now() };
  if (n > 500) writeJSON(`keys-${season}.json`, out);
  log(`key numbers from ${season}: ${n} games`);
  return out;
}

let current = null;
let building = null;
async function keys(season) {
  if (current?.season === season) return current;
  if (!building) {
    building = build(season)
      .then((k) => { current = k; return k; })
      .catch((e) => { log('key numbers:', e.message); return null; })
      .finally(() => { building = null; });
  }
  return building;
}

module.exports = { keys };
