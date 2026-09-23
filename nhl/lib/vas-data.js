'use strict';
// Data for the VAS engine, cached on the volume (DATA_DIR/nhl-vas) so a deploy never re-downloads history.
//   MoneyPuck season shot files (shots_<year>.zip): past seasons once, the current season at most once a day.
//   NHL boxscores for every game in those files: once each (lineups, TOI, assists, scores, goalie names).
// Zero dependencies: the zip is read with node:zlib, the CSV with a small quote-aware splitter.
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');

const SHOT_COLS = ['season', 'game_id', 'isPlayoffGame', 'isHomeTeam', 'xGoal', 'goal', 'homeSkatersOnIce', 'awaySkatersOnIce',
  'shotOnEmptyNet', 'goalieIdForShot', 'shooterPlayerId'];

function unzipFirst(buf, want = /\.csv$/i) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw Error('zip: no end record');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Error('zip: bad central record');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (want.test(name)) {
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data) : (() => { throw Error('zip: method ' + method); })();
    }
    p += 46 + nlen + elen + clen;
  }
  throw Error('zip: no csv entry');
}

function splitCsv(line) {
  if (line.indexOf('"') < 0) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}

// MoneyPuck shots CSV -> compact regular-season shot rows the engine understands.
function parseShots(csv) {
  const text = csv.toString('utf8'); let pos = text.indexOf('\n');
  const head = splitCsv(text.slice(0, pos).replace(/\r$/, '')); const ix = Object.fromEntries(SHOT_COLS.map(c => [c, head.indexOf(c)]));
  for (const [c, i] of Object.entries(ix)) if (i < 0) throw Error('shots csv missing column ' + c);
  const rows = [];
  while (pos < text.length) {
    let next = text.indexOf('\n', pos + 1); if (next < 0) next = text.length;
    const line = text.slice(pos + 1, next).replace(/\r$/, ''); pos = next;
    if (!line) continue;
    const f = splitCsv(line);
    if (Number(f[ix.isPlayoffGame]) !== 0) continue;
    const gid = Number(f[ix.season]) * 1e6 + Number(f[ix.game_id]);
    if (!Number.isInteger(gid) || Math.floor(gid / 10000) % 100 !== 2) continue;
    const num = k => Number(f[ix[k]]), id = k => { const v = Number(f[ix[k]]); return Number.isFinite(v) && v > 0 ? v : 0; };
    rows.push({ gid, home: num('isHomeTeam') === 1, xg: num('xGoal') || 0, goal: num('goal') === 1 ? 1 : 0, hs: num('homeSkatersOnIce'), as: num('awaySkatersOnIce'),
      en: num('shotOnEmptyNet') === 1, goalie: id('goalieIdForShot'), shooter: id('shooterPlayerId') });
  }
  return rows;
}

const toi = v => { const m = /^(\d+):(\d{2})$/.exec(String(v || '')); return m ? Number(m[1]) + Number(m[2]) / 60 : 0; };
// Official boxscore -> compact history game (same fields as research/build_games.py).
function compactBox(b) {
  if (!b || b.gameType !== 2 || !['OFF', 'FINAL'].includes(b.gameState)) return null;
  const g = { gid: b.id, season: Math.floor(b.id / 1e6), day: b.gameDate, start: b.startTimeUTC, home: b.homeTeam?.abbrev, away: b.awayTeam?.abbrev,
    homeGoals: b.homeTeam?.score, awayGoals: b.awayTeam?.score, lineups: {}, goalieNames: {}, starters: {} };
  if (!g.home || !g.away || !Number.isInteger(g.homeGoals) || !Number.isInteger(g.awayGoals) || g.homeGoals === g.awayGoals) return null;
  for (const side of ['home', 'away']) {
    const p = b.playerByGameStats?.[side + 'Team'] || {};
    g.lineups[side] = [...(p.forwards || []).map(x => ({ pid: x.playerId, pos: 'F', toi: toi(x.toi), a: x.assists || 0 })),
      ...(p.defense || []).map(x => ({ pid: x.playerId, pos: 'D', toi: toi(x.toi), a: x.assists || 0 }))];
    const gl = p.goalies || [];
    g.goalieNames[side] = Object.fromEntries(gl.map(x => [x.playerId, x.name?.default || null]));
    const st = gl.slice().sort((x, y) => (y.shotsAgainst || 0) - (x.shotsAgainst || 0) || y.playerId - x.playerId)[0];
    g.starters[side] = st ? st.playerId : null;
  }
  return g;
}

function create({ dir, fetchBuffer, fetchJSON, now = Date.now, log = () => {} }) {
  fs.mkdirSync(path.join(dir, 'box'), { recursive: true });
  const status = { seasons: {}, boxes: 0, missingBoxes: 0, lastRefresh: null, lastError: null };
  const shotsFile = y => path.join(dir, `shots_${y}.json.gz`);
  const readGz = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
  const writeGz = (f, v) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(v))); fs.renameSync(tmp, f); };

  async function shots(year, current) {
    const f = shotsFile(year), fresh = fs.existsSync(f) && (!current || now() - fs.statSync(f).mtimeMs < 20 * 3600e3);
    if (!fresh) {
      // MoneyPuck first. Older seasons leave that path, so fall back to a public mirror of the same files
      // (its 2025-26 file was verified byte-identical to moneypuck.com).
      for (const url of [`https://moneypuck.com/moneypuck/playerData/shots/shots_${year}.zip`, `https://peter-tanner.com/moneypuck/downloads/shots_${year}.zip`]) {
        try {
          const rows = parseShots(unzipFirst(await fetchBuffer(url))); writeGz(f, rows);
          status.seasons[year] = { source: new URL(url).hostname }; log(`[vas] ${year}: ${rows.length} shots from ${new URL(url).hostname}`); break;
        } catch (e) { status.lastError = `shots ${year} (${new URL(url).hostname}): ${String(e.message || e).slice(0, 100)}`; }
      }
    }
    if (!fs.existsSync(f)) return [];
    const rows = readGz(f); status.seasons[year] = { ...(status.seasons[year] || {}), shots: rows.length, updated: new Date(fs.statSync(f).mtimeMs).toISOString() }; return rows;
  }
  const boxFile = gid => path.join(dir, 'box', gid + '.json');
  async function box(gid) {
    const f = boxFile(gid);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    try {
      const g = compactBox(await fetchJSON(`https://api-web.nhle.com/v1/gamecenter/${gid}/boxscore`));
      if (g) fs.writeFileSync(f, JSON.stringify(g));
      return g;
    } catch (e) { status.lastError = `box ${gid}: ${String(e.message || e).slice(0, 120)}`; return null; }
  }

  // Returns {games, shots} for the engine: every regular-season game present in the MoneyPuck files whose boxscore
  // we have. Missing boxscores are fetched a slice at a time (maxFetch) so the first build is gradual, not a burst.
  async function history(currentSeason, { maxFetch = 400, concurrency = 3 } = {}) {
    const years = [currentSeason - 2, currentSeason - 1, currentSeason];
    const all = [];
    for (const y of years) for (const s of await shots(y, y === currentSeason)) all.push(s);
    const gids = [...new Set(all.map(s => s.gid))].sort((a, b) => a - b);
    const have = new Set(fs.readdirSync(path.join(dir, 'box')).map(f => Number(f.replace('.json', ''))));
    const todo = gids.filter(g => !have.has(g)).slice(0, maxFetch);
    let i = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => { while (i < todo.length) await box(todo[i++]); }));
    const games = [];
    for (const gid of gids) { const f = boxFile(gid); if (fs.existsSync(f)) games.push(JSON.parse(fs.readFileSync(f, 'utf8'))); }
    const keep = new Set(games.map(g => g.gid));
    status.boxes = games.length; status.missingBoxes = gids.length - games.length; status.lastRefresh = new Date(now()).toISOString();
    games.sort((a, b) => a.day.localeCompare(b.day) || (a.start || '').localeCompare(b.start || '') || a.gid - b.gid);
    return { games, shots: all.filter(s => keep.has(s.gid)), complete: status.missingBoxes === 0 };
  }
  return { history, box, status: () => ({ ...status }) };
}

module.exports = { create, unzipFirst, parseShots, compactBox, splitCsv };
