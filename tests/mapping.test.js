'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mapping = require('../src/brokers/scalable/mapping.js');

const CONTEXT = { exporter: 'librefolio-exporter/0.0.0-test' };
const PRIME_HEADER = 'date;time;status;reference;description;assetType;type;isin;shares;price;amount;fee;tax;currency';

function savingsPlanBuy() {
  return {
    __typename: 'BrokerSecurityTransactionSummary',
    id: 'tx-buy-1',
    currency: 'EUR',
    type: 'SECURITY_TRANSACTION',
    status: 'SETTLED',
    isCancellation: false,
    lastEventDateTime: '2023-06-11T09:29:06.000Z',
    description: 'Xtrackers MSCI World (Acc)',
    securityTransactionType: 'SAVINGS_PLAN',
    quantity: 4.981,
    amount: -499.99278,
    side: 'BUY',
    isin: 'IE00BJ0KDQ92',
  };
}

function buyDetails() {
  return {
    id: 'tx-buy-1',
    currency: 'EUR',
    transactionReference: 'REF-123',
    security: { id: 's1', name: 'Xtrackers MSCI World (Acc)', isin: 'IE00BJ0KDQ92' },
    side: 'BUY',
    status: 'SETTLED',
    numberOfShares: { filled: 4.981, total: 4.981 },
    averagePrice: 100.38,
    totalAmount: -499.99278,
    tradeTransactionAmounts: { marketValuation: 499.99278, taxAmount: 0, transactionFee: 0.99, venueFee: 0.1, cryptoSpreadFee: null },
    tradingVenue: 'GETTEX',
    fee: 1.09,
    transactionalFee: null,
    taxes: 0,
  };
}

test('the first 14 columns are the official Scalable CSV header', () => {
  assert.equal(mapping.PRIME_COLUMNS.map((column) => column.name).join(';'), PRIME_HEADER);
  assert.ok(mapping.COLUMNS.every((column) => mapping.PRIME_COLUMNS.includes(column) || column.name.startsWith('lf_')));
  assert.equal(new Set(mapping.COLUMNS.map((column) => column.name)).size, mapping.COLUMNS.length);
});

test('a savings-plan buy with details maps to Prime columns and verbatim lf_* columns', () => {
  const row = mapping.mapBrokerTransaction(savingsPlanBuy(), { status: 'yes', details: buyDetails() }, CONTEXT);
  assert.equal(row.date, '2023-06-11');
  assert.equal(row.time, '11:29:06');
  assert.equal(row.status, 'Executed');
  assert.equal(row.reference, 'REF-123');
  assert.equal(row.description, 'Xtrackers MSCI World (Acc)');
  assert.equal(row.assetType, 'Security');
  assert.equal(row.type, 'Savings plan');
  assert.equal(row.isin, 'IE00BJ0KDQ92');
  assert.equal(row.shares, '4,981');
  assert.equal(row.price, '100,38');
  assert.equal(row.amount, '-499,99278');
  assert.equal(row.fee, '1,09');
  assert.equal(row.tax, '0');
  assert.equal(row.currency, 'EUR');
  assert.equal(row.lf_account, 'broker');
  assert.equal(row.lf_id, 'tx-buy-1');
  assert.equal(row.lf_kind, 'SECURITY_TRANSACTION');
  assert.equal(row.lf_subtype, 'SAVINGS_PLAN');
  assert.equal(row.lf_side, 'BUY');
  assert.equal(row.lf_status, 'SETTLED');
  assert.equal(row.lf_is_cancellation, 'false');
  assert.equal(row.lf_timestamp_utc, '2023-06-11T09:29:06.000Z');
  assert.equal(row.lf_amount, '-499.99278');
  assert.equal(row.lf_quantity, '4.981');
  assert.equal(row.lf_price, '100.38');
  assert.equal(row.lf_filled_shares, '4.981');
  assert.equal(row.lf_transaction_fee, '0.99');
  assert.equal(row.lf_venue_fee, '0.1');
  assert.equal(row.lf_crypto_spread_fee, '');
  assert.equal(row.lf_fee, '1.09');
  assert.equal(row.lf_trading_venue, 'GETTEX');
  assert.equal(row.lf_transaction_reference, 'REF-123');
  assert.equal(row.lf_details, 'yes');
  assert.equal(row.lf_exporter, CONTEXT.exporter);
  assert.equal(row.lf_format, mapping.FORMAT_VERSION);
});

test('a sell whose details failed keeps the summary and flags the missing details', () => {
  const summary = Object.assign(savingsPlanBuy(), { id: 'tx-sell', side: 'SELL', securityTransactionType: 'SINGLE', amount: 250.5, quantity: 2 });
  const row = mapping.mapBrokerTransaction(summary, { status: 'error' }, CONTEXT);
  assert.equal(row.type, 'Sell');
  assert.equal(row.reference, 'tx-sell');
  assert.equal(row.price, '');
  assert.equal(row.fee, '');
  assert.equal(row.amount, '250,5');
  assert.equal(row.lf_details, 'error');
});

test('cash transactions map to the Prime cash types', () => {
  const base = { __typename: 'BrokerCashTransactionSummary', type: 'CASH_TRANSACTION', currency: 'EUR', status: 'SETTLED', lastEventDateTime: '2022-11-12T10:40:50Z' };
  const distribution = mapping.mapBrokerTransaction(
    Object.assign({}, base, { id: 'c1', description: 'Microsoft Corp', cashTransactionType: 'DISTRIBUTION', amount: 1.08, relatedIsin: 'US5949181045' }),
    { status: 'n/a' },
    CONTEXT,
  );
  assert.equal(distribution.assetType, 'Cash');
  assert.equal(distribution.type, 'Distribution');
  assert.equal(distribution.isin, 'US5949181045');
  assert.equal(distribution.amount, '1,08');
  assert.equal(distribution.lf_details, 'n/a');

  const expected = {
    DEPOSIT: 'Deposit',
    WITHDRAWAL: 'Withdrawal',
    CASH_TRANSFER_IN: 'Deposit',
    CASH_TRANSFER_OUT: 'Withdrawal',
    INTEREST: 'Interest',
    FEE: 'Fee',
    TAX: 'Taxes',
    TAX_RETURN: 'Taxes',
    SOMETHING_NEW: 'SOMETHING_NEW',
  };
  for (const [cashType, primeType] of Object.entries(expected)) {
    const row = mapping.mapBrokerTransaction(Object.assign({}, base, { id: cashType, cashTransactionType: cashType, amount: 1 }), null, CONTEXT);
    assert.equal(row.type, primeType, cashType);
    assert.equal(row.lf_subtype, cashType);
  }
});

test('non-trade, ELTIF and unknown transactions keep their raw type', () => {
  const transfer = mapping.mapBrokerTransaction(
    { __typename: 'BrokerNonTradeSecurityTransactionSummary', id: 'n1', type: 'NON_TRADE_SECURITY_TRANSACTION', nonTradeSecurityTransactionType: 'TRANSFER_IN', quantity: 3, isin: 'DE0001', status: 'SETTLED' },
    null,
    CONTEXT,
  );
  assert.equal(transfer.type, 'Security transfer');
  assert.equal(transfer.shares, '3');

  const corporate = mapping.mapBrokerTransaction(
    { __typename: 'BrokerNonTradeSecurityTransactionSummary', id: 'n2', nonTradeSecurityTransactionType: 'SPIN_OFF', quantity: 1 },
    null,
    CONTEXT,
  );
  assert.equal(corporate.type, 'Corporate action');

  const eltif = mapping.mapBrokerTransaction(
    { __typename: 'BrokerEltifTransactionSummary', id: 'e1', side: 'BUY', securityTransactionType: 'SINGLE', eltifQuantity: 1.5, amount: -150, isin: 'LU0001' },
    null,
    CONTEXT,
  );
  assert.equal(eltif.type, 'Buy');
  assert.equal(eltif.lf_quantity, '1.5');

  const unknown = mapping.mapBrokerTransaction({ __typename: 'SomethingElse', id: 'u1', type: 'NEW_KIND' }, null, CONTEXT);
  assert.equal(unknown.type, 'NEW_KIND');
  assert.equal(unknown.lf_kind, 'NEW_KIND');
});

test('statuses map to Prime labels and unknown ones stay raw', () => {
  assert.equal(mapping.primeStatus('SETTLED'), 'Executed');
  assert.equal(mapping.primeStatus('FILLED'), 'Executed');
  assert.equal(mapping.primeStatus('PENDING'), 'Pending');
  assert.equal(mapping.primeStatus('CANCELLED'), 'Cancelled');
  assert.equal(mapping.primeStatus('EXPIRED'), 'Expired');
  assert.equal(mapping.primeStatus('REJECTED'), 'Rejected');
  assert.equal(mapping.primeStatus('BRAND_NEW'), 'BRAND_NEW');
  assert.equal(mapping.primeStatus(undefined), '');
});

test('only executed trades need details', () => {
  assert.equal(mapping.needsDetails(savingsPlanBuy()), true);
  assert.equal(mapping.needsDetails(Object.assign(savingsPlanBuy(), { status: 'CANCELLED' })), false);
  assert.equal(mapping.needsDetails({ __typename: 'BrokerCashTransactionSummary', status: 'SETTLED' }), false);
});

test('overnight-account transactions map to cash rows', () => {
  const row = mapping.mapDepositTransaction(
    { id: 'd1', type: 'CASH_TRANSACTION', status: 'SETTLED', description: 'Interest', amount: 3.21, currency: 'EUR', lastEventDateTime: '2026-09-30T22:00:00Z', cashTransactionType: 'INTEREST' },
    2,
    CONTEXT,
  );
  assert.equal(row.date, '2026-10-01');
  assert.equal(row.assetType, 'Cash');
  assert.equal(row.type, 'Interest');
  assert.equal(row.amount, '3,21');
  assert.equal(row.isin, '');
  assert.equal(row.lf_account, 'deposit');
  assert.equal(row.lf_account_index, '2');
  assert.equal(row.lf_amount, '3.21');
  assert.equal(row.lf_subtype, 'INTEREST');
});
