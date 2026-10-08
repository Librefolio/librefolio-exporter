/*
 * Reads the data that a Next.js page of the Scalable web app carries in its HTML:
 * the server renders the page and writes its data in inline scripts,
 * self.__next_f.push([1, "<React server data>"]). The overnight account's
 * transactions are there, with the same fields as in the web app's GraphQL.
 *
 * Nothing is executed: the scripts are read as text and parsed as JSON.
 */
(function (root) {
  'use strict';

  const PUSH = 'self.__next_f.push(';
  const TRANSACTIONS_KEY = '"transactions":[';
  const MAX_CONTAINER_DISTANCE = 4000;

  // The text chunks of the page's server data, in order.
  function chunksFromScripts(sources) {
    const chunks = [];
    for (const source of sources) {
      const start = typeof source === 'string' ? source.indexOf(PUSH) : -1;
      if (start < 0) continue;
      const end = source.lastIndexOf(')');
      if (end <= start) continue;
      try {
        const value = JSON.parse(source.slice(start + PUSH.length, end));
        if (Array.isArray(value) && value[0] === 1 && typeof value[1] === 'string') chunks.push(value[1]);
      } catch (error) {
        // Another kind of inline script.
      }
    }
    return chunks;
  }

  function textFromDocument(document) {
    if (!document || typeof document.querySelectorAll !== 'function') return '';
    const sources = Array.from(document.querySelectorAll('script:not([src])'), (script) => script.textContent || '');
    return chunksFromScripts(sources).join('');
  }

  function textFromHtml(html) {
    const sources = [];
    const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = pattern.exec(String(html || '')))) sources.push(match[1]);
    return chunksFromScripts(sources).join('');
  }

  // The JSON array or object that starts at text[start], strings included; null if unbalanced.
  function extractBalanced(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return null;
  }

  // React server data escapes some strings: "$D…" is a date, "$$…" a text starting with "$".
  function decodeValue(value) {
    if (typeof value === 'string') {
      if (value === '$undefined') return undefined;
      if (value.startsWith('$$')) return value.slice(1);
      if (value.startsWith('$D')) return value.slice(2);
      return value;
    }
    if (Array.isArray(value)) return value.map(decodeValue);
    if (value && typeof value === 'object') {
      const decoded = {};
      for (const [key, item] of Object.entries(value)) decoded[key] = decodeValue(item);
      return decoded;
    }
    return value;
  }

  function isDepositTransaction(item) {
    return (
      Boolean(item) &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      typeof item.id === 'string' &&
      (typeof item.cashTransactionType === 'string' || /SavingsAccountCashTransaction/.test(item.__typename || ''))
    );
  }

  // The object that holds the array starting at arrayStart, such as { cursor, transactions }.
  function enclosingObject(text, arrayStart, arrayLength) {
    for (let index = arrayStart - 1; index >= Math.max(0, arrayStart - MAX_CONTAINER_DISTANCE); index--) {
      if (text[index] !== '{') continue;
      const block = extractBalanced(text, index);
      if (!block || index + block.length < arrayStart + arrayLength) continue;
      try {
        const value = JSON.parse(block);
        if (value && typeof value === 'object' && Array.isArray(value.transactions)) return value;
      } catch (error) {
        // Not a JSON object: keep looking.
      }
    }
    return null;
  }

  // The overnight account's transactions in the page's server data.
  // found: the page has a transaction list; more: it says that older pages exist.
  function findDepositTransactions(text) {
    const byId = new Map();
    let found = false;
    let more = false;
    for (let at = text.indexOf(TRANSACTIONS_KEY); at >= 0; at = text.indexOf(TRANSACTIONS_KEY, at + TRANSACTIONS_KEY.length)) {
      const start = at + TRANSACTIONS_KEY.length - 1;
      const block = extractBalanced(text, start);
      if (!block) continue;
      let list;
      try {
        list = JSON.parse(block);
      } catch (error) {
        continue;
      }
      const items = list.filter(isDepositTransaction);
      const container = enclosingObject(text, start, block.length);
      const looksLikeTransactions =
        items.length > 0 || (list.length === 0 && container !== null && /Transaction/.test(container.__typename || ''));
      if (!looksLikeTransactions) continue;
      found = true;
      for (const item of items) if (!byId.has(item.id)) byId.set(item.id, decodeValue(item));
      const cursor = container ? decodeValue(container.cursor) : undefined;
      if (typeof cursor === 'string' && cursor !== '') more = true;
    }
    return { found, transactions: Array.from(byId.values()), more };
  }

  const QUERY_REF_KEY = '"$__apollo_queryRef":';
  const MAX_QUERY_LENGTH = 8000;

  // The queries that the server ran for the page (Apollo "query references"): the exact
  // GraphQL text and variables the web app uses, as { operationName, query, variables }.
  function findQueryRecipes(text) {
    const recipes = [];
    for (let at = text.indexOf(QUERY_REF_KEY); at >= 0; at = text.indexOf(QUERY_REF_KEY, at + QUERY_REF_KEY.length)) {
      const block = extractBalanced(text, at + QUERY_REF_KEY.length);
      if (!block) continue;
      let reference;
      try {
        reference = JSON.parse(block);
      } catch (error) {
        continue;
      }
      const options = reference && reference.options;
      if (!options || typeof options.query !== 'string' || options.query.length > MAX_QUERY_LENGTH) continue;
      const name = /^\s*query\s+([A-Za-z_]\w*)/.exec(options.query);
      const variables = decodeValue(options.variables);
      if (!name || !variables || typeof variables !== 'object' || Array.isArray(variables)) continue;
      recipes.push({ operationName: name[1], query: options.query, variables });
    }
    return recipes;
  }

  // The recipe of the overnight account's transaction list, or null.
  function findDepositRecipe(text) {
    return findQueryRecipes(text).find((recipe) => /\bmoreTransactions\s*\(/.test(recipe.query) && /\bsavingsAccount\s*\(/.test(recipe.query)) || null;
  }

  // A recipe can be reused for an export only when it reads this account, unfiltered:
  // a page opened with filters would carry them in its input.
  function isUsableDepositRecipe(recipe, savingsAccountId) {
    if (!recipe || typeof recipe !== 'object' || typeof recipe.query !== 'string' || typeof recipe.operationName !== 'string') return false;
    if (!/\bmoreTransactions\s*\(/.test(recipe.query) || recipe.query.length > MAX_QUERY_LENGTH) return false;
    const variables = recipe.variables;
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return false;
    if (!Object.values(variables).includes(savingsAccountId)) return false;
    const input = variables.input;
    if (input === undefined) return true;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    return Object.keys(input).every((key) => key === 'pageSize' || key === 'cursor');
  }

  const api = {
    chunksFromScripts,
    textFromDocument,
    textFromHtml,
    extractBalanced,
    decodeValue,
    findDepositTransactions,
    findQueryRecipes,
    findDepositRecipe,
    isUsableDepositRecipe,
  };

  root.LFX = root.LFX || {};
  root.LFX.scalable = root.LFX.scalable || {};
  root.LFX.scalable.flight = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
