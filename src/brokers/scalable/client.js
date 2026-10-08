/*
 * Read-only GraphQL client for the Scalable Capital web app.
 *
 * It runs inside the logged-in page and sends same-origin requests, so the
 * browser attaches the session cookies: no credential is ever read or stored.
 * Requests are sequential and paced, so the export looks like light, manual use.
 */
(function (root) {
  'use strict';

  const isNode = typeof module === 'object' && module.exports;
  const queries = isNode ? require('./queries.js') : root.LFX.scalable.queries;

  const BROKER_PATH = '/broker/api/data';
  const INTEREST_PATH = '/interest/api/graphql/';
  const FEATURES = 'CRYPTO_MULTI_ETP,UNIQUE_SECURITY_ID';
  const BROKER_PAGE_SIZE = 50;
  const DEPOSIT_PAGE_SIZE = 50;
  const DEPOSIT_SINGLE_PAGE_SIZE = 200;
  const MAX_PAGES = 2000;

  const DEFAULT_PACING = Object.freeze({ minDelayMs: 300, maxDelayMs: 700, retryDelayMs: 2000, maxAttempts: 3 });

  class ExportError extends Error {
    constructor(code, detail) {
      super(detail === undefined || detail === null || detail === '' ? code : `${code}: ${detail}`);
      this.name = 'ExportError';
      this.code = code;
      this.detail = detail === undefined || detail === null ? '' : String(detail);
    }
  }

  // Errors after which another endpoint or query shape is worth trying.
  function isShapeError(error) {
    if (!(error instanceof ExportError)) return false;
    if (error.code === 'graphql' || error.code === 'unexpected') return true;
    return error.code === 'http' && ['400', '404', '405'].includes(error.detail);
  }

  function defaultSleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new ExportError('cancelled'));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ExportError('cancelled'));
      };
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function pick(object, path) {
    let current = object;
    for (const key of path) {
      if (current === null || current === undefined) return undefined;
      current = current[key];
    }
    return current;
  }

  // GraphQL messages can echo variable values: hide the identifiers before logging them.
  function redact(message, variables) {
    let text = String(message || '');
    const secrets = [];
    const collect = (value) => {
      if (typeof value === 'string' && value.length >= 4) secrets.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(variables);
    for (const secret of secrets.sort((a, b) => b.length - a.length)) text = text.split(secret).join('…');
    return text;
  }

  function createClient(options) {
    const fetchImpl = options.fetchImpl;
    const origin = options.origin;
    const signal = options.signal;
    const sleep = options.sleep || defaultSleep;
    const random = options.random || Math.random;
    const pacing = Object.assign({}, DEFAULT_PACING, options.pacing || {});
    const log = options.log || (() => {});
    let requestCount = 0;

    function checkAborted() {
      if (signal && signal.aborted) throw new ExportError('cancelled');
    }

    async function wait(ms) {
      if (ms > 0) await sleep(ms, signal);
    }

    async function post(path, operationName, query, variables, endpoint) {
      const settings = endpoint || {};
      for (let attempt = 1; ; attempt++) {
        checkAborted();
        if (requestCount > 0) await wait(pacing.minDelayMs + random() * (pacing.maxDelayMs - pacing.minDelayMs));
        requestCount++;
        const headers = { 'content-type': 'application/json' };
        if (settings.features !== false) headers['x-scacap-features-enabled'] = FEATURES;
        const init = {
          method: 'POST',
          headers,
          body: JSON.stringify({ operationName, variables, query }),
          credentials: 'same-origin',
          signal,
        };
        if (settings.referrer) init.referrer = settings.referrer;

        let response;
        const started = Date.now();
        try {
          response = await fetchImpl(origin + path, init);
        } catch (error) {
          if ((signal && signal.aborted) || (error && error.name === 'AbortError')) throw new ExportError('cancelled');
          log('request', { operation: operationName, path, attempt, error: 'network' });
          if (attempt < pacing.maxAttempts) {
            await wait(pacing.retryDelayMs * attempt);
            continue;
          }
          throw new ExportError('network', error && error.message);
        }

        const status = response.status;
        log('request', { operation: operationName, path, attempt, status, ms: Date.now() - started });
        if (status === 401 || status === 403) throw new ExportError('session', status);
        if (status === 429 || status >= 500) {
          if (attempt < pacing.maxAttempts) {
            await wait(pacing.retryDelayMs * attempt * (status === 429 ? 3 : 1));
            continue;
          }
          throw new ExportError(status === 429 ? 'rateLimited' : 'http', status);
        }
        if (!response.ok) throw new ExportError('http', status);

        let payload;
        try {
          payload = await response.json();
        } catch (error) {
          throw new ExportError('unexpected', 'response is not JSON');
        }
        const body = Array.isArray(payload) ? payload[0] : payload;
        if (!body || typeof body !== 'object') throw new ExportError('unexpected', 'empty response');
        if (Array.isArray(body.errors) && body.errors.length > 0) {
          const raw = body.errors.map((item) => item && item.message).filter(Boolean).join(' | ') || 'GraphQL error';
          const message = redact(raw, variables);
          log('graphql-error', { operation: operationName, path, message });
          if (/unauthori[sz]ed|unauthenticated|not authenticated|forbidden/i.test(message)) {
            throw new ExportError('session', message);
          }
          throw new ExportError('graphql', message);
        }
        if (!body.data || typeof body.data !== 'object') throw new ExportError('unexpected', 'missing data');
        return body.data;
      }
    }

    // Newest first, page by page; stopWhen(pageTransactions) ends the walk early.
    async function listBrokerTransactions(args) {
      const transactions = [];
      let cursor = null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (args.onPage) args.onPage(page);
        const data = await post(BROKER_PATH, 'moreTransactions', queries.BROKER_TRANSACTIONS, {
          personId: args.personId,
          portfolioId: args.portfolioId,
          input: {
            pageSize: BROKER_PAGE_SIZE,
            type: [],
            status: [],
            searchTerm: '',
            cursor,
            includeReinvestmentSubtypes: true,
          },
        });
        const result = pick(data, ['account', 'brokerPortfolio', 'moreTransactions']);
        if (!result || !Array.isArray(result.transactions)) {
          throw new ExportError('unexpected', 'brokerPortfolio.moreTransactions');
        }
        transactions.push(...result.transactions);
        cursor = result.cursor || null;
        if (!cursor || result.transactions.length === 0) return transactions;
        if (args.stopWhen && args.stopWhen(result.transactions)) return transactions;
      }
      throw new ExportError('unexpected', 'too many pages');
    }

    async function getTransactionDetails(args) {
      const data = await post(BROKER_PATH, 'getTransactionDetails', queries.TRANSACTION_DETAILS, {
        personId: args.personId,
        transactionId: args.transactionId,
        portfolioId: args.portfolioId,
      });
      const details = pick(data, ['account', 'brokerPortfolio', 'transactionDetails']);
      if (!details || typeof details !== 'object') throw new ExportError('unexpected', 'transactionDetails');
      return details;
    }

    async function listSavingsAccounts(args) {
      const data = await post(BROKER_PATH, 'getSavingsProducts', queries.SAVINGS_ACCOUNTS, { personId: args.personId });
      const accounts = pick(data, ['account', 'savingsAccounts']);
      if (!Array.isArray(accounts)) throw new ExportError('unexpected', 'account.savingsAccounts');
      return accounts.filter((account) => account && account.id);
    }

    // Public projects read the overnight account from two different endpoints:
    // try both, with the cursor first and then as a single page.
    function depositEndpoints(savingsAccountId) {
      return [
        { path: BROKER_PATH, features: true },
        {
          path: INTEREST_PATH,
          features: false,
          referrer: `${origin}/interest/overnight/${encodeURIComponent(savingsAccountId)}`,
        },
      ];
    }

    function extractDeposit(data) {
      const account = pick(data, ['account', 'savingsAccount']);
      const result = account && account.moreTransactions;
      if (!result || !Array.isArray(result.transactions)) {
        throw new ExportError('unexpected', 'savingsAccount.moreTransactions');
      }
      return { result, balance: account.totalAmount };
    }

    async function readDepositPaged(endpoint, args) {
      const transactions = [];
      let cursor = null;
      let balance;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await post(
          endpoint.path,
          'OvernightTransactions',
          queries.DEPOSIT_TRANSACTIONS_PAGED,
          { personId: args.personId, savingsAccountId: args.savingsAccountId, input: { pageSize: DEPOSIT_PAGE_SIZE, cursor } },
          endpoint,
        );
        const extracted = extractDeposit(data);
        balance = extracted.balance;
        transactions.push(...extracted.result.transactions);
        cursor = extracted.result.cursor || null;
        if (!cursor || extracted.result.transactions.length === 0) return { transactions, complete: true, balance };
        if (args.stopWhen && args.stopWhen(extracted.result.transactions)) return { transactions, complete: true, balance };
      }
      throw new ExportError('unexpected', 'too many pages');
    }

    async function readDepositSingle(endpoint, args) {
      const data = await post(
        endpoint.path,
        'OvernightTransactions',
        queries.DEPOSIT_TRANSACTIONS_SINGLE,
        { personId: args.personId, savingsAccountId: args.savingsAccountId, input: { pageSize: DEPOSIT_SINGLE_PAGE_SIZE } },
        endpoint,
      );
      const extracted = extractDeposit(data);
      const transactions = extracted.result.transactions;
      return { transactions, complete: transactions.length < DEPOSIT_SINGLE_PAGE_SIZE, balance: extracted.balance };
    }

    async function listDepositTransactions(args) {
      let lastError = null;
      for (const endpoint of depositEndpoints(args.savingsAccountId)) {
        for (const read of [readDepositPaged, readDepositSingle]) {
          const variant = read === readDepositPaged ? 'paged' : 'single page';
          try {
            const result = await read(endpoint, args);
            log('overnight-source', { path: endpoint.path, variant, transactions: result.transactions.length, complete: result.complete });
            return result;
          } catch (error) {
            if (!isShapeError(error)) throw error;
            log('overnight-fallback', { path: endpoint.path, variant, error: error.code, detail: error.detail });
            lastError = error;
          }
        }
      }
      throw lastError || new ExportError('unexpected', 'savingsAccount');
    }

    return {
      listBrokerTransactions,
      getTransactionDetails,
      listSavingsAccounts,
      listDepositTransactions,
      requestCount: () => requestCount,
    };
  }

  const api = {
    ExportError,
    isShapeError,
    createClient,
    defaultSleep,
    redact,
    BROKER_PATH,
    INTEREST_PATH,
    DEPOSIT_SINGLE_PAGE_SIZE,
  };

  root.LFX = root.LFX || {};
  root.LFX.scalable = root.LFX.scalable || {};
  root.LFX.scalable.client = api;
  if (isNode) module.exports = api;
})(globalThis);
