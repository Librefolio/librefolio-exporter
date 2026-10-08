'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, ExportError, BROKER_PATH, INTEREST_PATH } = require('../src/brokers/scalable/client.js');

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
    const call = { url, init, body: JSON.parse(init.body) };
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

function depositPage(transactions, cursor) {
  const moreTransactions = cursor === undefined ? { transactions } : { cursor, transactions };
  return { data: { account: { savingsAccount: { id: 's', totalAmount: 1000, moreTransactions } } } };
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

test('401 and 403 become a session error without retries', async () => {
  for (const status of [401, 403]) {
    const { client, calls } = makeClient([() => respond(status, {})]);
    await assert.rejects(client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' }), (error) => error.code === 'session');
    assert.equal(calls.length, 1);
  }
});

test('GraphQL errors are reported, authentication ones as session errors', async () => {
  let made = makeClient([() => respond(200, { errors: [{ message: 'Cannot query field "x"' }] })]);
  await assert.rejects(made.client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' }), (error) => error.code === 'graphql' && /Cannot query/.test(error.detail));
  made = makeClient([() => respond(200, { errors: [{ message: 'Unauthorized' }] })]);
  await assert.rejects(made.client.listBrokerTransactions({ personId: 'p', portfolioId: 'pf' }), (error) => error.code === 'session');
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

test('transaction details and savings accounts are extracted', async () => {
  const { client, calls } = makeClient([
    () => respond(200, { data: { account: { brokerPortfolio: { transactionDetails: { id: 'a', averagePrice: 10 } } } } }),
    () => respond(200, { data: { account: { savingsAccounts: [{ __typename: 'OvernightSavingsAccount', id: 's1' }, null, { id: '' }] } } }),
  ]);
  const details = await client.getTransactionDetails({ personId: 'p', portfolioId: 'pf', transactionId: 'a' });
  assert.equal(details.averagePrice, 10);
  assert.equal(calls[0].body.variables.transactionId, 'a');
  const accounts = await client.listSavingsAccounts({ personId: 'p' });
  assert.deepEqual(accounts, [{ __typename: 'OvernightSavingsAccount', id: 's1' }]);
});

test('the overnight account is read with the cursor when available', async () => {
  const { client, calls } = makeClient([
    () => respond(200, depositPage([{ id: 'd1' }], 'k1')),
    () => respond(200, depositPage([{ id: 'd2' }], null)),
  ]);
  const result = await client.listDepositTransactions({ personId: 'p', savingsAccountId: 's1' });
  assert.deepEqual(result.transactions.map((item) => item.id), ['d1', 'd2']);
  assert.equal(result.complete, true);
  assert.equal(result.balance, 1000);
  assert.equal(calls[0].url, ORIGIN + BROKER_PATH);
  assert.equal(calls[1].body.variables.input.cursor, 'k1');
  assert.match(calls[0].body.query, /cursor/);
});

test('without cursor support the overnight account falls back to one large page', async () => {
  const { client, calls } = makeClient([
    () => respond(200, { errors: [{ message: 'Cannot query field "cursor"' }] }),
    () => respond(200, depositPage([{ id: 'd1' }])),
  ]);
  const result = await client.listDepositTransactions({ personId: 'p', savingsAccountId: 's1' });
  assert.deepEqual(result.transactions.map((item) => item.id), ['d1']);
  assert.equal(result.complete, true);
  assert.doesNotMatch(calls[1].body.query, /cursor/);
  assert.equal(calls[1].body.variables.input.pageSize, 200);
});

test('when the broker endpoint cannot serve it, the interest endpoint is used', async () => {
  const { client, calls } = makeClient([
    () => respond(404, {}),
    () => respond(404, {}),
    () => respond(200, depositPage([{ id: 'd1' }], null)),
  ]);
  const result = await client.listDepositTransactions({ personId: 'p', savingsAccountId: 'acc/1' });
  assert.equal(result.transactions.length, 1);
  assert.equal(calls[2].url, ORIGIN + INTEREST_PATH);
  assert.equal(calls[2].init.headers['x-scacap-features-enabled'], undefined);
  assert.equal(calls[2].init.referrer, `${ORIGIN}/interest/overnight/acc%2F1`);
});

test('session errors on the overnight account are not swallowed by the fallbacks', async () => {
  const { client, calls } = makeClient([() => respond(401, {})]);
  await assert.rejects(client.listDepositTransactions({ personId: 'p', savingsAccountId: 's1' }), (error) => error.code === 'session');
  assert.equal(calls.length, 1);
});

test('a full single page is reported as possibly incomplete', async () => {
  const many = Array.from({ length: 200 }, (_, index) => ({ id: `d${index}` }));
  const { client } = makeClient([
    () => respond(200, { errors: [{ message: 'Unknown field cursor' }] }),
    () => respond(200, depositPage(many)),
  ]);
  const result = await client.listDepositTransactions({ personId: 'p', savingsAccountId: 's1' });
  assert.equal(result.complete, false);
});

test('diagnostics log operations and outcomes, never identifiers', async () => {
  const entries = [];
  const { client } = makeClient(
    [
      () => respond(200, { errors: [{ message: 'Variable "$personId" got invalid value "person-secret-1"' }] }),
      () => respond(200, { errors: [{ message: 'Cannot query field "cursor"' }] }),
      () => respond(200, depositPage([{ id: 'd1' }])),
    ],
    { log: (event, data) => entries.push([event, data]) },
  );
  await assert.rejects(client.listSavingsAccounts({ personId: 'person-secret-1' }), (error) => {
    assert.equal(error.code, 'graphql');
    assert.equal(error.detail, 'Variable "$personId" got invalid value "…"');
    return true;
  });
  await client.listDepositTransactions({ personId: 'person-secret-1', savingsAccountId: 'saving-secret-2' });

  const text = JSON.stringify(entries);
  assert.doesNotMatch(text, /secret/);
  assert.deepEqual(entries[0], ['request', { operation: 'getSavingsProducts', path: BROKER_PATH, attempt: 1, status: 200, ms: entries[0][1].ms }]);
  assert.ok(entries.some(([event, data]) => event === 'overnight-fallback' && data.variant === 'paged' && data.error === 'graphql'));
  assert.ok(entries.some(([event, data]) => event === 'overnight-source' && data.variant === 'single page' && data.transactions === 1));
});

test('redact hides every string variable, longest first', () => {
  const { redact } = require('../src/brokers/scalable/client.js');
  assert.equal(redact('id abc123 and abc123456', { a: 'abc123', input: { cursor: 'abc123456' } }), 'id … and …');
  assert.equal(redact('nothing to hide', { a: 'x', b: 3 }), 'nothing to hide');
});
