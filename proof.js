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
      const [record, health, season] = await Promise.all([get(s.port, '/api/vas/record', ownerCookie), get(s.port, '/api/health', ownerCookie), get(s.port, '/api/vas/season', ownerCookie)]);
      const vas = health && health.vas;
      out[key] = { label: s.label, live: !!record, model: vas ? { version: vas.model, builtAt: vas.builtAt, proven: vas.proven || null, external: vas.external || null, tiers: vas.tiers || null, history: vas.history || null } : null,
        record: record || null, season: season && season.ready && Array.isArray(season.rows) ? season.rows : null };
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
.sv-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:8px 0}.sv-s{background:var(--s2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}.sv-s small{font-size:11px;color:var(--i3)}.sv-s strong{font-size:19px;color:var(--ink);font-variant-numeric:tabular-nums}
.sv{display:block;width:100%;height:auto;margin-top:6px}.sv-g{stroke:var(--line)}.sv-g.z{stroke:var(--i3)}.sv-t{fill:var(--i3);font-size:11px}.sv-d{fill:var(--ink);fill-opacity:.55;stroke:var(--s);stroke-width:1}.sv-f{stroke:#B06E00;stroke-width:2.5}
</style></head><body><header class="top"><a class="brand" href="${adminPath}">${logo}<span>THE<span class="gold">.</span>BOARD</span></a><span class="private-mark">OWNER WORKSPACE</span>
<nav id="views" aria-label="Admin sections"><a href="${adminPath}#people">Devices</a><a href="${adminPath}#activity">Activity</a><a href="${adminPath}#security">Security</a><a href="${adminPath}/proof" aria-current="page">Proof</a><a href="${adminPath}/research">Research</a></nav><a class="board-link" href="/nhl/">Open board ↗</a></header>
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
// Out-of-sample replication on openers the model never saw (NFL: the owner's AusSportsBetting file). Evidence only.
function external(x){if(!x||!x.rows||!Object.keys(x.rows).length)return '';
 return '<h3>Replication on other openers (nothing refit)</h3><p class="note">'+esc(x.source||'')+' '+esc((x.caveats||[]).join(' '))+' p-values are Bonferroni-adjusted.</p>'+proven(x.rows);}
function live(r){if(!r)return '<p class="pf-empty">Live record not running for this sport yet.</p>';const t=r.tiers||{};const order={DIAMOND:0,PROVEN:0,GOLD:1,LEAN:1,ALL:9};const rows=Object.keys(t).sort((a,b)=>(order[a]??5)-(order[b]??5));
 let h=rows.length?'<div class="scroll"><table><thead><tr><th>Tier</th><th>Signals scored</th><th>CLV EV vs close</th><th>t-stat</th><th>Beat close</th><th>Settled</th><th>Won</th><th>ROI (settled)</th></tr></thead><tbody>'+rows.map(k=>{const v=t[k];return '<tr><td><strong>'+k+'</strong></td><td>'+v.bets+'</td><td class="'+cls(v.clvEvPct)+'">'+pct(v.clvEvPct)+'</td><td>'+(v.tStat==null?'—':v.tStat.toFixed(2))+'</td><td>'+Math.round(v.beatCloseRate*100)+'%</td><td>'+v.settled+'</td><td>'+v.won+'</td><td class="'+cls(v.roiPct)+'">'+pct(v.roiPct,1)+'</td></tr>'}).join('')+'</tbody></table></div>':'<p class="pf-empty">No signals scored yet'+(r.pending?' ('+r.pending+' waiting for game start)':'')+'.</p>';
 const sig=(r.signals||[]).slice(0,40);if(sig.length)h+='<h3>Recent signals</h3><div class="scroll"><table><thead><tr><th>Game</th><th>Tier</th><th>Play</th><th>Entry</th><th>Entry prob</th><th>Close prob</th><th>CLV EV</th><th>Result</th></tr></thead><tbody>'+sig.map(s=>{const ev=s.closeProb!=null?(s.closeProb*(s.entryOdds>0?1+s.entryOdds/100:1+100/-s.entryOdds)-1)*100:null;
 return '<tr><td><strong>'+esc(s.matchup)+'</strong><br><small>'+esc(new Date(s.start).toLocaleString())+'</small></td><td>'+esc(s.tier)+'</td><td>'+esc(s.side)+' '+esc(s.market||'')+(s.line!=null?' '+esc(s.line):'')+'</td><td>'+odds(s.entryOdds)+' <small>'+esc(s.entryBook||'')+'</small></td><td>'+(s.entryProb*100).toFixed(1)+'%</td><td>'+(s.closeProb!=null?(s.closeProb*100).toFixed(1)+'%':'pending')+'</td><td class="'+cls(ev)+'">'+pct(ev)+'</td><td>'+esc(s.result||'—')+'</td></tr>'}).join('')+'</tbody></table></div>';
 return h;}
// This season: model vs market vs result. x = how far the model sat from the closing line, y = how far the result
// landed from it. If the model knows something the close does not, the dots lean up-right (the fit line rises).
function seasonBlock(rows){if(!rows||!rows.length)return '';const R=rows.filter(r=>isFinite(r.fair)&&isFinite(r.market)&&isFinite(r.result));
 if(R.length<5)return '<h3>This season: model vs the closing line</h3><p class="pf-empty">'+(R.length?R.length+' games so far; the chart starts at five.':'No finished games with a closing line yet.')+'</p>';
 const n=R.length,mae=a=>a.reduce((s,v)=>s+Math.abs(v),0)/a.length;
 const mM=mae(R.map(r=>r.fair-r.result)),kM=mae(R.map(r=>r.market-r.result)),closer=R.filter(r=>Math.abs(r.fair-r.result)<Math.abs(r.market-r.result)).length;
 const X=R.map(r=>r.fair-r.market),Y=R.map(r=>r.result-r.market),mx=X.reduce((a,b)=>a+b,0)/n,my=Y.reduce((a,b)=>a+b,0)/n;
 let sxy=0,sxx=0,syy=0;for(let i=0;i<n;i++){sxy+=(X[i]-mx)*(Y[i]-my);sxx+=(X[i]-mx)**2;syy+=(Y[i]-my)**2;}const slope=sxx?sxy/sxx:0,corr=sxx&&syy?sxy/Math.sqrt(sxx*syy):0;
 const big=R.filter(r=>Math.abs(r.fair-r.market)>=3&&r.result!==r.market),bigWin=big.filter(r=>Math.sign(r.fair-r.market)===Math.sign(r.result-r.market)).length;
 const W=720,H=320,L=48,Rr=14,T=12,B=34,xr=Math.max(3,...X.map(Math.abs))*1.08,yr=Math.max(7,...Y.map(Math.abs))*1.05;
 const x=v=>L+(v+xr)/(2*xr)*(W-L-Rr),y=v=>T+(yr-v)/(2*yr)*(H-T-B);
 const tk=(r,st)=>{const o=[];for(let v=Math.ceil(-r/st)*st;v<=r;v+=st)o.push(v);return o};
 const xs=tk(xr,xr>12?5:xr>6?2:1),ys=tk(yr,yr>30?10:5);
 const g=xs.map(v=>'<line class="sv-g'+(v===0?' z':'')+'" x1="'+x(v)+'" x2="'+x(v)+'" y1="'+T+'" y2="'+(H-B)+'"/><text class="sv-t" x="'+x(v)+'" y="'+(H-B+16)+'" text-anchor="middle">'+(v>0?'+':'')+v+'</text>').join('')
  +ys.map(v=>'<line class="sv-g'+(v===0?' z':'')+'" x1="'+L+'" x2="'+(W-Rr)+'" y1="'+y(v)+'" y2="'+y(v)+'"/><text class="sv-t" x="'+(L-6)+'" y="'+(y(v)+4)+'" text-anchor="end">'+(v>0?'+':'')+v+'</text>').join('');
 const dots=R.map((r,i)=>'<circle class="sv-d" cx="'+x(X[i]).toFixed(1)+'" cy="'+y(Y[i]).toFixed(1)+'" r="4"><title>'+esc((r.away||'')+' @ '+(r.home||''))+(r.week?' · week '+r.week:'')+': model '+(r.fair>0?'+':'')+r.fair.toFixed(1)+', close '+(r.market>0?'+':'')+r.market+', result '+(r.result>0?'+':'')+r.result+' (home margin)</title></circle>').join('');
 const fit='<line class="sv-f" x1="'+x(-xr)+'" x2="'+x(xr)+'" y1="'+y(my+slope*(-xr-mx))+'" y2="'+y(my+slope*(xr-mx))+'"/>';
 const stat=(k,v,s)=>'<div class="sv-s"><small>'+k+'</small><strong>'+v+'</strong><small>'+s+'</small></div>';
 return '<h3>This season: model vs the closing line</h3><div class="sv-stats">'+stat('Games',n,'finished, with a close')+stat('Model closer to the result',Math.round(100*closer/n)+'%',closer+' of '+n+' games')+
  stat('Average miss',mM.toFixed(1)+' vs '+kM.toFixed(1),'model vs close, points of margin')+stat('Model 3+ pts off the close',big.length?Math.round(100*bigWin/big.length)+'%':'—',big.length?bigWin+' of '+big.length+' went the model’s way':'no games yet')+'</div>'+
  '<svg class="sv" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Model minus close against result minus close, one dot per game">'+g+dots+fit+'<text class="sv-t" x="'+(W-Rr)+'" y="'+(H-4)+'" text-anchor="end">model minus close (pts) →</text><text class="sv-t" x="'+(L+4)+'" y="'+(T+10)+'">↑ result minus close</text></svg>'+
  '<p class="note">One dot per game (home margin). Right of centre: the model liked the home side more than the close did; above centre: the home side beat the close. Dots leaning up-right (a rising line, correlation '+corr.toFixed(2)+') would mean the model saw something the close missed. A small sample says little; the holdout proof above is the real test.</p>';}
async function load(){try{const r=await fetch('${adminPath}/api/proof',{headers:{accept:'application/json'}});const d=await r.json();
 document.getElementById('out').innerHTML=Object.entries(d.sports).map(([k,s])=>'<section class="pf-card"><div class="pf-head"><h2>'+esc(s.label)+'</h2><span>'+(s.model?esc(s.model.version||'')+(s.model.builtAt?' · history built '+esc(new Date(s.model.builtAt).toLocaleString()):''):'model not deployed yet')+'</span></div><div class="pf-body"><h3>Holdout proof (past seasons)</h3>'+proven(s.model&&s.model.proven)+external(s.model&&s.model.external)+'<h3>Live record</h3>'+live(s.record)+seasonBlock(s.season)+'</div></section>').join('')+'<p class="note">Updated '+esc(new Date(d.at).toLocaleString())+'. Refreshes every minute.</p>';}
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
