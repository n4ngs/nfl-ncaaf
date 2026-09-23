'use strict';
// Owner-scoped opt-in Web Push. Subscription endpoints and VAPID secrets never leave this service.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SPORTS = ['nfl', 'ncaaf', 'mlb', 'nhl'];
const BOOKS = ['mgm', 'dk', 'fd', 'czr', 'circa', 'pin', 'stn', 'boom', 'sp', 'wg', 'wynn'];
const DEFAULT_RULES = Object.freeze({ sports: SPORTS, books: [], minEV: 3, cooldown: 900 });
const DAY = 86400000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
function stamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  return typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
}
function atomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, file);
}
function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fail('Invalid push endpoint.');
  let u; try { u = new URL(value); } catch { throw fail('Invalid push endpoint.'); }
  if (value !== u.href || u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) throw fail('Invalid push endpoint.');
  const allowed = (u.hostname === 'fcm.googleapis.com' && /^\/(?:fcm\/send|wp)\/[A-Za-z0-9_:.-]+$/.test(u.pathname)) ||
    (u.hostname === 'updates.push.services.mozilla.com' && /^\/wpush\/v[12]\/[A-Za-z0-9_-]+$/.test(u.pathname)) ||
    (u.hostname === 'web.push.apple.com' && /^\/[A-Za-z0-9_/-]+$/.test(u.pathname));
  if (!allowed || u.search) throw fail('This browser push service is not supported.');
  return u.href;
}
function key(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw fail('Invalid subscription key.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value.replace(/=+$/, '')) throw fail('Invalid subscription key.');
  return bytes;
}
function subscription(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('A browser subscription is required.');
  const url = endpoint(input.endpoint), pub = key(input.keys?.p256dh, 65), auth = key(input.keys?.auth, 16);
  try { crypto.ECDH.convertKey(pub, 'prime256v1'); } catch { throw fail('Invalid subscription key.'); }
  const expiration = input.expirationTime == null ? now + 90 * DAY : stamp(input.expirationTime);
  if (!Number.isFinite(expiration) || expiration <= now) throw fail('The browser subscription has expired.');
  return { endpoint: url, expirationTime: Math.min(expiration, now + 90 * DAY), keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } };
}
function rules(input = {}, allowedBooks = BOOKS) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['sports', 'books', 'minEV', 'cooldown'].includes(k))) throw fail('Invalid alert rules.');
  const out = { ...clone(DEFAULT_RULES), ...input };
  for (const [name, allowed] of [['sports', SPORTS], ['books', allowedBooks]]) {
    if (!Array.isArray(out[name]) || out[name].length > allowed.length || out[name].some((v) => !allowed.includes(v))) throw fail(`Invalid ${name} filter.`);
    out[name] = [...new Set(out[name])];
  }
  if (!out.sports.length || typeof out.minEV !== 'number' || !Number.isFinite(out.minEV) || out.minEV < 0 || out.minEV > 100 || !Number.isInteger(out.cooldown) || out.cooldown < 60 || out.cooldown > 86400) throw fail('Invalid alert threshold or cooldown.');
  return out;
}
function candidate(o, now, allowedBooks = BOOKS) {
  if (!o || o.eligible !== true || typeof o.id !== 'string' || !o.id.length || o.id.length > 256 || !SPORTS.includes(o.sport) || !allowedBooks.includes(o.book) || typeof o.label !== 'string' || !o.label.trim() || o.label.length > 240 || !Number.isFinite(o.evPct) || o.evPct < 0 || o.evPct > 100 || !Number.isFinite(o.odds) || Math.abs(o.odds) < 100 || (o.line != null && !Number.isFinite(o.line))) return null;
  const expiresAt = stamp(o.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 10 * 60000) return null;
  return { id: o.id, sport: o.sport, book: o.book, label: o.label.trim(), evPct: o.evPct, odds: o.odds, line: o.line ?? null, expiresAt };
}
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) throw fail('Request too large.', 413); }
  if (!raw) return {};
  try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw fail('Invalid JSON body.'); }
}
class NotificationService {
  constructor({ dataDir, origin, subject, vapid, webPush, now = Date.now, allowedBooks = BOOKS, maxOwners = 1000, maxSubscriptions = 5000 } = {}) {
    if (!dataDir || !origin) throw new TypeError('Notification dataDir and trusted origin are required.');
    const url = new URL(origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new TypeError('A trusted HTTP origin is required.');
    this.origin = url.origin; this.now = now; this.allowedBooks = [...allowedBooks]; this.maxOwners = maxOwners; this.maxSubscriptions = maxSubscriptions;
    this.webPush = webPush || require('web-push'); this.running = false;
    fs.mkdirSync(dataDir, { recursive: true }); this.file = path.join(dataDir, 'notifications.json');
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Notification storage could not be read.'); this.state = { version: 1, owners: {} }; }
    if (this.state?.version !== 1 || !this.state.owners || typeof this.state.owners !== 'object' || Array.isArray(this.state.owners)) throw new Error('Notification storage is invalid.');
    this.vapidFile = path.join(dataDir, 'notification-vapid.json');
    if (vapid) this.vapid = { ...vapid };
    else { try { this.vapid = JSON.parse(fs.readFileSync(this.vapidFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Notification keys could not be read.'); this.vapid = this.webPush.generateVAPIDKeys(); atomic(this.vapidFile, this.vapid); } }
    if (key(this.vapid.publicKey, 65)[0] !== 4) throw new Error('Invalid notification public key.'); key(this.vapid.privateKey, 32);
    this.subject = subject || (url.protocol === 'https:' ? this.origin : 'mailto:notifications@localhost');
    if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(this.subject)) throw new TypeError('Configure an HTTPS or mailto VAPID subject.');
    this.prune();
  }
  owner(ownerId, create = false) {
    if (typeof ownerId !== 'string' || !ownerId.length || ownerId.length > 256) throw fail('Sign in to manage alerts.', 401);
    const id = hash(ownerId);
    if (!this.state.owners[id] && create) {
      if (Object.keys(this.state.owners).length >= this.maxOwners) throw fail('Alert capacity reached.', 503);
      this.state.owners[id] = { enabled: false, rules: clone(DEFAULT_RULES), subscriptions: {}, sent: {}, nextAt: 0, touchedAt: this.now(), mutations: [] };
    }
    return this.state.owners[id] || null;
  }
  save() { atomic(this.file, this.state); }
  prune() {
    const now = this.now();
    for (const [id, o] of Object.entries(this.state.owners)) {
      if (!o || typeof o !== 'object' || !o.subscriptions || !o.sent) throw new Error('Notification storage is invalid.');
      rules(o.rules, this.allowedBooks);
      for (const [sid, s] of Object.entries(o.subscriptions)) if (!(s.subscription?.expirationTime > now)) delete o.subscriptions[sid];
      if (!Object.keys(o.subscriptions).length) o.enabled = false;
      for (const [key, at] of Object.entries(o.sent)) if (!Number.isFinite(at) || at < now - DAY) delete o.sent[key];
      if (!Object.keys(o.subscriptions).length && o.touchedAt < now - 90 * DAY) delete this.state.owners[id];
    }
  }
  view(ownerId) {
    this.prune(); const o = this.owner(ownerId);
    return { enabled: !!o?.enabled, rules: clone(o?.rules || DEFAULT_RULES), subscriptions: Object.entries(o?.subscriptions || {}).map(([id, s]) => ({ id, createdAt: s.createdAt, expiresAt: s.subscription.expirationTime })), publicKey: this.vapid.publicKey, supportedBooks: this.allowedBooks, supportedSports: SPORTS };
  }
  mutate(ownerId, method, input) {
    this.prune(); const now = this.now(), o = this.owner(ownerId, true);
    o.mutations = (o.mutations || []).filter((at) => at > now - 60000);
    if (o.mutations.length >= 20) throw fail('Too many alert changes. Try again shortly.', 429);
    // Validate before changing any owner state.
    if (method === 'POST') {
      const sub = subscription(input.subscription, now), sid = hash(sub.endpoint), nextRules = rules(input.rules || o.rules, this.allowedBooks);
      for (const [id, other] of Object.entries(this.state.owners)) if (id !== hash(ownerId) && other.subscriptions[sid]) throw fail('This browser subscription belongs to another sign-in. Disable it there first.', 409);
      if (!o.subscriptions[sid] && (Object.keys(o.subscriptions).length >= 5 || Object.values(this.state.owners).reduce((n, x) => n + Object.keys(x.subscriptions).length, 0) >= this.maxSubscriptions)) throw fail('Subscription limit reached.', 409);
      o.subscriptions[sid] = { subscription: sub, createdAt: o.subscriptions[sid]?.createdAt || now, retryAt: 0 };
      o.rules = nextRules; o.enabled = true;
    } else if (method === 'PATCH') {
      const nextRules = rules(input.rules || o.rules, this.allowedBooks);
      if ('enabled' in input && typeof input.enabled !== 'boolean') throw fail('Invalid enabled flag.');
      if (input.enabled === true && !Object.keys(o.subscriptions).length) throw fail('Enable alerts from a subscribed browser first.');
      o.rules = nextRules; if ('enabled' in input) o.enabled = input.enabled;
    } else if (method === 'DELETE') {
      if (input.id != null && (typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id))) throw fail('Invalid subscription ID.');
      if (input.id) delete o.subscriptions[input.id]; else o.subscriptions = {};
      if (!Object.keys(o.subscriptions).length) o.enabled = false;
    } else throw fail('Method not allowed.', 405);
    o.mutations.push(now); o.touchedAt = now; this.save(); return this.view(ownerId);
  }
  async handle(req, res, { ownerId } = {}) {
    const respond = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      this.owner(ownerId);
      if (req.method === 'GET') { respond(200, this.view(ownerId)); return; }
      if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) throw fail('Method not allowed.', 405);
      if (req.headers.origin !== this.origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) throw fail('Same-origin request required.', 403);
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail('JSON content type required.', 415);
      respond(200, this.mutate(ownerId, req.method, await body(req)));
    } catch (e) { respond(e.status || 500, { error: e.status ? e.message : 'Alert settings are unavailable.' }); }
  }
  async publish(opportunities) {
    if (this.running) return { busy: true, sent: 0 };
    if (!Array.isArray(opportunities)) return { sent: 0 };
    this.running = true; let sent = 0;
    try {
      this.prune();
      const candidates = opportunities.slice(0, 1000).map((o) => candidate(o, this.now(), this.allowedBooks)).filter(Boolean).sort((a, b) => b.evPct - a.evPct);
      for (const o of Object.values(this.state.owners)) {
        const now = this.now();
        if (!o.enabled || o.nextAt > now || Object.keys(o.sent).length >= 500) continue;
        const chosen = candidates.find((c) => c.expiresAt > now && o.rules.sports.includes(c.sport) && (!o.rules.books.length || o.rules.books.includes(c.book)) && c.evPct >= o.rules.minEV && !o.sent[hash(c.id)]);
        const targets = Object.entries(o.subscriptions).filter(([, s]) => s.subscription.expirationTime > now && !(s.retryAt > now));
        if (!chosen || !targets.length) continue;
        // Durable claim before sending: a concurrent tick or restart cannot send this opportunity twice.
        o.sent[hash(chosen.id)] = now; o.nextAt = now + o.rules.cooldown * 1000; this.save();
        for (const [id, s] of targets) {
          if (!o.enabled || o.subscriptions[id] !== s || chosen.expiresAt <= this.now()) continue;
          try {
            // Revalidate disk-restored endpoints before any network request.
            const sub = subscription(s.subscription, this.now());
            const ttl = Math.max(1, Math.min(120, Math.floor((chosen.expiresAt - this.now()) / 1000)));
            const payload = { kind: 'board-opportunity', id: chosen.id, title: `${chosen.sport.toUpperCase()} · ${chosen.book.toUpperCase()}`,
              body: `${chosen.label} · ${chosen.odds > 0 ? '+' : ''}${chosen.odds} · est. ${Math.round(chosen.evPct * 10) / 10}% EV`,
              expiresAt: chosen.expiresAt, url: `/opportunities?opportunity=${encodeURIComponent(chosen.id)}` };
            await this.webPush.sendNotification(sub, JSON.stringify(payload), { vapidDetails: { subject: this.subject, ...this.vapid }, TTL: ttl, timeout: 5000, urgency: 'normal', topic: hash(chosen.id).slice(0, 32) });
            sent++;
          } catch (e) { if (e.statusCode === 404 || e.statusCode === 410) delete o.subscriptions[id]; else s.retryAt = this.now() + 15 * 60000; }
        }
        this.save();
      }
      return { sent };
    } finally { this.running = false; }
  }
}
module.exports = { NotificationService, validateEndpoint: endpoint, validateSubscription: subscription, validateRules: rules, eligibleOpportunity: candidate };
