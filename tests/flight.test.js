'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const flight = require('../src/brokers/scalable/flight.js');

const QUERY =
  'query Transactions($personId:ID!$input:SavingsAccountCashTransactionInput!$portfolioId:ID!){account(id:$personId){id savingsAccount(id:$portfolioId){id ...TransactionsListContainer@unmask}}}fragment TransactionsListContainer on SavingsAccount{id moreTransactions(input:$input){cursor total transactions{id amount}}}';
const VARIABLES = { personId: 'short-account-1', portfolioId: 'sav-123456', input: { pageSize: 50 } };

function transaction(id, type, extra) {
  return Object.assign(
    { id, currency: 'EUR', type: 'CASH_TRANSACTION', status: 'SETTLED', isCancellation: false, lastEventDateTime: '$D2026-10-01T00:00:00.000Z', description: '', amount: 11.05, cashTransactionType: type, __typename: 'SavingsAccountCashTransactionSummary' },
    extra || {},
  );
}

// React server data as Next.js writes it, split in chunks pushed by inline scripts.
function serverData(cursor) {
  const list = { cursor, total: 2, transactions: [transaction('d1', 'INTEREST'), transaction('d2', 'WITHDRAWAL', { description: '$$5 fee', lastEventDateTime: '2026-09-21T08:02:10.425Z' })], __typename: 'SavingsAccountCashTransactionSummaries' };
  const reference = { options: { query: QUERY, variables: VARIABLES }, queryKey: 'k', stream: '$@7' };
  return [
    `1:I["chunk.js"]\n4:{"label":"Transazioni"}\n`,
    `5:["$","$L6",null,{"queryRef":{"$__apollo_queryRef":${JSON.stringify(reference)}},"personId":"short-account-1"}]\n`,
    `7:{"data":{"account":{"savingsAccount":{"moreTransactions":${JSON.stringify(list)}}}}}\n8:["$","div",null,{"transactions":["$7:data"]}]\n`,
  ];
}

function html(chunks) {
  const scripts = chunks.map((chunk) => `<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`).join('');
  return `<!DOCTYPE html><html><head><script src="/app.js"></script><script>self.__next_f=self.__next_f||[];self.__next_f.push([0])</script></head><body>${scripts}<script>var x = "not data";</script></body></html>`;
}

test('the server data is read from the inline scripts, in order, without running them', () => {
  const chunks = serverData(null);
  assert.equal(flight.textFromHtml(html(chunks)), chunks.join(''));
  const scripts = [{ textContent: 'self.__next_f.push([0])' }, ...chunks.map((chunk) => ({ textContent: `self.__next_f.push(${JSON.stringify([1, chunk])})` })), { textContent: '' }];
  const document = { querySelectorAll: (selector) => (assert.equal(selector, 'script:not([src])'), scripts) };
  assert.equal(flight.textFromDocument(document), chunks.join(''));
  assert.equal(flight.textFromDocument(null), '');
  assert.deepEqual(flight.chunksFromScripts(['self.__next_f.push([1, broken', 'self.__next_f.push([3,"AAEC"])', 42]), []);
});

test('the recipe of the transaction list is found, with its variables', () => {
  const text = flight.textFromHtml(html(serverData(null)));
  const recipes = flight.findQueryRecipes(text);
  assert.equal(recipes.length, 1);
  assert.deepEqual(flight.findDepositRecipe(text), { operationName: 'Transactions', query: QUERY, variables: VARIABLES });
  assert.equal(flight.findDepositRecipe('no data at all'), null);
  const other = `{"$__apollo_queryRef":${JSON.stringify({ options: { query: 'query SideNavigation($accountId:ID!){account(id:$accountId){id}}', variables: { accountId: 'a' } } })}}`;
  assert.equal(flight.findDepositRecipe(other), null, 'only a query of the transaction list');
});

test('a recipe is reused only for its own account, without filters', () => {
  const recipe = { operationName: 'Transactions', query: QUERY, variables: VARIABLES };
  assert.equal(flight.isUsableDepositRecipe(recipe, 'sav-123456'), true);
  assert.equal(flight.isUsableDepositRecipe(recipe, 'sav-999999'), false);
  const withCursor = Object.assign({}, recipe, { variables: Object.assign({}, VARIABLES, { input: { pageSize: 50, cursor: null } }) });
  assert.equal(flight.isUsableDepositRecipe(withCursor, 'sav-123456'), true);
  const filtered = Object.assign({}, recipe, { variables: Object.assign({}, VARIABLES, { input: { pageSize: 50, type: ['DEPOSIT'] } }) });
  assert.equal(flight.isUsableDepositRecipe(filtered, 'sav-123456'), false);
  assert.equal(flight.isUsableDepositRecipe(Object.assign({}, recipe, { query: 'query X{a}' }), 'sav-123456'), false);
  assert.equal(flight.isUsableDepositRecipe(null, 'sav-123456'), false);
});

test('the transactions in the page are decoded and counted once', () => {
  const found = flight.findDepositTransactions(flight.textFromHtml(html(serverData(null))));
  assert.equal(found.found, true);
  assert.equal(found.more, false);
  assert.deepEqual(found.transactions.map((item) => item.id), ['d1', 'd2']);
  assert.equal(found.transactions[0].lastEventDateTime, '2026-10-01T00:00:00.000Z', '"$D" dates are decoded');
  assert.equal(found.transactions[1].description, '$5 fee', '"$$" escapes are decoded');
  assert.equal(flight.findDepositTransactions(flight.textFromHtml(html(serverData('next-page')))).more, true);
  assert.deepEqual(flight.findDepositTransactions('{"transactions":[{"id":"x","name":"not a transaction"}]}'), { found: false, transactions: [], more: false });
});

test('balanced extraction respects strings and escapes', () => {
  const text = 'x {"a":"} ] \\" {","b":[1,{"c":2}]} tail';
  assert.equal(flight.extractBalanced(text, 2), '{"a":"} ] \\" {","b":[1,{"c":2}]}');
  assert.equal(flight.extractBalanced('{"open":', 0), null);
  assert.equal(flight.decodeValue('$undefined'), undefined);
});
