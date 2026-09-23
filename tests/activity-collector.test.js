'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../design/activity.js'), 'utf8');

function browser({ pathname = '/nfl/', hash = '#live', visible = true, reject = false } = {}) {
  const listeners = {}, requests = [], timers = new Map(); let timer = 0, now = 1700000000000;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const document = { visibilityState: visible ? 'visible' : 'hidden', addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); } };
  const location = { pathname, hash, search: '?code=SECRET', href: 'https://board.example' + pathname + '?code=SECRET' + hash };
  const context = { document, location, Date: Clock, Set, Uint32Array, Array, Number, String, Math, Intl,
    innerWidth: 390, innerHeight: 844, screen: { width: 390, height: 844 }, devicePixelRatio: 3,
    navigator: { languages: ['en-US'], maxTouchPoints: 5, standalone: false }, matchMedia: () => ({ matches: false }),
    crypto: { getRandomValues: values => { values.set([1, 23, 4567890]); return values; } },
    Blob: class { constructor(parts) { this.text = parts.join(''); } },
    fetch: (url, options) => { requests.push({ url, options, payload: JSON.parse(options.body) }); return reject ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: true }); },
    setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: id => timers.delete(id),
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
  };
  context.window = context;
  context.navigator.sendBeacon = (url, blob) => { requests.push({ url, payload: JSON.parse(blob.text), beacon: true }); return true; };
  vm.runInNewContext(source, context);
  return { context, requests, timers, emit(name, event = {}) { for (const fn of listeners[name] || []) fn(event); },
    advance(ms) { now += ms; }, flush() { context.tel?.flush(); }, events() { return requests.flatMap(r => r.payload.events); } };
}
function element(attrs = {}, tagName = 'BUTTON') {
  return { tagName, id: attrs.id || '', textContent: 'PRIVATE DOM TEXT', value: 'PRIVATE INPUT',
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
    matches(selector) { return selector.split(',').some(s => s.startsWith('#') ? this.id === s.slice(1) : s.startsWith('[') ? Object.hasOwn(attrs, s.slice(1, -1)) : tagName.toLowerCase() === s); },
    closest(selector) { return this.matches(selector) ? this : null; } };
}

test('all four sport pages load the shared collector exactly once, including NHL', () => {
  for (const sport of ['nfl', 'ncaaf', 'mlb', 'nhl']) {
    const html = fs.readFileSync(path.join(__dirname, '..', sport, 'public/index.html'), 'utf8');
    assert.equal(html.match(/src="\/_board\/activity\.js"/g)?.length, 1, sport);
    assert.doesNotMatch(html, /src="js\/tel\.js"/);
  }
});
test('uses only an allowlisted sport endpoint and preserves background-open provenance', () => {
  for (const sport of ['nfl', 'ncaaf', 'mlb', 'nhl']) {
    const b = browser({ pathname: `/${sport}/`, hash: '', visible: false }); b.flush();
    assert.equal(b.requests[0].url, `/${sport}/api/telemetry`);
    assert.equal(b.events()[0].data.ctx.visible, false);
    assert.equal(b.events()[1].route, sport === 'nhl' ? 'board' : 'live');
    assert.match(b.events()[0].vid, /^v_[a-z0-9_-]{8,48}$/i);
  }
  for (const pathname of ['/owner-private-1234567890123456', '/nfl/api/private', '/unknown/']) {
    const b = browser({ pathname }); assert.equal(b.context.tel, undefined); assert.equal(b.requests.length, 0);
  }
});
test('private text, input values, links, referrers, raw errors and arbitrary API data never enter payloads', () => {
  const b = browser();
  b.emit('click', { target: element({ href: 'https://outside.example/private?token=SECRET' }, 'A') });
  b.emit('click', { target: element({ 'data-tel': 'PRIVATE DOM TEXT' }) });
  b.emit('click', { target: element({ 'data-tab': 'admin' }, 'A') });
  b.emit('click', { target: element({ 'data-tab': 'tools' }, 'A') });
  b.context.tel.act('arbitrary secret', { token: 'SECRET' });
  b.context.tel.click('PRIVATE DOM TEXT', { href: 'SECRET' });
  b.context.tel.click('OPEN_TICKET', { href: 'SECRET', label: 'SECRET' });
  b.context.tel.view('/owner-private-1234567890123456?code=SECRET');
  b.emit('error', { message: 'SECRET ERROR' }); b.emit('unhandledrejection', { reason: 'SECRET' });
  b.flush();
  const payload = JSON.stringify(b.requests);
  assert.doesNotMatch(payload, /SECRET|PRIVATE|outside\.example|owner-private|admin|referrer/);
  assert.equal(b.events().filter(e => e.kind === 'client_error').length, 1);
  assert.deepEqual(b.events().filter(e => e.kind === 'click').map(e => e.data.label), ['tab:tools', 'OPEN_TICKET']);
  assert.deepEqual(Object.keys(b.events().find(e => e.data?.label === 'OPEN_TICKET').data), ['label']);
});
test('deduplicates same views while preserving return visits and sanitizes game deep links', () => {
  const b = browser(); b.context.tel.view('live'); b.emit('hashchange');
  b.context.tel.view('board'); b.context.tel.view('board'); b.context.tel.view('live');
  b.context.location.hash = '#game/123456'; b.emit('hashchange'); b.flush();
  assert.deepEqual(b.events().filter(e => e.kind === 'page_view').map(e => e.route), ['live', 'board', 'live', 'game']);
  assert.doesNotMatch(JSON.stringify(b.requests), /123456/);
});
test('NHL local tabs, game room, replay and ticket controls produce generic semantic events', () => {
  const b = browser({ pathname: '/nhl/', hash: '#board' });
  for (const [attrs, tag] of [[{ href: '#live' }, 'A'], [{ 'data-game': 'SECRET_GAME' }], [{ 'data-room-tab': 'replays' }], [{ 'data-replay': 'https://private.example/SECRET' }], [{ 'data-ticket': 'SECRET_TICKET' }]]) b.emit('click', { target: element(attrs, tag) });
  b.flush();
  assert.deepEqual(b.events().filter(e => e.kind === 'click').map(e => e.data.label), ['tab:live', 'OPEN_GAME', 'OPEN_REPLAYS', 'PLAY_REPLAY', 'OPEN_TICKET']);
  assert.doesNotMatch(JSON.stringify(b.requests), /SECRET|private\.example/);
});
test('batches and event rate remain bounded, failed sends are dropped without retry', async () => {
  const b = browser({ reject: true });
  for (let i = 0; i < 500; i++) b.context.tel.click('OPEN_GAME');
  b.flush(); await Promise.resolve();
  assert.equal(b.events().length, 120);
  assert.ok(b.requests.every(r => r.payload.events.length <= 20));
  assert.ok(b.requests.every(r => r.options.credentials === 'same-origin'));
  const sent = b.requests.length; b.flush(); assert.equal(b.requests.length, sent);
  b.advance(60001); b.context.tel.act('ONLINE'); b.flush(); assert.equal(b.events().length, 121);
});
test('errors and rejections share one generic signal per minute and never retry failed sends', async () => {
  const b = browser({ reject: true });
  const secret = { get message() { throw new Error('must not read error details'); }, stack: 'PRIVATE STACK', url: 'https://secret.example/?token=SECRET' };
  b.emit('error', { error: secret, message: 'PRIVATE MESSAGE', filename: 'https://secret.example/SECRET.js' });
  b.emit('unhandledrejection', { reason: secret });
  b.advance(59999); b.emit('error', { target: { src: 'https://secret.example/SECRET.png' } });
  b.flush(); await Promise.resolve();
  assert.equal(b.events().filter(e => e.kind === 'client_error').length, 1);
  const before = b.requests.length; b.flush(); assert.equal(b.requests.length, before);
  b.advance(1); b.emit('unhandledrejection', { reason: secret }); b.flush(); await Promise.resolve();
  const errors = b.events().filter(e => e.kind === 'client_error');
  assert.equal(errors.length, 2);
  assert.ok(errors.every(e => !Object.hasOwn(e, 'data')));
  assert.doesNotMatch(JSON.stringify(b.requests), /PRIVATE|SECRET|secret\.example|message|stack|filename/);
  const capped = browser(); for (let i = 0; i < 118; i++) capped.context.tel.click('OPEN_GAME');
  capped.emit('error', { error: secret }); capped.flush();
  assert.equal(capped.events().length, 120, 'generic errors also obey the normal event budget');
});
test('foreground/background and page exits use only fixed actions and can flush by beacon', () => {
  const b = browser(); b.context.document.visibilityState = 'hidden'; b.emit('visibilitychange');
  b.context.document.visibilityState = 'visible'; b.emit('visibilitychange'); b.emit('pagehide');
  assert.deepEqual(b.events().filter(e => e.kind === 'app_action').map(e => e.data.action), ['APP_BACKGROUND', 'APP_FOREGROUND', 'PAGE_EXIT']);
  assert.ok(b.requests.some(r => r.beacon));
});
