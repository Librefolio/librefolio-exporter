'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mapping = require('../src/brokers/scalable/mapping.js');
const queries = require('../src/brokers/scalable/queries.js');

const CONTEXT = {};
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
    amount: -501.08278,
    side: 'BUY',
    isin: 'IE00BJ0KDQ92',
  };
}

// What the details query asks for: only what the list does not already give.
function buyDetails() {
  return {
    transactionReference: 'REF-123',
    numberOfShares: { filled: 4.981, total: 4.981 },
    averagePrice: 100.38,
    tradeTransactionAmounts: { marketValuation: 499.99278, taxAmount: 0, transactionFee: 0.99, venueFee: 0.1, cryptoSpreadFee: null },
    tradingVenue: 'GETTEX',
  };
}

// Columns that would repeat a Prime column or another field, or that tell nothing the
// other columns do not.
const NEVER_WRITTEN = ['lf_kind', 'lf_side', 'lf_timestamp_utc', 'lf_amount', 'lf_quantity', 'lf_price', 'lf_filled_shares', 'lf_total_shares',
  'lf_total_amount', 'lf_market_valuation', 'lf_tax_amount', 'lf_gross_amount', 'lf_fee', 'lf_transactional_fee', 'lf_taxes',
  'lf_transaction_reference', 'lf_description', 'lf_isin', 'lf_related_isin', 'lf_currency', 'lf_is_pending', 'lf_transaction_history',
  'lf_status', 'lf_details', 'lf_exporter', 'lf_format', 'lf_trade_transaction_amounts_market_valuation'];

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
  assert.equal(row.amount, '-499,99278', 'the value of the shares: the web app gives -501.08278, fees included');
  assert.equal(row.fee, '1,09');
  assert.equal(row.tax, '0');
  assert.equal(row.currency, 'EUR');
  assert.equal(row.lf_account, 'broker');
  assert.equal(row.lf_account_index, '', 'the broker has one portfolio: no index');
  assert.equal(row.lf_id, 'tx-buy-1');
  assert.equal(row.lf_subtype, 'SAVINGS_PLAN');
  assert.equal(row.lf_is_cancellation, '', 'written only for a reversal');
  assert.equal(row.lf_ordered_shares, '', 'all the shares ordered were executed');
  assert.equal(row.lf_transaction_fee, '0.99');
  assert.equal(row.lf_venue_fee, '0.1');
  assert.equal(row.lf_crypto_spread_fee, '');
  assert.equal(row.lf_trading_venue, 'GETTEX');
  for (const name of NEVER_WRITTEN) assert.equal(row[name], undefined, `${name}: in a Prime column, or repeats another field`);
});

test('a sell whose details failed keeps the summary, with fee and tax unknown', () => {
  const summary = Object.assign(savingsPlanBuy(), { id: 'tx-sell', side: 'SELL', securityTransactionType: 'SINGLE', amount: 250.5, quantity: 2 });
  const row = mapping.mapBrokerTransaction(summary, { status: 'error' }, CONTEXT);
  assert.equal(row.type, 'Sell');
  assert.equal(row.reference, '', 'no reference without the details');
  assert.equal(row.price, '');
  assert.deepEqual([row.fee, row.tax], ['', ''], 'empty: unknown, not zero');
  assert.equal(row.amount, '250,5');
});

// 5 shares at 150.10 with a fee of 0.99: the web app's amount, -751.49, counts the fee too.
function singleBuy() {
  return Object.assign(savingsPlanBuy(), { id: 'tx-buy-2', securityTransactionType: 'SINGLE', quantity: 5, amount: -751.49 });
}

function singleBuyDetails() {
  return {
    transactionReference: 'REF-456',
    numberOfShares: { filled: 5, total: 5 },
    averagePrice: 150.1,
    tradeTransactionAmounts: { marketValuation: 750.5, taxAmount: 0, transactionFee: 0.99, venueFee: null, cryptoSpreadFee: null },
    tradingVenue: 'GETTEX',
  };
}

test('an executed trade read with details has in amount the value of the shares, like the official export', () => {
  const map = (summary, details) => mapping.mapBrokerTransaction(summary, { status: 'yes', details }, CONTEXT);
  const buy = map(singleBuy(), singleBuyDetails());
  assert.deepEqual([buy.type, buy.shares, buy.price, buy.amount, buy.fee, buy.tax], ['Buy', '5', '150,1', '-750,5', '0,99', '0']);
  const plan = map(savingsPlanBuy(), buyDetails());
  assert.deepEqual([plan.type, plan.amount, plan.fee], ['Savings plan', '-499,99278', '1,09']);
  const sell = map(
    Object.assign(singleBuy(), { id: 'tx-sell-2', side: 'SELL', quantity: 4, amount: 876.44 }),
    Object.assign(singleBuyDetails(), {
      numberOfShares: { filled: 4, total: 4 },
      averagePrice: 225.5,
      tradeTransactionAmounts: { marketValuation: 902, taxAmount: 24.57, transactionFee: 0.99 },
    }),
  );
  assert.deepEqual([sell.type, sell.amount, sell.fee, sell.tax], ['Sell', '902', '0,99', '24,57'], 'the web app gives 876.44, fee and tax taken off');

  const valued = (fields, marketValuation) =>
    map(Object.assign(singleBuy(), fields), Object.assign(singleBuyDetails(), { tradeTransactionAmounts: { marketValuation, transactionFee: 0.99 } })).amount;
  assert.equal(valued({}, '750.50'), '-750,50', 'a number as text, verbatim');
  assert.equal(valued({}, -750.5), '-750,5', 'the sign of the trade, not of the value');
  assert.equal(valued({ side: 'SELL', amount: 876.44 }, -902), '902');
  assert.equal(valued({ side: undefined }, 750.5), '-750,5', 'without a side, the sign of the amount the web app gives');
  assert.equal(valued({ side: undefined, amount: 876.44 }, 902), '902');
  assert.equal(valued({}, 0), '0', 'zero stays zero');

  const rows = [buy, plan, sell];
  for (const row of rows) for (const name of NEVER_WRITTEN) assert.equal(row[name], undefined, name);
  assert.deepEqual(mapping.extraColumns(rows), [], 'the value of the shares has no column of its own');
  assert.equal(mapping.columnsFor(rows).length, 23);
});

test('a trade without the value of the shares keeps the amount the web app gives, fees included', () => {
  const map = (summary, detailsResult) => mapping.mapBrokerTransaction(summary, detailsResult, CONTEXT);
  for (const status of ['no', 'error']) {
    const row = map(singleBuy(), { status });
    assert.deepEqual([row.amount, row.fee, row.tax], ['-751,49', '', ''], status);
  }
  for (const marketValuation of [undefined, null, '', 'n/a', NaN]) {
    const details = Object.assign(singleBuyDetails(), { tradeTransactionAmounts: { marketValuation, taxAmount: 0, transactionFee: 0.99 } });
    assert.equal(map(singleBuy(), { status: 'yes', details }).amount, '-751,49', String(marketValuation));
  }
  const cancelled = map(Object.assign(singleBuy(), { status: 'CANCELLED' }), { status: 'n/a' });
  assert.deepEqual([cancelled.status, cancelled.shares, cancelled.amount], ['Cancelled', '0', '-751,49']);
});

test('the details query asks for the value of the shares, and every amount it asks for has its place', () => {
  const block = /tradeTransactionAmounts \{([^}]*)\}/.exec(queries.TRANSACTION_DETAILS);
  assert.ok(block, 'tradeTransactionAmounts');
  const asked = block[1].trim().split(/\s+/);
  assert.deepEqual(asked, ['marketValuation', 'taxAmount', 'transactionFee', 'venueFee', 'cryptoSpreadFee']);
  for (const name of asked) assert.ok(mapping.FIELDS[`tradeTransactionAmounts.${name}`], name);
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
  assert.equal(eltif.shares, '1,5');

  const unknown = mapping.mapBrokerTransaction({ __typename: 'SomethingElse', id: 'u1', type: 'NEW_KIND' }, null, CONTEXT);
  assert.equal(unknown.type, 'NEW_KIND');
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
  assert.equal(row.lf_subtype, 'INTEREST');
  assert.equal(row.tax, '', 'unknown without the details');
});

test('interest details add the withheld tax and the reference', () => {
  const interest = { id: 'd1', type: 'CASH_TRANSACTION', status: 'SETTLED', amount: 11.05, currency: 'EUR', lastEventDateTime: '2026-09-30T22:00:00Z', cashTransactionType: 'INTEREST' };
  const row = mapping.mapDepositTransaction(interest, 1, CONTEXT, {
    status: 'yes',
    details: { isCancellation: false, transactionReference: 'REF-1', taxDetails: { grossAmount: 14.93, taxAmount: 3.88 } },
  });
  assert.equal(row.amount, '11,05', 'the amount stays the net one, as the web app shows it');
  assert.equal(row.tax, '3,88');
  assert.equal(row.reference, 'REF-1');
  assert.equal(row.lf_is_cancellation, '');
  assert.equal(row.lf_gross_amount, undefined, 'the gross amount is amount + tax');

  const failed = mapping.mapDepositTransaction(interest, 1, CONTEXT, { status: 'error' });
  assert.equal(failed.reference, '');
  assert.equal(failed.tax, '');
});

test('only interest that was paid needs details', () => {
  assert.equal(mapping.needsDepositDetails({ cashTransactionType: 'INTEREST', status: 'SETTLED' }), true);
  assert.equal(mapping.needsDepositDetails({ cashTransactionType: 'INTEREST_PAYMENT', status: 'PENDING' }), true);
  assert.equal(mapping.needsDepositDetails({ cashTransactionType: 'INTEREST', status: 'CANCELLED' }), false);
  assert.equal(mapping.needsDepositDetails({ cashTransactionType: 'WITHDRAWAL', status: 'SETTLED' }), false);
  assert.equal(mapping.needsDepositDetails(null), false);
  const row = mapping.mapDepositTransaction({ id: 'w1', cashTransactionType: 'WITHDRAWAL', status: 'SETTLED', amount: 1.03 }, 1, CONTEXT);
  assert.equal(row.type, 'Withdrawal');
  assert.equal(row.amount, '-1,03');
});

test('overnight outflows are negative in the Prime amount, like the official export', () => {
  const map = (type, amount) => mapping.mapDepositTransaction({ id: 'x', cashTransactionType: type, status: 'SETTLED', amount, currency: 'EUR' }, 1, CONTEXT);
  assert.equal(map('WITHDRAWAL', 1.03).amount, '-1,03');
  assert.equal(map('CASH_TRANSFER_OUT', 21500).amount, '-21500');
  assert.equal(map('CASH_TRANSFER_IN', 6.36).amount, '6,36');
  assert.equal(map('DEPOSIT', 0.02).amount, '0,02');
  assert.equal(map('INTEREST', 11.05).amount, '11,05');
  assert.equal(map('WITHDRAWAL', 0).amount, '0', 'zero stays zero');
  assert.equal(map('WITHDRAWAL', -5).amount, '-5', 'a sign already present is kept');
});

test('each field is written once; a field the web app adds gets a column of its own', () => {
  const summary = Object.assign(savingsPlanBuy(), { brandNewField: 'x', newObject: { innerValue: 2, __typename: 'Inner' }, legs: [{ a: 1 }], emptyOne: null });
  const details = Object.assign(buyDetails(), { lastEventDateTime: '2023-06-11T09:30:00.000Z' });
  const row = mapping.mapBrokerTransaction(summary, { status: 'yes', details }, CONTEXT);
  assert.equal(row.lf_brand_new_field, 'x');
  assert.equal(row.lf_new_object_inner_value, '2', 'nested objects are walked');
  assert.equal(row.lf_legs, '[{"a":1}]', 'a list is kept whole, as JSON');
  assert.equal(row.lf_details_last_event_date_time, '2023-06-11T09:30:00.000Z', 'a different value in the details is kept apart');
  for (const name of NEVER_WRITTEN) assert.equal(row[name], undefined, name);
  assert.ok(!Object.keys(row).some((name) => /typename|empty_one/.test(name)));

  assert.deepEqual(mapping.extraColumns([row]), ['lf_brand_new_field', 'lf_details_last_event_date_time', 'lf_legs', 'lf_new_object_inner_value']);
  const names = mapping.columnsFor([row]).map((column) => column.name);
  assert.deepEqual(names.slice(-5), [
    'lf_trading_venue',
    'lf_brand_new_field',
    'lf_details_last_event_date_time',
    'lf_legs',
    'lf_new_object_inner_value',
  ], 'the new fields come last, sorted');
  assert.deepEqual(mapping.columnsFor([]), mapping.COLUMNS, 'without new fields, the fixed columns');
});

test('the ids of the person and of the accounts are masked wherever they appear; IBANs stay', () => {
  const context = Object.assign({}, CONTEXT, { privateIds: { person: ['short-person-1'], portfolio: ['portfolio-1234'], account: ['sVJo3Mf7Y1kBxP7kpBFcfD'] } });
  const id = 'CASH_sVJo3Mf7Y1kBxP7kpBFcfD_INTEREST-PAY-sVJo3Mf7Y1kBxP7kpBFcfD-12103494_2026-10-01';
  const interest = { id, cashTransactionType: 'INTEREST', status: 'SETTLED', amount: 11.05, currency: 'EUR', description: 'Bonifico da IT60 X054 2811 1010 0000 0123 456 per IE00BJ0KDQ92' };
  const row = mapping.mapDepositTransaction(interest, 1, context);
  assert.match(row.lf_id, /^CASH_(account-[0-9a-f]{8})_INTEREST-PAY-\1-12103494_2026-10-01$/);
  assert.equal(row.reference, '', 'without details there is no reference, and the id is not repeated');
  assert.ok(!JSON.stringify(row).includes('sVJo3Mf7Y1kBxP7kpBFcfD'));
  assert.equal(mapping.mapDepositTransaction(Object.assign({}, interest), 1, context).lf_id, row.lf_id, 'the same id always gives the same tag');
  assert.equal(row.description, 'Bonifico da IT60 X054 2811 1010 0000 0123 456 per IE00BJ0KDQ92', 'descriptions are kept whole, IBANs included');

  const trade = mapping.mapBrokerTransaction(Object.assign(savingsPlanBuy(), { id: 'portfolio-1234/tx-9', description: 'for short-person-1' }), null, context);
  assert.match(trade.lf_id, /^portfolio-[0-9a-f]{8}\/tx-9$/);
  assert.match(trade.description, /^for person-[0-9a-f]{8}$/);
  assert.equal(mapping.maskIds('abc', { privateIds: { account: ['ab'] } }), 'abc', 'too short to be an id');
});

test('like the official export, an order never executed has no shares', () => {
  const cancelled = mapping.mapBrokerTransaction(Object.assign(savingsPlanBuy(), { status: 'CANCELLED', securityTransactionType: 'SINGLE' }), { status: 'n/a' }, CONTEXT);
  assert.equal(cancelled.status, 'Cancelled');
  assert.equal(cancelled.shares, '0');
  assert.equal(cancelled.lf_ordered_shares, '4.981', 'the shares ordered, since none was executed');
  const partial = mapping.mapBrokerTransaction(
    Object.assign(savingsPlanBuy(), { status: 'PARTIAL_FILLED', quantity: 4 }),
    { status: 'yes', details: Object.assign(buyDetails(), { numberOfShares: { filled: 4, total: 10 } }) },
    CONTEXT,
  );
  assert.equal(partial.shares, '4', 'the shares executed');
  assert.equal(partial.lf_ordered_shares, '10', 'the details give the shares ordered');
  const transfer = mapping.mapBrokerTransaction({ __typename: 'BrokerNonTradeSecurityTransactionSummary', id: 'n1', quantity: 3, status: 'SETTLED' }, null, CONTEXT);
  assert.deepEqual([transfer.shares, transfer.lf_ordered_shares], ['3', '']);
});

test('docs/formats/scalable.md names every field and every fixed column', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'formats', 'scalable.md'), 'utf8');
  for (const field of Object.keys(mapping.FIELDS)) assert.ok(doc.includes(`\`${field}\``), field);
  for (const column of mapping.LF_COLUMNS) assert.ok(doc.includes(`\`${column.name}\``), column.name);
});

test('read details without a fee or a tax give 0, like the official export; unread ones stay empty', () => {
  const noFees = Object.assign(buyDetails(), { tradeTransactionAmounts: { taxAmount: null, transactionFee: null, venueFee: null, cryptoSpreadFee: null } });
  const read = mapping.mapBrokerTransaction(savingsPlanBuy(), { status: 'yes', details: noFees }, CONTEXT);
  assert.deepEqual([read.fee, read.tax], ['0', '0']);
  assert.equal(read.lf_transaction_fee, '', 'the fee columns stay as received');
  const unread = mapping.mapBrokerTransaction(savingsPlanBuy(), { status: 'no' }, CONTEXT);
  assert.deepEqual([unread.fee, unread.tax], ['', '']);

  const interest = { id: 'd9', cashTransactionType: 'INTEREST', status: 'SETTLED', amount: 2, currency: 'EUR' };
  assert.equal(mapping.mapDepositTransaction(interest, 1, CONTEXT, { status: 'yes', details: { taxDetails: { grossAmount: 2 } } }).tax, '0');
  assert.equal(mapping.mapDepositTransaction(interest, 1, CONTEXT, { status: 'no' }).tax, '');
});
test('the overnight details: the pending flag, the history and the gross amount repeat other fields', () => {
  const interest = { id: 'd9', cashTransactionType: 'INTEREST', status: 'SETTLED', amount: 11.05, currency: 'EUR', __typename: 'SavingsAccountCashTransactionSummary' };
  const details = {
    __typename: 'SavingsAccountCashTransaction',
    id: 'd9',
    isPending: false,
    transactionHistory: [{ state: 'SETTLED', timestamp: 1727740800000, __typename: 'SavingsAccountCashTransactionHistoryEntry' }],
    taxDetails: { grossAmount: 14.93, taxAmount: 3.88, __typename: 'TaxDetails' },
  };
  const row = mapping.mapDepositTransaction(interest, 1, CONTEXT, { status: 'yes', details });
  assert.deepEqual([row.amount, row.tax], ['11,05', '3,88'], 'net amount and tax: the gross amount is their sum');
  for (const name of NEVER_WRITTEN) assert.equal(row[name], undefined, name);
  assert.deepEqual(mapping.extraColumns([row]), [], 'every field the page returns has its place');
  assert.ok(!Object.keys(row).some((name) => /typename/.test(name)));
});

test('each file has only the columns of its account', () => {
  const names = (rows) => mapping.columnsFor(rows).map((column) => column.name);
  const BROKER_ONLY = ['lf_ordered_shares', 'lf_transaction_fee', 'lf_venue_fee', 'lf_crypto_spread_fee', 'lf_trading_venue'];
  const deposit = mapping.mapDepositTransaction({ id: 'd1', cashTransactionType: 'WITHDRAWAL', status: 'SETTLED', amount: 1, currency: 'EUR' }, 1, CONTEXT);
  const broker = mapping.mapBrokerTransaction(savingsPlanBuy(), { status: 'yes', details: buyDetails() }, CONTEXT);
  assert.deepEqual(names([deposit]).slice(0, 14), mapping.PRIME_COLUMNS.map((column) => column.name), 'the official columns stay, empty or not');
  assert.deepEqual(names([deposit]).slice(14), ['lf_account', 'lf_account_index', 'lf_id', 'lf_subtype', 'lf_is_cancellation']);
  for (const name of BROKER_ONLY) assert.ok(names([broker]).includes(name), name);
  assert.ok(!names([broker]).includes('lf_account_index'), 'the index is for the overnight accounts only');
  assert.deepEqual(
    names([broker]).slice(14),
    ['lf_account', 'lf_id', 'lf_subtype', 'lf_is_cancellation', 'lf_ordered_shares', 'lf_transaction_fee', 'lf_venue_fee', 'lf_crypto_spread_fee', 'lf_trading_venue'],
    'read with details: the value of the shares is in amount',
  );
  assert.equal(names([broker]).length, 23);
  assert.deepEqual(names([broker, deposit]), mapping.COLUMNS.map((column) => column.name), 'rows of both accounts: every column');
  assert.deepEqual(
    mapping.LF_COLUMNS.filter((column) => column.account).map((column) => column.name).sort(),
    BROKER_ONLY.concat('lf_account_index').sort(),
  );
});

test('a reversal is marked; every other transaction leaves the column empty', () => {
  const broker = (fields, details) => mapping.mapBrokerTransaction(Object.assign(savingsPlanBuy(), fields), details ? { status: 'yes', details } : null, CONTEXT);
  assert.equal(broker({ isCancellation: true }).lf_is_cancellation, 'true');
  assert.equal(broker({ isCancellation: false }).lf_is_cancellation, '');
  assert.equal(broker({ isCancellation: undefined }, Object.assign(buyDetails(), { isCancellation: true })).lf_is_cancellation, 'true', 'or as the details say');
  const deposit = (isCancellation) => mapping.mapDepositTransaction({ id: 'x', cashTransactionType: 'DEPOSIT', status: 'SETTLED', amount: 1, isCancellation }, 1, CONTEXT);
  assert.equal(deposit(true).lf_is_cancellation, 'true');
  assert.equal(deposit(false).lf_is_cancellation, '');
});
