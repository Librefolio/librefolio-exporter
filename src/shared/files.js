/*
 * File names and download payloads, shared by the content script (preview) and
 * the background service worker (chrome.downloads).
 */
(function (root) {
  'use strict';

  const DEFAULT_PREFIX = 'scalable';
  const CSV_DATA_URL_PREFIX = 'data:text/csv;charset=utf-8;base64,';
  const ZIP_DATA_URL_PREFIX = 'data:application/zip;base64,';
  // Chrome refuses longer URLs; a larger file is saved from the page instead.
  const MAX_DATA_URL_LENGTH = 2 * 1024 * 1024 - 1024;
  const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
  const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

  function cleanSegment(text, maxLength) {
    return String(text === undefined || text === null ? '' : text)
      .replace(FORBIDDEN, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .replace(/[. ]+$/, '')
      .slice(0, maxLength);
  }

  function sanitizePrefix(text) {
    return cleanSegment(text, 60) || DEFAULT_PREFIX;
  }

  // Folder inside the browser's download directory; '' means the directory itself.
  function sanitizeFolder(text) {
    return String(text === undefined || text === null ? '' : text)
      .split(/[\\/]+/)
      .map((part) => cleanSegment(part, 60))
      .filter((part) => part !== '')
      .slice(0, 5)
      .join('/');
  }

  // One CSV per account; both accounts together are saved as one ZIP holding the two CSVs.
  function fileNames(prefix, stamp) {
    const start = sanitizePrefix(prefix);
    return { broker: `${start}-broker_${stamp}.csv`, deposit: `${start}-deposit_${stamp}.csv`, archive: `${start}_${stamp}.zip` };
  }

  function downloadPath(folder, name) {
    const directory = sanitizeFolder(folder);
    const file = cleanSegment(name, 150) || 'export.csv';
    return directory ? `${directory}/${file}` : file;
  }

  function base64(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  // data: URLs for chrome.downloads: the UTF-8 bytes of a CSV text, or the bytes of a ZIP.
  function toDataUrl(content) {
    return `${CSV_DATA_URL_PREFIX}${base64(new TextEncoder().encode(String(content)))}`;
  }

  function zipDataUrl(bytes) {
    return `${ZIP_DATA_URL_PREFIX}${base64(bytes)}`;
  }

  // The only URLs the extension downloads: data URLs built here, short enough for Chrome.
  function isDownloadUrl(url) {
    if (typeof url !== 'string' || url.length > MAX_DATA_URL_LENGTH) return false;
    const prefix = [CSV_DATA_URL_PREFIX, ZIP_DATA_URL_PREFIX].find((candidate) => url.startsWith(candidate));
    return Boolean(prefix) && BASE64.test(url.slice(prefix.length));
  }

  const api = {
    DEFAULT_PREFIX,
    MAX_DATA_URL_LENGTH,
    sanitizePrefix,
    sanitizeFolder,
    fileNames,
    downloadPath,
    toDataUrl,
    zipDataUrl,
    isDownloadUrl,
  };

  root.LFX = root.LFX || {};
  root.LFX.files = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
