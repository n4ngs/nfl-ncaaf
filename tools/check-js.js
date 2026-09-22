'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const skip = new Set(['.git', 'node_modules', 'data', 'work', 'outputs']);
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (skip.has(e.name)) return [];
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : /\.(?:js|cjs)$/.test(e.name) ? [p] : [];
}); }
let bad = 0;
const files = walk(root);
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; process.stderr.write(path.relative(root, file) + '\n' + (r.stderr || String(r.error || 'check failed'))); }
}
console.log('JavaScript syntax: ' + (files.length - bad) + '/' + files.length + ' passed');
process.exitCode = bad ? 1 : 0;
