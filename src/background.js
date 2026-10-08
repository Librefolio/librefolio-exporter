/*
 * Background service worker: checks GitHub for a newer release, at most once a
 * day and only while the user keeps the check enabled. The request carries no
 * personal or financial data.
 */
'use strict';

importScripts('shared/version.js');

const UPDATE_REPOSITORY = 'Librefolio/librefolio-exporter';
const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${UPDATE_REPOSITORY}/releases/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

async function fetchLatestRelease() {
  const response = await fetch(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const release = await response.json();
  if (!release || typeof release.tag_name !== 'string') return null;
  const url =
    typeof release.html_url === 'string' && release.html_url.startsWith(`https://github.com/${UPDATE_REPOSITORY}/`)
      ? release.html_url
      : RELEASES_PAGE;
  return { latest: release.tag_name.replace(/^v/i, ''), url };
}

async function updateStatus() {
  const current = chrome.runtime.getManifest().version;
  const stored = await chrome.storage.local.get({ updateCheckEnabled: true, updateCache: null });
  if (stored.updateCheckEnabled === false) return { enabled: false, current, available: false };

  let cache = stored.updateCache;
  const now = Date.now();
  if (!cache || typeof cache.nextCheckAt !== 'number' || now >= cache.nextCheckAt) {
    let release = null;
    try {
      release = await fetchLatestRelease();
    } catch (error) {
      release = null;
    }
    cache = release
      ? { latest: release.latest, url: release.url, nextCheckAt: now + CHECK_INTERVAL_MS }
      : { latest: cache && cache.latest, url: (cache && cache.url) || RELEASES_PAGE, nextCheckAt: now + RETRY_AFTER_FAILURE_MS };
    await chrome.storage.local.set({ updateCache: cache });
  }

  const available = Boolean(cache.latest) && self.LFX.version.isNewer(cache.latest, current);
  return { enabled: true, current, latest: cache.latest || null, available, url: cache.url || RELEASES_PAGE };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || sender.id !== chrome.runtime.id) return false;
  if (message.type === 'lfx:update-status') {
    updateStatus().then(sendResponse, () => sendResponse({ enabled: true, available: false }));
    return true;
  }
  return false;
});
