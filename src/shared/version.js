/*
 * Version comparison for the update check: "0.10.0" > "0.9.3" > "0.9.3-beta.1".
 */
(function (root) {
  'use strict';

  function parseVersion(text) {
    const cleaned = String(text === undefined || text === null ? '' : text).trim().replace(/^v/i, '');
    if (cleaned === '') return null;
    const dash = cleaned.indexOf('-');
    const main = dash < 0 ? cleaned : cleaned.slice(0, dash);
    const pre = dash < 0 ? '' : cleaned.slice(dash + 1);
    const numbers = main.split('.').map((part) => (/^\d+$/.test(part) ? parseInt(part, 10) : NaN));
    if (numbers.some(Number.isNaN)) return null;
    return { numbers, pre };
  }

  // -1, 0 or 1; unparsable versions compare as equal, so they never trigger a notice.
  function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return 0;
    const length = Math.max(a.numbers.length, b.numbers.length);
    for (let index = 0; index < length; index++) {
      const diff = (a.numbers[index] || 0) - (b.numbers[index] || 0);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    if (a.pre === b.pre) return 0;
    if (a.pre === '') return 1;
    if (b.pre === '') return -1;
    return a.pre < b.pre ? -1 : 1;
  }

  function isNewer(candidate, current) {
    return compareVersions(candidate, current) > 0;
  }

  const api = { parseVersion, compareVersions, isNewer };

  root.LFX = root.LFX || {};
  root.LFX.version = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
