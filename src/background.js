/*
 * Background service worker:
 * - saves the CSV files with chrome.downloads (a folder inside Downloads, or
 *   Chrome's "Save as" window when the user asks for it);
 * - remembers, in memory until the browser closes, the portfolio and overnight
 *   account seen on the pages, and the recipe of the overnight account's transaction
 *   list read from its page, so that both can be exported from any page of the web app;
 * - checks GitHub for a newer release: when the panel opens, at most once a day,
 *   and when the user presses the button. That request carries no personal data.
 */
'use strict';

importScripts('shared/version.js', 'shared/files.js');

const UPDATE_REPOSITORY = 'Librefolio/librefolio-exporter';
const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${UPDATE_REPOSITORY}/releases/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
// A button pressed again right away gets the answer just received.
const MIN_FORCED_INTERVAL_MS = 10 * 1000;
const MAX_FILES = 4;
const REMEMBERED_KEY = 'rememberedIds';
// Persistent, per person: the portfolio and overnight accounts seen on the pages, so that
// an export works from any page after an extension reload or a browser restart. The
// person is stored as a SHA-256 fingerprint of their id, never as the id itself.
const KNOWN_ACCOUNTS_KEY = 'knownAccounts';
const MAX_KNOWN_PEOPLE = 3;
const NAME_TIMEOUT_MS = 60 * 1000;
const MAX_SAVINGS_ACCOUNTS = 5;
const MAX_RECIPE_QUERY = 8000;
const MAX_RECIPE_VARIABLES = 2000;
const ID_PATTERN = /^[A-Za-z0-9_.:=+-]{6,128}$/;

// { latest, url }; latest is null while no release is published. Throws when GitHub cannot answer.
async function fetchLatestRelease() {
  const response = await fetch(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    cache: 'no-store',
  });
  if (response.status === 404) return { latest: null, url: RELEASES_PAGE };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const release = await response.json();
  if (!release || typeof release.tag_name !== 'string') throw new Error('unexpected answer');
  const url =
    typeof release.html_url === 'string' && release.html_url.startsWith(`https://github.com/${UPDATE_REPOSITORY}/`)
      ? release.html_url
      : RELEASES_PAGE;
  return { latest: release.tag_name.replace(/^v/i, ''), url };
}

async function updateStatus(force) {
  const current = chrome.runtime.getManifest().version;
  const stored = await chrome.storage.local.get({ updateCache: null });
  let cache = stored.updateCache;
  const now = Date.now();
  const stale = !cache || typeof cache.nextCheckAt !== 'number' || now >= cache.nextCheckAt;
  const recent = cache && typeof cache.checkedAt === 'number' && now - cache.checkedAt < MIN_FORCED_INTERVAL_MS;
  if (stale || (force && !recent)) {
    let release = null;
    try {
      release = await fetchLatestRelease();
    } catch (error) {
      release = null;
    }
    cache = release
      ? { ok: true, latest: release.latest, url: release.url, checkedAt: now, nextCheckAt: now + CHECK_INTERVAL_MS }
      : {
          ok: false,
          latest: (cache && cache.latest) || null,
          url: (cache && cache.url) || RELEASES_PAGE,
          checkedAt: now,
          nextCheckAt: now + RETRY_AFTER_FAILURE_MS,
        };
    await chrome.storage.local.set({ updateCache: cache });
  }

  const available = Boolean(cache.latest) && self.LFX.version.isNewer(cache.latest, current);
  return { ok: cache.ok !== false || available, current, latest: cache.latest || null, available, url: cache.url || RELEASES_PAGE };
}

// Names of the files this extension is saving, by data URL, until Chrome asks for them.
const pendingNames = new Map();

// Another extension that names downloads can override the name given to
// chrome.downloads.download: the name is given again when Chrome asks for it. Downloads
// of other origins are left untouched, and nothing about them is kept.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!item || item.byExtensionId !== chrome.runtime.id) return undefined;
  let filename = pendingNames.get(item.url);
  if (filename === undefined && pendingNames.size === 1) filename = pendingNames.values().next().value;
  if (filename === undefined) return undefined;
  for (const [url, name] of pendingNames) {
    if (name === filename) {
      pendingNames.delete(url);
      break;
    }
  }
  suggest({ filename, conflictAction: 'uniquify' });
  return undefined;
});

// One file per export: the CSV of one account, or a ZIP with both. Only the data URLs that
// the content scripts build are downloaded (files.isDownloadUrl).
function validFile(file) {
  return Boolean(file) && typeof file.name === 'string' && self.LFX.files.isDownloadUrl(file.dataUrl);
}

async function startDownload(file, filename, saveAs) {
  const url = file.dataUrl;
  pendingNames.set(url, filename);
  setTimeout(() => {
    if (pendingNames.get(url) === filename) pendingNames.delete(url);
  }, NAME_TIMEOUT_MS);
  try {
    return await chrome.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' });
  } catch (error) {
    pendingNames.delete(url);
    throw error;
  }
}

// Without a window, into the download folder: only for automated tests (saveDialog: false).
async function downloadFiles(message) {
  const files = Array.isArray(message.files) ? message.files : [];
  if (files.length === 0 || files.length > MAX_FILES) throw new Error('invalid file list');
  if (!files.every(validFile)) throw new Error('invalid file');
  const ids = [];
  for (const file of files) ids.push(await startDownload(file, self.LFX.files.downloadPath(message.folder, file.name), false));
  return { ok: true, ids };
}

async function findDownload(id) {
  const items = await chrome.downloads.search({ id });
  return items && items[0] ? items[0] : null;
}

function directoryOf(path) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : '';
}

// The file, with Chrome's "Save as" window: any folder.
async function saveWithWindow(message) {
  if (!validFile(message.file)) throw new Error('invalid file');
  const id = await startDownload(message.file, self.LFX.files.downloadPath('', message.file.name), true);
  return { ok: true, id };
}

// Where the file went: pending while the window is open.
async function downloadState(message) {
  if (typeof message.id !== 'number') return { state: 'failed' };
  const item = await findDownload(message.id);
  if (!item) return { state: 'cancelled' };
  if (item.state === 'interrupted') return { state: item.error === 'USER_CANCELED' ? 'cancelled' : 'failed', error: item.error || '' };
  if (!item.filename) return { state: 'pending' };
  return { state: 'chosen', directory: directoryOf(item.filename) };
}

// A file saved by this extension, shown in its folder (Finder, Explorer).
async function showDownload(message) {
  if (typeof message.id !== 'number') return { ok: false };
  const item = await findDownload(message.id);
  if (!item || item.byExtensionId !== chrome.runtime.id) return { ok: false };
  chrome.downloads.show(message.id);
  return { ok: true };
}

async function personKey(personId) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`librefolio-exporter:${personId}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function storeKnownAccounts(personId, portfolioId, savingsAccountIds) {
  const key = await personKey(personId);
  const stored = (await chrome.storage.local.get({ [KNOWN_ACCOUNTS_KEY]: {} }))[KNOWN_ACCOUNTS_KEY] || {};
  const known = Object.assign({}, stored);
  delete known[key];
  known[key] = { portfolioId: portfolioId || null, savingsAccountIds: savingsAccountIds.slice(-MAX_SAVINGS_ACCOUNTS) };
  const keys = Object.keys(known);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_KNOWN_PEOPLE))) delete known[old];
  await chrome.storage.local.set({ [KNOWN_ACCOUNTS_KEY]: known });
}

async function loadKnownAccounts(personId) {
  const stored = (await chrome.storage.local.get({ [KNOWN_ACCOUNTS_KEY]: {} }))[KNOWN_ACCOUNTS_KEY] || {};
  const entry = stored[await personKey(personId)];
  if (!entry || typeof entry !== 'object') return null;
  return {
    portfolioId: isId(entry.portfolioId) ? entry.portfolioId : null,
    savingsAccountIds: Array.isArray(entry.savingsAccountIds) ? entry.savingsAccountIds.filter(isId) : [],
  };
}

function isId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

// The recipe of an overnight account's transaction list, as read from its Transactions
// page: the web app's own query text and variables. Anything else is refused.
function cleanRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || !isId(recipe.savingsAccountId)) return null;
  if (typeof recipe.operationName !== 'string' || !/^[A-Za-z_]\w{0,80}$/.test(recipe.operationName)) return null;
  if (typeof recipe.query !== 'string' || recipe.query.length > MAX_RECIPE_QUERY || !recipe.query.includes('moreTransactions')) return null;
  const variables = recipe.variables;
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return null;
  let size;
  try {
    size = JSON.stringify(variables).length;
  } catch (error) {
    return null;
  }
  if (size > MAX_RECIPE_VARIABLES) return null;
  return { operationName: recipe.operationName, query: recipe.query, variables: JSON.parse(JSON.stringify(variables)) };
}

// Merges what a page shows into what was seen before for the same person.
async function rememberIds(message) {
  if (!isId(message.personId)) return { ok: false };
  const stored = (await chrome.storage.session.get(REMEMBERED_KEY))[REMEMBERED_KEY];
  const previous = stored && stored.personId === message.personId ? stored : null;
  const savingsAccountIds = previous && Array.isArray(previous.savingsAccountIds) ? previous.savingsAccountIds.filter(isId) : [];
  const newIds = Array.isArray(message.savingsAccountIds) ? message.savingsAccountIds.slice() : [];
  const recipe = cleanRecipe(message.depositRecipe);
  if (recipe) newIds.push(message.depositRecipe.savingsAccountId);
  for (const id of newIds) {
    if (isId(id) && !savingsAccountIds.includes(id)) savingsAccountIds.push(id);
  }
  const kept = savingsAccountIds.slice(-MAX_SAVINGS_ACCOUNTS);
  const depositRecipes = {};
  const previousRecipes = (previous && previous.depositRecipes) || {};
  for (const id of kept) {
    if (recipe && id === message.depositRecipe.savingsAccountId) depositRecipes[id] = recipe;
    else if (previousRecipes[id] && typeof previousRecipes[id] === 'object') depositRecipes[id] = previousRecipes[id];
  }
  const remembered = {
    personId: message.personId,
    portfolioId: isId(message.portfolioId) ? message.portfolioId : (previous && isId(previous.portfolioId) && previous.portfolioId) || null,
    savingsAccountIds: kept,
    depositRecipes,
  };
  await chrome.storage.session.set({ [REMEMBERED_KEY]: remembered });
  const known = await loadKnownAccounts(message.personId);
  const allIds = (known && known.savingsAccountIds.slice()) || [];
  for (const id of kept) if (!allIds.includes(id)) allIds.push(id);
  await storeKnownAccounts(message.personId, remembered.portfolioId || (known && known.portfolioId), allIds);
  return { ok: true };
}

// What is known for this person: this browser session's memory, completed with the
// accounts kept from earlier sessions.
async function recallIds(message) {
  if (!isId(message.personId)) return null;
  const stored = (await chrome.storage.session.get(REMEMBERED_KEY))[REMEMBERED_KEY];
  const session = stored && stored.personId === message.personId ? stored : null;
  const known = await loadKnownAccounts(message.personId);
  if (!session && !known) return null;
  const savingsAccountIds = [];
  for (const id of [...((known && known.savingsAccountIds) || []), ...((session && session.savingsAccountIds) || [])]) {
    if (!savingsAccountIds.includes(id)) savingsAccountIds.push(id);
  }
  return {
    personId: message.personId,
    portfolioId: (session && session.portfolioId) || (known && known.portfolioId) || null,
    savingsAccountIds,
    depositRecipes: (session && session.depositRecipes) || {},
  };
}

// Several tabs may report at once: their read-and-merge steps run one at a time.
let rememberQueue = Promise.resolve();
function queueRemember(message) {
  const next = rememberQueue.then(() => rememberIds(message));
  rememberQueue = next.catch(() => {});
  return next;
}

const HANDLERS = {
  'lfx:update-status': (message) => updateStatus(message.force === true),
  'lfx:download': (message) => downloadFiles(message),
  'lfx:save-as': (message) => saveWithWindow(message),
  'lfx:download-state': (message) => downloadState(message),
  'lfx:show-download': (message) => showDownload(message),
  'lfx:remember-ids': (message) => queueRemember(message),
  'lfx:recall-ids': (message) => recallIds(message),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || sender.id !== chrome.runtime.id) return false;
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, message.type) ? HANDLERS[message.type] : null;
  if (!handler) return false;
  handler(message).then(sendResponse, (error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
  return true;
});
