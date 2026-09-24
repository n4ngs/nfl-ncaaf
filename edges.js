'use strict';
/* Edges (/edges): one screen of every signal that qualifies right now, across the four boards.

   Colour and wording rules (owner, option 1):
   - GREEN only for signals that beat the closing line out-of-sample in the research: the NHL DIAMOND tier, the MLB
     DraftKings-opener rule and the NCAAF off-consensus opener (variant B, labelled Thin on the board).
   - NFL totals are PROVISIONAL and shown as a neutral lean. The NCAAF late QB change (variant C) is provisional too,
     but the engine does not produce it live (no confirmed-starter feed), so it is listed as not live, never faked.
   - Football rows follow the football boards' rules: market reads, informational only, no alerts, no stakes, no
     "bet this" wording, Solid / Thin / Weak read labels with their caveat.
   - Prices and links are Nevada books only (BetMGM NV, Caesars NV, Circa, STN, Westgate SuperBook, South Point).

   Speed: each engine exposes a compact owner-only /api/edges feed (a projection of the views it already builds).
   This module polls them over loopback once a minute, builds the rows and renders the page ONCE per refresh; a
   request only ever sends the cached HTML. Evidence (holdout proof + live record) refreshes every ten minutes. */
const http = require('node:http');

const NV_BOOKS = Object.freeze({
  mgm: { name: 'BetMGM', full: 'BetMGM Nevada', url: 'https://www.nv.betmgm.com/en/sports' },
  czr: { name: 'Caesars', full: 'Caesars Sportsbook Nevada', url: 'https://sportsbook.caesars.com/us/nv/bet' },
  circa: { name: 'Circa', full: 'Circa Sports', url: 'https://www.circasports.com/' },
  stn: { name: 'STN', full: 'STN Sports (Station Casinos)', url: 'https://stnsports.com/' },
  wg: { name: 'Westgate', full: 'Westgate SuperBook', url: 'https://www.superbook.com/' },
  sp: { name: 'South Point', full: 'South Point', url: 'https://southpointcasino.com/' },
});
const NV_KEYS = Object.keys(NV_BOOKS);

// The four signals this page knows. `proven` = beat the close out-of-sample (green). Nothing else is listed.
const SIGNALS = {
  nhl: { sport: 'NHL', name: 'NHL DIAMOND tier', proven: true, market: 'Moneyline', board: '/nhl/',
    rule: 'Goalie Matrix line-movement model: predicted open-to-close move of at least 0.08 (win probability).',
    caveat: 'Starters are projected until the NHL confirms them; a different confirmed starter voids the signal.' },
  mlb: { sport: 'MLB', name: 'MLB DraftKings-opener rule', proven: true, market: 'Moneyline', board: '/mlb/',
    rule: "The model and DraftKings' opening moneyline differ by at least 0.30 logit.",
    caveat: 'Small edge. Tested at the DraftKings opener for about 2 hours after it posts; after that only while DraftKings still clears the gap.' },
  ncaaf: { sport: 'NCAAF', name: 'NCAAF off-consensus opener', proven: true, football: true, market: 'Spread', board: '/ncaaf/',
    rule: "A Nevada book's opening spread sits off the other books' opening consensus by enough that the model reads at least 1.5 points of closing-line value, and the book is still hanging that opener.",
    caveat: "Thin read: openers this far off the pack moved toward it in 2023-25 testing, but when books posted them can't be verified historically. Scored live against the close. An estimate, not advice." },
  nfl: { sport: 'NFL', name: 'NFL totals read', proven: false, football: true, market: 'Total', board: '/nfl/',
    rule: 'Model-expected move of the total of at least 1 point from the line posted once both teams last played.',
    caveat: 'Provisional: beat the closing total in back-testing (+1.96% expected value, 238 games, 2016 and 2023-25) but is not yet statistically settled on recent seasons alone. Scored live against the close. An estimate, not advice.' },
};
// Which holdout row is the live threshold, per sport (keys differ by engine; match on the number in the key).
const THRESHOLD = { nhl: 0.08, mlb: 0.3, ncaaf: 1.5, nfl: 1 };
// Which live-record tier is this signal.
const RECORD_TIER = { nhl: 'DIAMOND', mlb: 'DIAMOND', ncaaf: 'THIN', nfl: 'PROVEN' };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
const odds = (a) => (Number.isFinite(a) ? (a > 0 ? '+' + a : String(a)).replace('-', '−') : '—');
const pts = (v) => { const r = Math.round(v * 2) / 2; return r === 0 ? 'PK' : ((r > 0 ? '+' : '') + r).replace('-', '−'); };
const pct = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d) + '%');
const num = (v) => Number.isFinite(v);

// Best Nevada price for one side of a two-way market: highest payout, ties to the owner's book order.
function bestPrice(books, pick) {
  let best = null;
  for (const k of NV_KEYS) {
    const q = books && books[k] && pick(books[k]);
    if (!q || !num(q.odds) || q.odds === 0) continue;
    if (!best || better(q, best)) best = { ...q, book: k };
  }
  return best;
}
// For spreads/totals a better NUMBER beats a better price; `line` is oriented so bigger is better for the bettor.
function better(a, b) {
  if (num(a.edge) && num(b.edge) && a.edge !== b.edge) return a.edge > b.edge;
  return dec(a.odds) > dec(b.odds);
}

const tz = 'America/Los_Angeles';
function when(iso, now) {
  const t = new Date(iso); if (isNaN(t)) return '';
  const day = (d) => d.toLocaleDateString('en-CA', { timeZone: tz });
  const time = t.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const d0 = day(new Date(now)), d1 = day(new Date(now + 86400e3)), dt = day(t);
  const label = dt === d0 ? 'Today' : dt === d1 ? 'Tomorrow' : t.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  return label + ' · ' + time + ' PT';
}

/* ---------------------------------------------------------------- rows (pure) */
function nhlRows(feed, now) {
  const rows = [], notes = [];
  for (const g of (feed && feed.games) || []) {
    const v = g.vas || {};
    if (v.status && v.status !== 'OK') { notes.push(v.reason); continue; }
    if (v.tier !== 'DIAMOND' || !v.side || !(Date.parse(g.start) > now)) continue;
    const side = v.side, team = g[side] || {};
    const price = bestPrice(g.books, (b) => ({ odds: b[side] }));
    const gl = v.goalies && v.goalies[side], conf = v.confirmed && v.confirmed[side];
    const mk = v.market && num(v.market.prob) ? (side === 'home' ? v.market.prob : 1 - v.market.prob) : null;
    const model = num(v.pHome) ? (side === 'home' ? v.pHome : 1 - v.pHome) : null;
    rows.push({ sig: 'nhl', id: 'nhl:' + g.id, start: g.start, matchup: `${g.away?.abbr} @ ${g.home?.abbr}`,
      title: `${team.abbr} moneyline`, pick: { text: `${team.abbr} ML` },
      detail: [`Model ${model == null ? '—' : Math.round(model * 100) + '%'} vs market ${mk == null ? '—' : Math.round(mk * 100) + '%'}${v.market && v.market.books ? ' (' + v.market.books + ' books, no-vig median)' : ''}.`,
        gl && gl.name ? `${team.abbr} goalie ${gl.name} ${conf ? (conf === gl.id ? 'confirmed' : 'NOT the confirmed starter') : 'projected'}.` : '',
      ].filter(Boolean).join(' '),
      price });
  }
  return { rows, note: rows.length ? null : (notes.find(Boolean) || null) };
}

function mlbRows(feed, now) {
  const rows = [];
  for (const g of (feed && feed.games) || []) {
    const r = g.read || {};
    if (r.tier !== 'DIAMOND' || !r.side || !(Date.parse(g.start) > now)) continue;
    const [away, home] = String(g.matchup || '').split(' @ ');
    const team = r.side === 'home' ? home : away;
    const ref = num(r.price) ? r.price : null;
    const price = bestPrice(g.books, (b) => ({ odds: b[r.side] }));
    const shorter = price && ref != null && dec(price.odds) < dec(ref);
    rows.push({ sig: 'mlb', id: 'mlb:' + g.id, start: g.start, matchup: g.matchup || '', title: `${team || r.side} moneyline`, pick: { text: `${team || r.side} ML` },
      detail: `Model vs DraftKings opener gap ${num(r.gap) ? Math.abs(r.gap).toFixed(2) : '—'} logit (tested at 0.30).${ref != null ? ` Tested price: DraftKings ${odds(ref)}.` : ''}`,
      warn: shorter ? `The best Nevada price is shorter than the tested DraftKings number (${odds(ref)}); at a shorter price the tested edge shrinks or disappears.` : null,
      price });
  }
  return { rows, note: rows.length ? null : feed && feed.ready === false ? 'Model history is still loading.' : null };
}

function ncaafRows(feed, now) {
  const rows = []; let weak = 0;
  for (const g of (feed && feed.games) || []) {
    const m = g.model || {};
    const all = (m.reads || []).filter((r) => NV_BOOKS[r.book]);
    weak += all.filter((r) => r.tier !== 'THIN').length;
    const thin = all.filter((r) => r.tier === 'THIN' && num(r.bookOpen));
    if (!thin.length || !(Date.parse(g.start) > now)) continue;
    // one row per game: the Nevada book still hanging the off-consensus opener at the best price
    const best = bestPrice(Object.fromEntries(thin.map((r) => [r.book, r])), (r) => ({ odds: r.price, line: r.bookOpen, side: r.side, cons: r.consensusOpen }));
    const r = best || { ...thin[0], odds: thin[0].price, line: thin[0].bookOpen, cons: thin[0].consensusOpen, book: thin[0].book };
    const team = (g[r.side] || {}).abbr || r.side;
    const sp = (homeSpread) => `${team} ${pts(r.side === 'home' ? homeSpread : -homeSpread)}`;
    rows.push({ sig: 'ncaaf', id: 'ncaaf:' + g.id, start: g.start, matchup: `${g.away?.abbr} @ ${g.home?.abbr}`, confidence: 'Thin read',
      title: `${NV_BOOKS[r.book].name} opened ${sp(r.line)}; the other books opened around ${sp(r.cons)}.`, pick: { text: sp(r.line) },
      detail: `It is still hanging that opener.${thin.length > 1 ? ` ${thin.length} Nevada books are.` : ''}`,
      price: num(r.odds) ? { odds: r.odds, book: r.book } : { odds: null, book: r.book } });
  }
  return { rows, note: rows.length ? null : weak ? `${weak} smaller opener gap${weak === 1 ? '' : 's'} (Weak reads) are on the board, not here: below the tested threshold.` : null };
}

function nflRows(feed, now) {
  const rows = []; let lean = 0;
  for (const g of (feed && feed.games) || []) {
    const t = (g.model || {}).total;
    if (!t) continue;
    if (t.tier === 'LEAN') lean++;
    if (t.tier !== 'PROVEN' || !num(t.openTotal) || !(Date.parse(g.start) > now)) continue;
    const up = t.direction === 'up';
    // best Nevada number in the read's direction: the lowest total to go over, the highest to go under
    const price = bestPrice(g.books, (b) => (num(b.t) && b.to ? { odds: up ? b.to[0] : b.to[1], line: b.t, edge: up ? -b.t : b.t } : null));
    const done = num(t.currentTotal) ? t.currentTotal - t.openTotal : null;
    const moved = done == null ? '' : Math.abs(done) < 0.25 ? ' It has not moved yet.' : (done > 0) === up ? ` It has already moved ${Math.abs(done).toFixed(1)} points that way.` : ' It has moved the other way so far.';
    rows.push({ sig: 'nfl', id: 'nfl:' + g.id, start: g.start, matchup: `${g.away?.abbr} @ ${g.home?.abbr}`, confidence: 'Thin read',
      title: `Total: the model expects it to ${up ? 'rise' : 'fall'} from ${t.openTotal} toward about ${num(t.expected) ? t.expected.toFixed(1) : '—'}.`,
      pick: price ? { text: `${up ? 'Over' : 'Under'} ${price.line}` } : { text: up ? 'Over' : 'Under' },
      detail: `From the line when both teams' last games were final.${moved}`,
      price });
  }
  return { rows, note: rows.length ? null : lean ? `${lean} smaller total read${lean === 1 ? '' : 's'} (Lean) are on the NFL board, not here: that size was not proven.` : null };
}

function buildRows(feeds, now = Date.now()) {
  const parts = { nhl: nhlRows(feeds.nhl, now), mlb: mlbRows(feeds.mlb, now), ncaaf: ncaafRows(feeds.ncaaf, now), nfl: nflRows(feeds.nfl, now) };
  const rows = Object.values(parts).flatMap((p) => p.rows).sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || (SIGNALS[b.sig].proven - SIGNALS[a.sig].proven));
  const status = Object.fromEntries(Object.entries(parts).map(([k, p]) => [k, { count: p.rows.length, note: p.note, live: !!feeds[k] }]));
  return { rows, status };
}

// Holdout row at the live threshold + the live record for the signal's tier.
function evidenceFor(key, health, record) {
  const vas = health && health.vas, p = vas && vas.proven;
  let holdout = null;
  if (p) {
    const want = THRESHOLD[key];
    const hit = Object.entries(p).find(([k]) => { const m = String(k).match(/(\d+(?:\.\d+)?)(?!.*\d)/); return m && Math.abs(parseFloat(m[1]) - want) < 1e-9; });
    if (hit) holdout = { label: hit[0], ...hit[1] };
  }
  const t = record && record.tiers && record.tiers[RECORD_TIER[key]];
  return { holdout, live: record ? { tier: RECORD_TIER[key], scored: t ? t.bets : 0, clvEvPct: t ? t.clvEvPct : null, beatCloseRate: t ? t.beatCloseRate : null, pending: record.pending || 0 } : null };
}

/* ---------------------------------------------------------------- render */
const CSS = `
:root{color-scheme:light;--bg:#F0F3F8;--surface:#FFFFFF;--surface-2:#F5F7FB;--ink:#101B2F;--ink-2:#4F5C73;--ink-3:#606D83;--line:rgba(24,43,73,.12);--fill:rgba(24,43,73,.05);
 --accent:#EE3A2E;--win:#12753F;--win-fill:rgba(18,117,63,.1);--font:"Geist",ui-sans-serif,system-ui,sans-serif;--mono:"Geist Mono",ui-monospace,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#080E19;--surface:#111B2B;--surface-2:#172337;--ink:#F2F5FA;--ink-2:#B1BDD0;--ink-3:#92A1BA;
 --line:rgba(169,191,225,.16);--fill:rgba(169,191,225,.07);--accent:#FF453A;--win:#30D158;--win-fill:rgba(48,209,88,.13)}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#080E19;--surface:#111B2B;--surface-2:#172337;--ink:#F2F5FA;--ink-2:#B1BDD0;--ink-3:#92A1BA;--line:rgba(169,191,225,.16);--fill:rgba(169,191,225,.07);--accent:#FF453A;--win:#30D158;--win-fill:rgba(48,209,88,.13)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:15px;line-height:1.45;-webkit-font-smoothing:antialiased;letter-spacing:-.005em}
a{color:inherit}:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:8px}
#xsport{display:flex;align-items:center;gap:24px;height:62px;padding:0 max(16px,env(safe-area-inset-right)) 0 max(16px,env(safe-area-inset-left));background:#142030;color:#F3F6FC}
#xsport .brand{display:inline-flex;align-items:center;gap:11px;flex:none;text-decoration:none;color:inherit}#xsport .xm{width:28px;height:28px;border-radius:8px;display:block}
#xsport .wm{font-family:var(--mono);font-size:13px;font-weight:700;letter-spacing:.05em;white-space:nowrap}#xsport .wm b{color:var(--accent)}
#xsport .xseg{display:flex;gap:3px;padding:3px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);border-radius:11px;min-width:0}
#xsport .xseg a{display:flex;align-items:center;min-height:44px;padding:0 20px;border-radius:7px;font-size:13px;font-weight:650;color:#BFCDDD;text-decoration:none}
#xsport .xseg a:hover{color:#F3F6FC}#xsport .xedge{display:inline-flex;align-items:center;gap:7px;min-height:40px;padding:0 13px;border-radius:9px;font-size:13px;font-weight:650;color:#142030;background:#F3F6FC;text-decoration:none;flex:none}
#xsport .xedge:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent)}
.ed{max-width:1120px;margin:0 auto;padding:26px 20px 64px}
.eyebrow{font-family:var(--mono);font-size:12px;font-weight:500;letter-spacing:.08em;color:var(--ink-3);margin:0 0 6px;display:flex;align-items:center;gap:8px}
.eyebrow .dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}
h1{font-size:34px;letter-spacing:-.03em;line-height:1.1;margin:0 0 8px}.lede{color:var(--ink-2);margin:0 0 16px;max-width:760px}
.legend{display:flex;flex-wrap:wrap;gap:8px 18px;font-size:13px;color:var(--ink-2);margin:0 0 18px}
.mk{display:inline-flex;align-items:center;gap:7px;font-weight:600;font-size:12.5px;white-space:nowrap}.mk:before{content:"";width:8px;height:8px;border-radius:50%;flex:none}
.mk.pv{color:var(--win)}.mk.pv:before{background:var(--win)}.mk.pr{color:var(--ink-2)}.mk.pr:before{background:transparent;box-shadow:inset 0 0 0 1.5px var(--ink-3)}
.list{display:flex;flex-direction:column;gap:10px}
.row{display:grid;grid-template-columns:170px minmax(0,1fr) 230px;gap:18px;align-items:start;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px 18px}
.when{font-size:13px;color:var(--ink-2);font-variant-numeric:tabular-nums}.when b{display:block;font-family:var(--mono);font-size:12px;font-weight:500;letter-spacing:.06em;color:var(--ink);margin-bottom:3px}
.mid{min-width:0}.meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin:0 0 6px}
.kick{font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3)}
.tag{font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--fill);color:var(--ink-2)}
.mu{font-size:17px;font-weight:650;letter-spacing:-.01em;margin:0 0 3px}.ti{margin:0 0 4px;color:var(--ink)}.de{margin:0;color:var(--ink-2);font-size:13.5px}
.cv{margin:6px 0 0;color:var(--ink-3);font-size:12.5px}.warn{margin:6px 0 0;font-size:12.5px;color:var(--ink);padding:6px 10px;border-radius:10px;background:var(--fill)}
.px{display:flex;flex-direction:column;align-items:stretch;gap:8px}.px .pk{font-size:12px;color:var(--ink-3);margin:0}
.px .pr{font-size:22px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin:0;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.px .pr small{font-size:13px;font-weight:500;color:var(--ink-2)}
.btns{display:flex;gap:8px}.btn{flex:1;display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 12px;border-radius:12px;font-size:13.5px;font-weight:600;text-decoration:none;border:1px solid var(--line);color:var(--ink);background:var(--surface-2);white-space:nowrap}
.btn:hover{border-color:var(--ink-3)}.nop{font-size:13px;color:var(--ink-3)}
.empty{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px 20px;color:var(--ink-2)}.empty strong{display:block;color:var(--ink);font-size:17px;margin-bottom:4px}
h2{font-size:13px;font-family:var(--mono);font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin:34px 0 10px}
.status{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.st{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px 14px;font-size:13px;color:var(--ink-2)}
.st b{display:flex;justify-content:space-between;color:var(--ink);font-size:14px;margin-bottom:3px}.st b span{font-variant-numeric:tabular-nums}
.ev{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.evc{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px 18px;scroll-margin-top:16px}
.evc:target{box-shadow:0 0 0 2px var(--ink-3)}.evc h3{margin:0 0 4px;font-size:16px}.evc p{margin:0 0 8px;color:var(--ink-2);font-size:13.5px}
.kv{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:8px 0}.kv div{background:var(--surface-2);border-radius:10px;padding:8px 10px}.kv span{display:block;font-size:11px;color:var(--ink-3);letter-spacing:.04em;text-transform:uppercase}
.kv strong{font-size:16px;font-variant-numeric:tabular-nums}.kv .g{color:var(--win)}.links{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.links a{font-size:13px;font-weight:600;text-decoration:none;padding:8px 12px;border-radius:10px;border:1px solid var(--line)}
.foot{margin-top:26px;font-size:12px;color:var(--ink-3)}
@media (max-width:900px){.row{grid-template-columns:minmax(0,1fr);gap:10px}.status{grid-template-columns:repeat(2,minmax(0,1fr))}.ev{grid-template-columns:minmax(0,1fr)}.when b{display:inline;margin-right:8px}}
@media (max-width:560px){#xsport{gap:6px;height:60px;padding:0 max(12px,env(safe-area-inset-right)) 0 max(12px,env(safe-area-inset-left))}#xsport .wm{display:none}#xsport .xm{width:24px;height:24px}
 #xsport .xseg a{padding:0 9px;font-size:12px;min-height:42px}#xsport .xedge{padding:0 9px;font-size:12px;gap:5px}.ed{padding:18px 16px 48px}h1{font-size:28px}.kv{grid-template-columns:repeat(2,minmax(0,1fr))}.row{padding:14px}}
@media (max-width:420px){#xsport .xedge:before{display:none}#xsport .xedge{padding:0 8px}}
`;

function priceBlock(row) {
  const p = row.price, b = p && NV_BOOKS[p.book];
  if (!p || !num(p.odds) || !b) return `<div class="px"><p class="pk">${esc(row.pick.text)} · best Nevada price</p><p class="nop">No fresh Nevada price right now.</p><div class="btns"><a class="btn" href="#ev-${row.sig}">Evidence</a></div></div>`;
  return `<div class="px"><p class="pk">${esc(row.pick.text)} · best Nevada price</p><p class="pr">${esc(odds(p.odds))} <small>${esc(b.name)}</small></p>`
    + `<div class="btns"><a class="btn" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(b.full)}">${esc(b.name)} ↗</a><a class="btn" href="#ev-${row.sig}">Evidence</a></div></div>`;
}
function rowHTML(row, now) {
  const S = SIGNALS[row.sig];
  const mark = S.proven ? '<span class="mk pv">Beat the close out-of-sample</span>' : '<span class="mk pr">Provisional</span>';
  const kick = S.football ? `Market read · ${S.market.toLowerCase()}` : `${S.market} signal`;
  return `<article class="row" data-sig="${row.sig}"><div class="when"><b>${esc(S.sport)}</b>${esc(when(row.start, now))}</div>`
    + `<div class="mid"><div class="meta"><span class="kick">${esc(kick)}</span>${row.confidence ? `<span class="tag">${esc(row.confidence)}</span>` : ''}${mark}</div>`
    + `<p class="mu">${esc(row.matchup)}</p><p class="ti">${esc(row.title)}</p><p class="de">${esc(row.detail)}</p>`
    + (row.warn ? `<p class="warn">${esc(row.warn)}</p>` : '') + `<p class="cv">${esc(S.caveat)}</p></div>${priceBlock(row)}</article>`;
}
function evidenceHTML(key, ev, owner, adminPath) {
  const S = SIGNALS[key], h = ev && ev.holdout, l = ev && ev.live;
  const kv = h ? `<div class="kv"><div><span>Holdout bets</span><strong>${esc(h.bets)}</strong></div><div><span>CLV EV vs close</span><strong class="${S.proven && h.clv_ev_pct > 0 ? 'g' : ''}">${esc(pct(h.clv_ev_pct))}</strong></div>`
    + `<div><span>p-value</span><strong>${h.p == null ? '—' : h.p < 0.001 ? '&lt;0.001' : esc((+h.p).toFixed(3))}</strong></div><div><span>Beat the close</span><strong>${h.beat_close == null ? '—' : Math.round(h.beat_close * 100) + '%'}</strong></div></div>`
    + `<p>By season: ${esc(Object.entries(h.by_season || {}).map(([s, v]) => s.replace(/_pre_july$/, ' pre-July').replace(/_/g, ' ') + ' ' + pct(v)).join(' · ') || '—')}. Threshold: ${esc(h.label)}.</p>` : '<p>Holdout numbers are not available from this board right now.</p>';
  const live = owner && l ? `<p>Live record (${esc(l.tier)}): ${l.scored ? `${esc(l.scored)} scored, CLV EV ${esc(pct(l.clvEvPct))}, beat the close ${Math.round((l.beatCloseRate || 0) * 100)}%` : 'none scored yet'}${l.pending ? `, ${esc(l.pending)} waiting for the close` : ''}.</p>` : '';
  const links = owner && adminPath ? `<div class="links"><a href="${esc(adminPath)}/proof">Proof page ›</a><a href="${esc(adminPath)}/research?sport=${key}">Research write-up ›</a><a href="${S.board}">${esc(S.sport)} board ›</a></div>`
    : `<div class="links"><a href="${S.board}">${esc(S.sport)} board ›</a></div>`;
  return `<section class="evc" id="ev-${key}"><div class="meta">${S.proven ? '<span class="mk pv">Beat the close out-of-sample</span>' : '<span class="mk pr">Provisional</span>'}</div><h3>${esc(S.name)}</h3><p>${esc(S.rule)}</p>${kv}${live}${links}</section>`;
}

function render({ rows, status, evidence, at, errors }, { owner, adminPath }) {
  const now = at || Date.now();
  const st = (k) => { const s = status[k] || {}; const S = SIGNALS[k];
    return `<div class="st"><b>${esc(S.sport)} <span>${s.live ? s.count : '—'}</span></b>${esc(!s.live ? 'Board not reachable right now.' : s.note || (s.count ? (s.count === 1 ? '1 qualifies.' : s.count + ' qualify.') : 'Nothing qualifies right now.'))}</div>`; };
  const list = rows.length ? `<div class="list">${rows.map((r) => rowHTML(r, now)).join('')}</div>`
    : `<div class="empty"><strong>Nothing qualifies right now.</strong>A quiet screen is the normal state: these signals are rare by design. The status of each board is below.</div>`;
  return `<main class="ed" id="ed"><p class="eyebrow"><span class="dot"></span>EDGES · UPDATED ${esc(new Date(now).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }))} PT</p>
<h1>What qualifies right now</h1>
<p class="lede">Every signal across the four boards that meets its tested rule, with the best Nevada price. Green marks only the signals that beat the closing line out-of-sample. Football rows are market reads: information, not picks. Prices move; check the number at the book.</p>
<div class="legend"><span class="mk pv">Beat the close out-of-sample</span><span class="mk pr">Provisional, still being proven live</span><span>Nevada books only</span></div>
${list}
<h2>By board</h2><div class="status">${['nhl', 'mlb', 'ncaaf', 'nfl'].map(st).join('')}</div>
<h2>Evidence</h2><div class="ev">${['nhl', 'mlb', 'ncaaf', 'nfl'].map((k) => evidenceHTML(k, evidence && evidence[k], owner, adminPath)).join('')}</div>
<p class="foot">Not listed: the NCAAF late quarterback change read (provisional in research) needs the confirmed starter before books adjust, and the app has no confirmed-starter feed yet, so it is not produced live. Smaller leans (NHL GOLD, MLB below 0.30, NCAAF Weak, NFL Lean) stay on each board. No stakes, no alerts: this page never tells you what to bet.${errors && errors.length ? ' Some boards did not answer on the last refresh: ' + esc(errors.join(', ')) + '.' : ''} Refreshes every minute.</p></main>`;
}

function shell(main, nonce) {
  const nav = [['/nfl/', 'NFL'], ['/ncaaf/', 'NCAAF'], ['/mlb/', 'MLB'], ['/nhl/', 'NHL']].map(([h, l]) => `<a href="${h}">${l}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Edges · THE.BOARD</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#080E19">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Geist+Mono:wght@500;700&display=swap" rel="stylesheet"><style>${CSS}</style></head><body>
<div id="xsport"><a class="brand" href="/" aria-label="THE.BOARD home"><svg class="xm" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="var(--ink)"/><path d="M21 21 L33 32 L21 43" fill="none" stroke="var(--accent)" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="34" y="38.5" width="15" height="5" rx="2.5" fill="var(--surface)"/></svg><span class="wm">THE<b>.</b>BOARD</span></a><nav class="xseg" aria-label="Sport">${nav}</nav><a class="xedge" href="/edges" aria-current="page">Edges</a></div>
${main}
<script nonce="${nonce}">(function(){var busy=false;function tick(){if(busy||document.hidden)return;busy=true;fetch('/edges?part=main',{headers:{accept:'text/html'},cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){if(h){var el=document.getElementById('ed');if(el&&el.outerHTML!==h)el.outerHTML=h}}).catch(function(){}).then(function(){busy=false})}setInterval(tick,60000);document.addEventListener('visibilitychange',function(){if(!document.hidden)tick()})})();</script>
</body></html>`;
}

/* ---------------------------------------------------------------- service */
function loopback(port, p, cookie, timeout = 8000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { cookie, accept: 'application/json' }, timeout }, (res) => {
      const parts = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 8e6) req.destroy(); else parts.push(c); });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(Buffer.concat(parts).toString('utf8')) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

module.exports = function edges({ sports, ownerCookie, adminPath = '', interval = 60e3, evidenceEvery = 10 * 60e3, get = loopback, now = Date.now, log = console.log }) {
  const keys = ['nhl', 'mlb', 'ncaaf', 'nfl'].filter((k) => sports[k]);
  let state = { rows: [], status: {}, evidence: {}, at: 0, errors: [] }, pages = null, evidenceAt = 0, timer = null, running = null;

  async function refresh() {
    if (running) return running;
    running = (async () => {
      const t0 = now();
      const feeds = {}, errors = [];
      await Promise.all(keys.map(async (k) => { const d = await get(sports[k].port, '/api/edges', ownerCookie); if (d) feeds[k] = d; else errors.push(sports[k].label || k); }));
      let evidence = state.evidence;
      if (!evidenceAt || t0 - evidenceAt >= evidenceEvery) {
        evidence = {};
        await Promise.all(keys.map(async (k) => {
          const [health, record] = await Promise.all([get(sports[k].port, '/api/health', ownerCookie), get(sports[k].port, '/api/vas/record', ownerCookie)]);
          evidence[k] = evidenceFor(k, health, record);
        }));
        evidenceAt = t0;
      }
      const built = buildRows(feeds, t0);
      state = { ...built, evidence, at: t0, errors };
      // Render once per refresh, per audience. Requests only send these strings.
      pages = { owner: render(state, { owner: true, adminPath }), guest: render(state, { owner: false, adminPath: '' }) };
      if (now() - t0 > 3000) log(`[edges] refresh took ${now() - t0}ms`);
    })().catch((e) => log('[edges] refresh failed: ' + (e && e.message))).finally(() => { running = null; });
    return running;
  }
  function start(delay = 15e3) {
    if (timer) return;
    const loop = async () => { await refresh(); timer = setTimeout(loop, interval); timer.unref && timer.unref(); };
    timer = setTimeout(loop, delay); timer.unref && timer.unref();
  }
  function stop() { clearTimeout(timer); timer = null; }

  const headers = (nonce) => ({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
  const loading = `<main class="ed" id="ed"><p class="eyebrow"><span class="dot"></span>EDGES</p><h1>What qualifies right now</h1><div class="empty"><strong>Checking the boards…</strong>The first read takes a few seconds after a deploy. This page refreshes itself.</div></main>`;

  return {
    refresh, start, stop, state: () => state,
    // true when handled. role: 'owner' | 'guest' | null (null only reaches here when boards are locked)
    handle(req, res, pathname, qs, role) {
      if (pathname !== '/edges' && pathname !== '/edges/') return false;
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return true; }
      if (!role) { res.writeHead(302, { location: '/', 'cache-control': 'no-store' }); res.end(); return true; }
      const main = pages ? pages[role === 'owner' ? 'owner' : 'guest'] : loading;
      const nonce = require('node:crypto').randomBytes(12).toString('base64');
      const part = /(?:^|[?&])part=main(?:&|$)/.test(String(qs || ''));
      res.writeHead(200, headers(nonce));
      res.end(req.method === 'HEAD' ? '' : part ? main : shell(main, nonce));
      return true;
    },
  };
};
module.exports.buildRows = buildRows;
module.exports.evidenceFor = evidenceFor;
module.exports.render = render;
module.exports.NV_BOOKS = NV_BOOKS;
module.exports.SIGNALS = SIGNALS;
