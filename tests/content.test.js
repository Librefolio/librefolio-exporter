'use strict';

/*
 * End-to-end smoke test of the content scripts as the browser loads them: plain
 * scripts sharing the LFX namespace, in manifest order, inside a fake page with
 * a minimal DOM, chrome.* API and Scalable GraphQL endpoint.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://de.scalable.capital';

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
    if (this.tagName === 'A') this.page.downloads.push({ name: this.download, url: this.href });
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

function scalableServer(calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, operation: body.operationName, variables: body.variables, credentials: init.credentials });
    switch (body.operationName) {
      case 'moreTransactions':
        return respond({
          data: {
            account: {
              brokerPortfolio: {
                moreTransactions: {
                  cursor: null,
                  transactions: [
                    {
                      __typename: 'BrokerSecurityTransactionSummary', id: 't1', type: 'SECURITY_TRANSACTION', status: 'SETTLED',
                      lastEventDateTime: '2026-09-01T08:00:00Z', description: 'Some ETF', securityTransactionType: 'SAVINGS_PLAN',
                      side: 'BUY', quantity: 2.5, amount: -250, isin: 'IE00TEST0001', currency: 'EUR',
                    },
                    {
                      __typename: 'BrokerCashTransactionSummary', id: 'c1', type: 'CASH_TRANSACTION', status: 'SETTLED',
                      lastEventDateTime: '2026-08-31T08:00:00Z', description: 'Deposit; "SEPA"', cashTransactionType: 'DEPOSIT', amount: 500, currency: 'EUR',
                    },
                  ],
                },
              },
            },
          },
        });
      case 'getTransactionDetails':
        return respond({ data: { account: { brokerPortfolio: { transactionDetails: { transactionReference: 'R1', averagePrice: 100, tradeTransactionAmounts: { transactionFee: 0, taxAmount: 0 } } } } } });
      case 'getSavingsProducts':
        return respond({ data: { account: { savingsAccounts: [{ __typename: 'OvernightSavingsAccount', id: 'sav-123456' }] } } });
      case 'OvernightTransactions':
        return respond({
          data: {
            account: {
              savingsAccount: {
                totalAmount: 1000,
                moreTransactions: {
                  cursor: null,
                  transactions: [{ id: 'd1', type: 'CASH_TRANSACTION', status: 'SETTLED', description: 'Interest', amount: 1.23, currency: 'EUR', lastEventDateTime: '2026-09-30T23:00:00Z', cashTransactionType: 'INTEREST' }],
                },
              },
            },
          },
        });
      default:
        return { status: 400, ok: false, json: async () => ({}) };
    }
  };
}

function createPage() {
  const page = { downloads: [], blobs: new Map(), stored: {}, calls: [], intervals: [], logs: [], tables: [] };
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
    querySelectorAll: () => [],
  };
  const chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ version: '0.1.0' }),
      sendMessage: async (message) => {
        assert.equal(message.type, 'lfx:update-status');
        return { enabled: true, available: true, latest: '9.9.9', url: 'https://github.com/Librefolio/librefolio-exporter/releases/tag/v9.9.9' };
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
  let blobCount = 0;
  page.context = vm.createContext({
    document: page.document,
    chrome,
    navigator: { language: 'it-IT' },
    location: { origin: ORIGIN, pathname: '/broker/transactions', search: '?portfolioId=pf-123456' },
    sessionStorage: fakeStorage({ uniqueId: 'person-123456' }),
    localStorage: fakeStorage({}),
    fetch: scalableServer(page.calls),
    URL: {
      createObjectURL: (blob) => {
        const url = `blob:${ORIGIN}/${++blobCount}`;
        page.blobs.set(url, blob);
        return url;
      },
      revokeObjectURL: () => {},
    },
    URLSearchParams,
    Blob,
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
      table: (rows) => page.tables.push(rows),
      warn: () => {},
      error: () => {},
    },
  });
  return page;
}

function loadContentScripts(page) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  for (const file of manifest.content_scripts[0].js) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), page.context, { filename: file });
  }
}

async function settle(condition) {
  for (let round = 0; round < 500; round++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition not met');
}

test('the content scripts export both accounts end to end', async () => {
  const page = createPage();
  loadContentScripts(page);

  const rootNode = page.document.body.findByTestId('lfx-root');
  assert.ok(rootNode, 'the button is shown on a web-app page');
  assert.equal(page.intervals[0].ms, 1000, 'route changes are followed');
  const find = (testId) => rootNode.findByTestId(testId);

  find('lfx-open').click();
  await settle(() => !find('lfx-update').hidden);
  assert.equal(find('lfx-panel').hidden, false);
  assert.equal(find('lfx-risk').hidden, false, 'the risk notice is shown first');
  assert.equal(find('lfx-export').disabled, true, 'no export before the notice is accepted');
  assert.equal(find('lfx-update-text').textContent, 'È disponibile la versione 9.9.9.');

  find('lfx-risk-accept').click();
  await settle(() => page.stored.riskAccepted === true);
  assert.equal(find('lfx-risk').hidden, true);
  assert.equal(find('lfx-export').disabled, false);

  find('lfx-export').click();
  await settle(() => find('lfx-status').className === 'status success');
  assert.equal(find('lfx-status').textContent, 'Fatto: 2 transazioni del broker, 1 del conto deposito.');

  assert.deepEqual(
    page.calls.map((call) => call.operation),
    ['moreTransactions', 'getTransactionDetails', 'getSavingsProducts', 'OvernightTransactions'],
  );
  assert.ok(page.calls.every((call) => call.url.startsWith(`${ORIGIN}/`) && call.credentials === 'same-origin'));
  assert.equal(page.calls[0].variables.personId, 'person-123456');
  assert.equal(page.calls[0].variables.portfolioId, 'pf-123456');

  assert.equal(page.downloads.length, 2);
  assert.match(page.downloads[0].name, /^scalable-broker_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.csv$/);
  assert.match(page.downloads[1].name, /^scalable-deposit_.*\.csv$/);

  const broker = await page.blobs.get(page.downloads[0].url).text();
  const lines = broker.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('date;time;status;reference;description;assetType;type;isin;shares;price;amount;fee;tax;currency;lf_account;'));
  assert.ok(lines[1].startsWith('2026-09-01;10:00:00;Executed;"R1";"Some ETF";Security;Savings plan;IE00TEST0001;2,5;100;-250;0;0;EUR;broker;1;t1;'));
  assert.ok(lines[2].includes(';"Deposit; ""SEPA""";Cash;Deposit;'));
  assert.ok(lines[1].endsWith(';yes;librefolio-exporter/0.1.0;1'));

  const deposit = await page.blobs.get(page.downloads[1].url).text();
  assert.ok(deposit.split('\n')[1].startsWith('2026-10-01;01:00:00;Executed;"d1";"Interest";Cash;Interest;;;;1,23;;;EUR;deposit;1;d1;'));

  assert.match(page.stored.lastExportDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(find('lfx-last-export').hidden, false);
  assert.equal(find('lfx-export').disabled, false, 'the panel is usable again');

  const diagnostics = JSON.stringify([page.logs, page.tables]);
  for (const secret of ['person-123456', 'pf-123456', 'sav-123456', 'Some ETF', 'SEPA', 'IE00TEST0001', '-250', 'R1']) {
    assert.ok(!diagnostics.includes(secret), `diagnostics must not contain ${secret}`);
  }
  assert.ok(page.logs.some((entry) => entry[1] === 'identifiers' && entry[2].person === 'sessionStorage' && entry[2].portfolio === 'url'));
  assert.equal(page.logs.filter((entry) => entry[1] === 'request').length, 4);
  assert.equal(page.tables.length, 1);
  assert.equal(page.tables[0].reduce((total, entry) => total + entry.count, 0), 3);
});

test('the button is not shown outside the web app', () => {
  const page = createPage();
  page.context.location.pathname = '/it/prezzi';
  loadContentScripts(page);
  assert.equal(page.document.body.findByTestId('lfx-root'), null);
});
