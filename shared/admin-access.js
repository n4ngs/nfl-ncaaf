'use strict';
// A private URL reduces discovery; every request still requires owner authentication.
function adminPath(value) {
  const route = String(value || '').trim();
  if (!route) return ''; // Missing configuration disables the Admin entrance.
  if (!/^\/[a-z0-9][a-z0-9-]{23,79}$/.test(route)) throw new Error('ADMIN_PATH must be a long, single-segment lowercase path.');
  return route;
}
function isSameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return site === 'same-origin';
  const proto = req.socket?.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https:' : 'http:';
  try {
    const target = new URL(proto + '//' + req.headers.host);
    const source = new URL(origin);
    return source.origin === target.origin && source.origin !== 'null' && source.href === source.origin + '/';
  } catch { return false; }
}
module.exports = { adminPath, isSameOrigin };
