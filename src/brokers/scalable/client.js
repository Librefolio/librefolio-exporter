/*
 * Read-only client for the Scalable Capital web app.
 *
 * It runs inside the logged-in page and sends same-origin requests, so the
 * browser attaches the session cookies: no credential is ever read or stored.
 * Requests are sequential and paced, so the export looks like light, manual use.
 *
 * Broker: the web app's GraphQL endpoint, /broker/api/data.
 * Overnight account: from the browser, the interest app answers the queries its own
 * pages send. The extension reuses the exact query that the server-rendered
 * Transactions page carries (its "recipe") and only changes the page cursor.
 */
(function (root) {
  'use strict';

  const isNode = typeof module === 'object' && module.exports;
  const queries = isNode ? require('./queries.js') : root.LFX.scalable.queries;
  const flight = isNode ? require('./flight.js') : root.LFX.scalable.flight;

  const BROKER_PATH = '/broker/api/data';
  const INTEREST_PATH = '/interest/api/graphql/';
  const FEATURES = 'CRYPTO_MULTI_ETP,UNIQUE_SECURITY_ID';
  const BROKER_PAGE_SIZE = 50;
  const MAX_PAGES = 2000;

  const DEFAULT_PACING = Object.freeze({ minDelayMs: 300, maxDelayMs: 700, retryDelayMs: 2000, maxAttempts: 3 });

  const SESSION_MESSAGE = /unauthenticated|not authenticated|session expired|login required/i;
  const DENIED_MESSAGE = /unauthori[sz]ed|forbidden|access denied|not allowed|permission denied/i;

  class ExportError extends Error {
    constructor(code, detail) {
      super(detail === undefined || detail === null || detail === '' ? code : `${code}: ${detail}`);
      this.name = 'ExportError';
      this.code = code;
      this.detail = detail === undefined || detail === null ? '' : String(detail);
    }
  }

  // The query does not fit what the endpoint serves.
  function isShapeError(error) {
    if (!(error instanceof ExportError)) return false;
    if (error.code === 'graphql' || error.code === 'unexpected') return true;
    return error.code === 'http' && ['400', '404', '405'].includes(error.detail);
  }

  // The endpoint refused the request.
  function isAccessError(error) {
    return error instanceof ExportError && (error.code === 'denied' || error.code === 'session');
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

  // Paths in the logs, with anything shaped like an identifier hidden.
  function safePath(path) {
    return String(path || '').replace(/[A-Za-z0-9]{16,}/g, '…');
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

  function depositPagePath(savingsAccountId) {
    return `/interest/overnight/${encodeURIComponent(savingsAccountId)}/transactions/`;
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
    // One request at a time for the whole export: the two accounts are read side by side,
    // and their requests still go one by one, with a pause between them. A request waiting
    // on a retry, after "too many requests" too, holds the others back.
    let turn = Promise.resolve();

    function checkAborted() {
      if (signal && signal.aborted) throw new ExportError('cancelled');
    }

    async function wait(ms) {
      if (ms > 0) await sleep(ms, signal);
    }

    async function send(path, label, init, logPath) {
      const previous = turn;
      let release;
      turn = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await sendNow(path, label, init, logPath);
      } finally {
        release();
      }
    }

    // One paced request; network errors, 429 and 5xx are retried, 401 and 403 are not.
    // logPath replaces the path in the logs when the path holds an identifier.
    async function sendNow(path, label, init, logPath) {
      const shownPath = logPath || safePath(path);
      for (let attempt = 1; ; attempt++) {
        checkAborted();
        if (requestCount > 0) await wait(pacing.minDelayMs + random() * (pacing.maxDelayMs - pacing.minDelayMs));
        requestCount++;
        let response;
        const started = Date.now();
        try {
          response = await fetchImpl(origin + path, Object.assign({ credentials: 'same-origin', signal }, init));
        } catch (error) {
          if ((signal && signal.aborted) || (error && error.name === 'AbortError')) throw new ExportError('cancelled');
          log('request', { operation: label, path: shownPath, attempt, error: 'network' });
          if (attempt < pacing.maxAttempts) {
            await wait(pacing.retryDelayMs * attempt);
            continue;
          }
          throw new ExportError('network', error && error.message);
        }

        const status = response.status;
        const redirected = response.type === 'opaqueredirect' || (status >= 300 && status < 400);
        log('request', { operation: label, path: shownPath, attempt, status: redirected ? 'redirect' : status, ms: Date.now() - started });
        if (redirected) throw new ExportError('redirect', status || '');
        if (status === 401) throw new ExportError('session', status);
        if (status === 403) throw new ExportError('denied', status);
        if (status === 429 || status >= 500) {
          if (attempt < pacing.maxAttempts) {
            await wait(pacing.retryDelayMs * attempt * (status === 429 ? 3 : 1));
            continue;
          }
          throw new ExportError(status === 429 ? 'rateLimited' : 'http', status);
        }
        return response;
      }
    }

    async function postGraphql(path, operationName, query, variables, settings) {
      const headers = { 'content-type': 'application/json' };
      if (settings && settings.features) headers['x-scacap-features-enabled'] = FEATURES;
      const init = { method: 'POST', headers, body: JSON.stringify({ operationName, variables, query }) };
      if (settings && settings.referrer) init.referrer = settings.referrer;
      const response = await send(path, operationName, init);
      const status = response.status;
      // GraphQL servers may answer a query they reject with 400 and the reason in the body.
      if (!response.ok && status !== 400) throw new ExportError('http', status);

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw status === 400 ? new ExportError('http', status) : new ExportError('unexpected', 'response is not JSON');
      }
      const body = Array.isArray(payload) ? payload[0] : payload;
      if (!body || typeof body !== 'object') throw status === 400 ? new ExportError('http', status) : new ExportError('unexpected', 'empty response');
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        const raw = body.errors.map((item) => item && item.message).filter(Boolean).join(' | ') || 'GraphQL error';
        const message = redact(raw, variables);
        const first = body.errors[0] || {};
        const extensions = first.extensions && typeof first.extensions === 'object' ? first.extensions : {};
        const code = typeof extensions.code === 'string' ? redact(extensions.code, variables).slice(0, 60) : '';
        log('graphql-error', {
          operation: operationName,
          path: safePath(path),
          message,
          code,
          classification: typeof extensions.classification === 'string' ? redact(extensions.classification, variables).slice(0, 60) : '',
          at: Array.isArray(first.path) ? first.path.slice(0, 8).map((part) => (typeof part === 'number' ? part : redact(String(part), variables).slice(0, 60))) : [],
        });
        const detail = code ? `${message} [${code}]` : message;
        if (SESSION_MESSAGE.test(message)) throw new ExportError('session', detail);
        if (DENIED_MESSAGE.test(message)) throw new ExportError('denied', detail);
        throw new ExportError('graphql', detail);
      }
      if (status === 400) throw new ExportError('http', status);
      if (!body.data || typeof body.data !== 'object') throw new ExportError('unexpected', 'missing data');
      return body.data;
    }

    // Newest first, page by page; stopWhen(pageTransactions) ends the walk early.
    async function listBrokerTransactions(args) {
      const transactions = [];
      let cursor = null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (args.onPage) args.onPage(page);
        const data = await postGraphql(
          BROKER_PATH,
          'moreTransactions',
          queries.BROKER_TRANSACTIONS,
          {
            personId: args.personId,
            portfolioId: args.portfolioId,
            input: { pageSize: BROKER_PAGE_SIZE, type: [], status: [], searchTerm: '', cursor, includeReinvestmentSubtypes: true },
          },
          { features: true },
        );
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
      const data = await postGraphql(
        BROKER_PATH,
        'getTransactionDetails',
        queries.TRANSACTION_DETAILS,
        { personId: args.personId, transactionId: args.transactionId, portfolioId: args.portfolioId },
        { features: true },
      );
      const details = pick(data, ['account', 'brokerPortfolio', 'transactionDetails']);
      if (!details || typeof details !== 'object') throw new ExportError('unexpected', 'transactionDetails');
      return details;
    }

    // The overnight account's Transactions page, as the web app serves it when the
    // tab is opened: its server data carries the recipe of the transaction list.
    async function getDepositRecipe(savingsAccountId) {
      let response;
      try {
        response = await send(
          depositPagePath(savingsAccountId),
          'Transactions page',
          { method: 'GET', headers: { accept: 'text/html' }, redirect: 'manual' },
          '/interest/overnight/…/transactions/',
        );
      } catch (error) {
        // A redirect: the page wants a login or a security check first.
        if (error && error.code === 'redirect') throw new ExportError('depositPage', 'redirect');
        throw error;
      }
      if (!response.ok) throw new ExportError('http', response.status);
      const recipe = flight.findDepositRecipe(flight.textFromHtml(await response.text()));
      if (!recipe || !flight.isUsableDepositRecipe(recipe, savingsAccountId)) throw new ExportError('depositPage', 'no transaction list in the page');
      return recipe;
    }

    // Newest first, with the page's own query: only the cursor changes between pages.
    // Returns { transactions, total, complete }.
    async function listDepositTransactions(args) {
      const recipe = args.recipe;
      const query = recipe.query.replace(/\s*@unmask\b/g, '');
      const referrer = origin + depositPagePath(args.savingsAccountId);
      const transactions = [];
      let total = null;
      let cursor = null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (args.onPage) args.onPage(page);
        const variables = JSON.parse(JSON.stringify(recipe.variables));
        if (cursor) variables.input = Object.assign({}, variables.input, { cursor });
        const data = await postGraphql(INTEREST_PATH, recipe.operationName, query, variables, { referrer });
        const result = pick(data, ['account', 'savingsAccount', 'moreTransactions']);
        if (!result || !Array.isArray(result.transactions)) throw new ExportError('unexpected', 'savingsAccount.moreTransactions');
        transactions.push(...result.transactions);
        if (typeof result.total === 'number') total = result.total;
        cursor = result.cursor || null;
        const stopped = Boolean(cursor) && result.transactions.length > 0 && Boolean(args.stopWhen && args.stopWhen(result.transactions));
        if (!cursor || result.transactions.length === 0 || stopped) {
          const complete = stopped || total === null || transactions.length >= total;
          log('overnight-source', { pages: page, transactions: transactions.length, total, complete });
          return { transactions, total, complete };
        }
      }
      throw new ExportError('unexpected', 'too many pages');
    }

    // The details of an overnight-account transaction (gross interest, tax withheld),
    // with the query the page sends when a transaction is opened.
    async function getDepositTransactionDetails(args) {
      const data = await postGraphql(
        INTEREST_PATH,
        'OvernightTransactionDetails',
        queries.DEPOSIT_TRANSACTION_DETAILS,
        { personId: args.personId, savingsAccountId: args.savingsAccountId, transactionId: args.transactionId },
        { referrer: origin + depositPagePath(args.savingsAccountId) },
      );
      const details = pick(data, ['account', 'savingsAccount', 'transactionDetails']);
      if (!details || typeof details !== 'object') throw new ExportError('unexpected', 'savingsAccount.transactionDetails');
      return details;
    }

    return {
      listBrokerTransactions,
      getTransactionDetails,
      getDepositRecipe,
      listDepositTransactions,
      getDepositTransactionDetails,
      requestCount: () => requestCount,
    };
  }

  const api = {
    ExportError,
    isShapeError,
    isAccessError,
    createClient,
    defaultSleep,
    redact,
    safePath,
    depositPagePath,
    BROKER_PATH,
    INTEREST_PATH,
  };

  root.LFX = root.LFX || {};
  root.LFX.scalable = root.LFX.scalable || {};
  root.LFX.scalable.client = api;
  if (isNode) module.exports = api;
})(globalThis);
