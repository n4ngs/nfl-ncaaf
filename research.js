'use strict';
// Owner-only Research page (<ADMIN_PATH>/research): each sport's research write-up (<sport>/research/README.md —
// data sources, models tried, holdout closing-line proof, ablations, caveats) rendered for reading in the app.
// The READMEs ship with the code; nothing is fetched and nothing here is reachable by guests.
const fs = require('node:fs'), path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, 'design', 'admin-center.css'), 'utf8');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Inline markdown: code spans first (their contents stay literal), then bold / italic / links (http(s) only).
function inline(text) {
  const parts = String(text).split(/(`[^`]*`)/);
  return parts.map((p) => {
    if (/^`[^`]*`$/.test(p)) return '<code>' + esc(p.slice(1, -1)) + '</code>';
    let h = esc(p);
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>');
    return h;
  }).join('');
}

// A small, safe markdown renderer for the research READMEs: headings, paragraphs, lists, tables, fenced code.
// All text is escaped; no raw HTML passes through.
function markdown(md) {
  const lines = String(md).replace(/\r/g, '').split('\n');
  const out = [], toc = [];
  let i = 0, para = [];
  const flush = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush(); const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>'); continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      flush(); const lvl = Math.min(4, h[1].length + 1), id = 'h' + out.length;
      if (lvl <= 3) toc.push({ id, lvl, text: h[2] });
      out.push('<h' + lvl + ' id="' + id + '">' + inline(h[2]) + '</h' + lvl + '>'); i++; continue;
    }
    if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush(); const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push('<div class="scroll"><table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      flush(); const ordered = /^\s*\d+\./.test(l), items = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      out.push((ordered ? '<ol>' : '<ul>') + items.map((t) => '<li>' + inline(t) + '</li>').join('') + (ordered ? '</ol>' : '</ul>'));
      continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l.trim()); i++;
  }
  flush();
  return { html: out.join('\n'), toc };
}

module.exports = function research({ adminPath, sports, logo, root = __dirname }) {
  const cache = new Map();
  function doc(key) {
    const f = path.join(root, sports[key].dir, 'research', 'README.md');
    let st; try { st = fs.statSync(f); } catch { return null; }
    const c = cache.get(f);
    if (c && c.m === st.mtimeMs) return c.v;
    const v = { ...markdown(fs.readFileSync(f, 'utf8')), updated: st.mtime.toISOString() };
    cache.set(f, { m: st.mtimeMs, v });
    return v;
  }
  function page(sel) {
    const keys = Object.keys(sports).filter((k) => doc(k));
    const cur = keys.includes(sel) ? sel : keys[0];
    const d = cur ? doc(cur) : null;
    const tabs = keys.map((k) => '<a href="' + adminPath + '/research?sport=' + k + '"' + (k === cur ? ' aria-current="page" class="on"' : '') + '>' + esc(sports[k].label) + '</a>').join('');
    const toc = d ? d.toc.filter((t) => t.lvl === 2).map((t) => '<a href="#' + t.id + '">' + inline(t.text).replace(/<[^>]+>/g, '') + '</a>').join('') : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Research · THE.BOARD</title><meta name="robots" content="noindex"><style>${css}
.rs{max-width:1080px;margin:0 auto;padding:22px 16px 70px}.rs h1{font-size:28px;margin:6px 0 4px;color:var(--ink)}.rs .lede{color:var(--i2);margin:0 0 16px;font-size:14px;max-width:760px}
.rs-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}.rs-tabs a{padding:7px 14px;border:1px solid var(--line);border-radius:999px;color:var(--i2);text-decoration:none;font-weight:600;font-size:13px;background:var(--s)}
.rs-tabs a.on{background:var(--ink);color:var(--s);border-color:var(--ink)}
.rs-toc{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:12px;margin:0 0 16px;padding:10px 14px;background:var(--s2);border-radius:10px}.rs-toc a{color:var(--i2);text-decoration:none}.rs-toc a:hover{color:var(--ink);text-decoration:underline}
.rs-doc{background:var(--s);border:1px solid var(--line);border-radius:14px;padding:6px 22px 22px;color:var(--i2);font-size:14px;line-height:1.55}
.rs-doc h2{font-size:22px;color:var(--ink);margin:22px 0 8px}.rs-doc h3{font-size:17px;color:var(--ink);margin:22px 0 8px;padding-top:12px;border-top:1px solid var(--line)}
.rs-doc h4{font-size:14px;color:var(--ink);margin:16px 0 6px}.rs-doc strong{color:var(--ink)}.rs-doc code{font-size:12px;background:var(--s2);padding:1px 5px;border-radius:5px;word-break:break-word}
.rs-doc pre{background:var(--s2);padding:12px;border-radius:10px;overflow-x:auto}.rs-doc pre code{background:none;padding:0;word-break:normal;white-space:pre}
.rs-doc ul,.rs-doc ol{padding-left:22px}.rs-doc li{margin:3px 0}
.rs-doc table{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums;margin:6px 0 10px}.rs-doc th{text-align:left;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--i3);padding:7px 9px;background:var(--s2);white-space:nowrap}
.rs-doc td{padding:7px 9px;border-top:1px solid var(--line);vertical-align:top}.rs-doc .scroll{overflow-x:auto}.rs .note{font-size:12px;color:var(--i3);margin-top:10px}
</style></head><body><header class="top"><a class="brand" href="${adminPath}">${logo}<span>THE<span class="gold">.</span>BOARD</span></a><span class="private-mark">OWNER WORKSPACE</span>
<nav id="views" aria-label="Admin sections"><a href="${adminPath}#people">Devices</a><a href="${adminPath}#activity">Activity</a><a href="${adminPath}#security">Security</a><a href="${adminPath}/proof">Proof</a><a href="${adminPath}/research" aria-current="page">Research</a></nav><a class="board-link" href="/nfl/">Open board ↗</a></header>
<main class="rs"><p class="eyebrow">RESEARCH</p><h1>How each model was built and tested</h1>
<p class="lede">The full write-up per sport: data sources, every model tried (including the neural networks), the closing-line proof by season, what carries the signal, and the caveats. Live results are on the Proof page.</p>
<nav class="rs-tabs" aria-label="Sport">${tabs}</nav>
${d ? (toc ? '<nav class="rs-toc" aria-label="Sections">' + toc + '</nav>' : '') + '<article class="rs-doc">' + d.html + '</article><p class="note">Source: ' + esc(sports[cur].dir) + '/research/README.md · updated ' + esc(new Date(d.updated).toLocaleString()) + '</p>' : '<p class="note">No research write-up is deployed yet.</p>'}
</main></body></html>`;
  }
  const sec = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" };
  return {
    // true when handled
    handle(req, res, pathname, qs, role) {
      if (!adminPath || pathname !== adminPath + '/research') return false;
      if (role !== 'owner') { res.writeHead(404, { 'content-type': 'text/plain', ...sec }); res.end('Not found'); return true; }
      if (req.method !== 'GET') { res.writeHead(405, sec); res.end(); return true; }
      const sport = new URLSearchParams(String(qs || '').replace(/^\?/, '')).get('sport') || '';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...sec }); res.end(page(sport));
      return true;
    },
    markdown,
  };
};
