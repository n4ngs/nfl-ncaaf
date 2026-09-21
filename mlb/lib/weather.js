'use strict';
/* First-pitch weather for open-air parks, from Open-Meteo (free, no key). Ballpark coordinates and roof type
   come from the MLB venues endpoint and are cached, so this is one small request per hour for the whole slate.
   Wind is the number that moves baseball totals, so it leads; a closed roof says so instead. */

const { getJSON, readJSON, writeJSON, log } = require('./util');

const MLB = 'https://statsapi.mlb.com/api/v1';
const parks = readJSON('parks.json', {}); // venueId -> { lat, lon, roof, name }

async function ensureParks(ids) {
  const want = ids.filter((id) => id && !parks[id]);
  if (!want.length) return;
  try {
    const j = await getJSON(`${MLB}/venues?venueIds=${want.join(',')}&hydrate=location,fieldInfo`);
    for (const v of j.venues || []) {
      const c = v.location?.defaultCoordinates;
      if (!c) continue;
      parks[v.id] = { lat: c.latitude, lon: c.longitude, roof: v.fieldInfo?.roofType || 'Open', name: v.name };
    }
    writeJSON('parks.json', parks);
  } catch (e) {
    log('weather parks:', e.message);
  }
}

const compass = (d) => (d == null ? null : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8]);

// games: [{ pk, start, venue: { id, field } }] -> Map pk -> wx
async function forecast(games) {
  const out = new Map();
  const list = games.filter((g) => g.venue?.id && g.start);
  await ensureParks([...new Set(list.map((g) => g.venue.id))]);
  const open = [];
  for (const g of list) {
    const park = parks[g.venue.id];
    if (!park) continue;
    const roof = g.venue.field?.roofType || park.roof || 'Open';
    // A dome is settled weather; a retractable roof we can't see the state of, so it's reported as such.
    if (/dome/i.test(roof)) { out.set(g.pk, { roof: 'Dome', src: 'MLB', at: Date.now() }); continue; }
    open.push({ g, park, roof });
  }
  for (let i = 0; i < open.length; i += 40) {
    const chunk = open.slice(i, i + 40);
    const lat = chunk.map((x) => x.park.lat.toFixed(3)).join(',');
    const lon = chunk.map((x) => x.park.lon.toFixed(3)).join(',');
    try {
      const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m,wind_direction_10m&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC&forecast_days=7`, { timeout: 20000 });
      const all = Array.isArray(j) ? j : [j];
      chunk.forEach(({ g, roof }, idx) => {
        const h = all[idx]?.hourly;
        if (!h) return;
        const at = h.time.indexOf(`${new Date(g.start).toISOString().slice(0, 13)}:00`);
        if (at < 0) return;
        // First pitch through about the seventh inning.
        const span = [at, at + 1, at + 2].filter((x) => x < h.time.length);
        const avg = (k) => Math.round(span.reduce((s, x) => s + (h[k][x] ?? 0), 0) / span.length);
        out.set(g.pk, {
          temp: Math.round(h.temperature_2m[at]),
          wind: avg('wind_speed_10m'),
          gust: Math.round(Math.max(...span.map((x) => h.wind_gusts_10m[x] ?? 0))),
          dir: compass(h.wind_direction_10m[at]),
          pop: Math.max(...span.map((x) => h.precipitation_probability[x] ?? 0)),
          roof: /retract/i.test(roof) ? 'Retractable' : 'Open',
          src: 'Open-Meteo',
          at: Date.now(),
        });
      });
    } catch (e) {
      log('weather:', e.message);
    }
  }
  return out;
}

module.exports = { forecast };
