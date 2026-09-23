'use strict';
const crypto = require('node:crypto');
const { destinationFor } = require('./bet-links');
const esc = x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
function quantile(values, q) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(q * sorted.length) - 1]; }
module.exports = function createOpportunityHTTP({ service, links, sameOrigin, now = Date.now }) {
  const clients = new Set(), pending = new Map(), samples = [];let sampleVersion = 0, metricCache = null;
  const metrics = () => { const cutoff = now() - 3600000; while (samples[0]?.at < cutoff) { samples.shift(); sampleVersion++; } if (metricCache?.version === sampleVersion) return metricCache.value; const value = { sampleCount: samples.length, windowMinutes: 60, receiptToAckMs: { p50: quantile(samples.map(s => s.delivery), .5), p95: quantile(samples.map(s => s.delivery), .95) }, renderMs: { p50: quantile(samples.map(s => s.render), .5), p95: quantile(samples.map(s => s.render), .95) }, clockKind: 'OPPORTUNITY_ENGINE_RECEIPT', description: 'Opportunity-engine receipt to rendered acknowledgement is an upper bound on delivery/render time and includes the return network trip. It starts after provider transport and normalization. Browser render time is client reported. Neither measures sportsbook quote age or end-to-end sportsbook latency.' }; metricCache = { version: sampleVersion, value }; return value; };
  const rowMap = snapshot => new Map((snapshot.rows || []).map(row => [row.id, JSON.stringify(row)]));
  let broadcastRows = rowMap(service.snapshot());
  const encodedSnapshot = snapshot => { const { ack, ...data } = snapshot; return JSON.stringify({ ...data, metrics: metrics() }).slice(0, -1); };
  const prunePending = () => { for (const [key, sample] of pending) if (sample.sentAt < now() - 30000) pending.delete(key); };
  function push(client, snapshot, measure = true, encoded = encodedSnapshot(snapshot)) {
    if (client.res.destroyed || client.res.writableEnded || client.res.writableLength > 262144) { client.res.destroy(); return; }
    let ack = null;const trace = snapshot.trace;
    // Only changed snapshots received recently are delivery samples; expiry/heartbeats are not.
    if (measure && trace?.clockKind === 'OPPORTUNITY_ENGINE_RECEIPT' && typeof trace.id === 'string' && Number.isFinite(trace.receivedAt) && now() - trace.receivedAt >= 0 && now() - trace.receivedAt < 5000 && trace.id !== client.lastTrace) {
      ack = crypto.randomBytes(16).toString('hex');
      if (pending.size >= 2048) pending.delete(pending.keys().next().value);
      pending.set(ack, { owner: client.owner, client, receivedAt: trace.receivedAt, sentAt: now() }); client.lastTrace = trace.id;
    }
    client.res.write(`event: opportunities\ndata: ${encoded + ',"ack":' + JSON.stringify(ack) + '}'}\n\n`);
  }
  const update = snapshot => {
    const next = rowMap(snapshot);
    const delta = { ...snapshot, type: 'delta', rows: (snapshot.rows || []).filter(row => broadcastRows.get(row.id) !== next.get(row.id)), removed: [...broadcastRows.keys()].filter(id => !next.has(id)) };
    broadcastRows = next; prunePending();
    // Compute and encode the shared payload once; only the opaque ACK differs per client.
    const encoded = encodedSnapshot(delta);
    for (const client of clients) push(client, delta, true, encoded);
  };
  service.on('update', update);
  const heartbeat = setInterval(() => { for (const client of clients) { if (client.res.destroyed || client.res.writableEnded || client.res.writableLength > 262144) client.res.destroy(); else client.res.write(': keepalive\n\n'); } }, 20000); heartbeat.unref();
  async function handle(req, res, url, { ownerId } = {}) {
    if (!url.pathname.startsWith('/api/opportunities')) return false;
    const route = url.pathname;
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) { json(res, 401, { error: 'Sign in required.' }); return true; }
    if (route === '/api/opportunities' && req.method === 'GET') { json(res, 200, { ...service.snapshot(), type: 'snapshot', metrics: metrics() }); return true; }
    if (route === '/api/opportunities/stream' && req.method === 'GET') {
      if (clients.size >= 300 || [...clients].filter(c => c.owner === ownerId).length >= 4) { json(res, 429, { error: 'Too many open streams. Close another board tab.' }); return true; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' }); res.flushHeaders();
      const client = { owner: ownerId, res }; clients.add(client); res.on('close', () => { clients.delete(client); for (const [key, sample] of pending) if (sample.client === client) pending.delete(key); }); prunePending(); push(client, { ...service.snapshot(), type: 'snapshot' }, false); return true;
    }
    if (route === '/api/opportunities/ack' && req.method === 'POST') {
      if (!sameOrigin(req)) { json(res, 403, { error: 'Origin not allowed.' }); return true; }
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1024) { json(res, 413, { error: 'Too large.' }); return true; } }
      let body; try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON.' }); return true; }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.ack !== 'string' || !/^[a-f0-9]{32}$/.test(body.ack)) { json(res, 400, { error: 'Invalid acknowledgement.' }); return true; }
      const sample = pending.get(body.ack);
      if (sample?.owner === ownerId && now() - sample.sentAt >= 0 && now() - sample.sentAt <= 30000 && Number.isFinite(body.renderMs) && body.renderMs >= 0 && body.renderMs <= 10000) {
        pending.delete(body.ack); const delivery = now() - sample.receivedAt;
        if (delivery >= 0) { samples.push({ at: now(), delivery, render: body.renderMs }); if (samples.length > 2000) samples.shift(); sampleVersion++; }
      }
      json(res, 200, { ok: true }); return true;
    }
    if (route === '/api/opportunities/go' && req.method === 'GET') {
      const id = url.searchParams.get('id'), version = url.searchParams.get('v');
      let result = service.validate(id, version);
      if (!result.error) {
        let link; try { link = await links.resolve(result.row.link, url.searchParams.get('state') || 'nv'); } catch { /* Unavailable, never guess a selection. */ }
        result = service.validate(id, version); // Network lookup can outlive the price.
        const destination = !result.error && link?.url && link.type === 'outcome' && (!link.book || link.book === result.row.book) && link.selectionVerified !== false ? destinationFor(link.url, result.row.book, url.searchParams.get('state') || 'nv', 'outcome') : null;
        if (!result.error && destination?.type === 'outcome') {
          res.writeHead(302, { location: destination.appUrl || destination.url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return true;
        }
        if (!result.error) result = { status: 422, error: 'This sportsbook does not provide a verified selection link for your region. Check the selection in your sportsbook before placing a bet.' };
      }
      res.writeHead(result.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/_board/opportunities.css"><title>Price check · THE.BOARD</title><main class="op-shell"><p class="op-eyebrow">THE.BOARD · PRICE CHECK</p><h1>Review this selection.</h1><p>${esc(result.error)}</p><a class="op-action" href="/opportunities">Return to opportunities</a></main></html>`); return true;
    }
    json(res, 405, { error: 'Method or route unavailable.' }); return true;
  }
  return { handle, metrics, close() { clearInterval(heartbeat); service.off('update', update); for (const client of clients) client.res.end(); clients.clear(); pending.clear(); } };
};
