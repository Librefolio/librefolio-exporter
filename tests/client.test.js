'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createClient, ExportError, BROKER_PATH, INTEREST_PATH } = require('../src/brokers/scalable/client.js');
const { DEPOSIT_TRANSACTION_DETAILS } = require('../src/brokers/scalable/queries.js');

const ORIGIN = 'https://de.scalable.capital';

function respond(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (payload instanceof Error) throw payload;
      return payload;
    },
  };
}

// Each handler answers one request, in order.
function fakeFetch(handlers) {
  const calls = [];
  const queue = handlers.slice();
  const fetchImpl = async (url, init) => {
    const call = { url, init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const handler = queue.shift();
    if (!handler) throw new Error(`unexpected request #${calls.length} to ${url}`);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function brokerPage(transactions, cursor) {
  return { data: { account: { id: 'p', brokerPortfolio: { id: 'pf', moreTransactions: { cursor, total: 3, transactions } } } } };
}

// The recipe of the Transactions page, as the server-rendered page carries it.
const RECIPE = {
  operationName: 'Transactions',
  query:
    'query Transactions($personId:ID!$input:SavingsAccountCashTransactionInput!$portfolioId:ID!){account(id:$personId){id savingsAccount(id:$portfolioId){id ...TransactionsListContainer@unmask}}}fragment TransactionsListContainer on SavingsAccount{id moreTransactions(input:$input){cursor total transactions{id amount}}}',
  variables: { personId: 'short-account-1', portfolioId: 'sav-123456', input: { pageSize: 50 } },
};

function listPage(transactions, cursor, total) {
  return { data: { account: { id: 'short-account-1', savingsAccount: { id: 'sav-123456', moreTransactions: { cursor, total, transactions } } } } };
}

// A Next.js page whose server data carries the recipe, as Apollo writes it.
function pageHtml(recipe) {
  const reference = { options: { query: recipe.query, variables: recipe.variables }, queryKey: 'k', stream: '$@7' };
  const data = `0:{}\n5:["$","$L6",null,{"queryRef":{"$__apollo_queryRef":${JSON.stringify(reference)}}}]\n`;
  return `<!DOCTYPE html><html><body><script>self.__next_f.push([0])</script><script>self.__next_f.push(${JSON.stringify([1, data])})</script></body></html>`;
}

function htmlResponse(html, status) {
  const code = status || 200;
  return { status: code, ok: code >= 200 && code < 300, type: 'basic', text: async () => html, json: async () => JSON.parse(html) };
}

function makeClient(handlers, extra) {
  const fake = fakeFetch(handlers);
  const sleeps = [];
  const client = createClient(
    Object.assign(
      { fetchImpl: fake.fetchImpl, origin: ORIGIN, sleep: async (ms) => sleeps.push(ms), random: () => 0 },
      extra || {},
    ),
  );
  return { client, calls: fake.calls, sleeps };
}

test('broker transactions are read page by page with the cursor', async () => {
  const { client, calls, sleeps } = makeClient([
    () => respond(200, brokerPage([{ id: 'a' }, { id: 'b' }], 'c1')),
    () => respond(200, [brokerPage([{ id: 'c' }], null)]),
  ]);
  const pages = [];
  const result = await client.listBrokerTransactions({ personId: 'person1', portfolioId: 'pf1', onPage: (n) => pages.push(n) });

  assert.deepEqual(result.map((item) => item.id), ['a', 'b', 'c']);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, ORIGIN + BROKER_PATH);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.headers['x-scacap-features-enabled'], 'CRYPTO_MULTI_ETP,UNIQUE_SECURITY_ID');
  assert.equal(calls[0].body.operationName, 'moreTransactions');
  assert.deepEqual(calls[0].body.variables.personId, 'person1');
  assert.equal(calls[0].body.variables.input.cursor, null);
  assert.equal(calls[1].body.variables.input.cursor, 'c1');
  assert.deepEqual(sleeps, [300], 'one pause, between the two requests only');
});

test('stopWhen ends the walk early', async () => {
  const { client, calls } = makeClient([() => respond(200, brokerPage([{ id: 'a' }], 'c1'))]);
  const result = await client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf', stopWhen: () => true });
  assert.equal(result.length, 1);
  assert.equal(calls.length, 1);
});

test('429 and 5xx are retried with a longer pause, then succeed', async () => {
  const { client, calls, sleeps } = makeClient([
    () => respond(429, {}),
    () => respond(503, {}),
    () => respond(200, brokerPage([{ id: 'a' }], null)),
  ]);
  const result = await client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' });
  assert.equal(result.length, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [6000, 300, 4000, 300]);
});

test('persistent 429 becomes a rateLimited error', async () => {
  const { client } = makeClient([() => respond(429, {}), () => respond(429, {}), () => respond(429, {})]);
  await assert.rejects(client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' }), (error) => error instanceof ExportError && error.code === 'rateLimited');
});

test('401 is an expired session and 403 a refusal, never retried', async () => {
  for (const [status, code] of [
    [401, 'session'],
    [403, 'denied'],
  ]) {
    const { client, calls } = makeClient([() => respond(status, {})]);
    await assert.rejects(client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' }), (error) => error.code === code);
    assert.equal(calls.length, 1);
  }
});

test('GraphQL errors are classified: session, refusal or query error', async () => {
  const cases = [
    ['Cannot query field "x"', 'graphql'],
    ['Unauthenticated', 'session'],
    ['Session expired', 'session'],
    ['Unauthorized access', 'denied'],
    ['Forbidden', 'denied'],
  ];
  for (const [message, code] of cases) {
    const { client } = makeClient([() => respond(200, { errors: [{ message }] })]);
    await assert.rejects(client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' }), (error) => {
      assert.equal(error.code, code, message);
      assert.equal(error.detail, message);
      return true;
    });
  }
});

test('the GraphQL error code and path are kept for diagnostics, classified by the message only', async () => {
  const entries = [];
  const { client } = makeClient(
    [
      () =>
        respond(200, {
          errors: [
            {
              message: 'Unauthorized access',
              path: ['_entities', 0, 'savingsAccount'],
              extensions: { code: 'UNAUTHENTICATED', classification: 'ExecutionAborted', secondFactorAuthResult: null },
            },
          ],
          data: { account: { savingsAccount: null, __typename: 'Account' } },
        }),
    ],
    { log: (event, data) => entries.push([event, data]) },
  );
  await assert.rejects(client.listBrokerTransactions({ personId: 'person-secret-1', portfolioId: 'pf' }), (error) => {
    assert.equal(error.code, 'denied', 'the session is not expired: the broker still answers');
    assert.equal(error.detail, 'Unauthorized access [UNAUTHENTICATED]');
    return true;
  });
  const logged = entries.find(([event]) => event === 'graphql-error')[1];
  assert.deepEqual(logged, {
    operation: 'moreTransactions',
    path: BROKER_PATH,
    message: 'Unauthorized access',
    code: 'UNAUTHENTICATED',
    classification: 'ExecutionAborted',
    at: ['_entities', 0, 'savingsAccount'],
  });
});

test('a 400 is read for its GraphQL reason, when it has one', async () => {
  let made = makeClient([() => respond(400, { errors: [{ message: 'Cannot query field "cursor"' }] })]);
  await assert.rejects(made.client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' }), (error) => error.code === 'graphql' && /cursor/.test(error.detail));
  made = makeClient([() => respond(400, new SyntaxError('bad json'))]);
  await assert.rejects(made.client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' }), (error) => error.code === 'http' && error.detail === '400');
  made = makeClient([() => respond(400, { data: {} })]);
  await assert.rejects(made.client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' }), (error) => error.code === 'http' && error.detail === '400');
});

test('unexpected shapes and invalid JSON are reported as unexpected', async () => {
  let made = makeClient([() => respond(200, { data: { account: null } })]);
  await assert.rejects(made.client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' }), (error) => error.code === 'unexpected');
  made = makeClient([() => respond(200, new SyntaxError('bad json'))]);
  await assert.rejects(made.client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' }), (error) => error.code === 'unexpected');
});

test('network failures are retried, then reported', async () => {
  const fail = () => {
    throw new TypeError('Failed to fetch');
  };
  const { client, calls } = makeClient([fail, fail, fail]);
  await assert.rejects(client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' }), (error) => error.code === 'network');
  assert.equal(calls.length, 3);
});

test('an aborted signal cancels before any request', async () => {
  const controller = new AbortController();
  controller.abort();
  const { client, calls } = makeClient([], { signal: controller.signal });
  await assert.rejects(client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' }), (error) => error.code === 'cancelled');
  assert.equal(calls.length, 0);
});

test('requests go one at a time, even when the accounts are read side by side', async () => {
  let inFlight = 0;
  let most = 0;
  const order = [];
  const client = createClient({
    origin: ORIGIN,
    sleep: async () => {},
    random: () => 0,
    fetchImpl: async (url, init) => {
      const id = JSON.parse(init.body).variables.transactionId;
      inFlight++;
      most = Math.max(most, inFlight);
      order.push(`${id} sent`);
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`${id} answered`);
      inFlight--;
      return respond(200, { data: { account: { brokerPortfolio: { transactionDetails: { id } } } } });
    },
  });
  const ids = ['a', 'b', 'c'];
  const details = await Promise.all(ids.map((transactionId) => client.getTransactionDetails({ personId: 'p', portfolioId: 'pf', transactionId })));
  assert.deepEqual(details.map((item) => item.id), ids);
  assert.equal(most, 1);
  assert.deepEqual(order, ['a sent', 'a answered', 'b sent', 'b answered', 'c sent', 'c answered']);
});

test('broker transaction details are extracted', async () => {
  const { client, calls } = makeClient([
    () => respond(200, { data: { account: { brokerPortfolio: { transactionDetails: { id: 'a', averagePrice: 10 } } } } }),
  ]);
  const details = await client.getTransactionDetails({ personId: 'p', portfolioId: 'pf', transactionId: 'a' });
  assert.equal(details.averagePrice, 10);
  assert.equal(calls[0].body.variables.transactionId, 'a');
  assert.equal(calls[0].init.headers['x-scacap-features-enabled'], 'CRYPTO_MULTI_ETP,UNIQUE_SECURITY_ID');
});

test('the Transactions page gives the recipe of the overnight list, read as text', async () => {
  const { client, calls } = makeClient([() => htmlResponse(pageHtml(RECIPE))]);
  const recipe = await client.getDepositRecipe('sav-123456');
  assert.deepEqual(recipe, RECIPE);
  assert.equal(calls[0].url, ORIGIN + '/interest/overnight/sav-123456/transactions/');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual', 'a login or a security check is never followed');
  assert.equal(calls[0].init.credentials, 'same-origin');
});

test('a redirect, or a page without a usable recipe, asks for the Transactions page', async () => {
  const filtered = Object.assign({}, RECIPE, { variables: Object.assign({}, RECIPE.variables, { input: { pageSize: 50, type: ['DEPOSIT'] } }) });
  const otherAccount = Object.assign({}, RECIPE, { variables: Object.assign({}, RECIPE.variables, { portfolioId: 'sav-999999' }) });
  const cases = [
    ['redirect', () => ({ status: 0, ok: false, type: 'opaqueredirect' }), 'redirect'],
    ['no data', () => htmlResponse('<!DOCTYPE html><html><body>Login</body></html>'), 'no transaction list in the page'],
    ['filtered', () => htmlResponse(pageHtml(filtered)), 'no transaction list in the page'],
    ['another account', () => htmlResponse(pageHtml(otherAccount)), 'no transaction list in the page'],
  ];
  for (const [name, handler, detail] of cases) {
    const { client, calls } = makeClient([handler]);
    await assert.rejects(client.getDepositRecipe('sav-123456'), (error) => {
      assert.equal(error.code, 'depositPage', name);
      assert.equal(error.detail, detail, name);
      return true;
    });
    assert.equal(calls.length, 1, `${name}: never retried`);
  }
});

test('the overnight list is read with the page’s own query, page by page with the cursor', async () => {
  const { client, calls, sleeps } = makeClient([
    () => respond(200, listPage([{ id: 'd1' }, { id: 'd2' }], 'c1', 3)),
    () => respond(200, listPage([{ id: 'd3' }], null, 3)),
  ]);
  const pages = [];
  const result = await client.listDepositTransactions({ recipe: RECIPE, savingsAccountId: 'sav-123456', onPage: (page) => pages.push(page) });
  assert.deepEqual(result.transactions.map((item) => item.id), ['d1', 'd2', 'd3']);
  assert.equal(result.total, 3);
  assert.equal(result.complete, true);
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(sleeps, [300]);
  assert.equal(calls[0].url, ORIGIN + INTEREST_PATH);
  assert.equal(calls[0].body.operationName, 'Transactions');
  assert.equal(calls[0].body.query, RECIPE.query.replace('@unmask', ''), 'the client-only @unmask directive is removed');
  assert.deepEqual(calls[0].body.variables, RECIPE.variables, 'the first page uses the page’s own variables');
  assert.deepEqual(calls[1].body.variables, { personId: 'short-account-1', portfolioId: 'sav-123456', input: { pageSize: 50, cursor: 'c1' } });
  assert.equal(calls[0].init.headers['x-scacap-features-enabled'], undefined);
  assert.equal(calls[0].init.referrer, ORIGIN + '/interest/overnight/sav-123456/transactions/');
  assert.deepEqual(RECIPE.variables.input, { pageSize: 50 }, 'the recipe itself is never changed');
});

test('a list shorter than its total is incomplete; one stopped at the period is complete', async () => {
  let made = makeClient([() => respond(200, listPage([{ id: 'd1' }], null, 2))]);
  let result = await made.client.listDepositTransactions({ recipe: RECIPE, savingsAccountId: 'sav-123456' });
  assert.equal(result.complete, false);

  made = makeClient([() => respond(200, listPage([{ id: 'd1' }], 'c1', 9))]);
  result = await made.client.listDepositTransactions({ recipe: RECIPE, savingsAccountId: 'sav-123456', stopWhen: () => true });
  assert.equal(result.complete, true);
  assert.equal(made.calls.length, 1);

  made = makeClient([() => respond(200, { data: { account: { savingsAccount: null } } })]);
  await assert.rejects(made.client.listDepositTransactions({ recipe: RECIPE, savingsAccountId: 'sav-123456' }), (error) => error.code === 'unexpected');
});

test('overnight transaction details use the query the page sends, character by character', async () => {
  const details = { __typename: 'SavingsAccountCashTransaction', id: 'd1', taxDetails: { grossAmount: 14.93, taxAmount: 3.88 } };
  const { client, calls } = makeClient([
    () => respond(200, { data: { account: { savingsAccount: { id: 'sav-123456', transactionDetails: details } } } }),
    () => respond(200, { data: { account: { savingsAccount: { id: 'sav-123456', transactionDetails: null } } } }),
  ]);
  const read = await client.getDepositTransactionDetails({ personId: 'short-account-1', savingsAccountId: 'sav-123456', transactionId: 'd1' });
  assert.deepEqual(read, details);
  assert.equal(calls[0].url, ORIGIN + INTEREST_PATH);
  assert.equal(calls[0].body.operationName, 'OvernightTransactionDetails');
  assert.equal(calls[0].body.query, DEPOSIT_TRANSACTION_DETAILS);
  assert.deepEqual(calls[0].body.variables, { personId: 'short-account-1', savingsAccountId: 'sav-123456', transactionId: 'd1' });
  assert.equal(calls[0].init.headers['x-scacap-features-enabled'], undefined);
  assert.equal(calls[0].init.referrer, ORIGIN + '/interest/overnight/sav-123456/transactions/');
  await assert.rejects(client.getDepositTransactionDetails({ personId: 'short-account-1', savingsAccountId: 'sav-123456', transactionId: 'd2' }), (error) => error.code === 'unexpected');
});

test('the details query is pinned: an accidental edit would stop the server from accepting it', () => {
  assert.equal(DEPOSIT_TRANSACTION_DETAILS.length, 1398);
  assert.equal(createHash('sha256').update(DEPOSIT_TRANSACTION_DETAILS).digest('hex').slice(0, 16), 'ec7f7f30bb2372b8');
});

test('diagnostics log operations and outcomes, never identifiers', async () => {
  const entries = [];
  const savingsAccountId = 'sAvInGsEcReT1234567890';
  const secretRecipe = Object.assign({}, RECIPE, { variables: { personId: 'pErSoNsEcReT1234567890', portfolioId: savingsAccountId, input: { pageSize: 50 } } });
  const { client } = makeClient(
    [
      () => htmlResponse(pageHtml(secretRecipe)),
      () => respond(200, { errors: [{ message: 'Variable "$personId" got invalid value "pErSoNsEcReT1234567890"' }] }),
      () => respond(200, listPage([{ id: 'd1' }], null, 1)),
    ],
    { log: (event, data) => entries.push([event, data]) },
  );
  const recipe = await client.getDepositRecipe(savingsAccountId);
  await assert.rejects(client.listDepositTransactions({ recipe, savingsAccountId }), (error) => {
    assert.equal(error.code, 'graphql');
    assert.equal(error.detail, 'Variable "$personId" got invalid value "…"');
    return true;
  });
  await client.listDepositTransactions({ recipe, savingsAccountId });
  assert.doesNotMatch(JSON.stringify(entries), /sEcReT/);
  assert.deepEqual(entries[0], ['request', { operation: 'Transactions page', path: '/interest/overnight/…/transactions/', attempt: 1, status: 200, ms: entries[0][1].ms }]);
  assert.ok(entries.some(([event, data]) => event === 'overnight-source' && data.transactions === 1 && data.total === 1 && data.complete === true));
});

test('safePath hides identifier-like segments only', () => {
  const { safePath } = require('../src/brokers/scalable/client.js');
  assert.equal(safePath('/interest/api/graphql/'), '/interest/api/graphql/');
  assert.equal(safePath('/interest/overnight/AbCdEfGhIjKlMnOpQrStUv'), '/interest/overnight/…');
  assert.equal(safePath(undefined), '');
});

test('redact hides every string variable, longest first', () => {
  const { redact } = require('../src/brokers/scalable/client.js');
  assert.equal(redact('id abc123 and abc123456', { a: 'abc123', input: { cursor: 'abc123456' } }), 'id … and …');
  assert.equal(redact('nothing to hide', { a: 'x', b: 3 }), 'nothing to hide');
});
