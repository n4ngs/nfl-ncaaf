'use strict';
const net = require('node:net');
const crypto = require('node:crypto');

const ADDRESS_HEADER = 'x-board-client-address';
const SIGNATURE_HEADER = 'x-board-client-signature';
const SIGNING_CONTEXT = 'the.board/client-ip/v1\0';
const SOURCES = new Set(['railway-x-real-ip', 'railway-x-forwarded-for', 'socket', 'unavailable']);

// Only address literals are accepted: no lists, hostnames, ports, zone IDs or object keys.
function normalizeIp(value) {
  if (typeof value !== 'string') return '';
  const ip = value.trim();
  if (!ip || ip.length > 45 || ip.includes('%') || !net.isIP(ip)) return '';
  if (net.isIP(ip) === 4) return ip;
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
}

function ipv6Number(ip) {
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = left.concat(Array(8 - left.length - right.length).fill('0'), right);
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
}
// IANA special-purpose registries, checked 2026-09-22. Deliberately separate from proxy trust.
// https://www.iana.org/assignments/iana-ipv6-special-registry
// https://www.iana.org/assignments/iana-ipv4-special-registry
const NON_PUBLIC_V6 = [
  ['::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['100:0:0:1::', 64],
  ['2001:2::', 48], ['2001:db8::', 32], ['3fff::', 20], ['5f00::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
].map(([prefix, bits]) => { const shift = BigInt(128 - bits); return { value: ipv6Number(prefix) >> shift, shift }; });

// "private" also covers known non-public special-use addresses. This is a display classification,
// not a guarantee of routability or a proxy allowlist. Do not blanket-block 2001::/23: it includes
// public anycast assignments and transition mechanisms with conditional reachability.
function addressKind(ip) {
  if (!ip) return 'unavailable';
  if (net.isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 127) return 'loopback';
    if (ip === '192.0.0.9' || ip === '192.0.0.10') return 'public';
    if (a === 0 || a === 10 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || ip === '192.88.99.2' || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)) return 'private';
    return 'public';
  }
  if (ip === '::1') return 'loopback';
  const value = ipv6Number(ip);
  return NON_PUBLIC_V6.some((prefix) => (value >> prefix.shift) === prefix.value) ? 'private' : 'public';
}

function oneHeader(req, name) {
  const headers = req.headers || {};
  const value = headers[name];
  let count = 0;
  for (let i = 0; i < (req.rawHeaders || []).length; i += 2) {
    if (String(req.rawHeaders[i]).toLowerCase() === name) count++;
  }
  const present = value !== undefined || count > 0;
  return { present, value: count > 1 || typeof value !== 'string' ? '' : value.trim() };
}

function railwayEnvironment(env) {
  return ['RAILWAY_SERVICE_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_PROJECT_ID'].some((name) =>
    typeof env[name] === 'string' && env[name].trim().length > 0);
}

function signature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(SIGNING_CONTEXT).update(payload).digest('hex');
}

function internalAddress(req, secret, peer) {
  if (addressKind(peer) !== 'loopback' || typeof secret !== 'string' || !secret) return null;
  const payload = oneHeader(req, ADDRESS_HEADER).value;
  const sig = oneHeader(req, SIGNATURE_HEADER).value;
  if (!payload || payload.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[a-f0-9]{64}$/.test(sig)) return null;
  const expected = signature(payload, secret);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const ip = normalizeIp(data.ip);
    if (data.v !== 1 || typeof data.ip !== 'string' || data.ip !== ip || !SOURCES.has(data.source)
      || data.kind !== addressKind(ip) || ((!ip) !== (data.source === 'unavailable'))
      || (data.reason !== undefined && !/^[A-Z_]{1,80}$/.test(data.reason))) return null;
    return { ip, source: data.source, kind: data.kind, ...(data.reason ? { reason: data.reason } : {}), via: 'terminal' };
  } catch { return null; }
}

/**
 * direct: socket only. railway: the platform's documented X-Real-IP, then its rightmost XFF hop.
 * internal: only loopback + a valid terminal signature; unsigned requests fall back to the socket.
 * Railway mode is a deployment trust decision, never enabled by a request header or a private IP.
 */
function resolveClientIp(req, options = {}) {
  const env = options.env || process.env;
  const mode = options.mode || (railwayEnvironment(env) ? 'railway' : 'direct');
  const peer = normalizeIp(req.socket?.remoteAddress);
  const fallback = (reason) => ({ ip: peer, source: peer ? 'socket' : 'unavailable', kind: addressKind(peer), ...(reason ? { reason } : {}) });
  if (mode === 'internal') {
    return internalAddress(req, options.secret, peer) || fallback('INTERNAL_ADDRESS_UNVERIFIED');
  }
  const real = oneHeader(req, 'x-real-ip');
  const forwarded = oneHeader(req, 'x-forwarded-for');
  if (mode !== 'railway') return fallback(real.present || forwarded.present ? 'FORWARDED_HEADERS_IGNORED' : undefined);
  const realIp = normalizeIp(real.value);
  if (realIp) return { ip: realIp, source: 'railway-x-real-ip', kind: addressKind(realIp) };
  // Never skip an invalid final token to select a client-controlled earlier one.
  const last = forwarded.value.split(',').at(-1);
  const forwardedIp = normalizeIp(last);
  if (forwardedIp) return { ip: forwardedIp, source: 'railway-x-forwarded-for', kind: addressKind(forwardedIp), ...(real.present ? { reason: 'REAL_IP_INVALID' } : {}) };
  return fallback(real.present || forwarded.present ? 'FORWARDED_ADDRESS_INVALID' : 'FORWARDED_ADDRESS_MISSING');
}

function clientIp(req, options) { return resolveClientIp(req, options).ip; }

// Return a full replacement header object, not an overlay: incoming internal headers must disappear.
// XFF and X-Real-IP are canonicalized too, so downstream code cannot accidentally reuse spoofed prefixes.
function forwardClientIpHeaders(req, secret, options) {
  if (typeof secret !== 'string' || !secret) throw new Error('Internal address signing requires a peer secret');
  const headers = {};
  for (const [name, value] of Object.entries(req.headers || {})) {
    const key = name.toLowerCase();
    if (key.startsWith('x-board-') || key === 'x-forwarded-for' || key === 'x-real-ip' || key === 'forwarded') continue;
    headers[key] = value;
  }
  const address = resolveClientIp(req, options);
  const payload = Buffer.from(JSON.stringify({ v: 1, ...address })).toString('base64url');
  headers[ADDRESS_HEADER] = payload;
  headers[SIGNATURE_HEADER] = signature(payload, secret);
  if (address.ip) {
    headers['x-forwarded-for'] = address.ip;
    headers['x-real-ip'] = address.ip;
  }
  return headers;
}

module.exports = { resolveClientIp, clientIp, forwardClientIpHeaders, normalizeIp };
