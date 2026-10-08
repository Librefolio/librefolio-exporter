/*
 * Export orchestration: reads the selected accounts, keeps the rows of the
 * chosen period and maps them to CSV rows. Each account is exported on its own,
 * so a failure in one does not lose the other.
 */
(function (root) {
  'use strict';

  const isNode = typeof module === 'object' && module.exports;
  const format = isNode ? require('../../shared/format.js') : root.LFX.format;
  const csv = isNode ? require('../../shared/csv.js') : root.LFX.csv;
  const mapping = isNode ? require('./mapping.js') : root.LFX.scalable.mapping;
  const client = isNode ? require('./client.js') : root.LFX.scalable.client;
  const ExportError = client.ExportError;

  // After these errors, asking for more trade details would only make things worse.
  const STOP_DETAILS = new Set(['session', 'rateLimited', 'network']);

  function berlinDate(timestamp) {
    return format.berlinDateTime(timestamp).date;
  }

  function inRange(timestamp, from, to) {
    const date = berlinDate(timestamp);
    if (!date) return true;
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  }

  // Lists are newest first: once a page ends before "from", older pages are not needed.
  function pageEndsBefore(from) {
    return (page) => {
      if (!from || page.length === 0) return false;
      const last = page[page.length - 1];
      const date = berlinDate(last && last.lastEventDateTime);
      return Boolean(date) && date < from;
    };
  }

  function uniqueById(items) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
      if (!item) continue;
      if (item.id) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
      }
      result.push(item);
    }
    return result;
  }

  async function exportBroker({ api, ids, options, progress, context }) {
    if (!ids.personId) throw new ExportError('noPerson');
    if (!ids.portfolioId) throw new ExportError('noPortfolio');

    const summaries = await api.listBrokerTransactions({
      personId: ids.personId,
      portfolioId: ids.portfolioId,
      onPage: (page) => progress('progressBrokerList', page),
      stopWhen: pageEndsBefore(options.from),
    });
    const selected = uniqueById(summaries).filter((summary) => inRange(summary.lastEventDateTime, options.from, options.to));

    const detailsById = new Map();
    const warnings = [];
    if (options.details) {
      const pending = selected.filter(mapping.needsDetails);
      let failed = 0;
      for (let index = 0; index < pending.length; index++) {
        const summary = pending[index];
        progress('progressBrokerDetails', index + 1, pending.length);
        try {
          const details = await api.getTransactionDetails({
            personId: ids.personId,
            portfolioId: ids.portfolioId,
            transactionId: summary.id,
          });
          detailsById.set(summary.id, { status: 'yes', details });
        } catch (error) {
          if (error && error.code === 'cancelled') throw error;
          failed++;
          detailsById.set(summary.id, { status: 'error' });
          if (error && STOP_DETAILS.has(error.code)) {
            for (const rest of pending.slice(index + 1)) {
              detailsById.set(rest.id, { status: 'error' });
              failed++;
            }
            break;
          }
        }
      }
      if (failed > 0) warnings.push({ key: 'warnDetails', args: [failed] });
    }

    const rows = selected.map((summary) =>
      mapping.mapBrokerTransaction(
        summary,
        detailsById.get(summary.id) || { status: mapping.needsDetails(summary) ? 'no' : 'n/a' },
        context,
      ),
    );
    return { rows, warnings };
  }

  async function exportDeposit({ api, ids, options, progress, context }) {
    if (!ids.personId) throw new ExportError('noPerson');

    let accounts;
    try {
      accounts = await api.listSavingsAccounts({ personId: ids.personId });
    } catch (error) {
      const pageIds = ids.savingsAccountIds || [];
      if (!client.isShapeError(error) || pageIds.length === 0) throw error;
      accounts = pageIds.map((id) => ({ id }));
    }
    const overnight = accounts.filter((account) => !account.__typename || /overnight/i.test(account.__typename));
    if (overnight.length === 0) return { rows: [], warnings: [{ key: 'warnNoDeposit' }] };

    const rows = [];
    const warnings = [];
    for (let index = 0; index < overnight.length; index++) {
      progress('progressDeposit', index + 1, overnight.length);
      const result = await api.listDepositTransactions({
        personId: ids.personId,
        savingsAccountId: overnight[index].id,
        stopWhen: pageEndsBefore(options.from),
      });
      if (!result.complete) warnings.push({ key: 'warnDepositPartial', args: [result.transactions.length] });
      for (const transaction of uniqueById(result.transactions)) {
        if (inRange(transaction.lastEventDateTime, options.from, options.to)) {
          rows.push(mapping.mapDepositTransaction(transaction, index + 1, context));
        }
      }
    }
    return { rows, warnings };
  }

  // options: { broker, deposit, details, from, to } with dates as YYYY-MM-DD (or '').
  // Returns { broker: rows|null, deposit: rows|null, warnings, errors }.
  async function runExport({ api, ids, options, progress, context }) {
    const report = progress || (() => {});
    const outcome = { broker: null, deposit: null, warnings: [], errors: [] };
    const sections = [];
    if (options.broker) sections.push(['broker', exportBroker]);
    if (options.deposit) sections.push(['deposit', exportDeposit]);
    for (const [account, run] of sections) {
      try {
        const result = await run({ api, ids, options, progress: report, context });
        outcome[account] = result.rows;
        outcome.warnings.push(...result.warnings);
      } catch (error) {
        if (error && error.code === 'cancelled') throw error;
        outcome.errors.push({ account, error });
      }
    }
    return outcome;
  }

  function toCsv(rows) {
    return csv.build(mapping.COLUMNS, rows);
  }

  function sign(plain) {
    if (!plain) return '';
    if (plain.startsWith('-')) return '-';
    return /[1-9]/.test(plain) ? '+' : '0';
  }

  // Shape of an export, for diagnostics: kinds, statuses and signs with their counts,
  // never an amount, a description or an identifier.
  function summarize(rows) {
    const groups = new Map();
    for (const row of rows) {
      const entry = {
        account: row.lf_account,
        kind: row.lf_kind,
        subtype: row.lf_subtype,
        side: row.lf_side,
        status: row.lf_status,
        type: row.type,
        amount: sign(row.lf_amount),
        quantity: sign(row.lf_quantity),
        fee: sign(row.lf_transaction_fee),
        tax: sign(row.lf_tax_amount),
        details: row.lf_details,
      };
      const key = JSON.stringify(entry);
      if (!groups.has(key)) groups.set(key, Object.assign(entry, { count: 0 }));
      groups.get(key).count++;
    }
    return Array.from(groups.values()).sort((a, b) => b.count - a.count);
  }

  const api = { runExport, toCsv, summarize, inRange, pageEndsBefore, uniqueById };

  root.LFX = root.LFX || {};
  root.LFX.scalable = root.LFX.scalable || {};
  root.LFX.scalable.exporter = api;
  if (isNode) module.exports = api;
})(globalThis);
