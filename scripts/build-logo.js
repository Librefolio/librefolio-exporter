'use strict';

// Regenerates src/content/logo.js from icons/icon-48.png. The logo is inlined as a
// data: URL because loading extension files into the page would need
// web_accessible_resources, which let any site detect the extension.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ICON = 'icons/icon-48.png';
const TARGET = 'src/content/logo.js';

function render() {
  const base64 = fs.readFileSync(path.join(ROOT, ICON)).toString('base64');
  return `/* Generated from ${ICON} by scripts/build-logo.js: do not edit. */
(function (root) {
  'use strict';
  root.LFX = root.LFX || {};
  root.LFX.logoDataUrl = 'data:image/png;base64,${base64}';
})(globalThis);
`;
}

if (require.main === module) {
  fs.writeFileSync(path.join(ROOT, TARGET), render());
  console.log(`✓ ${TARGET} regenerated from ${ICON}`);
}

module.exports = { render, TARGET };
