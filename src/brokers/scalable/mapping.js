/*
 * Maps Scalable web-app transactions to CSV rows.
 *
 * The first 14 columns follow the official Scalable CSV export (PRIME), so tools
 * that read it can read these files too; their labels are a best-effort mapping.
 * The lf_* columns carry, verbatim, every field that the queries return, and are the
 * source of truth for LibreFolio. See docs/FORMAT.md.
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

  // Columns closing every row, after the fields.
  const CLOSING_COLUMNS = ['lf_details', 'lf_exporter', 'lf_format'].map((name) => ({ name }));

  // Every field that the queries return, from the list and from the details, is written as
  // an lf_* column: GraphQL answers only the fields a query asks for, so the queries decide
  // the content (queries.js for the broker; the web app's own for the overnight account).
  // The fields known so far keep a short name and a fixed place, listed here; any other
  // field is named after its path (numberOfShares.total → lf_number_of_shares_total) and
  // placed before the closing columns.
  const FIELD_COLUMNS = [
    ['id', 'lf_id'],
    ['type', 'lf_kind'],
    ['securityTransactionType', 'lf_subtype'],
    ['cashTransactionType', 'lf_subtype'],
    ['nonTradeSecurityTransactionType', 'lf_subtype'],
    ['side', 'lf_side'],
    ['status', 'lf_status'],
    ['isCancellation', 'lf_is_cancellation'],
    ['isPending', 'lf_is_pending'],
    ['lastEventDateTime', 'lf_timestamp_utc'],
    ['description', 'lf_description'],
    ['isin', 'lf_isin'],
    ['relatedIsin', 'lf_related_isin'],
    ['currency', 'lf_currency'],
    ['amount', 'lf_amount'],
    ['quantity', 'lf_quantity'],
    ['eltifQuantity', 'lf_quantity'],
    ['averagePrice', 'lf_price'],
    ['numberOfShares.filled', 'lf_filled_shares'],
    ['numberOfShares.total', 'lf_total_shares'],
    ['totalAmount', 'lf_total_amount'],
    ['tradeTransactionAmounts.marketValuation', 'lf_market_valuation'],
    ['tradeTransactionAmounts.transactionFee', 'lf_transaction_fee'],
    ['tradeTransactionAmounts.venueFee', 'lf_venue_fee'],
    ['tradeTransactionAmounts.cryptoSpreadFee', 'lf_crypto_spread_fee'],
    ['tradeTransactionAmounts.taxAmount', 'lf_tax_amount'],
    ['taxDetails.taxAmount', 'lf_tax_amount'],
    ['taxDetails.grossAmount', 'lf_gross_amount'],
    ['fee', 'lf_fee'],
    ['transactionalFee', 'lf_transactional_fee'],
    ['taxes', 'lf_taxes'],
    ['tradingVenue', 'lf_trading_venue'],
    ['transactionReference', 'lf_transaction_reference'],
    ['transactionHistory', 'lf_transaction_history'],
  ];
  const FIELD_COLUMN = new Map(FIELD_COLUMNS);

  // The only field left out: GraphQL's own name of each type, at any depth, which names
  // the shape of the answer rather than the transaction. Everything else that a query
  // returns is written.
  const EXCLUDED_FIELDS = {
    __typename: 'GraphQL type name, internal to the web app',
  };

  function isExcluded(path) {
    return path === '__typename' || path.endsWith('.__typename');
  }

  function columnOf(path) {
    if (FIELD_COLUMN.has(path)) return FIELD_COLUMN.get(path);
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

  // Writes the fields into the row: fixed columns in place, new fields as new columns.
  function writeFields(row, fields, context) {
    for (const path of Object.keys(fields)) {
      if (isExcluded(path)) continue;
      const column = columnOf(path);
      if (!row[column]) row[column] = maskIds(fieldText(fields[path]), context);
    }
  }

  // The new fields among the rows, sorted, and every column of a file: the fixed ones, the
  // new fields, then the closing columns.
  function extraColumns(rows) {
    const fixed = new Set(COLUMNS.map((column) => column.name));
    const extra = new Set();
    for (const row of rows) for (const name of Object.keys(row)) if (!fixed.has(name)) extra.add(name);
    return Array.from(extra).sort();
  }

  function columnsFor(rows) {
    const closing = new Set(CLOSING_COLUMNS.map((column) => column.name));
    return COLUMNS.filter((column) => !closing.has(column.name)).concat(
      extraColumns(rows).map((name) => ({ name })),
      CLOSING_COLUMNS,
    );
  }

  // Not fields of the web app: which account, and which of its overnight accounts.
  const ACCOUNT_COLUMNS = ['lf_account', 'lf_account_index'].map((name) => ({ name }));

  // The fixed lf_* columns: the account, the known fields in order, the closing columns.
  const LF_COLUMNS = ACCOUNT_COLUMNS.concat(
    Array.from(new Set(FIELD_COLUMNS.map(([, name]) => name))).map((name) => ({ name })),
    CLOSING_COLUMNS,
  );

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
    const when = format.berlinDateTime(summary.lastEventDateTime);
    const rawQuantity = summary.quantity !== undefined && summary.quantity !== null ? summary.quantity : summary.eltifQuantity;
    const filled = details && details.numberOfShares ? details.numberOfShares.filled : undefined;
    // Like the official export: the shares executed, so none for an order that never was.
    const shares = NOT_EXECUTED.has(summary.status) ? '0' : format.toPlainString(filled !== undefined && filled !== null ? filled : rawQuantity);
    const price = format.toPlainString(details && details.averagePrice);
    // Read details without a fee or a tax mean none, like the official export's 0; without
    // the details, fee and tax stay empty: unknown.
    const fee = details ? format.sumDecimals([amounts.transactionFee, amounts.venueFee, amounts.cryptoSpreadFee]) || '0' : '';
    const tax = details ? format.toPlainString(amounts.taxAmount) || '0' : '';
    const fields = mergedFields(summary, details);

    const row = emptyRow(context);
    Object.assign(row, {
      date: when.date,
      time: when.time,
      status: primeStatus(summary.status),
      reference: maskIds((details && details.transactionReference) || summary.id || '', context),
      description: maskIds(summary.description || '', context),
      assetType: classify(summary) === 'cash' ? 'Cash' : 'Security',
      type: primeType(summary),
      isin: summary.isin || summary.relatedIsin || '',
      shares: format.toDecimalComma(shares),
      price: format.toDecimalComma(price),
      amount: format.toDecimalComma(format.toPlainString(summary.amount)),
      fee: format.toDecimalComma(fee),
      tax: format.toDecimalComma(tax),
      currency: summary.currency || '',
      lf_account: 'broker',
      lf_account_index: '1',
      lf_details: (detailsResult && detailsResult.status) || 'n/a',
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
    const row = emptyRow(context);
    Object.assign(row, {
      date: when.date,
      time: when.time,
      status: primeStatus(transaction.status),
      reference: maskIds((details && details.transactionReference) || transaction.id || '', context),
      description: maskIds(transaction.description || '', context),
      assetType: 'Cash',
      type: CASH_TO_PRIME[subtype] || subtype || transaction.type || '',
      amount: format.toDecimalComma(signedAmount),
      tax: format.toDecimalComma(details ? format.toPlainString(taxDetails.taxAmount) || '0' : ''),
      currency: transaction.currency || '',
      lf_account: 'deposit',
      lf_account_index: String(accountIndex),
      lf_details: (detailsResult && detailsResult.status) || (needsDepositDetails(transaction) ? 'no' : 'n/a'),
    });
    writeFields(row, fields, context);
    return row;
  }

  const api = {
    FORMAT_VERSION,
    PRIME_COLUMNS,
    LF_COLUMNS,
    COLUMNS,
    CLOSING_COLUMNS,
    FIELD_COLUMNS,
    EXCLUDED_FIELDS,
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
