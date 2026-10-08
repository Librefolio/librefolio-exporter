/*
 * GraphQL operations of the Scalable Capital web app, limited to fields that
 * public projects already read from the web endpoints (see THIRD_PARTY_NOTICES.md):
 * every extra field is one more place where a schema change breaks the export.
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
        id
        currency
        type
        lastEventDateTime
        transactionReference
        security {
          id
          name
          isin
          __typename
        }
        ... on BrokerSecurityTransaction {
          side
          status
          numberOfShares {
            filled
            total
            __typename
          }
          averagePrice
          totalAmount
          tradeTransactionAmounts {
            marketValuation
            taxAmount
            transactionFee
            venueFee
            cryptoSpreadFee
            __typename
          }
          tradingVenue
          fee
          transactionalFee
          taxes
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

  const SAVINGS_ACCOUNTS = `query getSavingsProducts($personId: ID!) {
  account(id: $personId) {
    savingsAccounts {
      __typename
      id
    }
    __typename
  }
}`;

  function depositTransactions(withCursor) {
    return `query OvernightTransactions($personId: ID!, $savingsAccountId: ID!, $input: SavingsAccountCashTransactionInput!) {
  account(id: $personId) {
    savingsAccount(id: $savingsAccountId) {
      id
      ... on OvernightSavingsAccount {
        totalAmount
        moreTransactions(input: $input) {
          ${withCursor ? 'cursor\n          ' : ''}transactions {
            id
            type
            status
            description
            amount
            currency
            lastEventDateTime
            cashTransactionType
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;
  }

  const api = {
    BROKER_TRANSACTIONS,
    TRANSACTION_DETAILS,
    SAVINGS_ACCOUNTS,
    DEPOSIT_TRANSACTIONS_PAGED: depositTransactions(true),
    DEPOSIT_TRANSACTIONS_SINGLE: depositTransactions(false),
  };

  root.LFX = root.LFX || {};
  root.LFX.scalable = root.LFX.scalable || {};
  root.LFX.scalable.queries = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
