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

  // After these errors, asking for more details would only make things worse.
  const STOP_DETAILS = new Set(['session', 'denied', 'rateLimited', 'network']);

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

  // One request per item, in sequence; a session, access or rate-limit error stops
  // the remaining requests and flags those items as not read.
  async function readDetails(items, fetchOne, onProgress) {
    const detailsById = new Map();
    let failed = 0;
    for (let index = 0; index < items.length; index++) {
      onProgress(index + 1, items.length);
      try {
        detailsById.set(items[index].id, { status: 'yes', details: await fetchOne(items[index]) });
      } catch (error) {
        if (error && error.code === 'cancelled') throw error;
        failed++;
        detailsById.set(items[index].id, { status: 'error' });
        if (error && STOP_DETAILS.has(error.code)) {
          for (const rest of items.slice(index + 1)) {
            detailsById.set(rest.id, { status: 'error' });
            failed++;
          }
          break;
        }
      }
    }
    return { detailsById, warnings: failed > 0 ? [{ key: 'warnDetails', args: [failed] }] : [] };
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

    let detailsById = new Map();
    let warnings = [];
    if (options.details) {
      ({ detailsById, warnings } = await readDetails(
        selected.filter(mapping.needsDetails),
        (summary) => api.getTransactionDetails({ personId: ids.personId, portfolioId: ids.portfolioId, transactionId: summary.id }),
        (done, total) => progress('progressBrokerDetails', done, total),
      ));
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

  // The list is read with the recipe of the account's Transactions page: the one in the
  // open page or remembered in this browser session first, then the one in a fresh copy
  // of the page. A known recipe that stops working is replaced by a fresh one, once.
  async function readDepositList({ api, ids, savingsAccountId, options, diagnostics }) {
    const known = (ids.depositRecipes || {})[savingsAccountId];
    const candidates = known ? [known, null] : [null];
    for (const candidate of candidates) {
      const source = candidate ? candidate.source : 'download';
      const recipe = candidate ? candidate.recipe : await api.getDepositRecipe(savingsAccountId);
      diagnostics('overnight-recipe', { source, operation: recipe.operationName });
      try {
        const result = await api.listDepositTransactions({ recipe, savingsAccountId, stopWhen: pageEndsBefore(options.from) });
        return Object.assign({ recipe }, result);
      } catch (error) {
        if (!candidate || !(client.isShapeError(error) || client.isAccessError(error))) throw error;
        diagnostics('overnight-recipe-retry', { source, error: error.code });
      }
    }
    throw new ExportError('unexpected', 'overnight recipe');
  }

  // Overnight accounts: the ids seen on the web app's pages, in this tab or earlier in
  // this browser session.
  async function exportDeposit({ api, ids, options, progress, context, diagnostics }) {
    const accounts = ids.savingsAccountIds || [];
    if (accounts.length === 0) throw new ExportError('noDepositAccount');

    const rows = [];
    const warnings = [];
    for (let index = 0; index < accounts.length; index++) {
      const savingsAccountId = accounts[index];
      progress('progressDeposit', index + 1, accounts.length);
      const result = await readDepositList({ api, ids, savingsAccountId, options, diagnostics });
      if (!result.complete) warnings.push({ key: 'warnDepositPartial', args: [result.transactions.length] });
      // The interest app knows the person by a short code of its own: masked as well.
      const privateIds = Object.assign({}, context.privateIds, {
        person: ((context.privateIds && context.privateIds.person) || []).concat(result.recipe.variables.personId || []),
      });
      const accountContext = Object.assign({}, context, { privateIds });
      const selected = uniqueById(result.transactions).filter((transaction) => inRange(transaction.lastEventDateTime, options.from, options.to));

      let detailsById = new Map();
      if (options.details) {
        const read = await readDetails(
          selected.filter(mapping.needsDepositDetails),
          (transaction) =>
            api.getDepositTransactionDetails({ personId: result.recipe.variables.personId, savingsAccountId, transactionId: transaction.id }),
          (done, total) => progress('progressDepositDetails', done, total),
        );
        detailsById = read.detailsById;
        warnings.push(...read.warnings);
      }
      for (const transaction of selected) {
        rows.push(mapping.mapDepositTransaction(transaction, index + 1, accountContext, detailsById.get(transaction.id)));
      }
    }
    return { rows, warnings };
  }

  // options: { broker, deposit, details, from, to } with dates as YYYY-MM-DD (or '').
  // Returns { broker: rows|null, deposit: rows|null, warnings, errors }.
  async function runExport({ api, ids, options, progress, context, diagnostics }) {
    const report = progress || (() => {});
    const note = diagnostics || (() => {});
    const outcome = { broker: null, deposit: null, warnings: [], errors: [] };
    // The ids of the person and of the accounts are never written: where a value contains
    // one, it becomes a tag (mapping.maskIds).
    const rowContext = Object.assign({}, context, {
      privateIds: {
        person: [ids.personId].filter(Boolean),
        portfolio: [ids.portfolioId].filter(Boolean),
        account: (ids.savingsAccountIds || []).filter(Boolean),
      },
    });
    const sections = [];
    if (options.broker) sections.push(['broker', exportBroker]);
    if (options.deposit) sections.push(['deposit', exportDeposit]);
    // The accounts are read side by side, so that both show their progress from the start;
    // the client still sends one request at a time. accountDone and accountFailed tell the
    // progress when an account is over.
    const results = await Promise.all(
      sections.map(([account, run]) =>
        run({ api, ids, options, progress: report, context: rowContext, diagnostics: note }).then(
          (result) => {
            report('accountDone', account, result.rows.length);
            return { account, result };
          },
          (error) => {
            if (!(error && error.code === 'cancelled')) report('accountFailed', account);
            return { account, error };
          },
        ),
      ),
    );
    for (const { account, result, error } of results) {
      if (result === undefined) {
        if (error && error.code === 'cancelled') throw error;
        outcome.errors.push({ account, error });
      } else {
        outcome[account] = result.rows;
        outcome.warnings.push(...result.warnings);
      }
    }
    // Fields of the web app that this version does not know yet: their names, never values.
    const newFields = mapping.extraColumns([].concat(outcome.broker || [], outcome.deposit || []));
    if (newFields.length > 0) note('new-fields', newFields);
    return outcome;
  }

  function toCsv(rows) {
    return csv.build(mapping.columnsFor(rows), rows);
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
        assetType: row.assetType,
        type: row.type,
        subtype: row.lf_subtype,
        status: row.lf_status,
        amount: sign(row.amount),
        shares: sign(row.shares),
        fee: sign(row.fee),
        tax: sign(row.tax),
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
