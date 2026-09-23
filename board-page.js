/* Owner-only Admin Center. Assets are inlined here and never publicly routed. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, 'design', name), 'utf8');
const template = read('admin-center.html');
const stylesheet = read('admin-center.css');
const script = read('admin-center.js');
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const scriptJSON = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
module.exports = function page({ brand, logo, ownerName, sports, adminPath }) {
  if (typeof adminPath !== 'string' || !/^\/[a-z0-9][a-z0-9-]{23,79}$/.test(adminPath)) throw new Error('Invalid private admin path');
  const values = {
    BRAND: esc(brand), LOGO: logo, CSS: stylesheet, ADMIN: adminPath,
    SPORT_OPTIONS: sports.map(([key, label]) => '<option value="' + esc(key) + '">' + esc(label) + '</option>').join(''),
    OWNER_JSON: scriptJSON(ownerName || ''), SPORT_JSON: scriptJSON(Object.fromEntries(sports)),
  };
  values.SCRIPT = script.replace(/__(ADMIN|OWNER_JSON|SPORT_JSON)__/g, (_, key) => values[key]);
  return template.replace(/__(BRAND|LOGO|CSS|ADMIN|SPORT_OPTIONS|SCRIPT)__/g, (_, key) => values[key]);
};
