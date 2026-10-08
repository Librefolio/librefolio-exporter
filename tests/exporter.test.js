'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const exporter = require('../src/brokers/scalable/exporter.js');
const { ExportError } = require('../src/brokers/scalable/client.js');
const mapping = require('../src/brokers/scalable/mapping.js');

const CONTEXT = { exporter: 'librefolio-exporter/0.0.0-test' };
const IDS = { personId: 'person', portfolioId: 'portfolio', savingsAccountIds: [] };
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
  const calls = { details: [], deposit: [] };
  const api = Object.assign(
    {
      async listBrokerTransactions() {
        return [trade('t3', '2026-03-01T10:00:00Z'), cash('c2', '2026-02-01T10:00:00Z'), trade('t1', '2026-01-01T10:00:00Z', 'CANCELLED')];
      },
      async getTransactionDetails(args) {
        calls.details.push(args.transactionId);
        return { transactionReference: `ref-${args.transactionId}`, averagePrice: 10, tradeTransactionAmounts: { transactionFee: 0.99, taxAmount: 0 } };
      },
      async listSavingsAccounts() {
        return [{ __typename: 'OvernightSavingsAccount', id: 's1' }, { __typename: 'FixedTermSavingsAccount', id: 'f1' }];
      },
      async listDepositTransactions(args) {
        calls.deposit.push(args.savingsAccountId);
        return { transactions: [{ id: 'd1', type: 'CASH_TRANSACTION', status: 'SETTLED', cashTransactionType: 'INTEREST', amount: 2, currency: 'EUR', lastEventDateTime: '2026-02-28T12:00:00Z' }], complete: true };
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
  assert.deepEqual(calls.deposit, ['s1'], 'only overnight accounts are read');
  const byId = Object.fromEntries(outcome.broker.map((row) => [row.lf_id, row]));
  assert.equal(byId.t3.lf_details, 'yes');
  assert.equal(byId.t3.reference, 'ref-t3');
  assert.equal(byId.t3.fee, '0,99');
  assert.equal(byId.t1.lf_details, 'n/a', 'non-executed trades never need details');
  assert.equal(byId.c2.lf_details, 'n/a');
  assert.ok(progress.includes('progressBrokerDetails'));
  assert.ok(progress.includes('progressDeposit'));
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

test('without details, executed trades are flagged as not read', async () => {
  const { api, calls } = fakeApi();
  const outcome = await exporter.runExport({ api, ids: IDS, options: Object.assign({}, ALL, { details: false }), context: CONTEXT });
  assert.deepEqual(calls.details, []);
  assert.equal(outcome.broker.find((row) => row.lf_id === 't3').lf_details, 'no');
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
  const outcome = await exporter.runExport({ api, ids: { personId: 'person', portfolioId: null }, options: ALL, context: CONTEXT });
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

test('the overnight ids found in the page are used when the account list fails', async () => {
  const { api, calls } = fakeApi({
    async listSavingsAccounts() {
      throw new ExportError('graphql', 'Cannot query field "savingsAccounts"');
    },
  });
  const outcome = await exporter.runExport({
    api,
    ids: Object.assign({}, IDS, { savingsAccountIds: ['page-1'] }),
    options: Object.assign({}, ALL, { broker: false }),
    context: CONTEXT,
  });
  assert.deepEqual(calls.deposit, ['page-1']);
  assert.equal(outcome.deposit.length, 1);
});

test('missing overnight accounts and partial reads produce warnings', async () => {
  let made = fakeApi({
    async listSavingsAccounts() {
      return [];
    },
  });
  let outcome = await exporter.runExport({ api: made.api, ids: IDS, options: Object.assign({}, ALL, { broker: false }), context: CONTEXT });
  assert.deepEqual(outcome.warnings, [{ key: 'warnNoDeposit' }]);

  made = fakeApi({
    async listDepositTransactions() {
      return { transactions: [{ id: 'd1', lastEventDateTime: '2026-02-28T12:00:00Z' }], complete: false };
    },
  });
  outcome = await exporter.runExport({ api: made.api, ids: IDS, options: Object.assign({}, ALL, { broker: false }), context: CONTEXT });
  assert.deepEqual(outcome.warnings, [{ key: 'warnDepositPartial', args: [1] }]);
});

test('duplicates returned by overlapping pages are written once', () => {
  assert.deepEqual(exporter.uniqueById([{ id: 'a' }, { id: 'a' }, { id: 'b' }, null, {}]).length, 3);
});

test('toCsv writes the full header in column order', () => {
  const text = exporter.toCsv([]);
  assert.equal(text, mapping.COLUMNS.map((column) => column.name).join(';') + '\n');
});

test('summarize keeps kinds, statuses and signs, never amounts or identifiers', async () => {
  const { api } = fakeApi();
  const outcome = await exporter.runExport({ api, ids: IDS, options: ALL, context: CONTEXT });
  const summary = exporter.summarize([].concat(outcome.broker, outcome.deposit));
  const text = JSON.stringify(summary);
  for (const secret of ['t3', 'c2', 'd1', 'IE0000000001', '-10', '100']) assert.ok(!text.includes(`"${secret}"`), secret);
  const buy = summary.find((entry) => entry.kind === 'SECURITY_TRANSACTION' && entry.status === 'SETTLED');
  assert.deepEqual(buy, {
    account: 'broker',
    kind: 'SECURITY_TRANSACTION',
    subtype: 'SINGLE',
    side: 'BUY',
    status: 'SETTLED',
    type: 'Buy',
    amount: '-',
    quantity: '+',
    fee: '+',
    tax: '0',
    details: 'yes',
    count: 1,
  });
  assert.equal(summary.reduce((total, entry) => total + entry.count, 0), 4);
});
