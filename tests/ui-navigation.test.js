'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
for (const sport of ['nfl', 'ncaaf']) {
  test(`${sport}: feed updates preserve focused filter choices without replacing unchanged controls`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', sport, 'public/js/views.js'), 'utf8');
    const code = source.slice(source.indexOf('function syncBoardChoices'), source.indexOf('function renderBoard'));
    const old = { dataset: { filter: 'SEC' } }, replacement = { dataset: { filter: 'SEC' }, focus() { active = this; } };
    const summary = { focus() { active = this; } };
    let active = old, replacements = 0, choices = [replacement];
    const root = { dataset: {}, contains: node => node === old || choices.includes(node),
      set innerHTML(value) { replacements++; }, querySelectorAll: () => choices,
      closest: () => ({ querySelector: () => summary }) };
    const context = { $: () => root, document: { get activeElement() { return active; } } };
    vm.createContext(context); vm.runInContext(code, context);
    context.syncBoardChoices('#filters', 'first markup', 'filter');
    assert.equal(active, replacement); assert.equal(replacements, 1);
    context.syncBoardChoices('#filters', 'first markup', 'filter');
    assert.equal(replacements, 1);
    choices = []; active = old;
    context.syncBoardChoices('#filters', 'updated markup', 'filter');
    assert.equal(active, summary); assert.equal(replacements, 2);
  });
  test(`${sport}: navigation updates every tab and announces only the selected page`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', sport, 'public/js/boot.js'), 'utf8');
    const code = source.slice(source.indexOf('const TABS'), source.indexOf('// A tab hash'));
    function element(dataset, classes = []) {
      const values = new Set(classes), attrs = new Map();
      return { dataset, attrs, classList: { contains: x => values.has(x), toggle(x, on) { on ? values.add(x) : values.delete(x); } },
        setAttribute(k, v) { attrs.set(k, v); }, removeAttribute(k) { attrs.delete(k); }, hasClass: x => values.has(x) };
    }
    const tabs = ['live', 'board', 'bets', 'tools', 'admin'];
    const views = tabs.map(view => element({ view }));
    const links = [...tabs, ...tabs].map(tab => element({ tab }));
    const brand = element({ tab: 'live' }, ['brand']); links.push(brand);
    const S = { me: { role: 'guest', shared: true }, def: 'week-4' }, stored = new Map();
    let renders = 0;
    const context = { S, $: () => links[0], $$: s => s === '.view' ? views : links,
      store: { set: (k, v) => stored.set(k, v) }, location: { hash: '#live' }, history: { replaceState() {} },
      window: { scrollTo() {} }, renderAll() { renders++; } };
    vm.createContext(context); vm.runInContext(code + '\nthis.navigate = setTab;', context);
    context.navigate('board');
    assert.equal(S.boardWeek, 'week-4'); assert.equal(S.tab, 'board'); assert.equal(stored.get('lastTab'), 'board');
    assert.equal(views.filter(v => v.hasClass('on')).length, 1);
    assert.equal(links.filter(a => a.attrs.get('aria-current') === 'page').length, 2);
    assert.ok(links.filter(a => a.dataset.tab === 'board').every(a => a.hasClass('on')));
    context.navigate('bets');
    assert.ok(links.filter(a => a.dataset.tab === 'board').every(a => !a.attrs.has('aria-current')));
    assert.ok(links.filter(a => a.dataset.tab === 'bets').every(a => a.attrs.get('aria-current') === 'page'));
    context.navigate('admin');
    assert.equal(S.tab, 'live'); assert.equal(brand.attrs.has('aria-current'), false); assert.equal(brand.hasClass('on'), false);
    assert.equal(renders, 3);
  });
}
