/*
 * GraphQL operations of the Scalable Capital web app. GraphQL answers only the fields a
 * query asks for, so the broker queries below ask only for what the CSV writes
 * (docs/formats/scalable.md): the transaction list, and from the details what the list does not
 * give (reference, shares executed and ordered, price, fees and taxes, venue). Every field is also
 * one more place where a schema change breaks the export. The overnight account's
 * queries are the web app's own, used as they are.
 */
(function (root) {
  'use strict';

  const BROKER_TRANSACTIONS = `query moreTransactions($personId: ID!, $input: BrokerTransactionInput!, $portfolioId: ID!) {
  account(id: $personId) {
    id
    brokerPortfolio(id: $portfolioId) {
      id
      moreTransactions(input: $input) {
        ...MoreTransactionsFragment
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment MoreTransactionsFragment on BrokerTransactionSummaries {
  cursor
  total
  transactions {
    id
    currency
    type
    status
    isCancellation
    lastEventDateTime
    description
    ...BrokerCashTransactionSummaryFragment
    ...BrokerNonTradeSecurityTransactionSummaryFragment
    ...BrokerSecurityTransactionSummaryFragment
    ...BrokerEltifTransactionSummaryFragment
    __typename
  }
  __typename
}

fragment BrokerCashTransactionSummaryFragment on BrokerCashTransactionSummary {
  cashTransactionType
  amount
  relatedIsin
  __typename
}

fragment BrokerNonTradeSecurityTransactionSummaryFragment on BrokerNonTradeSecurityTransactionSummary {
  nonTradeSecurityTransactionType
  quantity
  amount
  isin
  __typename
}

fragment BrokerSecurityTransactionSummaryFragment on BrokerSecurityTransactionSummary {
  securityTransactionType
  quantity
  amount
  side
  isin
  __typename
}

fragment BrokerEltifTransactionSummaryFragment on BrokerEltifTransactionSummary {
  amount
  eltifQuantity
  isin
  securityTransactionType
  side
  __typename
}`;

  const TRANSACTION_DETAILS = `query getTransactionDetails($personId: ID!, $transactionId: ID!, $portfolioId: ID!) {
  account(id: $personId) {
    id
    brokerPortfolio(id: $portfolioId) {
      id
      transactionDetails(id: $transactionId) {
        transactionReference
        ... on BrokerSecurityTransaction {
          numberOfShares {
            filled
            total
          }
          averagePrice
          tradeTransactionAmounts {
            taxAmount
            transactionFee
            venueFee
            cryptoSpreadFee
          }
          tradingVenue
        }
      }
    }
  }
}`;

  // Overnight account: the interest app answers, from the browser, the queries its own
  // pages send. The transaction list is read with the query that the Transactions page
  // carries (see flight.js); this one is sent by the page when a transaction is opened,
  // and is reproduced here character by character.
  const DEPOSIT_TRANSACTION_DETAILS = [
    'query OvernightTransactionDetails($personId: ID!, $savingsAccountId: ID!, $transactionId: ID!) {',
    '  account(id: $personId) {',
    '    id',
    '    savingsAccount(id: $savingsAccountId) {',
    '      id',
    '      ... on OvernightSavingsAccount {',
    '        transactionDetails(id: $transactionId) {',
    '          __typename',
    '          id',
    '          ...TransactionDetailsHeader',
    '          ...TransactionDetailsOverview',
    '          ...TransactionDetailsAccounting',
    '          ...TransactionDetailsHistory',
    '          ...TransactionDetailsReference',
    '        }',
    '        __typename',
    '      }',
    '      __typename',
    '    }',
    '    __typename',
    '  }',
    '}',
    '',
    'fragment TransactionDetailsHeader on SavingsAccountCashTransaction {',
    '  id',
    '  __typename',
    '  status',
    '  type',
    '  description',
    '  amount',
    '  cashTransactionType',
    '  isPending',
    '  isCancellation',
    '}',
    '',
    'fragment TransactionDetailsOverview on SavingsAccountCashTransaction {',
    '  id',
    '  amount',
    '  cashTransactionType',
    '  taxDetails {',
    '    grossAmount',
    '    __typename',
    '  }',
    '  __typename',
    '}',
    '',
    'fragment TransactionDetailsAccounting on SavingsAccountCashTransaction {',
    '  id',
    '  __typename',
    '  cashTransactionType',
    '  taxDetails {',
    '    taxAmount',
    '    __typename',
    '  }',
    '}',
    '',
    'fragment TransactionDetailsHistory on SavingsAccountCashTransaction {',
    '  id',
    '  __typename',
    '  cashTransactionType',
    '  transactionHistory {',
    '    state',
    '    timestamp',
    '    __typename',
    '  }',
    '}',
    '',
    'fragment TransactionDetailsReference on SavingsAccountCashTransaction {',
    '  id',
    '  transactionReference',
    '  __typename',
    '}',
  ].join('\n');

  const api = {
    BROKER_TRANSACTIONS,
    TRANSACTION_DETAILS,
    DEPOSIT_TRANSACTION_DETAILS,
  };

  root.LFX = root.LFX || {};
  root.LFX.scalable = root.LFX.scalable || {};
  root.LFX.scalable.queries = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
