'use strict';
/* Share links: a bet card you can send like a song. The board draws the card on the device (share.js) and, when the
   user opens the share sheet, posts the picture here once. They get back https://<host>/s/<id>: a small public page
   whose Open Graph tags carry the picture, so Messages, WhatsApp, Slack, X or Mail show the card itself as the link
   preview, and a tap opens the board.

   What is public, and what is not:
   - Only the picture and the one-line caption the user's own sheet produced. Amounts are on it only if they switched
     "Include amount" on. No account, device, bet id, book account or history is stored with it.
   - The id is 128 random bits, so links cannot be listed or guessed. Pages are noindex.
   - PNG or JPEG only, checked by signature, at most 2.5 MB; at most 40 links per address per hour; at most 5,000 links
     kept (oldest removed first) and each lasts 120 days.
   Creating needs a signed-in board user (owner or guest) from this origin; viewing needs nothing. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const MAX_IMAGE = 2.5 * 1024 * 1024, MAX_BODY = Math.ceil(MAX_IMAGE * 4 / 3) + 8192;
const KEEP = 5000, TTL = 120 * 86400e3, PER_HOUR = 40;
const SPORTS = new Set(['nfl', 'ncaaf', 'mlb', 'nhl']);
const ID = /^[A-Za-z0-9_-]{22}$/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, n);

function imageType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}

function create({ dataDir, origin, brand = 'THE.BOARD', now = Date.now }) {
  const dir = path.join(dataDir, 'shares');
  fs.mkdirSync(dir, { recursive: true });
  const hits = new Map();
  const limited = (ip) => {
    const t = now(), h = (hits.get(ip) || []).filter((x) => t - x < 3600e3);
    if (h.length >= PER_HOUR) { hits.set(ip, h); return true; }
    h.push(t); hits.set(ip, h);
    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    return false;
  };
  const metaOf = (id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); } catch { return null; } };
  function prune() {
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return; }
    const items = files.map((f) => { const id = f.slice(0, -5); const m = metaOf(id); return { id, at: m ? Date.parse(m.createdAt) || 0 : 0 }; }).sort((a, b) => a.at - b.at);
    const cut = now() - TTL;
    items.forEach((x, i) => {
      if (x.at < cut || items.length - i > KEEP) for (const ext of ['.json', '.png', '.jpg']) { try { fs.unlinkSync(path.join(dir, x.id + ext)); } catch { /* gone */ } }
    });
  }
  let created = 0;

  function save({ image, sport, title, text }) {
    const buf = Buffer.from(String(image || ''), 'base64');
    const type = imageType(buf);
    if (!type || buf.length > MAX_IMAGE) return null;
    const id = crypto.randomBytes(16).toString('base64url');
    fs.writeFileSync(path.join(dir, `${id}.${type}`), buf);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ sport: SPORTS.has(sport) ? sport : 'nfl', type, title: clean(title, 120) || 'My bet', text: clean(text, 400), createdAt: new Date(now()).toISOString() }));
    if (++created % 50 === 0) prune();
    return id;
  }

  function page(id, m) {
    const img = `${origin}/s/${id}.${m.type}`, url = `${origin}/s/${id}`, desc = m.text.split('\n').filter((l) => !/^https?:\/\//.test(l)).join(' · ') || 'A bet shared from ' + brand;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.title)} · ${esc(brand)}</title><meta name="robots" content="noindex,nofollow"><meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(brand)}"><meta property="og:title" content="${esc(m.title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(img)}">
<meta property="og:image:type" content="image/${m.type === 'jpg' ? 'jpeg' : 'png'}"><meta property="og:image:width" content="1080"><meta property="og:image:height" content="1350">
<meta property="og:image:alt" content="${esc(m.title)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(m.title)}">
<meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(img)}"><meta name="theme-color" content="#0b1018">
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0b1018;color:#f2f4f5;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;padding:24px 16px 40px}
.b{font-weight:800;letter-spacing:.12em;font-size:14px;margin:4px 0 20px}.b span{color:#ee3a2e}img{display:block;width:100%;max-width:420px;height:auto;border-radius:18px;box-shadow:0 0 0 1px #2a3746,0 20px 50px rgba(0,0,0,.45)}
p{max-width:420px;color:#b4c0cc;font-size:13px;text-align:center;margin:18px 0 0;white-space:pre-line}a.go{display:inline-flex;align-items:center;justify-content:center;min-height:48px;margin-top:22px;padding:12px 26px;border-radius:999px;background:#f2f4f5;color:#0b1018;font-weight:700;text-decoration:none}
a.go:focus-visible{outline:3px solid #ee3a2e;outline-offset:3px}small{margin-top:26px;color:#8794a3;font-size:11px;text-align:center}</style></head>
<body><div class="b">THE<span>.</span>BOARD</div><img src="${esc(img)}" width="1080" height="1350" alt="${esc(m.title)}">
${desc ? `<p>${esc(desc)}</p>` : ''}<a class="go" href="/${esc(m.sport)}/">Open the ${esc(m.sport.toUpperCase())} board</a>
<small>Shared by a ${esc(brand)} user. For entertainment, not advice. 21+. Gambling problem? Call 1-800-GAMBLER.</small></body></html>`;
  }

  // true when handled
  async function handle(req, res, pathname, { role, ip, sameOrigin }) {
    const m = /^\/s\/([A-Za-z0-9_-]{22})(?:\.(png|jpg))?$/.exec(pathname);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      const id = m[1], meta = ID.test(id) ? metaOf(id) : null;
      if (!meta || Date.parse(meta.createdAt) < now() - TTL || (m[2] && m[2] !== meta.type)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end('This shared bet is no longer available.'); return true; }
      if (m[2]) {
        let buf; try { buf = fs.readFileSync(path.join(dir, `${id}.${meta.type}`)); } catch { res.writeHead(404); res.end(); return true; }
        res.writeHead(200, { 'content-type': meta.type === 'jpg' ? 'image/jpeg' : 'image/png', 'content-length': buf.length, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' });
        res.end(req.method === 'HEAD' ? undefined : buf); return true;
      }
      const html = page(id, meta);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      res.end(req.method === 'HEAD' ? undefined : html); return true;
    }
    if (pathname !== '/api/share') return false;
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
    if (req.method !== 'POST') return json(405, { error: 'POST only' });
    if (!role) return json(401, { error: 'Sign in to share.' });
    if (!sameOrigin) return json(403, { error: 'Request origin not allowed' });
    if (limited(ip || 'unknown')) return json(429, { error: 'Too many share links this hour. Try again later.' });
    let size = 0; const chunks = [];
    try { for await (const c of req) { size += c.length; if (size > MAX_BODY) return json(413, { error: 'That picture is too large to share.' }); chunks.push(c); } } catch { return json(400, { error: 'Invalid request.' }); }
    let b; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: 'Invalid request.' }); }
    if (!b || typeof b !== 'object') return json(400, { error: 'Invalid request.' });
    const id = save({ image: b.image, sport: b.sport, title: b.title, text: b.text });
    if (!id) return json(400, { error: 'Only a PNG or JPEG bet card can be shared.' });
    return json(200, { url: `${origin}/s/${id}` });
  }
  return { handle, save, prune, dir };
}
module.exports = { create, imageType };
