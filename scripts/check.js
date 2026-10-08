'use strict';

/*
 * Static checks that need no dependency:
 * - manifest and package versions match, and every referenced file exists;
 * - the locales define the same keys;
 * - every JavaScript file parses;
 * - extension code never builds HTML from strings, evaluates code or calls
 *   hosts other than the broker (same origin) and the GitHub update check.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
  } catch (error) {
    fail(`${relative}: ${error.message}`);
    return null;
  }
}

function exists(relative) {
  if (!fs.existsSync(path.join(ROOT, relative))) fail(`missing file: ${relative}`);
}

function listFiles(directory, extension) {
  const result = [];
  const absolute = path.join(ROOT, directory);
  if (!fs.existsSync(absolute)) return result;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(relative, extension));
    else if (entry.name.endsWith(extension)) result.push(relative);
  }
  return result;
}

const manifest = readJson('manifest.json');
const pkg = readJson('package.json');

if (manifest && pkg) {
  if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
  if (manifest.version !== pkg.version) fail(`version mismatch: manifest ${manifest.version}, package.json ${pkg.version}`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) fail(`manifest version must be MAJOR.MINOR.PATCH: ${manifest.version}`);
  for (const icon of Object.values(manifest.icons || {})) exists(icon);
  if (manifest.background && manifest.background.service_worker) exists(manifest.background.service_worker);
  for (const script of manifest.content_scripts || []) for (const file of script.js || []) exists(file);

  const allowedPermissions = new Set(['storage', 'downloads']);
  for (const permission of manifest.permissions || []) {
    if (!allowedPermissions.has(permission)) fail(`unexpected permission: ${permission}`);
  }
  if ((manifest.host_permissions || []).length > 0) fail('host_permissions must stay empty');
  if (manifest.web_accessible_resources) fail('web_accessible_resources must stay empty');

  const localeDirectory = path.join('_locales', manifest.default_locale || '');
  exists(path.join(localeDirectory, 'messages.json'));
  const reference = readJson(path.join(localeDirectory, 'messages.json'));
  const locales = fs
    .readdirSync(path.join(ROOT, '_locales'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const locale of locales) {
    const messages = readJson(path.join('_locales', locale, 'messages.json'));
    if (reference && messages && Object.keys(messages).sort().join() !== Object.keys(reference).sort().join()) {
      fail(`_locales/${locale} keys differ from ${manifest.default_locale}`);
    }
    if (messages && messages.extName && /scalable/i.test(messages.extName.message)) {
      fail(`_locales/${locale}: the extension name must not contain a third-party brand`);
    }
  }
}

for (const file of [...listFiles('src', '.js'), ...listFiles('scripts', '.js'), ...listFiles('tests', '.js')]) {
  try {
    new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
  } catch (error) {
    fail(`${file}: ${error.message}`);
  }
}

const logo = require('./build-logo.js');
if (fs.readFileSync(path.join(ROOT, logo.TARGET), 'utf8') !== logo.render()) {
  fail(`${logo.TARGET} is out of date: run node scripts/build-logo.js`);
}

const ALLOWED_URLS = [
  /^https:\/\/api\.github\.com\/repos\/\$\{UPDATE_REPOSITORY\}\/releases\/latest$/,
  /^https:\/\/github\.com\/\$\{UPDATE_REPOSITORY\}\//,
  /^https:\/\/github\.com\/Librefolio\/librefolio-exporter/,
  /^http:\/\/www\.w3\.org\/2000\/svg$/,
];
const FORBIDDEN = [
  [/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/, 'HTML built from strings'],
  [/\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*['"`]/, 'dynamic code evaluation'],
  [/\bimport\s*\(/, 'dynamic import'],
];
for (const file of listFiles('src', '.js')) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const [pattern, reason] of FORBIDDEN) {
    if (pattern.test(source)) fail(`${file}: ${reason}`);
  }
  for (const url of source.match(/https?:\/\/[^\s'"`)]+/g) || []) {
    if (!ALLOWED_URLS.some((allowed) => allowed.test(url))) fail(`${file}: unexpected URL ${url}`);
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`✗ ${message}`);
  process.exit(1);
}
console.log(`✓ checks passed (manifest ${manifest.version}, ${listFiles('src', '.js').length} source files)`);
