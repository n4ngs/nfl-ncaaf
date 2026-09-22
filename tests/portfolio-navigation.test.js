'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const repo = path.join(__dirname, '..');
function cleanup(sport, search, hash = '#bets') {
  const source = fs.readFileSync(path.join(repo, sport, 'server.js'), 'utf8');
  const line = source.split('\n').find(line => line.includes("stash += '<script>try{if(location.search)"));
  assert.ok(line, 'page embeds credential cleanup');
  const context = { stash: '', URLSearchParams, location: { pathname: `/${sport}/`, search, hash }, calls: [] };
  context.history = { replaceState: (...args) => context.calls.push(args) };
  vm.runInNewContext(line, context);
  vm.runInNewContext(context.stash.replace(/^<script>|<\/script>$/g, ''), context);
  return context.calls;
}
for (const sport of ['nfl', 'ncaaf']) {
  test(`${sport}: credential cleanup preserves allowlisted portfolio mode and tab`, () => {
    for (const mode of ['new', 'mine']) {
      assert.deepEqual(cleanup(sport, `?code=example&portfolio=${mode}&key=dummy&token=fake`), [[null, '', `/${sport}/?portfolio=${mode}#bets`]]);
      assert.deepEqual(cleanup(sport, `?portfolio=${mode}`, '#tools'), [[null, '', `/${sport}/?portfolio=${mode}#tools`]]);
    }
  });
  test(`${sport}: unknown query keys and non-allowlisted modes are discarded`, () => {
    for (const query of ['?code=example', '?portfolio=admin&code=example', '?portfolio=new%26key%3Ddummy', '?next=https%3A%2F%2Fexample.com&foo=bar', '?Portfolio=new']) {
      assert.deepEqual(cleanup(sport, query), [[null, '', `/${sport}/#bets`]]);
    }
    assert.deepEqual(cleanup(sport, '?portfolio=new&portfolio=mine&key=dummy', ''), [[null, '', `/${sport}/?portfolio=new`]]);
  });
  test(`${sport}: an existing hash without query parameters is untouched`, () => {
    assert.deepEqual(cleanup(sport, '', '#bets'), []);
  });
}
function designResponse(pathname, cached = false) {
  const source = fs.readFileSync(path.join(repo, 'terminal.js'), 'utf8');
  const handler = source.slice(source.indexOf('function serveDesign('), source.indexOf('// ---- speed:'));
  const route = source.match(/  const dm = [^\n]+\n  if \(dm\) return serveDesign[^\n]+/)[0];
  const files = ['broadcast.css', 'broadcast.js', 'portfolio.css', 'portfolio.js', 'portfolio-view.js'];
  const DESIGN = Object.fromEntries(files.map(name => [name, { body: name, etag: '"test"' }]));
  const response = {};
  const context = { pathname, DESIGN, req: { headers: cached ? { 'if-none-match': '"test"' } : {} }, res: {
    writeHead(status, headers) { response.status = status; response.headers = headers; },
    end(body) { response.body = body; }
  } };
  vm.runInNewContext(handler + `\n(function(){${route}\n})();`, context);
  return response;
}
test('shared design routes serve all five explicit assets with the correct content type and cache validation', () => {
  for (const name of ['broadcast.css', 'broadcast.js', 'portfolio.css', 'portfolio.js', 'portfolio-view.js']) {
    const response = designResponse(`/_board/${name}`);
    assert.equal(response.status, 200);
    assert.equal(response.body, name);
    assert.equal(response.headers['content-type'], name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
    assert.equal(designResponse(`/_board/${name}`, true).status, 304);
  }
});
test('shared design routes reject unlisted names and path traversal instead of accessing missing assets', () => {
  for (const name of ['portfolio-view.css', 'broadcast-view.js', 'other.js', '../terminal.js', 'portfolio.js/extra', 'portfolio.js.map']) {
    assert.deepEqual(designResponse(`/_board/${name}`), {});
  }
});
