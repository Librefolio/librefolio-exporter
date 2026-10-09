'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const exporter = require('../src/brokers/scalable/exporter.js');
const { ExportError } = require('../src/brokers/scalable/client.js');
const mapping = require('../src/brokers/scalable/mapping.js');

const CONTEXT = { exporter: 'librefolio-exporter/0.0.0-test' };
const IDS = { personId: 'person', portfolioId: 'portfolio', savingsAccountIds: ['s1'] };
const RECIPE = {
  operationName: 'Transactions',
  query: 'query Transactions($personId:ID!$input:SavingsAccountCashTransactionInput!$portfolioId:ID!){account(id:$personId){savingsAccount(id:$portfolioId){moreTransactions(input:$input){cursor total transactions{id}}}}}',
  variables: { personId: 'short-1', portfolioId: 's1', input: { pageSize: 50 } },
};

function interest(id, timestamp, status) {
  return { id, type: 'CASH_TRANSACTION', status: status || 'SETTLED', cashTransactionType: 'INTEREST', amount: 2, currency: 'EUR', lastEventDateTime: timestamp };
}
const ALL = { broker: true, deposit: true, details: true, from: '', to: '' };

function trade(id, timestamp, status) {
  return {
    __typename: 'BrokerSecurityTransactionSummary',
    id,
    type: 'SECURITY_TRANSACTION',
    status: status || 'SETTLED',
    lastEventDateTime: timestamp,
    side: 'BUY',
    securityTransactionType: 'SINGLE',
    quantity: 1,
    amount: -10,
    currency: 'EUR',
    isin: 'IE0000000001',
  };
}

function cash(id, timestamp) {
  return { __typename: 'BrokerCashTransactionSummary', id, type: 'CASH_TRANSACTION', status: 'SETTLED', lastEventDateTime: timestamp, cashTransactionType: 'DEPOSIT', amount: 100, currency: 'EUR' };
}

function fakeApi(overrides) {
  const calls = { details: [], recipes: [], lists: [], depositDetails: [] };
  const api = Object.assign(
    {
      async listBrokerTransactions() {
        return [trade('t3', '2026-03-01T10:00:00Z'), cash('c2', '2026-02-01T10:00:00Z'), trade('t1', '2026-01-01T10:00:00Z', 'CANCELLED')];
      },
      async getTransactionDetails(args) {
        calls.details.push(args.transactionId);
        return { transactionReference: `ref-${args.transactionId}`, averagePrice: 10, tradeTransactionAmounts: { transactionFee: 0.99, taxAmount: 0 } };
      },
      async getDepositRecipe(savingsAccountId) {
        calls.recipes.push(savingsAccountId);
        return Object.assign({}, RECIPE, { variables: Object.assign({}, RECIPE.variables, { portfolioId: savingsAccountId }) });
      },
      async listDepositTransactions(args) {
        calls.lists.push([args.savingsAccountId, args.recipe.variables.personId]);
        return { transactions: [interest('d1', '2026-02-28T12:00:00Z')], total: 1, complete: true };
      },
      async getDepositTransactionDetails(args) {
        calls.depositDetails.push([args.personId, args.savingsAccountId, args.transactionId]);
        return { id: args.transactionId, isCancellation: false, transactionReference: `ref-${args.transactionId}`, taxDetails: { grossAmount: 2.7, taxAmount: 0.7 } };
      },
    },
    overrides || {},
  );
  return { api, calls };
}

test('both accounts are exported, with details only for executed trades', async () => {
  const { api, calls } = fakeApi();
  const progress = [];
  const outcome = await exporter.runExport({ api, ids: IDS, options: ALL, context: CONTEXT, progress: (key) => progress.push(key) });

  assert.equal(outcome.broker.length, 3);
  assert.equal(outcome.deposit.length, 1);
  assert.deepEqual(outcome.errors, []);
  assert.deepEqual(outcome.warnings, []);
  assert.deepEqual(calls.details, ['t3']);
  assert.deepEqual(calls.recipes, ['s1'], 'without a known recipe, the account’s page gives one');
  assert.deepEqual(calls.lists, [['s1', 'short-1']]);
  assert.deepEqual(calls.depositDetails, [['short-1', 's1', 'd1']], 'interest details use the person id of the recipe');
  const interest = outcome.deposit[0];
  assert.equal(interest.lf_details, 'yes');
  assert.equal(interest.tax, '0,7');
  assert.equal(interest.reference, 'ref-d1');
  const byId = Object.fromEntries(outcome.broker.map((row) => [row.lf_id, row]));
  assert.equal(byId.t3.lf_details, 'yes');
  assert.equal(byId.t3.reference, 'ref-t3');
  assert.equal(byId.t3.fee, '0,99');
  assert.equal(byId.t1.lf_details, 'n/a', 'non-executed trades never need details');
  assert.equal(byId.c2.lf_details, 'n/a');
  assert.ok(progress.includes('progressBrokerDetails'));
  assert.ok(progress.includes('progressDeposit'));
  assert.ok(progress.includes('progressDepositDetails'));
});

test('the period filters rows and stops paging once a page ends before "from"', async () => {
  let stopWhen = null;
  const { api } = fakeApi({
    async listBrokerTransactions(args) {
      stopWhen = args.stopWhen;
      return [trade('t3', '2026-03-01T10:00:00Z'), cash('c2', '2026-02-01T10:00:00Z'), trade('t1', '2026-01-01T10:00:00Z')];
    },
  });
  const outcome = await exporter.runExport({ api, ids: IDS, options: Object.assign({}, ALL, { from: '2026-02-01', to: '2026-02-28' }), context: CONTEXT });
  assert.deepEqual(outcome.broker.map((row) => row.lf_id), ['c2']);
  assert.equal(outcome.deposit.length, 1);
  assert.equal(stopWhen([cash('x', '2026-01-31T10:00:00Z')]), true);
  assert.equal(stopWhen([cash('x', '2026-02-01T10:00:00Z')]), false);
});

test('without details, executed trades and interest are flagged as not read', async () => {
  const { api, calls } = fakeApi();
  const outcome = await exporter.runExport({ api, ids: IDS, options: Object.assign({}, ALL, { details: false }), context: CONTEXT });
  assert.deepEqual(calls.details, []);
  assert.deepEqual(calls.depositDetails, []);
  assert.equal(outcome.broker.find((row) => row.lf_id === 't3').lf_details, 'no');
  assert.equal(outcome.deposit[0].lf_details, 'no');
  assert.equal(outcome.deposit[0].tax, '', 'unknown without the details');
  assert.equal(outcome.deposit[0].reference, '');
});

test('a refusal while reading interest details stops the remaining ones', async () => {
  const { api, calls } = fakeApi({
    async listDepositTransactions() {
      return { transactions: [interest('i3', '2026-02-28T12:00:00Z'), interest('i2', '2026-02-27T12:00:00Z'), interest('i1', '2026-02-26T12:00:00Z')], total: 3, complete: true };
    },
    async getDepositTransactionDetails(args) {
      calls.depositDetails.push(args.transactionId);
      throw new ExportError('denied', 'Unauthorized access');
    },
  });
  const outcome = await exporter.runExport({ api, ids: IDS, options: Object.assign({}, ALL, { broker: false }), context: CONTEXT });
  assert.deepEqual(calls.depositDetails, ['i3']);
  assert.deepEqual(outcome.deposit.map((row) => row.lf_details), ['error', 'error', 'error']);
  assert.deepEqual(outcome.warnings, [{ key: 'warnDetails', args: [3] }]);
});

test('a rate limit while reading details stops further detail requests and warns', async () => {
  const trades = [trade('a', '2026-03-03T10:00:00Z'), trade('b', '2026-03-02T10:00:00Z'), trade('c', '2026-03-01T10:00:00Z')];
  const { api, calls } = fakeApi({
    async listBrokerTransactions() {
      return trades;
    },
    async getTransactionDetails(args) {
      calls.details.push(args.transactionId);
      if (args.transactionId === 'b') throw new ExportError('rateLimited', '429');
      return { averagePrice: 1 };
    },
  });
  const outcome = await exporter.runExport({ api, ids: IDS, options: Object.assign({}, ALL, { deposit: false }), context: CONTEXT });
  assert.deepEqual(calls.details, ['a', 'b']);
  assert.deepEqual(outcome.broker.map((row) => row.lf_details), ['yes', 'error', 'error']);
  assert.deepEqual(outcome.warnings, [{ key: 'warnDetails', args: [2] }]);
});

test('a failing account does not lose the other one', async () => {
  const { api } = fakeApi();
  const outcome = await exporter.runExport({ api, ids: { personId: 'person', portfolioId: null, savingsAccountIds: ['s1'] }, options: ALL, context: CONTEXT });
  assert.equal(outcome.broker, null);
  assert.equal(outcome.deposit.length, 1);
  assert.equal(outcome.errors.length, 1);
  assert.equal(outcome.errors[0].account, 'broker');
  assert.equal(outcome.errors[0].error.code, 'noPortfolio');
});

test('cancellation ends the whole export', async () => {
  const { api } = fakeApi({
    async listBrokerTransactions() {
      throw new ExportError('cancelled');
    },
  });
  await assert.rejects(exporter.runExport({ api, ids: IDS, options: ALL, context: CONTEXT }), (error) => error.code === 'cancelled');
});

test('a recipe already known from the page or the session is used without downloading the page', async () => {
  const notes = [];
  const known = { recipe: Object.assign({}, RECIPE, { variables: Object.assign({}, RECIPE.variables, { personId: 'from-page' }) }), source: 'page' };
  const { api, calls } = fakeApi();
  const outcome = await exporter.runExport({
    api,
    ids: Object.assign({}, IDS, { depositRecipes: { s1: known } }),
    options: Object.assign({}, ALL, { broker: false }),
    context: CONTEXT,
    diagnostics: (event, data) => notes.push([event, data]),
  });
  assert.deepEqual(calls.recipes, []);
  assert.deepEqual(calls.lists, [['s1', 'from-page']]);
  assert.equal(outcome.deposit.length, 1);
  assert.deepEqual(notes, [['overnight-recipe', { source: 'page', operation: 'Transactions' }]]);
});

test('a known recipe that stops working is replaced by a fresh one, once', async () => {
  const notes = [];
  const known = { recipe: Object.assign({}, RECIPE, { variables: Object.assign({}, RECIPE.variables, { personId: 'stale' }) }), source: 'memory' };
  const { api, calls } = fakeApi({
    async listDepositTransactions(args) {
      calls.lists.push(args.recipe.variables.personId);
      if (args.recipe.variables.personId === 'stale') throw new ExportError('denied', 'Unauthorized access');
      return { transactions: [interest('d1', '2026-02-28T12:00:00Z')], total: 1, complete: true };
    },
  });
  const outcome = await exporter.runExport({
    api,
    ids: Object.assign({}, IDS, { depositRecipes: { s1: known } }),
    options: Object.assign({}, ALL, { broker: false, details: false }),
    context: CONTEXT,
    diagnostics: (event, data) => notes.push([event, data]),
  });
  assert.deepEqual(calls.lists, ['stale', 'short-1']);
  assert.deepEqual(calls.recipes, ['s1']);
  assert.equal(outcome.deposit.length, 1);
  assert.deepEqual(notes.map(([event, data]) => `${event}:${data.source}`), ['overnight-recipe:memory', 'overnight-recipe-retry:memory', 'overnight-recipe:download']);
});

test('errors that a fresh recipe cannot fix are not retried', async () => {
  const known = { recipe: RECIPE, source: 'memory' };
  const { api, calls } = fakeApi({
    async listDepositTransactions() {
      throw new ExportError('rateLimited', '429');
    },
  });
  const outcome = await exporter.runExport({ api, ids: Object.assign({}, IDS, { depositRecipes: { s1: known } }), options: Object.assign({}, ALL, { broker: false }), context: CONTEXT });
  assert.deepEqual(calls.recipes, []);
  assert.equal(outcome.errors[0].error.code, 'rateLimited');
});

test('without an overnight account seen on the pages, the user is asked to open it', async () => {
  const { api, calls } = fakeApi();
  const outcome = await exporter.runExport({ api, ids: Object.assign({}, IDS, { savingsAccountIds: [] }), options: Object.assign({}, ALL, { broker: false }), context: CONTEXT });
  assert.equal(outcome.deposit, null);
  assert.equal(outcome.errors[0].error.code, 'noDepositAccount');
  assert.deepEqual(calls.recipes, [], 'nothing is requested');

  const blocked = fakeApi({
    async getDepositRecipe() {
      throw new ExportError('depositPage', 'redirect');
    },
  });
  const second = await exporter.runExport({ api: blocked.api, ids: IDS, options: Object.assign({}, ALL, { broker: false }), context: CONTEXT });
  assert.equal(second.errors[0].error.code, 'depositPage');
});

test('a list shorter than its total produces a warning', async () => {
  const { api } = fakeApi({
    async listDepositTransactions() {
      return { transactions: [interest('d1', '2026-02-28T12:00:00Z')], total: 5, complete: false };
    },
  });
  const outcome = await exporter.runExport({ api, ids: IDS, options: Object.assign({}, ALL, { broker: false, details: false }), context: CONTEXT });
  assert.deepEqual(outcome.warnings, [{ key: 'warnDepositPartial', args: [1] }]);
});

test('duplicates returned by overlapping pages are written once', () => {
  assert.deepEqual(exporter.uniqueById([{ id: 'a' }, { id: 'a' }, { id: 'b' }, null, {}]).length, 3);
});

test('toCsv writes the full header in column order', () => {
  const text = exporter.toCsv([]);
  assert.equal(text, mapping.COLUMNS.map((column) => column.name).join(';') + '\n');
});

test('summarize keeps types, statuses and signs, never amounts or identifiers', async () => {
  const { api } = fakeApi();
  const outcome = await exporter.runExport({ api, ids: IDS, options: ALL, context: CONTEXT });
  const summary = exporter.summarize([].concat(outcome.broker, outcome.deposit));
  const text = JSON.stringify(summary);
  for (const secret of ['t3', 'c2', 'd1', 'IE0000000001', '-10', '100']) assert.ok(!text.includes(`"${secret}"`), secret);
  const buy = summary.find((entry) => entry.assetType === 'Security' && entry.status === 'SETTLED');
  assert.deepEqual(buy, {
    account: 'broker',
    assetType: 'Security',
    type: 'Buy',
    subtype: 'SINGLE',
    status: 'SETTLED',
    amount: '-',
    shares: '+',
    fee: '+',
    tax: '0',
    details: 'yes',
    count: 1,
  });
  const interest = summary.find((entry) => entry.account === 'deposit');
  assert.equal(interest.tax, '+');
  assert.equal(interest.shares, '');
  assert.equal(summary.reduce((total, entry) => total + entry.count, 0), 4);
});

test('a field the web app adds arrives in the CSV, and its name in the diagnostics', async () => {
  const notes = [];
  const { api } = fakeApi({
    async listBrokerTransactions() {
      return [Object.assign(cash('c9', '2026-02-01T10:00:00Z'), { brandNewField: 'v', description: 'paid from portfolio' })];
    },
    async listDepositTransactions() {
      return { transactions: [interest('CASH_short-1_s1_x', '2026-02-28T12:00:00Z')], total: 1, complete: true };
    },
  });
  const outcome = await exporter.runExport({ api, ids: IDS, options: ALL, context: CONTEXT, diagnostics: (event, data) => notes.push([event, data]) });
  assert.equal(outcome.broker[0].lf_brand_new_field, 'v');
  assert.deepEqual(
    notes.filter(([event]) => event === 'new-fields'),
    [['new-fields', ['lf_brand_new_field']]],
    'names only, never values',
  );
  const header = exporter.toCsv(outcome.broker).split('\n')[0].split(';');
  assert.deepEqual(header.slice(-4), ['lf_brand_new_field', 'lf_details', 'lf_exporter', 'lf_format']);
  assert.match(outcome.broker[0].description, /^paid from portfolio-[0-9a-f]{8}$/, 'the portfolio id never appears');
  assert.match(outcome.deposit[0].lf_id, /^CASH_person-[0-9a-f]{8}_s1_x$/, "the interest app's short code of the person is masked too");
});
