'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const discovery = require('../src/brokers/scalable/discovery.js');

function fakeStorage(entries) {
  const keys = Object.keys(entries);
  return {
    get length() {
      return keys.length;
    },
    key: (index) => keys[index],
    getItem: (key) => (Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null),
  };
}

function fakeElement(attributes, textContent) {
  return { getAttribute: (name) => (attributes[name] === undefined ? null : attributes[name]), textContent: textContent || '' };
}

function fakeDocument(bySelector) {
  return { querySelectorAll: (selector) => bySelector[selector] || [] };
}

function env(overrides) {
  return Object.assign(
    {
      location: { search: '', pathname: '/cockpit' },
      sessionStorage: fakeStorage({}),
      localStorage: fakeStorage({}),
      document: fakeDocument({}),
    },
    overrides,
  );
}

test('the person id comes from sessionStorage first', () => {
  const found = discovery.findPersonId(env({ sessionStorage: fakeStorage({ uniqueId: 'abc123def' }) }));
  assert.deepEqual(found, { value: 'abc123def', source: 'sessionStorage' });
  const quoted = discovery.findPersonId(env({ sessionStorage: fakeStorage({ uniqueId: '"abc123def"' }) }));
  assert.equal(quoted.value, 'abc123def');
});

test('the person id falls back to localStorage keys and inline JSON', () => {
  const fromKeys = discovery.findPersonId(env({ localStorage: fakeStorage({ other: '1', 'sortingOption-portfolio-zz9988xx': 'DATE' }) }));
  assert.deepEqual(fromKeys, { value: 'zz9988xx', source: 'localStorage' });
  const fromScript = discovery.findPersonId(
    env({ document: fakeDocument({ 'script:not([src])': [fakeElement({}, 'window.x = {"personId": "pp-77665544"}')] }) }),
  );
  assert.deepEqual(fromScript, { value: 'pp-77665544', source: 'inlineScript' });
});

test('invalid or missing person ids are ignored', () => {
  assert.equal(discovery.findPersonId(env({ sessionStorage: fakeStorage({ uniqueId: 'has space' }) })), null);
  assert.equal(discovery.findPersonId(env({ sessionStorage: null, localStorage: null, document: null })), null);
  const throwing = { getItem: () => { throw new Error('denied'); }, get length() { throw new Error('denied'); } };
  assert.equal(discovery.findPersonId(env({ sessionStorage: throwing, localStorage: throwing })), null);
});

test('the portfolio id comes from the URL, then from links', () => {
  const fromUrl = discovery.findPortfolioId(env({ location: { search: '?portfolioId=pf-123456', pathname: '/broker/transactions' } }));
  assert.deepEqual(fromUrl, { value: 'pf-123456', source: 'url' });
  const fromLink = discovery.findPortfolioId(
    env({ document: fakeDocument({ 'a[href*="portfolioId="]': [fakeElement({ href: '/broker/transactions?x=1&portfolioId=pf-654321' })] }) }),
  );
  assert.deepEqual(fromLink, { value: 'pf-654321', source: 'link' });
  assert.equal(discovery.findPortfolioId(env()), null);
});

test('overnight account ids come from the path and from links, without duplicates', () => {
  const ids = discovery.findSavingsAccountIds(
    env({
      location: { search: '', pathname: '/interest/overnight/sav-111111' },
      document: fakeDocument({
        'a[href*="/interest/overnight/"]': [
          fakeElement({ href: '/interest/overnight/sav-111111' }),
          fakeElement({ href: 'https://de.scalable.capital/interest/overnight/sav-222222?tab=x' }),
        ],
      }),
    }),
  );
  assert.deepEqual(ids, ['sav-111111', 'sav-222222']);
});

test('discover collects everything and reports the sources', () => {
  const result = discovery.discover(
    env({
      location: { search: '?portfolioId=pf-123456', pathname: '/broker/transactions' },
      sessionStorage: fakeStorage({ uniqueId: 'person-123' }),
    }),
  );
  assert.deepEqual(result, {
    personId: 'person-123',
    personSource: 'sessionStorage',
    portfolioId: 'pf-123456',
    portfolioSource: 'url',
    savingsAccountIds: [],
    savingsSource: null,
  });
});

test('what the page does not show comes from the same person’s remembered ids', () => {
  const person = { sessionStorage: fakeStorage({ uniqueId: 'person-123' }) };
  const remembered = { personId: 'person-123', portfolioId: 'pf-777777', savingsAccountIds: ['sav-999999', 'bad id', 42] };

  const filled = discovery.discover(env(Object.assign({ remembered }, person)));
  assert.equal(filled.portfolioId, 'pf-777777');
  assert.equal(filled.portfolioSource, 'remembered');
  assert.deepEqual(filled.savingsAccountIds, ['sav-999999']);
  assert.equal(filled.savingsSource, 'remembered');

  const pageWins = discovery.discover(
    env(
      Object.assign({ remembered }, person, {
        location: { search: '?portfolioId=pf-123456', pathname: '/interest/overnight/sav-111111' },
      }),
    ),
  );
  assert.equal(pageWins.portfolioId, 'pf-123456');
  assert.equal(pageWins.portfolioSource, 'url');
  assert.deepEqual(pageWins.savingsAccountIds, ['sav-111111']);
  assert.equal(pageWins.savingsSource, 'page');

  const otherPerson = discovery.discover(env(Object.assign({ remembered: Object.assign({}, remembered, { personId: 'person-456' }) }, person)));
  assert.equal(otherPerson.portfolioId, null);
  assert.deepEqual(otherPerson.savingsAccountIds, []);
  assert.equal(otherPerson.savingsSource, null);

  const noPerson = discovery.discover(env({ remembered }));
  assert.equal(noPerson.portfolioId, null, 'without the person, nothing remembered is used');
});
