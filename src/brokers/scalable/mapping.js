/*
 * Maps Scalable web-app transactions to CSV rows.
 *
 * The first 14 columns follow the official Scalable CSV export (PRIME), so tools
 * that read it can read these files too; their labels are a best-effort mapping.
 * The lf_* columns carry, verbatim, what the Prime columns do not: every field that the
 * queries return is written once. See docs/formats/scalable.md.
 */
(function (root) {
  'use strict';

  const isNode = typeof module === 'object' && module.exports;
  const format = isNode ? require('../../shared/format.js') : root.LFX.format;

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

  // Where each field of the web app goes, so that none is written twice: in the lf_*
  // column named here (`column`); only in the Prime column that already carries it
  // (`prime`); or nowhere, because it repeats another field (`none`). A column that only
  // one account fills (`account`) is left out of the other account's file. GraphQL's
  // __typename names types, not data, and is never written. A field missing here can only
  // come from a query of the web app that Scalable has changed: it is written as a new
  // column named after its path (numberOfShares.total → lf_number_of_shares_total).
  const FIELDS = {
    id: { column: 'lf_id' },
    securityTransactionType: { column: 'lf_subtype' },
    cashTransactionType: { column: 'lf_subtype' },
    nonTradeSecurityTransactionType: { column: 'lf_subtype' },
    isCancellation: { column: 'lf_is_cancellation', when: 'a reversal' },
    'numberOfShares.total': { column: 'lf_ordered_shares', when: 'not all were executed', account: 'broker' },
    'tradeTransactionAmounts.transactionFee': { column: 'lf_transaction_fee', account: 'broker' },
    'tradeTransactionAmounts.venueFee': { column: 'lf_venue_fee', account: 'broker' },
    'tradeTransactionAmounts.cryptoSpreadFee': { column: 'lf_crypto_spread_fee', account: 'broker' },
    tradingVenue: { column: 'lf_trading_venue', account: 'broker' },
    lastEventDateTime: { prime: 'date, time' },
    status: { prime: 'status' },
    transactionReference: { prime: 'reference' },
    description: { prime: 'description' },
    type: { prime: 'assetType, type' },
    side: { prime: 'type' },
    isin: { prime: 'isin' },
    relatedIsin: { prime: 'isin' },
    quantity: { prime: 'shares', column: 'lf_ordered_shares', when: 'not all were executed', account: 'broker' },
    eltifQuantity: { prime: 'shares', column: 'lf_ordered_shares', when: 'not all were executed', account: 'broker' },
    'numberOfShares.filled': { prime: 'shares' },
    averagePrice: { prime: 'price' },
    // A trade read with its details has in amount the value of the shares, as in the official
    // export: the web app's amount, fees and taxes included, is then amount - fee - tax.
    amount: { prime: 'amount' },
    'tradeTransactionAmounts.marketValuation': { prime: 'amount' },
    'tradeTransactionAmounts.taxAmount': { prime: 'tax' },
    'taxDetails.taxAmount': { prime: 'tax' },
    currency: { prime: 'currency' },
    isPending: { none: 'repeats the status' },
    'taxDetails.grossAmount': { none: 'equals amount + tax' },
    transactionHistory: { none: 'repeats the status and the date' },
  };

  function knownField(path) {
    return Object.prototype.hasOwnProperty.call(FIELDS, path) ? FIELDS[path] : null;
  }

  function columnOf(path) {
    const known = knownField(path);
    if (known) return known.column || null;
    const words = path.replace(/\./g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2');
    return `lf_${words.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
  }

  // Every field of a web-app object, as { path: value }: nested objects are walked, lists
  // kept whole; empty values carry no field.
  function flatten(value, prefix, out) {
    for (const key of Object.keys(value || {})) {
      const item = value[key];
      const path = prefix ? `${prefix}.${key}` : key;
      if (item === null || item === undefined) continue;
      if (typeof item === 'object' && !Array.isArray(item)) flatten(item, path, out);
      else out[path] = item;
    }
    return out;
  }

  function fieldText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' || typeof value === 'bigint') return format.toPlainString(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') return value;
    // A list, such as the overnight account's transactionHistory, written whole.
    return JSON.stringify(value, (key, item) => (key === '__typename' ? undefined : item));
  }

  // The fields of the list item and of its details: a field in both keeps the list value,
  // and a different value in the details goes to a details.* path, so nothing is lost.
  function mergedFields(summary, details) {
    const fields = flatten(summary, '', {});
    const more = details ? flatten(details, '', {}) : {};
    for (const path of Object.keys(more)) {
      if (!(path in fields)) fields[path] = more[path];
      else if (fieldText(fields[path]) !== fieldText(more[path])) fields[`details.${path}`] = more[path];
    }
    return fields;
  }

  // A short tag in place of an account id: the same id always gives the same tag, and the
  // tag does not give the id back.
  function tag(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  // The person, portfolio and overnight-account ids, wherever they appear in a value (the
  // overnight account's transaction ids contain its id), become `<kind>-<tag>`.
  // context.privateIds: { person: [...], portfolio: [...], account: [...] }.
  function maskIds(text, context) {
    if (typeof text !== 'string' || !context || !context.privateIds) return text;
    let masked = text;
    for (const [kind, ids] of Object.entries(context.privateIds)) {
      for (const id of ids || []) {
        if (typeof id === 'string' && id.length >= 6 && masked.includes(id)) masked = masked.split(id).join(`${kind}-${tag(id)}`);
      }
    }
    return masked;
  }

  // Writes the fields that have an lf_* column: known ones in place, new ones as new columns.
  // A field written only under a condition (`when`) is left to the mapping functions.
  function writeFields(row, fields, context) {
    for (const path of Object.keys(fields)) {
      if (path === '__typename' || path.endsWith('.__typename')) continue;
      if ((knownField(path) || {}).when) continue;
      const column = columnOf(path);
      if (column && !row[column]) row[column] = maskIds(fieldText(fields[path]), context);
    }
  }

  // The new fields among the rows, sorted, and every column of a file: the fixed ones of its
  // accounts, then the new fields.
  function extraColumns(rows) {
    const fixed = new Set(COLUMNS.map((column) => column.name));
    const extra = new Set();
    for (const row of rows) for (const name of Object.keys(row)) if (!fixed.has(name)) extra.add(name);
    return Array.from(extra).sort();
  }

  function columnsFor(rows) {
    const accounts = new Set(rows.map((row) => row.lf_account));
    const ofTheseAccounts = (column) => !column.account || rows.length === 0 || accounts.has(column.account);
    return COLUMNS.filter(ofTheseAccounts).concat(extraColumns(rows).map((name) => ({ name })));
  }

  // Not fields of the web app: which account, and which of its overnight accounts (the
  // broker has one portfolio).
  const ACCOUNT_COLUMNS = [{ name: 'lf_account' }, { name: 'lf_account_index', account: 'deposit' }];

  // The fixed lf_* columns: the account, then the known fields in order, with the account
  // that fills them when only one does.
  const FIELD_COLUMNS = [];
  for (const field of Object.values(FIELDS)) {
    if (!field.column || FIELD_COLUMNS.some((column) => column.name === field.column)) continue;
    FIELD_COLUMNS.push(field.account ? { name: field.column, account: field.account } : { name: field.column });
  }
  const LF_COLUMNS = ACCOUNT_COLUMNS.concat(FIELD_COLUMNS);

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

  function emptyRow() {
    const row = {};
    for (const column of COLUMNS) row[column.name] = '';
    return row;
  }

  // A reversal of another transaction: marked, since it otherwise looks like any other.
  function reversal(...sources) {
    return sources.some((source) => source && source.isCancellation === true) ? 'true' : '';
  }

  // The value of a trade's shares with the sign of the trade: negative for a buy, positive
  // for a sell, otherwise that of the web app's amount. '' when the value is not a number.
  function sharesValue(summary, marketValuation) {
    const value = format.toPlainString(marketValuation);
    if (!/^-?\d+(?:\.\d+)?$/.test(value)) return '';
    const magnitude = value.replace(/^-/, '');
    const negative = summary.side === 'BUY' || (summary.side !== 'SELL' && format.toPlainString(summary.amount).startsWith('-'));
    return negative && /[1-9]/.test(magnitude) ? `-${magnitude}` : magnitude;
  }

  // detailsResult: { status: 'yes' | 'no' | 'error' | 'n/a', details }
  function mapBrokerTransaction(summary, detailsResult, context) {
    const details = (detailsResult && detailsResult.details) || null;
    const amounts = (details && details.tradeTransactionAmounts) || {};
    const when = format.berlinDateTime(summary.lastEventDateTime);
    const rawQuantity = summary.quantity !== undefined && summary.quantity !== null ? summary.quantity : summary.eltifQuantity;
    const filled = details && details.numberOfShares ? details.numberOfShares.filled : undefined;
    const total = details && details.numberOfShares ? details.numberOfShares.total : undefined;
    // Like the official export: the shares executed, so none for an order that never was.
    const shares = NOT_EXECUTED.has(summary.status) ? '0' : format.toPlainString(filled !== undefined && filled !== null ? filled : rawQuantity);
    // The shares ordered, only when they differ from the shares executed.
    const ordered = format.toPlainString(total !== undefined && total !== null ? total : rawQuantity);
    const price = format.toPlainString(details && details.averagePrice);
    // Like the official export, the value of the shares, fees and taxes apart, when the details
    // give it; otherwise the web app's amount, fees included.
    const amount = sharesValue(summary, amounts.marketValuation) || format.toPlainString(summary.amount);
    // Read details without a fee or a tax mean none, like the official export's 0; without
    // the details, fee and tax stay empty: unknown.
    const fee = details ? format.sumDecimals([amounts.transactionFee, amounts.venueFee, amounts.cryptoSpreadFee]) || '0' : '';
    const tax = details ? format.toPlainString(amounts.taxAmount) || '0' : '';
    const fields = mergedFields(summary, details);

    const row = emptyRow();
    Object.assign(row, {
      date: when.date,
      time: when.time,
      status: primeStatus(summary.status),
      reference: maskIds((details && details.transactionReference) || '', context),
      description: maskIds(summary.description || '', context),
      assetType: classify(summary) === 'cash' ? 'Cash' : 'Security',
      type: primeType(summary),
      isin: summary.isin || summary.relatedIsin || '',
      shares: format.toDecimalComma(shares),
      price: format.toDecimalComma(price),
      amount: format.toDecimalComma(amount),
      fee: format.toDecimalComma(fee),
      tax: format.toDecimalComma(tax),
      currency: summary.currency || '',
      lf_account: 'broker',
      lf_is_cancellation: reversal(summary, details),
      lf_ordered_shares: ordered && ordered !== shares ? ordered : '',
    });
    writeFields(row, fields, context);
    return row;
  }

  // detailsResult: { status: 'yes' | 'no' | 'error' | 'n/a', details } for interest.
  function mapDepositTransaction(transaction, accountIndex, context, detailsResult) {
    const details = (detailsResult && detailsResult.details) || null;
    const taxDetails = (details && details.taxDetails) || {};
    const when = format.berlinDateTime(transaction.lastEventDateTime);
    const amount = format.toPlainString(transaction.amount);
    const subtype = transaction.cashTransactionType || '';
    const outflow = DEPOSIT_OUTFLOW.test(subtype) && /^[0-9.]+$/.test(amount) && /[1-9]/.test(amount);
    const signedAmount = outflow ? `-${amount}` : amount;
    const fields = mergedFields(transaction, details);
    const row = emptyRow();
    Object.assign(row, {
      date: when.date,
      time: when.time,
      status: primeStatus(transaction.status),
      reference: maskIds((details && details.transactionReference) || '', context),
      description: maskIds(transaction.description || '', context),
      assetType: 'Cash',
      type: CASH_TO_PRIME[subtype] || subtype || transaction.type || '',
      amount: format.toDecimalComma(signedAmount),
      tax: format.toDecimalComma(details ? format.toPlainString(taxDetails.taxAmount) || '0' : ''),
      currency: transaction.currency || '',
      lf_account: 'deposit',
      lf_account_index: String(accountIndex),
      lf_is_cancellation: reversal(transaction, details),
    });
    writeFields(row, fields, context);
    return row;
  }

  const api = {
    PRIME_COLUMNS,
    LF_COLUMNS,
    COLUMNS,
    FIELDS,
    columnsFor,
    extraColumns,
    maskIds,
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
