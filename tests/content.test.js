'use strict';

/*
 * End-to-end tests of the extension as the browser loads it: the content scripts,
 * plain scripts sharing the LFX namespace in manifest order, inside a fake page
 * with a minimal DOM and Scalable GraphQL endpoint; and the real background
 * service worker in its own context, reached through chrome.runtime.sendMessage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const format = require('../src/shared/format.js');
const filesApi = require('../src/shared/files.js');
const { unzip } = require('./unzip.js');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://de.scalable.capital';
const EXTENSION_ID = 'test-extension';
const INTEREST_PATH = '/interest/api/graphql/';
const SECRETS = ['person-123456', 'pf-123456', 'sav-123456', 'Some ETF', 'SEPA', 'IE00TEST0001', '-250', 'R1', 'RI-1'];

class FakeNode {
  constructor(tag, page) {
    this.tagName = tag.toUpperCase();
    this.page = page;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this.parentNode = null;
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
  }

  setAttribute(name, value) {
    const text = String(value);
    this.attributes[name] = text;
    if (name === 'hidden') this.hidden = true;
    if (name === 'checked') this.checked = true;
    if (name === 'disabled') this.disabled = true;
    if (name === 'href') this.href = text;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((node) => node !== child);
    child.parentNode = null;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceChildren(...nodes) {
    for (const node of this.children) node.parentNode = null;
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }

  addEventListener(type, listener) {
    (this.listeners[type] = this.listeners[type] || []).push(listener);
  }

  removeEventListener() {}

  dispatch(type, extra) {
    for (const listener of this.listeners[type] || []) listener(Object.assign({ type, target: this }, extra || {}));
  }

  click() {
    if (this.disabled) return;
    this.dispatch('click');
    if (this.tagName === 'A' && this.download) this.page.anchorDownloads.push({ name: this.download, url: this.href });
  }

  // What a user does in a text or date field: type, then leave it.
  type(value) {
    this.value = value;
    this.dispatch('input');
    this.dispatch('change');
  }

  toggle() {
    this.checked = !this.checked;
    this.dispatch('change');
  }

  attachShadow() {
    this.shadowRoot = new FakeNode('#shadow-root', this.page);
    this.shadowRoot.host = this;
    return this.shadowRoot;
  }

  get isConnected() {
    let node = this;
    while (node) {
      if (node === this.page.document.documentElement) return true;
      node = node.parentNode || node.host;
    }
    return false;
  }

  querySelectorAll() {
    return [];
  }

  findByTestId(testId) {
    if (this.getAttribute('data-testid') === testId) return this;
    for (const child of [...this.children, ...(this.shadowRoot ? [this.shadowRoot] : [])]) {
      const found = child.findByTestId(testId);
      if (found) return found;
    }
    return null;
  }
}

function fakeStorage(entries) {
  const keys = Object.keys(entries);
  return { length: keys.length, key: (index) => keys[index], getItem: (key) => (key in entries ? entries[key] : null) };
}

function respond(payload) {
  return { status: 200, ok: true, json: async () => payload };
}

function brokerTransactions() {
  return [
    {
      __typename: 'BrokerSecurityTransactionSummary', id: 't1', type: 'SECURITY_TRANSACTION', status: 'SETTLED',
      lastEventDateTime: '2026-09-01T08:00:00Z', description: 'Some ETF', securityTransactionType: 'SAVINGS_PLAN',
      side: 'BUY', quantity: 2.5, amount: -250, isin: 'IE00TEST0001', currency: 'EUR',
    },
    {
      __typename: 'BrokerCashTransactionSummary', id: 'c1', type: 'CASH_TRANSACTION', status: 'SETTLED',
      lastEventDateTime: '2026-08-31T08:00:00Z', description: 'Deposit; "SEPA"', cashTransactionType: 'DEPOSIT', amount: 500, currency: 'EUR',
    },
  ];
}

// The recipe that the overnight account's Transactions page carries, as Apollo writes it.
const DEPOSIT_RECIPE = {
  operationName: 'Transactions',
  query:
    'query Transactions($personId:ID!$input:SavingsAccountCashTransactionInput!$portfolioId:ID!){account(id:$personId){id savingsAccount(id:$portfolioId){id ...TransactionsListContainer@unmask}}}fragment TransactionsListContainer on SavingsAccount{id moreTransactions(input:$input){cursor total transactions{id currency type status isCancellation lastEventDateTime description amount cashTransactionType}}}',
  variables: { personId: 'short-123456', portfolioId: 'sav-123456', input: { pageSize: 50 } },
};

function depositServerData(recipe) {
  const reference = { options: { query: recipe.query, variables: recipe.variables }, queryKey: 'k', stream: '$@7' };
  return `0:{}\n5:["$","$L6",null,{"queryRef":{"$__apollo_queryRef":${JSON.stringify(reference)}},"personId":"${recipe.variables.personId}"}]\n`;
}

function depositPageHtml(recipe) {
  return `<!DOCTYPE html><html><body><script>self.__next_f.push([0])</script><script>self.__next_f.push(${JSON.stringify([1, depositServerData(recipe)])})</script></body></html>`;
}

function interestTransactions() {
  return [
    { id: 'd1', type: 'CASH_TRANSACTION', status: 'SETTLED', isCancellation: false, description: 'Interest', amount: 1.23, currency: 'EUR', lastEventDateTime: '2026-09-30T23:00:00Z', cashTransactionType: 'INTEREST' },
    { id: 'd2', type: 'CASH_TRANSACTION', status: 'SETTLED', isCancellation: false, description: 'Withdrawal', amount: 2.5, currency: 'EUR', lastEventDateTime: '2026-09-29T10:00:00Z', cashTransactionType: 'WITHDRAWAL' },
  ];
}

// As in the browser: the interest app answers the queries of its own pages only, and the
// Transactions page carries the recipe of its list. server.depositPage can change its answer.
function scalableServer(calls, server) {
  const state = server || {};
  return async (url, init) => {
    const pathName = url.slice(ORIGIN.length);
    if ((init.method || 'GET') === 'GET') {
      calls.push({ url, path: pathName, operation: 'GET', credentials: init.credentials, redirect: init.redirect });
      if (state.depositPage) return state.depositPage(pathName);
      if (pathName === '/interest/overnight/sav-123456/transactions/') {
        return { status: 200, ok: true, type: 'basic', text: async () => depositPageHtml(DEPOSIT_RECIPE) };
      }
      return { status: 404, ok: false, type: 'basic', text: async () => 'not found' };
    }
    const body = JSON.parse(init.body);
    calls.push({ url, path: pathName, operation: body.operationName, variables: body.variables, query: body.query, credentials: init.credentials });
    const refused = respond({ errors: [{ message: 'Unauthorized access', extensions: { code: 'UNAUTHENTICATED' } }] });
    if (pathName === '/broker/api/data') {
      if (body.operationName === 'moreTransactions') {
        return respond({ data: { account: { brokerPortfolio: { moreTransactions: { cursor: null, transactions: brokerTransactions() } } } } });
      }
      if (body.operationName === 'getTransactionDetails') {
        return respond({ data: { account: { brokerPortfolio: { transactionDetails: { transactionReference: 'R1', averagePrice: 100, tradeTransactionAmounts: { transactionFee: 0, taxAmount: 0 } } } } } });
      }
      return refused;
    }
    if (pathName !== '/interest/api/graphql/') return { status: 404, ok: false, json: async () => ({}) };
    if (body.operationName === 'Transactions' && body.query === DEPOSIT_RECIPE.query.replace('@unmask', '') && body.variables.personId === 'short-123456') {
      const transactions = interestTransactions();
      return respond({ data: { account: { savingsAccount: { moreTransactions: { cursor: null, total: transactions.length, transactions } } } } });
    }
    if (body.operationName === 'OvernightTransactionDetails' && body.variables.personId === 'short-123456') {
      return respond({
        data: {
          account: {
            savingsAccount: {
              transactionDetails: { __typename: 'SavingsAccountCashTransaction', id: 'd1', isCancellation: false, transactionReference: 'RI-1', taxDetails: { grossAmount: 1.67, taxAmount: 0.44 } },
            },
          },
        },
      });
    }
    return refused;
  };
}

// The real background service worker, with chrome.* faked around it. Its local
// storage is the one the content scripts see, as in the browser.
// options.release(requestNumber) answers GitHub's latest-release request; background.clock is Date.now().
function createBackground(options) {
  const settings = Object.assign(
    { release: () => respond({ tag_name: 'v9.9.9', html_url: 'https://github.com/Librefolio/librefolio-exporter/releases/tag/v9.9.9' }) },
    options || {},
  );
  // ignoreNames: like another extension that names downloads, the name given to
  // chrome.downloads.download is replaced; the extension's own listener is asked last.
  // root: Chrome's download folder. With the "Save as" window, a file stays unnamed for
  // windowPolls looks, then is saved in dialogDirectory, or cancelled when dialogCancels.
  const background = {
    downloads: [],
    session: {},
    listeners: [],
    nameListeners: [],
    ignoreNames: false,
    releaseRequests: 0,
    local: {},
    clock: Date.now(),
    root: '/Users/test/Downloads',
    dialogDirectory: '/Users/test/Documents/Finanza',
    dialogCancels: false,
    windowPolls: 0,
    dialogs: 0,
    items: new Map(),
    shown: [],
  };
  class FakeDate extends Date {}
  FakeDate.now = () => background.clock;
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getManifest: () => ({ version: '1.0.0' }),
      onMessage: { addListener: (listener) => background.listeners.push(listener) },
    },
    storage: {
      local: {
        get: async (defaults) => Object.assign({}, defaults, background.local),
        set: async (values) => Object.assign(background.local, values),
        remove: async (keys) => {
          for (const key of [].concat(keys)) delete background.local[key];
        },
      },
      session: {
        get: async (key) => (key in background.session ? { [key]: background.session[key] } : {}),
        set: async (values) => Object.assign(background.session, values),
      },
    },
    downloads: {
      onDeterminingFilename: { addListener: (listener) => background.nameListeners.push(listener) },
      download: async (options) => {
        const item = { id: background.downloads.length + 1, url: options.url, filename: background.ignoreNames ? 'download.csv' : options.filename, byExtensionId: EXTENSION_ID };
        let finalName = item.filename;
        for (const listener of background.nameListeners) {
          listener(item, (suggestion) => {
            if (suggestion && suggestion.filename) finalName = suggestion.filename;
          });
        }
        const entry = { id: item.id, filename: `${background.root}/${finalName}`, state: 'complete', pending: 0, byExtensionId: EXTENSION_ID };
        if (options.saveAs === true) {
          background.dialogs++;
          entry.pending = background.windowPolls;
          if (background.dialogCancels) Object.assign(entry, { filename: '', state: 'interrupted', error: 'USER_CANCELED' });
          else entry.filename = `${background.dialogDirectory}/${finalName.split('/').pop()}`;
        }
        background.items.set(item.id, entry);
        background.downloads.push(Object.assign({}, options, { id: item.id, finalName, entry }));
        return item.id;
      },
      search: async (query) => {
        const entry = background.items.get(query.id);
        if (!entry) return [];
        if (entry.pending > 0) {
          entry.pending--;
          return [{ id: entry.id, filename: '', state: 'in_progress', byExtensionId: entry.byExtensionId }];
        }
        return [{ id: entry.id, filename: entry.filename, state: entry.state, error: entry.error, byExtensionId: entry.byExtensionId }];
      },
      show: (id) => {
        background.shown.push(id);
      },
    },
  };
  const context = vm.createContext({
    chrome,
    console,
    TextEncoder,
    btoa,
    crypto: globalThis.crypto,
    // Short waits pass at once on the background's clock; long timers never fire.
    setTimeout: (callback, ms) => {
      if (ms <= 1000) {
        setImmediate(() => {
          background.clock += ms;
          callback();
        });
      }
      return 0;
    },
    Date: FakeDate,
    fetch: async (url) => {
      background.releaseRequests++;
      assert.equal(url, 'https://api.github.com/repos/Librefolio/librefolio-exporter/releases/latest');
      return settings.release(background.releaseRequests);
    },
  });
  context.self = context;
  background.context = context;
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', file), 'utf8'), context, { filename: file });
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8'), context, { filename: 'src/background.js' });
  assert.equal(background.listeners.length, 1);

  background.send = (message, sender) =>
    new Promise((resolve) => {
      const waiting = background.listeners[0](message, sender || { id: EXTENSION_ID }, resolve);
      if (!waiting) resolve(undefined);
    });
  // The files saved, with the name each was given; a ZIP also lists its entries.
  background.files = () =>
    background.downloads
      .filter((options) => options.entry.state === 'complete')
      .map((options) => {
        const bytes = Buffer.from(options.url.split(',')[1], 'base64');
        const zip = options.url.startsWith('data:application/zip;');
        return {
          id: options.id,
          filename: options.finalName,
          path: options.entry.filename,
          saveAs: options.saveAs,
          conflictAction: options.conflictAction,
          text: zip ? null : bytes.toString('utf8'),
          entries: zip ? unzip(bytes) : null,
        };
      });
  return background;
}

function createPage(options) {
  const settings = Object.assign(
    {
      pathname: '/broker/transactions',
      search: '?portfolioId=pf-123456',
      session: { uniqueId: 'person-123456' },
      background: null,
      resources: null,
      links: ['/interest/overnight/sav-123456'],
      scripts: [],
      server: null,
    },
    options || {},
  );
  const page = { anchorDownloads: [], blobs: new Map(), calls: [], intervals: [], logs: [], groups: [], groupEnds: 0, messages: [], override: null, server: settings.server || {} };
  page.background = settings.background || createBackground();
  const server = scalableServer(page.calls, page.server);
  page.stored = page.background.local;

  const documentElement = new FakeNode('html', page);
  documentElement.lang = 'it';
  const body = new FakeNode('body', page);
  documentElement.appendChild(body);
  page.document = {
    documentElement,
    body,
    createElement: (tag) => new FakeNode(tag, page),
    createElementNS: (ns, tag) => new FakeNode(tag, page),
    createTextNode: (text) => Object.assign(new FakeNode('#text', page), { textContent: String(text) }),
    // Links of the web app's navigation, and the inline scripts of a server-rendered page.
    querySelectorAll: (selector) => {
      if (selector.startsWith('a[href')) return settings.links.map((href) => Object.assign(new FakeNode('a', page), { attributes: { href } }));
      if (selector === 'script:not([src])') return settings.scripts.map((source) => ({ textContent: source }));
      return [];
    },
  };
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getManifest: () => ({ version: '1.0.0' }),
      sendMessage: async (message) => {
        page.messages.push(message);
        if (page.override) {
          const answer = page.override(message);
          if (answer !== undefined) return answer;
        }
        return page.background.send(message);
      },
    },
    storage: {
      local: {
        get: async (defaults) => Object.assign({}, defaults, page.stored),
        set: async (values) => Object.assign(page.stored, values),
        remove: async (key) => {
          delete page.stored[key];
        },
      },
    },
  };
  page.chrome = chrome;
  let blobCount = 0;
  const globals = {
    document: page.document,
    chrome,
    navigator: { language: 'it-IT' },
    location: { origin: ORIGIN, pathname: settings.pathname, search: settings.search },
    sessionStorage: fakeStorage(settings.session),
    localStorage: fakeStorage({}),
    fetch: async (...args) => {
      page.inFlight = (page.inFlight || 0) + 1;
      page.maxInFlight = Math.max(page.maxInFlight || 0, page.inFlight);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await server(...args);
      } finally {
        page.inFlight--;
      }
    },
    URL: Object.assign(
      function (...args) {
        return new URL(...args);
      },
      {
        createObjectURL: (blob) => {
          const url = `blob:${ORIGIN}/${++blobCount}`;
          page.blobs.set(url, blob);
          return url;
        },
        revokeObjectURL: () => {},
      },
    ),
    URLSearchParams,
    Blob,
    Response,
    CompressionStream,
    btoa,
    TextEncoder,
    AbortController,
    setTimeout: (callback) => {
      setImmediate(callback);
      return 0;
    },
    clearTimeout: () => {},
    setInterval: (callback, ms) => {
      page.intervals.push({ callback, ms });
      return 0;
    },
    console: {
      info: (...args) => page.logs.push(args),
      groupCollapsed: (...args) => page.groups.push(args),
      groupEnd: () => {
        page.groupEnds++;
      },
      warn: () => {},
      error: () => {},
    },
  };
  if (settings.resources) {
    globals.PerformanceObserver = class {
      constructor(callback) {
        this.callback = callback;
      }

      observe(init) {
        assert.equal(init.type, 'resource');
        this.callback({ getEntries: () => settings.resources });
      }
    };
  }
  page.context = vm.createContext(globals);
  return page;
}

function loadContentScripts(page) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  for (const file of manifest.content_scripts[0].js) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), page.context, { filename: file });
  }
  page.root = page.document.body.findByTestId('lfx-root');
  page.find = (testId) => page.root.findByTestId(testId);
  return page;
}

function textOf(node) {
  return node.children.length > 0 ? node.children.map(textOf).join('') : node.textContent;
}

function resultFile(page) {
  return page.find('lfx-result-box').hidden ? null : page.find('lfx-result-file').textContent;
}

// Values built inside another context have that context's prototypes.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function settle(condition) {
  for (let round = 0; round < 500; round++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition not met');
}

const UPDATE_DONE = ['available', 'current', 'failed'];

function updateMessages(page) {
  return page.messages.filter((message) => message.type === 'lfx:update-status').length;
}

// Opening the panel loads the settings, then checks for updates: wait for its answer.
async function openPanel(page) {
  const before = updateMessages(page);
  page.find('lfx-open').click();
  await settle(() => updateMessages(page) > before && UPDATE_DONE.includes(page.find('lfx-update').getAttribute('data-state')));
}

async function pressUpdateCheck(page) {
  const before = updateMessages(page);
  page.find('lfx-update-check').click();
  assert.equal(page.find('lfx-update').getAttribute('data-state'), 'checking');
  assert.equal(page.find('lfx-update-check').disabled, true);
  await settle(() => updateMessages(page) > before && UPDATE_DONE.includes(page.find('lfx-update').getAttribute('data-state')));
}

async function acceptRiskAndExport(page) {
  if (!page.find('lfx-risk').hidden) {
    page.find('lfx-risk-accept').click();
    await settle(() => page.stored.riskAccepted === true);
  }
  page.find('lfx-export').click();
  assert.equal(page.find('lfx-cancel').hidden, false, 'the export has started');
  await settle(() => page.find('lfx-cancel').hidden);
}

// Console lines: [prefix, event, JSON text]
function logged(page, event) {
  return page.logs.filter((entry) => entry[1] === event).map((entry) => (entry[2] === undefined ? undefined : JSON.parse(entry[2])));
}

function assertNoSecrets(page) {
  const diagnostics = JSON.stringify([page.logs, page.groups]);
  for (const secret of SECRETS) assert.ok(!diagnostics.includes(secret), `diagnostics must not contain ${secret}`);
}

const BROKER_CALLS = ['moreTransactions /broker/api/data', 'getTransactionDetails /broker/api/data'];
const DEPOSIT_CALLS = ['Transactions /interest/api/graphql/', 'OvernightTransactionDetails /interest/api/graphql/'];

function callNames(page) {
  return page.calls.map((call) => `${call.operation} ${call.path}`);
}

// The requests of one account, in their order: the two accounts are read side by side.
function accountCalls(page, account) {
  return callNames(page).filter((name) => name.includes('/broker/') === (account === 'broker'));
}

function findCall(page, operation) {
  return page.calls.find((call) => call.operation === operation);
}

function warningTexts(page) {
  return page.find('lfx-warnings').children.map((node) => node.textContent);
}

test('the content scripts export both accounts end to end', async () => {
  const page = loadContentScripts(createPage());

  assert.ok(page.root, 'the button is shown on a web-app page');
  assert.equal(page.intervals[0].ms, 1000, 'route changes are followed');
  const find = page.find;

  await openPanel(page);
  assert.equal(find('lfx-panel').hidden, false);
  assert.equal(find('lfx-risk').hidden, false, 'the risk notice is shown first');
  assert.equal(find('lfx-export').disabled, true, 'no export before the notice is accepted');
  assert.equal(find('lfx-update-text').textContent, 'È disponibile la versione 9.9.9.');
  assert.equal(find('lfx-from').value, '', 'the first export starts from the beginning');
  assert.equal(find('lfx-to').value, format.todayBerlin(), '"to" is today');

  await acceptRiskAndExport(page);
  const files = page.background.files();
  assert.equal(files.length, 1, 'both accounts in one file');
  const [saved] = files;
  assert.match(saved.filename, /^scalable_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/);
  assert.deepEqual([saved.saveAs, saved.conflictAction], [true, 'uniquify']);
  assert.equal(page.background.dialogs, 1, 'one "Save as" window');
  assert.equal(saved.path, `/Users/test/Documents/Finanza/${saved.filename}`, 'in any folder, also outside Downloads');
  const stamp = saved.filename.slice('scalable_'.length, -'.zip'.length);
  const [brokerFile, depositFile] = saved.entries;
  assert.deepEqual(
    saved.entries.map((entry) => entry.name),
    [`scalable-broker_${stamp}.csv`, `scalable-deposit_${stamp}.csv`],
  );
  assert.equal(find('lfx-status').textContent, '');
  assert.equal(find('lfx-progress-label').textContent, 'Scegli dove salvare lo ZIP con i due file');
  assert.equal(find('lfx-progress-label').hidden, true, 'the step label goes when the export is over');
  assert.equal(resultFile(page), `📦 ${saved.filename}`, 'only the saved file, its folder and the button');
  assert.equal(find('lfx-result-folder').textContent, '📁 Cartella: /Users/test/Documents/Finanza');
  assert.equal(find('lfx-result-show').hidden, false);
  assert.equal(find('lfx-result-show').textContent, 'Mostra cartella');
  find('lfx-result-show').click();
  await settle(() => page.background.shown.length === 1);
  assert.deepEqual(page.background.shown, [saved.id], 'the ZIP is shown in its folder');
  assert.equal(find('lfx-progress').hidden, false, 'the account rows stay with their outcome');
  assert.equal(find('lfx-warnings').hidden, true, warningTexts(page).join(' | '));

  assert.deepEqual(accountCalls(page, 'broker'), BROKER_CALLS);
  assert.deepEqual(accountCalls(page, 'deposit'), ['GET /interest/overnight/sav-123456/transactions/', ...DEPOSIT_CALLS]);
  assert.equal(callNames(page)[1], 'GET /interest/overnight/sav-123456/transactions/', 'side by side: the overnight account starts with the broker');
  assert.equal(page.maxInFlight, 1, 'and the requests still go one at a time');
  assert.ok(page.calls.every((call) => call.credentials === 'same-origin'));
  assert.equal(findCall(page, 'GET').redirect, 'manual');
  assert.equal(findCall(page, 'moreTransactions').variables.personId, 'person-123456');
  assert.equal(findCall(page, 'moreTransactions').variables.portfolioId, 'pf-123456');
  assert.deepEqual(findCall(page, 'Transactions').variables, DEPOSIT_RECIPE.variables, 'the list is read with the page’s own variables');
  assert.deepEqual(findCall(page, 'OvernightTransactionDetails').variables, { personId: 'short-123456', savingsAccountId: 'sav-123456', transactionId: 'd1' });

  assert.equal(find('lfx-progress-broker-step').textContent, '✓ 2 transazioni');
  assert.equal(find('lfx-progress-deposit-step').textContent, '✓ 2 movimenti');
  assert.equal(find('lfx-progress-deposit').className, 'progress-row deposit done');
  assert.equal(find('lfx-progress-broker').className, 'progress-row broker done');

  assert.equal(page.anchorDownloads.length, 0, 'saved by the extension, not by the page');

  const lines = brokerFile.text.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('date;time;status;reference;description;assetType;type;isin;shares;price;amount;fee;tax;currency;lf_account;'));
  assert.ok(lines[1].startsWith('2026-09-01;10:00:00;Executed;"R1";"Some ETF";Security;Savings plan;IE00TEST0001;2,5;100;-250;0;0;EUR;broker;1;t1;'));
  assert.ok(lines[2].includes(';"Deposit; ""SEPA""";Cash;Deposit;'));
  assert.ok(lines[1].endsWith(';yes;librefolio-exporter/1.0.0;1'));
  const deposit = depositFile.text.trimEnd().split('\n');
  assert.equal(deposit.length, 3);
  assert.ok(lines[0].includes(';lf_trading_venue;'));
  assert.ok(deposit[0].endsWith(';currency;lf_account;lf_account_index;lf_id;lf_subtype;lf_status;lf_is_cancellation;lf_details;lf_exporter;lf_format'), 'no broker columns in the overnight file');
  assert.ok(deposit[1].startsWith('2026-10-01;01:00:00;Executed;"RI-1";"Interest";Cash;Interest;;;;1,23;;0,44;EUR;deposit;1;d1;'), deposit[1]);
  assert.ok(deposit[2].startsWith('2026-09-29;12:00:00;Executed;"";"Withdrawal";Cash;Withdrawal;;;;-2,5;;;EUR;deposit;1;d2;'), deposit[2]);

  assert.deepEqual(plain(page.stored.lastExportDates), { broker: format.todayBerlin(), deposit: format.todayBerlin() });
  assert.equal(find('lfx-last-export').hidden, false);
  assert.equal(find('lfx-preset-last').hidden, false, 'the "since last export" preset appears');
  assert.equal(find('lfx-export').disabled, false, 'the panel is usable again');

  assert.deepEqual(plain(page.background.session.rememberedIds), { personId: 'person-123456', portfolioId: 'pf-123456', savingsAccountIds: ['sav-123456'], depositRecipes: {} });
  assertNoSecrets(page);
  assert.deepEqual(logged(page, 'identifiers'), [{ person: 'sessionStorage', portfolio: 'url', overnight: 'page', overnightAccounts: 1, overnightRecipes: [] }]);
  assert.deepEqual(logged(page, 'overnight-recipe'), [{ source: 'download', operation: 'Transactions' }]);
  assert.equal(logged(page, 'request').length, 5);
  assert.deepEqual(logged(page, 'new-fields'), [], 'every field of the responses is known or excluded');
  const structure = logged(page, 'structure of the export (no amounts, descriptions or identifiers)');
  assert.equal(structure.length, 1);
  assert.equal(structure[0].reduce((total, entry) => total + entry.count, 0), 4);
  assert.deepEqual([page.groups.length, page.groupEnds], [1, 1], 'one collapsed console group per export');
  assert.ok(page.logs.some((entry) => entry[1] === 'Conto deposito 1/1…' || /^Conto deposito/.test(entry[1] || '')), 'progress steps go to the console');
});

test('on the Transactions page the recipe is read from the page, and remembered for the other pages', async () => {
  const background = createBackground();
  loadContentScripts(createPage({ background, links: [] }));
  await settle(() => background.session.rememberedIds);

  const transactionsPage = loadContentScripts(
    createPage({
      background,
      pathname: '/interest/overnight/sav-123456/transactions/',
      search: '',
      links: [],
      scripts: ['self.__next_f.push([0])', `self.__next_f.push(${JSON.stringify([1, depositServerData(DEPOSIT_RECIPE)])})`],
    }),
  );
  await settle(() => Object.keys(background.session.rememberedIds.depositRecipes || {}).length === 1);
  assert.deepEqual(plain(background.session.rememberedIds.depositRecipes['sav-123456']), DEPOSIT_RECIPE);

  await openPanel(transactionsPage);
  await acceptRiskAndExport(transactionsPage);
  assert.equal(transactionsPage.find('lfx-result-box').hidden, false, transactionsPage.find('lfx-status').textContent);
  assert.deepEqual(accountCalls(transactionsPage, 'broker'), BROKER_CALLS);
  assert.deepEqual(accountCalls(transactionsPage, 'deposit'), DEPOSIT_CALLS, 'no page download');
  assert.deepEqual(logged(transactionsPage, 'identifiers'), [{ person: 'sessionStorage', portfolio: 'remembered', overnight: 'page', overnightAccounts: 1, overnightRecipes: ['page'] }]);
  assertNoSecrets(transactionsPage);

  const home = loadContentScripts(createPage({ background, pathname: '/cockpit/', search: '', links: [] }));
  await openPanel(home);
  home.find('lfx-preset-all').click();
  await acceptRiskAndExport(home);
  assert.equal(home.find('lfx-result-box').hidden, false);
  assert.deepEqual(accountCalls(home, 'broker'), BROKER_CALLS);
  assert.deepEqual(accountCalls(home, 'deposit'), DEPOSIT_CALLS);
  assert.deepEqual(logged(home, 'identifiers'), [{ person: 'sessionStorage', portfolio: 'remembered', overnight: 'remembered', overnightAccounts: 1, overnightRecipes: ['memory'] }]);
});

test('another person’s remembered ids are never used', async () => {
  const background = createBackground();
  background.session.rememberedIds = {
    personId: 'person-999999',
    portfolioId: 'pf-999999',
    savingsAccountIds: ['sav-999999'],
    depositRecipes: { 'sav-999999': Object.assign({}, DEPOSIT_RECIPE, { variables: { personId: 'short-999999', portfolioId: 'sav-999999', input: { pageSize: 50 } } }) },
  };
  const page = loadContentScripts(createPage({ background, pathname: '/cockpit/', search: '', links: [] }));
  await openPanel(page);
  await acceptRiskAndExport(page);
  assert.deepEqual(page.calls, [], 'nothing is requested');
  assert.equal(page.find('lfx-status').className, 'status error');
  assert.deepEqual(warningTexts(page), [
    'Conto broker: Apri su Scalable la pagina delle transazioni del broker e riprova.',
    'Conto deposito: Apri una volta su Scalable la pagina del conto deposito, poi riprova.',
  ]);
});

test('a security check on the Transactions page asks the user to open it', async () => {
  const page = loadContentScripts(createPage({ server: { depositPage: () => ({ status: 0, ok: false, type: 'opaqueredirect' }) } }));
  await openPanel(page);
  await acceptRiskAndExport(page);
  assert.match(resultFile(page), /^📄 scalable-broker_\S+\.csv$/, 'the broker is still saved');
  assert.deepEqual(warningTexts(page), [
    'Conto deposito: Apri su Scalable la pagina «Transazioni» del conto deposito, poi esporta da lì.',
    'Dettagli tecnici: depositPage: redirect',
  ]);
  assert.deepEqual(accountCalls(page, 'broker'), BROKER_CALLS);
  assert.deepEqual(accountCalls(page, 'deposit'), ['GET /interest/overnight/sav-123456/transactions/'], 'the redirect is not followed');
  assert.equal(page.find('lfx-progress-deposit-step').textContent, 'Non letto');
  assert.equal(page.find('lfx-progress-deposit').className, 'progress-row deposit error');
  assert.equal(page.find('lfx-progress-broker-step').textContent, '✓ 2 transazioni');
  assert.equal(page.find('lfx-progress').hidden, false, 'the rows say which account was not read');
  const files = page.background.files();
  assert.equal(files.length, 1);
  assert.match(files[0].filename, /^scalable-broker_\S+\.csv$/, 'one account: its CSV, without a ZIP');
  assert.deepEqual(Object.keys(page.stored.lastExportDates), ['broker'], 'the overnight account is not exported yet');
});

test('presets fill the period, and the form survives a page change for the day', async () => {
  const today = format.todayBerlin();
  const page = loadContentScripts(createPage());
  await openPanel(page);
  const find = page.find;
  assert.equal(find('lfx-preset-last').hidden, true, 'no "since last export" before an export');

  for (const [testId, from] of [
    ['lfx-preset-1m', format.shiftMonths(today, -1)],
    ['lfx-preset-1y', format.shiftMonths(today, -12)],
    ['lfx-preset-all', ''],
    ['lfx-preset-3m', format.shiftMonths(today, -3)],
  ]) {
    find('lfx-to').value = '2020-01-01';
    find(testId).click();
    assert.equal(find('lfx-from').value, from, testId);
    assert.equal(find('lfx-to').value, today, `${testId} ends today`);
  }
  assert.equal(find('lfx-account-deposit').getAttribute('aria-pressed'), 'true', 'both accounts start chosen');
  find('lfx-account-deposit').click();
  assert.equal(find('lfx-account-deposit').getAttribute('aria-pressed'), 'false');
  await settle(() => page.stored.formDraft && page.stored.formDraft.deposit === false);
  assert.deepEqual(plain(page.stored.formDraft), { broker: true, deposit: false, details: true, from: format.shiftMonths(today, -3), to: today, day: today });

  find('lfx-close').click();
  await openPanel(page);
  assert.equal(find('lfx-from').value, format.shiftMonths(today, -3), 'reopening the panel keeps the values');
  find('lfx-to').value = '';
  find('lfx-close').click();
  await openPanel(page);
  assert.equal(find('lfx-to').value, today, 'an empty "to" is today again');

  const next = loadContentScripts(createPage({ background: page.background, pathname: '/interest/overnight/sav-123456', search: '' }));
  await openPanel(next);
  assert.equal(next.find('lfx-from').value, format.shiftMonths(today, -3), 'another page of the web app keeps the values');
  assert.equal(next.find('lfx-account-deposit').getAttribute('aria-pressed'), 'false');

  page.stored.formDraft = Object.assign({}, page.stored.formDraft, { to: '' });
  const emptyTo = loadContentScripts(createPage({ background: page.background }));
  await openPanel(emptyTo);
  assert.equal(emptyTo.find('lfx-to').value, today, 'a saved form without "to" ends today');
  assert.equal(emptyTo.find('lfx-from').value, format.shiftMonths(today, -3));

  page.stored.formDraft = Object.assign({}, page.stored.formDraft, { day: '2000-01-01' });
  page.stored.lastExportDates = { broker: '2026-01-31', deposit: '2025-12-15' };
  const tomorrow = loadContentScripts(createPage({ background: page.background }));
  await openPanel(tomorrow);
  assert.equal(tomorrow.find('lfx-from').value, '2025-12-15', 'an old form gives way to the oldest last export');
  assert.equal(tomorrow.find('lfx-to').value, today);
  assert.equal(tomorrow.find('lfx-account-deposit').getAttribute('aria-pressed'), 'true');
  assert.equal(tomorrow.find('lfx-last-export').textContent, 'Ultima esportazione: Conto broker 2026-01-31 · Conto deposito 2025-12-15');
  tomorrow.find('lfx-to').value = '2020-01-01';
  tomorrow.find('lfx-preset-last').click();
  assert.equal(tomorrow.find('lfx-from').value, '2025-12-15', 'since the oldest last export of the chosen accounts');
  assert.equal(tomorrow.find('lfx-to').value, today);
  tomorrow.find('lfx-account-deposit').click();
  tomorrow.find('lfx-preset-last').click();
  assert.equal(tomorrow.find('lfx-from').value, '2026-01-31', 'only the broker chosen: its own last export');

  page.stored.formDraft = null;
  page.stored.lastExportDates = { broker: '2026-01-31' };
  const brokerOnly = loadContentScripts(createPage({ background: page.background }));
  await openPanel(brokerOnly);
  assert.equal(brokerOnly.find('lfx-from').value, '', 'an account never exported starts from the beginning');
  assert.equal(brokerOnly.find('lfx-preset-last').hidden, true, 'and has no "since last export"');
  assert.equal(brokerOnly.find('lfx-last-export').textContent, 'Ultima esportazione: Conto broker 2026-01-31 · Conto deposito mai');
  brokerOnly.find('lfx-account-deposit').click();
  assert.equal(brokerOnly.find('lfx-preset-last').hidden, false, 'with the broker alone, it appears');

  page.stored.formDraft = null;
  page.stored.lastExportDates = {};
  page.stored.lastExportDate = '2026-01-10';
  const migrated = loadContentScripts(createPage({ background: page.background }));
  await openPanel(migrated);
  assert.equal(migrated.find('lfx-last-export').textContent, 'Ultima esportazione: 2026-01-10', 'the former single date covers both accounts');
});

test('the prefix is the only saving setting; the names shown follow the chosen accounts', async () => {
  const page = loadContentScripts(createPage());
  await openPanel(page);
  const find = page.find;
  assert.equal(find('lfx-prefix').value, 'scalable');
  assert.equal(find('lfx-prefix').hidden, false, 'shown at once, without an edit button');
  assert.equal(find('lfx-save-edit'), null);
  assert.equal(find('lfx-folder'), null, 'no folder setting');
  assert.match(textOf(find('lfx-file-name-archive')), /^scalable_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip, con:scalable-broker_\S+\.csvscalable-deposit_\S+\.csv$/);
  assert.match(find('lfx-file-name-broker').textContent, /^scalable-broker_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.csv$/);

  find('lfx-prefix').type('conto*mio');
  await settle(() => find('lfx-prefix').value === 'contomio');
  assert.equal(page.stored.filePrefix, 'contomio');
  assert.match(textOf(find('lfx-file-name-archive')), /^contomio_\S+\.zip, con:contomio-broker_\S+\.csvcontomio-deposit_\S+\.csv$/);

  find('lfx-account-broker').click();
  assert.equal(find('lfx-file-name-archive'), null, 'one account: its CSV, without a ZIP');
  assert.equal(find('lfx-file-name-broker'), null);
  assert.match(find('lfx-file-name-deposit').textContent, /^contomio-deposit_\S+\.csv$/);
  find('lfx-account-deposit').click();
  assert.equal(find('lfx-file-names').hidden, true, 'no account, no file');
  find('lfx-account-broker').click();
  find('lfx-account-deposit').click();

  await acceptRiskAndExport(page);
  const [saved] = page.background.files();
  assert.match(saved.filename, /^contomio_\S+\.zip$/);
  assert.deepEqual(
    saved.entries.map((entry) => entry.name.split('_')[0]),
    ['contomio-broker', 'contomio-deposit'],
  );
});

test('one account is saved as its own CSV file', async () => {
  const page = loadContentScripts(createPage());
  await openPanel(page);
  page.find('lfx-account-broker').click();
  await acceptRiskAndExport(page);
  const files = page.background.files();
  assert.equal(files.length, 1);
  const [saved] = files;
  assert.match(saved.filename, /^scalable-deposit_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.csv$/);
  assert.equal(saved.entries, null);
  assert.ok(saved.text.startsWith('date;time;status;reference;'));
  assert.equal(page.find('lfx-progress-label').textContent, 'Scegli dove salvare il file');
  assert.equal(resultFile(page), `📄 ${saved.filename}`);
  assert.equal(page.find('lfx-progress-broker').hidden, true, 'only the chosen account has a row');
  assert.equal(page.find('lfx-progress-deposit-step').textContent, '✓ 2 movimenti');
  assert.deepEqual(Object.keys(page.stored.lastExportDates), ['deposit']);
});

test('an export cancelled while reading leaves no rows and no file', async () => {
  const page = loadContentScripts(createPage());
  await openPanel(page);
  page.server.depositPage = () => {
    page.find('lfx-cancel').click();
    return { status: 200, ok: true, type: 'basic', text: async () => depositPageHtml(DEPOSIT_RECIPE) };
  };
  await acceptRiskAndExport(page);
  assert.equal(page.find('lfx-status').textContent, 'Esportazione annullata.');
  assert.equal(page.find('lfx-progress').hidden, true, 'rows stopped half way would keep moving');
  assert.equal(resultFile(page), null);
  assert.deepEqual(page.background.files(), []);
  assert.equal(page.stored.lastExportDates, undefined);
});

test('closing the "Save as" window saves nothing, and the accounts do not count as exported', async () => {
  const page = loadContentScripts(createPage());
  await openPanel(page);
  page.background.dialogCancels = true;
  await acceptRiskAndExport(page);
  assert.equal(page.find('lfx-status').textContent, 'Salvataggio annullato: nessun file scritto.');
  assert.equal(resultFile(page), null);
  assert.equal(page.find('lfx-result-show').hidden, true);
  assert.equal(page.find('lfx-progress').hidden, false, 'the accounts were read: their rows stay');
  assert.deepEqual(page.background.files(), []);
  assert.equal(page.stored.lastExportDates, undefined);

  page.background.dialogCancels = false;
  page.background.windowPolls = 30;
  await acceptRiskAndExport(page);
  assert.equal(page.background.files().length, 1, 'saved once the user chooses, however long the window stays open');
  assert.deepEqual(Object.keys(page.stored.lastExportDates).sort(), ['broker', 'deposit']);
  assert.deepEqual(logged(page, 'save'), [
    { file: 'zip', state: 'cancelled' },
    { file: 'zip', state: 'chosen' },
  ]);
  assert.ok(!JSON.stringify(page.logs).includes('/Users/test'), 'folders are never logged');
});

test('a save failure is reported, and without the extension the page saves the files', async () => {
  const page = loadContentScripts(createPage());
  await openPanel(page);
  page.override = (message) => (message.type === 'lfx:save-as' ? { ok: false, error: 'disk full' } : undefined);
  await acceptRiskAndExport(page);
  assert.equal(page.find('lfx-status').className, 'status error');
  assert.equal(resultFile(page), null);
  assert.equal(page.find('lfx-status').textContent, 'Salvataggio dei file non riuscito: disk full');
  assert.equal(page.stored.lastExportDates, undefined, 'a failed save is not a done export');

  page.override = (message) => {
    if (message.type === 'lfx:save-as') throw new Error('Extension context invalidated.');
    return undefined;
  };
  await acceptRiskAndExport(page);
  assert.match(resultFile(page), /^📦 scalable_\S+\.zip$/);
  assert.equal(page.find('lfx-result-folder').textContent, '📁 Cartella: Download');
  assert.equal(page.find('lfx-result-show').hidden, true, 'saved by the page: nothing to show');
  assert.equal(page.anchorDownloads.length, 1);
  assert.match(page.anchorDownloads[0].name, /^scalable_\S+\.zip$/);
  const blob = page.blobs.get(page.anchorDownloads[0].url);
  assert.equal(blob.type, 'application/zip');
  const entries = unzip(Buffer.from(await blob.arrayBuffer()));
  assert.deepEqual(
    entries.map((entry) => entry.name.split('_')[0]),
    ['scalable-broker', 'scalable-deposit'],
  );
  assert.match(entries[1].text, /^date;time;status;/);
  assert.deepEqual(logged(page, 'download-fallback'), [{ reason: 'no answer from the extension' }]);
});

// Chrome cuts the script of an open page off from a reloaded extension: no id, every call fails.
function cutOff(page) {
  const gone = async () => {
    throw new Error('Extension context invalidated.');
  };
  page.chrome.runtime.id = undefined;
  page.chrome.runtime.sendMessage = gone;
  page.chrome.storage.local.get = gone;
  page.chrome.storage.local.set = gone;
}

test('a page left open while the extension is reloaded asks to be reloaded', async () => {
  const reloadText = 'L’estensione è stata aggiornata o ricaricata: ricarica questa pagina per usarla.';
  const page = loadContentScripts(createPage());
  cutOff(page);
  page.find('lfx-open').click();
  await settle(() => page.find('lfx-status').textContent !== '');
  assert.equal(page.find('lfx-status').textContent, reloadText);
  assert.equal(page.find('lfx-status').className, 'status error');
  assert.equal(page.find('lfx-risk').hidden, true, 'not the notice again, as if never accepted');
  assert.equal(page.find('lfx-export').disabled, true);
  assert.equal(page.find('lfx-update-check').disabled, true);

  const open = loadContentScripts(createPage());
  await openPanel(open);
  open.find('lfx-risk-accept').click();
  await settle(() => open.stored.riskAccepted === true);
  cutOff(open);
  open.find('lfx-export').click();
  await settle(() => open.find('lfx-status').textContent !== '');
  assert.equal(open.find('lfx-status').textContent, reloadText, 'a panel already open when the extension was reloaded');
  assert.equal(open.find('lfx-export').disabled, true);
  assert.deepEqual(open.calls, [], 'nothing is read from Scalable');
});

test('the button is shown on every web-app page, and only there', () => {
  const outside = loadContentScripts(createPage({ pathname: '/it/prezzi', search: '', session: {} }));
  assert.equal(outside.root, null, 'a public page without a logged-in tab');
  const known = loadContentScripts(createPage({ pathname: '/interest/overnight/sav-123456', search: '', session: {} }));
  assert.ok(known.root, 'a known web-app path');
  const home = loadContentScripts(createPage({ pathname: '/', search: '' }));
  assert.ok(home.root, 'any page of a logged-in tab, such as the home page');
});

test('the background merges ids per person, drops invalid ones and keeps five accounts at most', async () => {
  const background = createBackground();
  const remember = (message) => background.send(Object.assign({ type: 'lfx:remember-ids' }, message));
  const recall = async (personId = 'person-1') => plain(await background.send({ type: 'lfx:recall-ids', personId }));

  assert.equal(await background.send({ type: 'lfx:recall-ids', personId: 'person-1' }), null);
  assert.deepEqual(plain(await remember({ personId: 'person-1', portfolioId: 'pf-111111', savingsAccountIds: [] })), { ok: true });
  await remember({ personId: 'person-1', portfolioId: null, savingsAccountIds: ['sav-000001'] });
  assert.deepEqual(await recall(), { personId: 'person-1', portfolioId: 'pf-111111', savingsAccountIds: ['sav-000001'], depositRecipes: {} });

  const many = ['sav-000002', 'sav-000003', 'sav-000004', 'sav-000005', 'sav-000006'];
  await remember({ personId: 'person-1', savingsAccountIds: ['bad id', 7, 'sav-000001', ...many] });
  assert.deepEqual((await recall()).savingsAccountIds, many, 'the five most recent, without duplicates');

  assert.deepEqual(plain(await remember({ personId: 'x', portfolioId: 'pf-999999' })), { ok: false });
  assert.equal((await recall()).portfolioId, 'pf-111111');

  await remember({ personId: 'person-2', portfolioId: 'pf-222222' });
  assert.deepEqual(await recall('person-2'), { personId: 'person-2', portfolioId: 'pf-222222', savingsAccountIds: [], depositRecipes: {} }, 'another person starts afresh');

  await Promise.all([
    remember({ personId: 'person-2', savingsAccountIds: ['sav-aaaaaa'] }),
    remember({ personId: 'person-2', savingsAccountIds: ['sav-bbbbbb'] }),
  ]);
  assert.deepEqual((await recall('person-2')).savingsAccountIds, ['sav-aaaaaa', 'sav-bbbbbb'], 'tabs reporting together lose nothing');
});

test('the background saves files only within its limits', async () => {
  const background = createBackground();
  const download = async (files, folder) => plain(await background.send({ type: 'lfx:download', files, folder }));
  const csv = (name, text) => ({ name, dataUrl: filesApi.toDataUrl(text) });

  assert.deepEqual(await download([]), { ok: false, error: 'invalid file list' });
  assert.deepEqual(await download(Array.from({ length: 5 }, (_, index) => csv(`f${index}.csv`, 'x'))), { ok: false, error: 'invalid file list' });
  assert.deepEqual(await download([{ name: 'a.csv' }]), { ok: false, error: 'invalid file' });
  assert.deepEqual(await download([{ name: 'a.csv', dataUrl: 'https://example.com/a.csv' }]), { ok: false, error: 'invalid file' }, 'only data URLs built by the extension');
  assert.deepEqual(await download([{ name: 'a.html', dataUrl: 'data:text/html;base64,PGI+' }]), { ok: false, error: 'invalid file' });
  const tooLarge = { name: 'b.csv', dataUrl: `data:text/csv;charset=utf-8;base64,${'A'.repeat(2 * 1024 * 1024)}` };
  assert.deepEqual(await download([csv('a.csv', 'x'), tooLarge]), { ok: false, error: 'invalid file' });
  assert.equal(background.downloads.length, 0, 'nothing is saved when one file is refused');

  const answer = await download([csv('../a?.csv', 'x;y\n')], '../../Mie/Esportazioni');
  assert.deepEqual(answer, { ok: true, ids: [1] });
  assert.deepEqual(
    background.files().map((file) => [file.filename, file.saveAs, file.conflictAction, file.text]),
    [['Mie/Esportazioni/a.csv', false, 'uniquify', 'x;y\n']],
  );
});

test('the background shows only its own saved files in their folder', async () => {
  const background = createBackground();
  const { ids } = plain(await background.send({ type: 'lfx:download', files: [{ name: 'a.zip', dataUrl: filesApi.zipDataUrl(new Uint8Array([80, 75, 5, 6])) }], folder: '' }));
  assert.deepEqual(plain(await background.send({ type: 'lfx:show-download', id: ids[0] })), { ok: true });
  assert.deepEqual(background.shown, [ids[0]]);
  assert.deepEqual(plain(await background.send({ type: 'lfx:show-download', id: 99 })), { ok: false });
  assert.deepEqual(plain(await background.send({ type: 'lfx:show-download', id: '1' })), { ok: false });
  background.items.get(ids[0]).byExtensionId = 'another-extension';
  assert.deepEqual(plain(await background.send({ type: 'lfx:show-download', id: ids[0] })), { ok: false }, 'not a download of another extension');
  assert.deepEqual(background.shown, [ids[0]]);
});

test('the background answers only this extension, and only known messages', async () => {
  const background = createBackground();
  assert.equal(await background.send({ type: 'lfx:recall-ids' }, { id: 'another-extension' }), undefined);
  assert.equal(await background.send({ type: 'lfx:unknown' }), undefined);
  assert.equal(await background.send({ type: 'toString' }), undefined);
  assert.equal(await background.send(null), undefined);
});

test('the update check runs when the panel opens, at most daily, and on request', async () => {
  let answer = () => ({ status: 404, ok: false, json: async () => ({ message: 'Not Found' }) });
  const background = createBackground({ release: () => answer() });
  const page = loadContentScripts(createPage({ background }));
  const find = page.find;
  assert.equal(find('lfx-update-text').textContent, 'Versione 1.0.0', 'the version is shown before any check');

  await openPanel(page);
  assert.equal(find('lfx-update').getAttribute('data-state'), 'current', 'no release published yet: nothing newer');
  assert.equal(find('lfx-update-text').textContent, 'Versione 1.0.0 · aggiornata');
  assert.equal(find('lfx-update-link').hidden, true);
  assert.equal(background.releaseRequests, 1);

  find('lfx-close').click();
  await openPanel(page);
  assert.equal(background.releaseRequests, 1, 'opening again uses the daily cache');
  await pressUpdateCheck(page);
  assert.equal(background.releaseRequests, 1, 'a press right after a check reuses its answer');

  background.clock += 60 * 1000;
  answer = () => respond({ tag_name: 'v1.1.0', html_url: 'https://github.com/Librefolio/librefolio-exporter/releases/tag/v1.1.0' });
  await pressUpdateCheck(page);
  assert.equal(background.releaseRequests, 2, 'the button asks GitHub now');
  assert.equal(find('lfx-update').getAttribute('data-state'), 'available');
  assert.equal(find('lfx-update-text').textContent, 'È disponibile la versione 1.1.0.');
  assert.equal(find('lfx-update-link').hidden, false);
  assert.equal(find('lfx-update-link').href, 'https://github.com/Librefolio/librefolio-exporter/releases/tag/v1.1.0');

  background.clock += 60 * 1000;
  answer = () => {
    throw new TypeError('Failed to fetch');
  };
  await pressUpdateCheck(page);
  assert.equal(background.releaseRequests, 3);
  assert.equal(find('lfx-update').getAttribute('data-state'), 'available', 'a failed check keeps the release already known');

  const offline = loadContentScripts(createPage({ background: createBackground({ release: answer }) }));
  await openPanel(offline);
  assert.equal(offline.find('lfx-update').getAttribute('data-state'), 'failed');
  assert.equal(offline.find('lfx-update-text').textContent, 'Versione 1.0.0 · controllo non riuscito');

  const broken = loadContentScripts(createPage({ background: createBackground({ release: () => respond({ unexpected: true }) }) }));
  await openPanel(broken);
  assert.equal(broken.find('lfx-update').getAttribute('data-state'), 'failed', 'an answer without a release tag is a failed check');
});

test('the background keeps a checked recipe per overnight account, for the same person only', async () => {
  const background = createBackground();
  const remember = (message) => background.send(Object.assign({ type: 'lfx:remember-ids', personId: 'person-1' }, message));
  const recall = async (personId = 'person-1') => plain(await background.send({ type: 'lfx:recall-ids', personId }));
  const recipe = Object.assign({ savingsAccountId: 'sav-123456' }, DEPOSIT_RECIPE);

  await remember({ depositRecipe: recipe });
  assert.deepEqual(await recall(), { personId: 'person-1', portfolioId: null, savingsAccountIds: ['sav-123456'], depositRecipes: { 'sav-123456': DEPOSIT_RECIPE } });

  await remember({ savingsAccountIds: ['sav-000002'] });
  assert.deepEqual(Object.keys((await recall()).depositRecipes), ['sav-123456'], 'other pages keep the recipe');

  for (const broken of [
    Object.assign({}, recipe, { savingsAccountId: 'sav-000003', query: 'query X { a }' }),
    Object.assign({}, recipe, { savingsAccountId: 'sav-000004', operationName: 'bad name!' }),
    Object.assign({}, recipe, { savingsAccountId: 'sav-000005', query: `${DEPOSIT_RECIPE.query} #${'x'.repeat(8000)}` }),
    Object.assign({}, recipe, { savingsAccountId: 'sav-000006', variables: 'not an object' }),
  ]) {
    await remember({ depositRecipe: broken });
  }
  assert.deepEqual(Object.keys((await recall()).depositRecipes), ['sav-123456'], 'invalid recipes are refused');

  await background.send({ type: 'lfx:remember-ids', personId: 'person-2', portfolioId: 'pf-222222' });
  assert.deepEqual((await recall('person-2')).depositRecipes, {}, 'another person starts afresh');
});

test('files keep their names when another extension renames downloads', async () => {
  const background = createBackground();
  background.ignoreNames = true;
  const page = loadContentScripts(createPage({ background }));
  await openPanel(page);
  await acceptRiskAndExport(page);
  assert.equal(page.find('lfx-result-box').hidden, false);
  const names = background.files().map((file) => file.filename);
  assert.equal(names.length, 1);
  assert.match(names[0], /^scalable_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/);

  const listener = background.nameListeners[0];
  let suggested = 'not asked';
  listener({ id: 99, url: 'https://example.com/file.pdf', filename: 'file.pdf', byExtensionId: undefined }, (suggestion) => {
    suggested = suggestion;
  });
  assert.equal(suggested, 'not asked', 'other downloads are left untouched');
});

test('accounts seen on the pages survive an extension reload, per person, without storing the person id', async () => {
  const background = createBackground();
  await background.send({ type: 'lfx:remember-ids', personId: 'person-123456', portfolioId: 'pf-123456', savingsAccountIds: ['sav-123456'] });
  background.session = {};
  assert.deepEqual(plain(await background.send({ type: 'lfx:recall-ids', personId: 'person-123456' })), {
    personId: 'person-123456',
    portfolioId: 'pf-123456',
    savingsAccountIds: ['sav-123456'],
    depositRecipes: {},
  });
  assert.equal(await background.send({ type: 'lfx:recall-ids', personId: 'person-999999' }), null);
  const kept = JSON.stringify(background.local.knownAccounts);
  assert.doesNotMatch(kept, /person-123456/);
  assert.deepEqual(Object.keys(background.local.knownAccounts).map((key) => /^[0-9a-f]{64}$/.test(key)), [true]);

  const page = loadContentScripts(createPage({ background, links: [] }));
  await openPanel(page);
  await acceptRiskAndExport(page);
  assert.equal(page.find('lfx-result-box').hidden, false, page.find('lfx-status').textContent);
  assert.deepEqual(logged(page, 'identifiers')[0].overnight, 'remembered', 'from the broker page, after a reload');
  assert.ok(page.calls.some((call) => call.operation === 'Transactions'));
});
