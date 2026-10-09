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
  // root: Chrome's download folder. A file with a window (saveAs, or any file when
  // askEveryFile, Chrome's "ask where to save each file") stays unnamed for windowPolls
  // looks, then is saved in dialogDirectory; it is cancelled when dialogCancels is true, or
  // is the number of the first window the user closes. Paths matching refuseNames are refused.
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
    dialogDirectory: '/Users/test/Downloads/Reports',
    dialogCancels: false,
    askEveryFile: false,
    windowPolls: 0,
    refuseNames: null,
    dialogs: 0,
    items: new Map(),
    removed: [],
  };
  class FakeDate extends Date {}
  FakeDate.now = () => background.clock;
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getManifest: () => ({ version: '0.1.0' }),
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
        if (background.refuseNames && background.refuseNames.test(options.filename)) throw new Error('Invalid filename');
        const item = { id: background.downloads.length + 1, url: options.url, filename: background.ignoreNames ? 'download.csv' : options.filename, byExtensionId: EXTENSION_ID };
        let finalName = item.filename;
        for (const listener of background.nameListeners) {
          listener(item, (suggestion) => {
            if (suggestion && suggestion.filename) finalName = suggestion.filename;
          });
        }
        const window = options.saveAs === true || background.askEveryFile;
        const entry = { id: item.id, filename: `${background.root}/${finalName}`, state: 'complete', pending: 0, byExtensionId: EXTENSION_ID };
        if (window) {
          background.dialogs++;
          entry.pending = background.windowPolls;
          const cancels = background.dialogCancels === true || (typeof background.dialogCancels === 'number' && background.dialogs >= background.dialogCancels);
          if (cancels) Object.assign(entry, { filename: '', state: 'interrupted', error: 'USER_CANCELED' });
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
          return [{ id: entry.id, filename: '', state: 'in_progress', byExtensionId: EXTENSION_ID }];
        }
        return [{ id: entry.id, filename: entry.filename, state: entry.state, error: entry.error, byExtensionId: EXTENSION_ID }];
      },
      removeFile: async (id) => {
        const entry = background.items.get(id);
        if (!entry || entry.state !== 'complete' || entry.pending > 0) throw new Error('Download must be complete');
        entry.removed = true;
        background.removed.push(entry.filename);
      },
      cancel: async (id) => {
        const entry = background.items.get(id);
        if (entry && entry.state !== 'complete') Object.assign(entry, { state: 'interrupted', error: 'USER_CANCELED' });
      },
      erase: async (query) => {
        background.items.delete(query.id);
        return [query.id];
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
  // The files saved and still there, with the name each was given.
  const kept = () => background.downloads.filter((options) => options.entry.state === 'complete' && !options.entry.removed);
  background.saved = () => kept().map((options) => options.entry.filename);
  background.files = () =>
    kept().map((options) => ({
      filename: options.finalName,
      saveAs: options.saveAs,
      conflictAction: options.conflictAction,
      text: Buffer.from(options.url.split(',')[1], 'base64').toString('utf8'),
    }));
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
      getManifest: () => ({ version: '0.1.0' }),
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
    fetch: scalableServer(page.calls, page.server),
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

function resultLines(page) {
  return page.find('lfx-result').children.map(textOf);
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
  assert.equal(find('lfx-status').textContent, '');
  assert.deepEqual(resultLines(page), [
    `✅ ${page.background.files()[0].filename} — 2 transazioni del conto broker`,
    `✅ ${page.background.files()[1].filename.split('/').pop()} — 2 movimenti del conto deposito`,
  ]);
  assert.equal(find('lfx-result-folder').textContent, '📁 Cartella: /Users/test/Downloads/Reports');
  assert.equal(find('lfx-progress').hidden, true, 'the progress bar is shown only while exporting');
  assert.equal(find('lfx-warnings').hidden, true, warningTexts(page).join(' | '));

  assert.deepEqual(callNames(page), [...BROKER_CALLS, 'GET /interest/overnight/sav-123456/transactions/', ...DEPOSIT_CALLS]);
  assert.ok(page.calls.every((call) => call.credentials === 'same-origin'));
  assert.equal(page.calls[2].redirect, 'manual');
  assert.equal(page.calls[0].variables.personId, 'person-123456');
  assert.equal(page.calls[0].variables.portfolioId, 'pf-123456');
  assert.deepEqual(page.calls[3].variables, DEPOSIT_RECIPE.variables, 'the list is read with the page’s own variables');
  assert.deepEqual(page.calls[4].variables, { personId: 'short-123456', savingsAccountId: 'sav-123456', transactionId: 'd1' });

  assert.equal(page.anchorDownloads.length, 0, 'saved by the extension, not by the page');
  const files = page.background.files();
  assert.equal(files.length, 2);
  assert.match(files[0].filename, /^scalable-broker_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.csv$/);
  assert.match(files[1].filename, /^Reports\/scalable-deposit_.*\.csv$/, 'the second file goes next to the first, inside the download folder');
  assert.equal(page.background.dialogs, 1, 'one "Save as" window for both files');
  assert.deepEqual(
    plain(page.background.saved()).map((saved) => saved.slice(0, saved.lastIndexOf('/'))),
    ['/Users/test/Downloads/Reports', '/Users/test/Downloads/Reports'],
  );
  assert.deepEqual(
    plain(page.background.removed),
    [`/Users/test/Downloads/${files[1].filename.split('/').pop()}`],
    'the first time, the second file lands in Chrome’s download folder, which shows where that is, and is moved',
  );
  assert.equal(page.background.local.downloadRoot, '/Users/test/Downloads');
  assert.equal(files[0].filename.slice(-23), files[1].filename.slice(-23), 'both files share the time stamp');
  assert.deepEqual(files.map((file) => [file.saveAs, file.conflictAction]), [[true, 'uniquify'], [false, 'uniquify']]);

  const lines = files[0].text.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('date;time;status;reference;description;assetType;type;isin;shares;price;amount;fee;tax;currency;lf_account;'));
  assert.ok(lines[1].startsWith('2026-09-01;10:00:00;Executed;"R1";"Some ETF";Security;Savings plan;IE00TEST0001;2,5;100;-250;0;0;EUR;broker;1;t1;'));
  assert.ok(lines[2].includes(';"Deposit; ""SEPA""";Cash;Deposit;'));
  assert.ok(lines[1].endsWith(';yes;librefolio-exporter/0.1.0;1'));
  const deposit = files[1].text.trimEnd().split('\n');
  assert.equal(deposit.length, 3);
  assert.ok(deposit[1].startsWith('2026-10-01;01:00:00;Executed;"RI-1";"Interest";Cash;Interest;;;;1,23;;0,44;EUR;deposit;1;d1;'), deposit[1]);
  assert.ok(deposit[1].includes(';0.44;1.67;'), 'tax and gross amount of the interest');
  assert.ok(deposit[2].startsWith('2026-09-29;12:00:00;Executed;"d2";"Withdrawal";Cash;Withdrawal;;;;-2,5;;;EUR;deposit;1;d2;'), deposit[2]);

  assert.deepEqual(plain(page.stored.lastExportDates), { broker: format.todayBerlin(), deposit: format.todayBerlin() });
  assert.equal(find('lfx-last-export').hidden, false);
  assert.equal(find('lfx-preset-last').hidden, false, 'the "since last export" preset appears');
  assert.equal(find('lfx-export').disabled, false, 'the panel is usable again');

  assert.deepEqual(plain(page.background.session.rememberedIds), { personId: 'person-123456', portfolioId: 'pf-123456', savingsAccountIds: ['sav-123456'], depositRecipes: {} });
  assertNoSecrets(page);
  assert.deepEqual(logged(page, 'identifiers'), [{ person: 'sessionStorage', portfolio: 'url', overnight: 'page', overnightAccounts: 1, overnightRecipes: [] }]);
  assert.deepEqual(logged(page, 'overnight-recipe'), [{ source: 'download', operation: 'Transactions' }]);
  assert.equal(logged(page, 'request').length, 5);
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
  assert.equal(transactionsPage.find('lfx-result').hidden, false, transactionsPage.find('lfx-status').textContent);
  assert.deepEqual(callNames(transactionsPage), [...BROKER_CALLS, ...DEPOSIT_CALLS], 'no page download');
  assert.deepEqual(logged(transactionsPage, 'identifiers'), [{ person: 'sessionStorage', portfolio: 'remembered', overnight: 'page', overnightAccounts: 1, overnightRecipes: ['page'] }]);
  assertNoSecrets(transactionsPage);

  const home = loadContentScripts(createPage({ background, pathname: '/cockpit/', search: '', links: [] }));
  await openPanel(home);
  home.find('lfx-preset-all').click();
  await acceptRiskAndExport(home);
  assert.equal(home.find('lfx-result').hidden, false);
  assert.deepEqual(callNames(home), [...BROKER_CALLS, ...DEPOSIT_CALLS]);
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
  assert.equal(resultLines(page).length, 1, 'the broker is still saved');
  assert.deepEqual(warningTexts(page), [
    'Conto deposito: Apri su Scalable la pagina «Transazioni» del conto deposito, poi esporta da lì.',
    'Dettagli tecnici: depositPage: redirect',
  ]);
  assert.deepEqual(callNames(page), [...BROKER_CALLS, 'GET /interest/overnight/sav-123456/transactions/'], 'the redirect is not followed');
  assert.equal(page.background.files().length, 1);
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

test('the prefix is the only saving setting: Chrome’s window chooses the folder every time', async () => {
  const page = loadContentScripts(createPage());
  await openPanel(page);
  const find = page.find;
  assert.equal(find('lfx-prefix').value, 'scalable');
  assert.equal(find('lfx-prefix').hidden, false, 'shown at once, without an edit button');
  assert.equal(find('lfx-save-edit'), null);
  assert.equal(find('lfx-folder'), null, 'no folder setting');
  assert.equal(find('lfx-ask-where'), null, 'no "ask where" setting');
  assert.match(find('lfx-file-name-broker').textContent, /^scalable-broker_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.csv$/);
  assert.match(find('lfx-file-name-deposit').textContent, /^scalable-deposit_\S+\.csv$/);

  find('lfx-prefix').type('conto*mio');
  await settle(() => find('lfx-prefix').value === 'contomio');
  assert.equal(page.stored.filePrefix, 'contomio');
  assert.match(find('lfx-file-name-broker').textContent, /^contomio-broker_\S+\.csv$/);
  assert.match(find('lfx-file-name-deposit').textContent, /^contomio-deposit_\S+\.csv$/);

  await acceptRiskAndExport(page);
  const files = page.background.files();
  assert.match(files[0].filename, /^contomio-broker_/);
  assert.match(files[1].filename, /^Reports\/contomio-deposit_/);
  assert.equal(page.background.dialogs, 1);
});

// The broker file is saved first, with Chrome's window; the deposit file follows.
function savedFolders(background) {
  return plain(background.saved()).map((saved) => saved.slice(0, saved.lastIndexOf('/')));
}

test('the second file goes next to the first without a window, whenever Chrome allows it', async () => {
  const page = loadContentScripts(createPage());
  await openPanel(page);
  const background = page.background;
  await acceptRiskAndExport(page);
  assert.equal(background.removed.length, 1, 'the first export learns Chrome’s download folder');
  assert.equal(page.find('lfx-progress-label').textContent, 'Scegli dove salvare: se è dentro Download, l’altro file ci andrà da solo');

  await acceptRiskAndExport(page);
  assert.equal(background.removed.length, 1, 'then the second file goes straight next to the first');
  assert.equal(background.dialogs, 2, 'one window per export');
  assert.deepEqual(savedFolders(background).slice(2), ['/Users/test/Downloads/Reports', '/Users/test/Downloads/Reports']);

  background.dialogDirectory = '/Users/test/Downloads';
  await acceptRiskAndExport(page);
  assert.deepEqual(savedFolders(background).slice(4), ['/Users/test/Downloads', '/Users/test/Downloads'], 'the download folder itself');
  assert.equal(background.dialogs, 3);

  background.dialogDirectory = '/Users/test/Documents/Finanza';
  await acceptRiskAndExport(page);
  assert.equal(background.dialogs, 5, 'outside the download folder, Chrome needs a window for each file');
  assert.equal(background.removed.length, 1, 'and nothing is written in the download folder first');
  assert.deepEqual(resultLines(page).length, 2);
  assert.equal(page.find('lfx-result-folder').textContent, '📁 Cartella: /Users/test/Documents/Finanza', 'both chosen in the same folder');
  assert.equal(
    page.find('lfx-progress-label').textContent,
    'Chrome chiede dove salvare anche l’altro file: scegli la stessa cartella',
    'its window starts in the download folder: the label says where to go',
  );

  background.dialogDirectory = '/Users/test/Downloads/.private';
  await acceptRiskAndExport(page);
  assert.equal(background.dialogs, 7, 'a folder name that would not reach Chrome unchanged: a window');

  background.dialogDirectory = '/Users/test/Downloads/Reports';
  background.refuseNames = /^Reports\//;
  await acceptRiskAndExport(page);
  assert.equal(background.dialogs, 9, 'a path Chrome refuses: a window');
  assert.equal(background.removed.length, 1);
  assert.deepEqual(logged(page, 'save-next').slice(-1), [{ account: 'deposit', how: 'window', state: 'chosen' }]);
  assert.ok(!JSON.stringify(page.logs).includes('/Users/test'), 'folders are never logged');
});

test('with Chrome set to ask where to save each file, each file has its window and none is moved', async () => {
  const page = loadContentScripts(createPage());
  await openPanel(page);
  const background = page.background;
  background.askEveryFile = true;
  background.windowPolls = 40;
  await acceptRiskAndExport(page);
  assert.equal(background.dialogs, 2);
  assert.deepEqual(background.removed, [], 'a file saved through a window is never moved');
  assert.deepEqual(savedFolders(background), ['/Users/test/Downloads/Reports', '/Users/test/Downloads/Reports']);
  assert.equal(resultLines(page).length, 2);
  assert.equal(page.find('lfx-result-folder').textContent, '📁 Cartella: /Users/test/Downloads/Reports');
  assert.equal(background.local.downloadRoot, undefined, 'nothing learnt from a window');
});

test('closing a window saves nothing more, and only saved accounts count as exported', async () => {
  const page = loadContentScripts(createPage());
  await openPanel(page);
  const background = page.background;
  background.dialogCancels = true;
  await acceptRiskAndExport(page);
  assert.equal(page.find('lfx-status').textContent, 'Salvataggio annullato: nessun file scritto.');
  assert.equal(page.find('lfx-result').hidden, true);
  assert.deepEqual(background.saved(), []);
  assert.equal(page.stored.lastExportDates, undefined);

  background.dialogCancels = 3;
  background.dialogDirectory = '/Users/test/Documents';
  await acceptRiskAndExport(page);
  assert.equal(background.dialogs, 3, 'the deposit file had its own window, closed by the user');
  assert.equal(page.find('lfx-status').textContent, '');
  assert.deepEqual(resultLines(page).map((line) => line.split(' — ')[1]), ['2 transazioni del conto broker']);
  assert.equal(page.find('lfx-result-folder').textContent, '📁 Cartella: /Users/test/Documents');
  assert.deepEqual(Object.keys(page.stored.lastExportDates), ['broker'], 'the deposit is not exported yet');
});

test('a changed download folder is learnt again from where the file lands', async () => {
  const page = loadContentScripts(createPage());
  await openPanel(page);
  const background = page.background;
  const week = 7 * 24 * 60 * 60 * 1000;
  Object.assign(background.local, { downloadRoot: '/Users/test/Old', downloadRootCheckedAt: background.clock });
  background.dialogDirectory = '/Users/test/Old/Reports';
  await acceptRiskAndExport(page);
  assert.equal(background.local.downloadRoot, '/Users/test/Downloads', 'the file landed in the new download folder');
  assert.equal(background.removed.length, 1, 'and was taken away from there');
  assert.equal(background.dialogs, 2, 'the chosen folder is outside the new download folder: a window');

  background.dialogDirectory = '/Users/test/Downloads/Reports';
  Object.assign(background.local, { downloadRoot: '/Users/test/Old', downloadRootCheckedAt: background.clock });
  await acceptRiskAndExport(page);
  assert.equal(background.dialogs, 4, 'outside the known folder, checked recently: a window at once');
  assert.equal(background.removed.length, 1);

  background.local.downloadRootCheckedAt = background.clock - week;
  await acceptRiskAndExport(page);
  assert.equal(background.dialogs, 5, 'checked again after a week: one window');
  assert.equal(background.local.downloadRoot, '/Users/test/Downloads');
  assert.deepEqual(savedFolders(background).slice(-2), ['/Users/test/Downloads/Reports', '/Users/test/Downloads/Reports']);
});

test('paths below the download folder are compared as Chrome reports them', () => {
  const { relativeFolder, rootFrom, sameDirectory } = createBackground().context;
  assert.equal(relativeFolder('/Users/t/Downloads', '/Users/t/Downloads/'), '');
  assert.equal(relativeFolder('/Users/t/Downloads', '/Users/t/Downloads/LibreFolio/2026'), 'LibreFolio/2026');
  assert.equal(relativeFolder('/Users/t/Downloads', '/Users/t/Downloads2/x'), null);
  assert.equal(relativeFolder('/Users/t/Downloads', '/Users/t/Documents'), null);
  assert.equal(relativeFolder('/Users/t/Downloads', '/Users/t/Downloads/a/b/c/d/e/f'), null, 'deeper than Chrome’s paths here');
  assert.equal(relativeFolder('/Users/t/Downloads', '/Users/t/Downloads/Esportazioni  2026'), null, 'a name that would change');
  assert.equal(relativeFolder('/Users/t/Downloads', '/Users/t/Downloads/Spese e\u0301'), 'Spese \u00e9');
  assert.equal(relativeFolder('C:\\Users\\T\\Downloads', 'c:\\users\\t\\downloads\\Export'), 'Export');
  assert.equal(relativeFolder('', '/Users/t/Downloads'), null);
  assert.equal(rootFrom('/Users/t/Downloads/LibreFolio/2026', 'LibreFolio/2026'), '/Users/t/Downloads');
  assert.equal(rootFrom('/Users/t/Downloads', ''), '/Users/t/Downloads');
  assert.equal(rootFrom('/Users/t/Other', 'LibreFolio'), '');
  assert.equal(rootFrom('C:\\D\\Export', 'export'), 'C:\\D');
  assert.equal(sameDirectory('/Users/t/Spese e\u0301', '/Users/t/Spese \u00e9/'), true);
  assert.equal(sameDirectory('/Users/t/a', '/Users/t/A'), false);
  assert.equal(sameDirectory('C:\\Users\\T', 'c:\\users\\t'), true);
});

test('a save failure is reported, and without the extension the page saves the files', async () => {
  const page = loadContentScripts(createPage());
  await openPanel(page);
  page.override = (message) => (message.type === 'lfx:save-first' ? { ok: false, error: 'disk full' } : undefined);
  await acceptRiskAndExport(page);
  assert.equal(page.find('lfx-status').className, 'status error');
  assert.equal(page.find('lfx-result').hidden, true);
  assert.equal(page.find('lfx-status').textContent, 'Salvataggio dei file non riuscito: disk full');
  assert.equal(page.stored.lastExportDates, undefined, 'a failed save is not a done export');

  page.override = (message) => {
    if (message.type === 'lfx:save-first') throw new Error('Extension context invalidated.');
    return undefined;
  };
  await acceptRiskAndExport(page);
  assert.equal(page.find('lfx-result').hidden, false);
  assert.equal(page.find('lfx-result-folder').textContent, '📁 Cartella: Download');
  assert.equal(page.anchorDownloads.length, 2);
  assert.match(page.anchorDownloads[0].name, /^scalable-broker_/);
  assert.match(await page.blobs.get(page.anchorDownloads[1].url).text(), /^date;time;status;/);
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
  const download = async (files, folder) => plain(await background.send({ type: 'lfx:download', files, folder, saveAs: false }));
  const file = (name, content) => ({ name, content });

  assert.deepEqual(await download([]), { ok: false, error: 'invalid file list' });
  assert.deepEqual(await download(Array.from({ length: 5 }, (_, index) => file(`f${index}.csv`, 'x'))), { ok: false, error: 'invalid file list' });
  assert.deepEqual(await download([{ name: 'a.csv' }]), { ok: false, error: 'invalid file' });
  assert.deepEqual(await download([file('a.csv', 'x'), file('b.csv', 'x'.repeat(2 * 1024 * 1024))]), { ok: false, error: 'file too large' });
  assert.equal(background.downloads.length, 0, 'nothing is saved when one file is refused');

  assert.deepEqual(await download([file('../a?.csv', 'x;y\n')], '../../Mie/Esportazioni'), { ok: true, count: 1 });
  assert.deepEqual(plain(background.files()), [{ filename: 'Mie/Esportazioni/a.csv', saveAs: false, conflictAction: 'uniquify', text: 'x;y\n' }]);
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
  assert.equal(find('lfx-update-text').textContent, 'Versione 0.1.0', 'the version is shown before any check');

  await openPanel(page);
  assert.equal(find('lfx-update').getAttribute('data-state'), 'current', 'no release published yet: nothing newer');
  assert.equal(find('lfx-update-text').textContent, 'Versione 0.1.0 · aggiornata');
  assert.equal(find('lfx-update-link').hidden, true);
  assert.equal(background.releaseRequests, 1);

  find('lfx-close').click();
  await openPanel(page);
  assert.equal(background.releaseRequests, 1, 'opening again uses the daily cache');
  await pressUpdateCheck(page);
  assert.equal(background.releaseRequests, 1, 'a press right after a check reuses its answer');

  background.clock += 60 * 1000;
  answer = () => respond({ tag_name: 'v0.2.0', html_url: 'https://github.com/Librefolio/librefolio-exporter/releases/tag/v0.2.0' });
  await pressUpdateCheck(page);
  assert.equal(background.releaseRequests, 2, 'the button asks GitHub now');
  assert.equal(find('lfx-update').getAttribute('data-state'), 'available');
  assert.equal(find('lfx-update-text').textContent, 'È disponibile la versione 0.2.0.');
  assert.equal(find('lfx-update-link').hidden, false);
  assert.equal(find('lfx-update-link').href, 'https://github.com/Librefolio/librefolio-exporter/releases/tag/v0.2.0');

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
  assert.equal(offline.find('lfx-update-text').textContent, 'Versione 0.1.0 · controllo non riuscito');

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
  assert.equal(page.find('lfx-result').hidden, false);
  const names = background.files().map((file) => file.filename);
  assert.equal(names.length, 2);
  assert.match(names[0], /^scalable-broker_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.csv$/);
  assert.match(names[1], /^Reports\/scalable-deposit_/);

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
  assert.equal(page.find('lfx-result').hidden, false, page.find('lfx-status').textContent);
  assert.deepEqual(logged(page, 'identifiers')[0].overnight, 'remembered', 'from the broker page, after a reload');
  assert.ok(page.calls.some((call) => call.operation === 'Transactions'));
});
