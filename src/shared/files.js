/*
 * File names and download payloads, shared by the content script (preview) and
 * the background service worker (chrome.downloads).
 */
(function (root) {
  'use strict';

  const DEFAULT_PREFIX = 'scalable';
  const DEFAULT_FOLDER = 'LibreFolio';
  const DATA_URL_PREFIX = 'data:text/csv;charset=utf-8;base64,';
  // Chrome refuses longer URLs; a larger file is saved from the page instead.
  const MAX_DATA_URL_LENGTH = 2 * 1024 * 1024 - 1024;
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

  function fileNames(prefix, stamp) {
    const start = sanitizePrefix(prefix);
    return { broker: `${start}-broker_${stamp}.csv`, deposit: `${start}-deposit_${stamp}.csv` };
  }

  function downloadPath(folder, name) {
    const directory = sanitizeFolder(folder);
    const file = cleanSegment(name, 150) || 'export.csv';
    return directory ? `${directory}/${file}` : file;
  }

  // data: URL with the UTF-8 bytes of the text, for chrome.downloads.
  function toDataUrl(content) {
    const bytes = new TextEncoder().encode(String(content));
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return `${DATA_URL_PREFIX}${btoa(binary)}`;
  }

  function fitsDataUrl(content) {
    const bytes = new TextEncoder().encode(String(content)).length;
    return DATA_URL_PREFIX.length + Math.ceil(bytes / 3) * 4 <= MAX_DATA_URL_LENGTH;
  }

  const api = {
    DEFAULT_PREFIX,
    DEFAULT_FOLDER,
    MAX_DATA_URL_LENGTH,
    sanitizePrefix,
    sanitizeFolder,
    fileNames,
    downloadPath,
    toDataUrl,
    fitsDataUrl,
  };

  root.LFX = root.LFX || {};
  root.LFX.files = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
