/*
 * Maps Scalable web-app transactions to CSV rows.
 *
 * The first 14 columns follow the official Scalable CSV export (PRIME), so tools
 * that read it can read these files too; their labels are a best-effort mapping.
 * The lf_* columns carry the API values verbatim and are the source of truth for
 * LibreFolio. See docs/FORMAT.md.
 */
(function (root) {
  'use strict';

  const isNode = typeof module === 'object' && module.exports;
  const format = isNode ? require('../../shared/format.js') : root.LFX.format;

  const FORMAT_VERSION = '1';

  const PRIME_COLUMNS = [
    { name: 'date' },
    { name: 'time' },
    { name: 'status' },
    { name: 'reference', quote: true },
    { name: 'description', quote: true },
    { name: 'assetType' },
    { name: 'type' },
    { name: 'isin' },
    { name: 'shares' },
    { name: 'price' },
    { name: 'amount' },
    { name: 'fee' },
    { name: 'tax' },
    { name: 'currency' },
  ];

  const LF_COLUMNS = [
    'lf_account',
    'lf_account_index',
    'lf_id',
    'lf_kind',
    'lf_subtype',
    'lf_side',
    'lf_status',
    'lf_is_cancellation',
    'lf_timestamp_utc',
    'lf_amount',
    'lf_quantity',
    'lf_price',
    'lf_filled_shares',
    'lf_total_amount',
    'lf_market_valuation',
    'lf_transaction_fee',
    'lf_venue_fee',
    'lf_crypto_spread_fee',
    'lf_tax_amount',
    'lf_gross_amount',
    'lf_fee',
    'lf_transactional_fee',
    'lf_taxes',
    'lf_trading_venue',
    'lf_transaction_reference',
    'lf_details',
    'lf_exporter',
    'lf_format',
  ].map((name) => ({ name }));

  const COLUMNS = PRIME_COLUMNS.concat(LF_COLUMNS);

  const STATUS_TO_PRIME = {
    SETTLED: 'Executed',
    FILLED: 'Executed',
    CONFIRMED: 'Executed',
    PARTIAL_FILLED: 'Pending',
    CREATED: 'Pending',
    REQUESTED: 'Pending',
    PENDING: 'Pending',
    CANCEL_REQUESTED: 'Pending',
    CANCELLED: 'Cancelled',
    EXPIRED: 'Expired',
    REJECTED: 'Rejected',
  };

  const CASH_TO_PRIME = {
    DEPOSIT: 'Deposit',
    WITHDRAWAL: 'Withdrawal',
    CASH_TRANSFER_IN: 'Deposit',
    CASH_TRANSFER_OUT: 'Withdrawal',
    POCKET_MONEY: 'Deposit',
    DISTRIBUTION: 'Distribution',
    REINVESTMENT_DISTRIBUTION: 'Distribution',
    INTEREST: 'Interest',
    INTEREST_PAYMENT: 'Interest',
    FEE: 'Fee',
    TAX: 'Taxes',
    TAX_RETURN: 'Taxes',
  };

  // Executed trades: the only ones whose details (fees, taxes, price) are read.
  const EXECUTED = new Set(['FILLED', 'SETTLED', 'PARTIAL_FILLED']);
  const NOT_EXECUTED = new Set(['CANCELLED', 'REJECTED', 'EXPIRED']);
  // The overnight account lists every amount as positive: these types take money out.
  const DEPOSIT_OUTFLOW = /WITHDRAWAL|_OUT$/;

  function classify(summary) {
    switch (summary && summary.__typename) {
      case 'BrokerSecurityTransactionSummary':
        return 'security';
      case 'BrokerCashTransactionSummary':
        return 'cash';
      case 'BrokerNonTradeSecurityTransactionSummary':
        return 'nonTrade';
      case 'BrokerEltifTransactionSummary':
        return 'eltif';
      default:
        break;
    }
    if (summary && summary.type === 'SECURITY_TRANSACTION') return 'security';
    if (summary && summary.type === 'CASH_TRANSACTION') return 'cash';
    return 'unknown';
  }

  function needsDetails(summary) {
    return classify(summary) === 'security' && EXECUTED.has(summary.status);
  }

  // Overnight-account interest: its details carry the gross amount and the withheld tax.
  function needsDepositDetails(transaction) {
    return /INTEREST/.test((transaction && transaction.cashTransactionType) || '') && !NOT_EXECUTED.has(transaction.status);
  }

  function primeStatus(status) {
    return STATUS_TO_PRIME[status] || status || '';
  }

  function primeType(summary) {
    const kind = classify(summary);
    const subtype = summary.securityTransactionType || summary.cashTransactionType || summary.nonTradeSecurityTransactionType || '';
    if (kind === 'security' || kind === 'eltif') {
      if (summary.side === 'SELL') return 'Sell';
      if (summary.side === 'BUY') return subtype === 'SAVINGS_PLAN' ? 'Savings plan' : 'Buy';
      return subtype || summary.side || summary.type || '';
    }
    if (kind === 'cash') return CASH_TO_PRIME[subtype] || subtype || summary.type || '';
    if (kind === 'nonTrade') return /TRANSFER/.test(subtype) ? 'Security transfer' : 'Corporate action';
    return subtype || summary.type || '';
  }

  function booleanText(value) {
    if (value === true) return 'true';
    if (value === false) return 'false';
    return '';
  }

  function emptyRow(context) {
    const row = {};
    for (const column of COLUMNS) row[column.name] = '';
    row.lf_exporter = context.exporter;
    row.lf_format = FORMAT_VERSION;
    return row;
  }

  // detailsResult: { status: 'yes' | 'no' | 'error' | 'n/a', details }
  function mapBrokerTransaction(summary, detailsResult, context) {
    const details = (detailsResult && detailsResult.details) || null;
    const amounts = (details && details.tradeTransactionAmounts) || {};
    const security = (details && details.security) || {};
    const when = format.berlinDateTime(summary.lastEventDateTime);
    const rawQuantity = summary.quantity !== undefined && summary.quantity !== null ? summary.quantity : summary.eltifQuantity;
    const quantity = format.toPlainString(rawQuantity);
    const amount = format.toPlainString(summary.amount);
    const price = format.toPlainString(details && details.averagePrice);
    const fee = details ? format.sumDecimals([amounts.transactionFee, amounts.venueFee, amounts.cryptoSpreadFee]) : '';
    const taxAmount = format.toPlainString(amounts.taxAmount);

    const row = emptyRow(context);
    Object.assign(row, {
      date: when.date,
      time: when.time,
      status: primeStatus(summary.status),
      reference: (details && details.transactionReference) || summary.id || '',
      description: summary.description || security.name || '',
      assetType: classify(summary) === 'cash' ? 'Cash' : 'Security',
      type: primeType(summary),
      isin: summary.isin || summary.relatedIsin || security.isin || '',
      shares: format.toDecimalComma(quantity),
      price: format.toDecimalComma(price),
      amount: format.toDecimalComma(amount),
      fee: format.toDecimalComma(fee),
      tax: format.toDecimalComma(taxAmount),
      currency: summary.currency || (details && details.currency) || '',
      lf_account: 'broker',
      lf_account_index: '1',
      lf_id: summary.id || '',
      lf_kind: summary.type || '',
      lf_subtype: summary.securityTransactionType || summary.cashTransactionType || summary.nonTradeSecurityTransactionType || '',
      lf_side: summary.side || '',
      lf_status: summary.status || '',
      lf_is_cancellation: booleanText(summary.isCancellation),
      lf_timestamp_utc: summary.lastEventDateTime || '',
      lf_amount: amount,
      lf_quantity: quantity,
      lf_price: price,
      lf_filled_shares: format.toPlainString(details && details.numberOfShares && details.numberOfShares.filled),
      lf_total_amount: format.toPlainString(details && details.totalAmount),
      lf_market_valuation: format.toPlainString(amounts.marketValuation),
      lf_transaction_fee: format.toPlainString(amounts.transactionFee),
      lf_venue_fee: format.toPlainString(amounts.venueFee),
      lf_crypto_spread_fee: format.toPlainString(amounts.cryptoSpreadFee),
      lf_tax_amount: taxAmount,
      lf_fee: format.toPlainString(details && details.fee),
      lf_transactional_fee: format.toPlainString(details && details.transactionalFee),
      lf_taxes: format.toPlainString(details && details.taxes),
      lf_trading_venue: (details && details.tradingVenue) || '',
      lf_transaction_reference: (details && details.transactionReference) || '',
      lf_details: (detailsResult && detailsResult.status) || 'n/a',
    });
    return row;
  }

  // detailsResult: { status: 'yes' | 'no' | 'error' | 'n/a', details } for interest.
  function mapDepositTransaction(transaction, accountIndex, context, detailsResult) {
    const details = (detailsResult && detailsResult.details) || null;
    const taxDetails = (details && details.taxDetails) || {};
    const when = format.berlinDateTime(transaction.lastEventDateTime);
    const amount = format.toPlainString(transaction.amount);
    const taxAmount = format.toPlainString(taxDetails.taxAmount);
    const subtype = transaction.cashTransactionType || '';
    const outflow = DEPOSIT_OUTFLOW.test(subtype) && /^[0-9.]+$/.test(amount) && /[1-9]/.test(amount);
    const signedAmount = outflow ? `-${amount}` : amount;
    const isCancellation = details && typeof details.isCancellation === 'boolean' ? details.isCancellation : transaction.isCancellation;
    const row = emptyRow(context);
    Object.assign(row, {
      date: when.date,
      time: when.time,
      status: primeStatus(transaction.status),
      reference: (details && details.transactionReference) || transaction.id || '',
      description: transaction.description || '',
      assetType: 'Cash',
      type: CASH_TO_PRIME[subtype] || subtype || transaction.type || '',
      amount: format.toDecimalComma(signedAmount),
      tax: format.toDecimalComma(taxAmount),
      currency: transaction.currency || '',
      lf_account: 'deposit',
      lf_account_index: String(accountIndex),
      lf_id: transaction.id || '',
      lf_kind: transaction.type || '',
      lf_subtype: subtype,
      lf_status: transaction.status || '',
      lf_is_cancellation: booleanText(isCancellation),
      lf_timestamp_utc: transaction.lastEventDateTime || '',
      lf_amount: amount,
      lf_tax_amount: taxAmount,
      lf_gross_amount: format.toPlainString(taxDetails.grossAmount),
      lf_transaction_reference: (details && details.transactionReference) || '',
      lf_details: (detailsResult && detailsResult.status) || (needsDepositDetails(transaction) ? 'no' : 'n/a'),
    });
    return row;
  }

  const api = {
    FORMAT_VERSION,
    PRIME_COLUMNS,
    LF_COLUMNS,
    COLUMNS,
    STATUS_TO_PRIME,
    CASH_TO_PRIME,
    classify,
    needsDetails,
    needsDepositDetails,
    DEPOSIT_OUTFLOW,
    primeStatus,
    primeType,
    mapBrokerTransaction,
    mapDepositTransaction,
  };

  root.LFX = root.LFX || {};
  root.LFX.scalable = root.LFX.scalable || {};
  root.LFX.scalable.mapping = api;
  if (isNode) module.exports = api;
})(globalThis);
