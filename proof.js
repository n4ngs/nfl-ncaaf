'use strict';
// Owner-only Proof page: every sport's VAS model, its holdout proof, and its LIVE closing-line record.
// Served by the terminal under the private admin path (<ADMIN_PATH>/proof). Each engine exposes an owner-only
// /api/vas/record (live record) and /api/health (vas.proven, model status); the terminal reads them over loopback
// with the owner's credential cookies, so nothing here is reachable by guests.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const css = fs.readFileSync(path.join(__dirname, 'design', 'admin-center.css'), 'utf8');

function get(port, p, cookie) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { cookie, accept: 'application/json' }, timeout: 5000 }, res => {
      let b = ''; res.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(b) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

module.exports = function proof({ adminPath, sports, ownerCookie, logo }) {
  async function collect() {
    const out = {};
    for (const [key, s] of Object.entries(sports)) {
      const [record, health] = await Promise.all([get(s.port, '/api/vas/record', ownerCookie), get(s.port, '/api/health', ownerCookie)]);
      const vas = health && health.vas;
      out[key] = { label: s.label, live: !!record, model: vas ? { version: vas.model, builtAt: vas.builtAt, proven: vas.proven || null, tiers: vas.tiers || null, history: vas.history || null } : null,
        record: record || null };
    }
    return { at: new Date().toISOString(), sports: out };
  }
  const page = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proof · THE.BOARD</title><meta name="robots" content="noindex"><style>${css}
.pf{max-width:1180px;margin:0 auto;padding:22px 16px 60px}.pf h1{font-size:28px;margin:6px 0 4px;color:var(--ink)}.pf .lede{color:var(--i2);margin:0 0 18px;font-size:14px;max-width:760px}
.pf-card{background:var(--s);border:1px solid var(--line);border-radius:14px;margin:0 0 16px;overflow:hidden}.pf-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline;padding:14px 16px;border-bottom:1px solid var(--line)}
.pf-head h2{margin:0;font-size:18px;color:var(--ink)}.pf-head span{color:var(--i3);font-size:12px}.pf-body{padding:12px 16px}.pf-empty{color:var(--i3);font-size:13px;padding:12px 16px}
.pf table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}.pf th{text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--i3);padding:8px 10px;background:var(--s2)}
.pf td{padding:8px 10px;border-top:1px solid var(--line);color:var(--i2)}.pf td strong{color:var(--ink)}.pf .scroll{overflow-x:auto}.pf .pos{color:#1f8a4c}.pf .neg{color:var(--a)}.pf h3{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--i3);margin:14px 0 6px}
.pf .note{font-size:12px;color:var(--i3);margin-top:8px}
</style></head><body><header class="top"><a class="brand" href="${adminPath}">${logo}<span>THE<span class="gold">.</span>BOARD</span></a><span class="private-mark">OWNER WORKSPACE</span>
<nav id="views" aria-label="Admin sections"><a href="${adminPath}#people">Devices</a><a href="${adminPath}#activity">Activity</a><a href="${adminPath}#security">Security</a><a href="${adminPath}/proof" aria-current="page">Proof</a></nav><a class="board-link" href="/nhl/">Open board ↗</a></header>
<main class="pf"><p class="eyebrow">MODEL PROOF</p><h1>Does it beat the closing line?</h1>
<p class="lede">Each sport's VAS model is shown with its holdout proof (past seasons, never seen in training) and its live record. A signal counts once, at the first price it appeared; it is scored against the market just before the game starts. CLV EV is the expected return if the closing price is the truth; it is the standard proof of an edge. Settled ROI is shown but takes hundreds of bets to mean anything.</p>
<div id="out"><p class="pf-empty">Loading…</p></div></main>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const pct=(v,d=2)=>v==null||!isFinite(v)?'—':(v>0?'+':'')+v.toFixed(d)+'%';const cls=v=>v>0?'pos':v<0?'neg':'';
const odds=o=>isFinite(o)?(o>0?'+'+o:o):'—';
function proven(p){if(!p)return '<p class="pf-empty">No holdout proof published by this model yet.</p>';
 return '<div class="scroll"><table><thead><tr><th>Tier threshold</th><th>Bets</th><th>CLV EV vs close</th><th>p-value</th><th>Beat close</th><th>By season</th></tr></thead><tbody>'+
 Object.entries(p).map(([k,v])=>'<tr><td><strong>'+esc(k)+'</strong></td><td>'+v.bets+'</td><td class="'+cls(v.clv_ev_pct)+'">'+pct(v.clv_ev_pct)+'</td><td>'+(v.p<0.001?'<0.001':(+v.p).toFixed(3))+'</td><td>'+(v.beat_close!=null?Math.round(v.beat_close*100)+'%':'—')+'</td><td>'+esc(Object.entries(v.by_season||{}).map(([s,e])=>s+': '+pct(e)).join(' · '))+'</td></tr>').join('')+'</tbody></table></div>';}
function live(r){if(!r)return '<p class="pf-empty">Live record not running for this sport yet.</p>';const t=r.tiers||{};const order={DIAMOND:0,PROVEN:0,GOLD:1,LEAN:1,ALL:9};const rows=Object.keys(t).sort((a,b)=>(order[a]??5)-(order[b]??5));
 let h=rows.length?'<div class="scroll"><table><thead><tr><th>Tier</th><th>Signals scored</th><th>CLV EV vs close</th><th>t-stat</th><th>Beat close</th><th>Settled</th><th>Won</th><th>ROI (settled)</th></tr></thead><tbody>'+rows.map(k=>{const v=t[k];return '<tr><td><strong>'+k+'</strong></td><td>'+v.bets+'</td><td class="'+cls(v.clvEvPct)+'">'+pct(v.clvEvPct)+'</td><td>'+(v.tStat==null?'—':v.tStat.toFixed(2))+'</td><td>'+Math.round(v.beatCloseRate*100)+'%</td><td>'+v.settled+'</td><td>'+v.won+'</td><td class="'+cls(v.roiPct)+'">'+pct(v.roiPct,1)+'</td></tr>'}).join('')+'</tbody></table></div>':'<p class="pf-empty">No signals scored yet'+(r.pending?' ('+r.pending+' waiting for game start)':'')+'.</p>';
 const sig=(r.signals||[]).slice(0,40);if(sig.length)h+='<h3>Recent signals</h3><div class="scroll"><table><thead><tr><th>Game</th><th>Tier</th><th>Play</th><th>Entry</th><th>Entry prob</th><th>Close prob</th><th>CLV EV</th><th>Result</th></tr></thead><tbody>'+sig.map(s=>{const ev=s.closeProb!=null?(s.closeProb*(s.entryOdds>0?1+s.entryOdds/100:1+100/-s.entryOdds)-1)*100:null;
 return '<tr><td><strong>'+esc(s.matchup)+'</strong><br><small>'+esc(new Date(s.start).toLocaleString())+'</small></td><td>'+esc(s.tier)+'</td><td>'+esc(s.side)+' '+esc(s.market||'')+(s.line!=null?' '+esc(s.line):'')+'</td><td>'+odds(s.entryOdds)+' <small>'+esc(s.entryBook||'')+'</small></td><td>'+(s.entryProb*100).toFixed(1)+'%</td><td>'+(s.closeProb!=null?(s.closeProb*100).toFixed(1)+'%':'pending')+'</td><td class="'+cls(ev)+'">'+pct(ev)+'</td><td>'+esc(s.result||'—')+'</td></tr>'}).join('')+'</tbody></table></div>';
 return h;}
async function load(){try{const r=await fetch('${adminPath}/api/proof',{headers:{accept:'application/json'}});const d=await r.json();
 document.getElementById('out').innerHTML=Object.entries(d.sports).map(([k,s])=>'<section class="pf-card"><div class="pf-head"><h2>'+esc(s.label)+'</h2><span>'+(s.model?esc(s.model.version||'')+(s.model.builtAt?' · history built '+esc(new Date(s.model.builtAt).toLocaleString()):''):'model not deployed yet')+'</span></div><div class="pf-body"><h3>Holdout proof (past seasons)</h3>'+proven(s.model&&s.model.proven)+'<h3>Live record</h3>'+live(s.record)+'</div></section>').join('')+'<p class="note">Updated '+esc(new Date(d.at).toLocaleString())+'. Refreshes every minute.</p>';}
 catch(e){document.getElementById('out').innerHTML='<p class="pf-empty">Could not load proof data.</p>'}}
load();setInterval(load,60000);
</script></body></html>`;

  const sec = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' };
  return {
    // true when handled
    handle(req, res, pathname, role) {
      if (!adminPath || (pathname !== adminPath + '/proof' && pathname !== adminPath + '/api/proof')) return false;
      if (role !== 'owner') { res.writeHead(404, { 'content-type': 'text/plain', ...sec }); res.end('Not found'); return true; }
      if (req.method !== 'GET') { res.writeHead(405, sec); res.end(); return true; }
      if (pathname === adminPath + '/proof') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...sec }); res.end(page()); return true; }
      collect().then(d => { res.writeHead(200, { 'content-type': 'application/json', ...sec }); res.end(JSON.stringify(d)); },
        () => { res.writeHead(500, sec); res.end('{}'); });
      return true;
    },
  };
};
