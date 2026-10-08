/*
 * Finds the identifiers the web app itself uses (person, portfolio, overnight
 * account) from the page: URL, links, web storage and inline JSON.
 * Cookies and credentials are never read.
 */
(function (root) {
  'use strict';

  const ID = '[A-Za-z0-9_.:=+-]{6,128}';
  const ID_ONLY = new RegExp(`^${ID}$`);

  function safeGet(storage, key) {
    try {
      return storage ? storage.getItem(key) : null;
    } catch (error) {
      return null;
    }
  }

  function storageKeys(storage) {
    const keys = [];
    try {
      for (let index = 0; storage && index < storage.length; index++) keys.push(storage.key(index));
    } catch (error) {
      return [];
    }
    return keys;
  }

  function unquote(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (text.startsWith('"')) {
      try {
        const parsed = JSON.parse(text);
        return typeof parsed === 'string' ? parsed : null;
      } catch (error) {
        return null;
      }
    }
    return text;
  }

  function queryAll(document, selector) {
    try {
      return document ? Array.from(document.querySelectorAll(selector)) : [];
    } catch (error) {
      return [];
    }
  }

  function findPersonId(env) {
    const fromSession = unquote(safeGet(env.sessionStorage, 'uniqueId'));
    if (fromSession && ID_ONLY.test(fromSession)) return { value: fromSession, source: 'sessionStorage' };

    const keyPattern = new RegExp(`^sortingOption-portfolio-(${ID})$`);
    for (const key of storageKeys(env.localStorage)) {
      const match = keyPattern.exec(key || '');
      if (match) return { value: match[1], source: 'localStorage' };
    }

    const inlinePattern = new RegExp(`"personId"\\s*:\\s*"(${ID})"`);
    for (const script of queryAll(env.document, 'script:not([src])')) {
      const match = inlinePattern.exec(script.textContent || '');
      if (match) return { value: match[1], source: 'inlineScript' };
    }
    return null;
  }

  function findPortfolioId(env) {
    let fromUrl = null;
    try {
      fromUrl = env.location ? new URLSearchParams(env.location.search || '').get('portfolioId') : null;
    } catch (error) {
      fromUrl = null;
    }
    if (fromUrl && ID_ONLY.test(fromUrl)) return { value: fromUrl, source: 'url' };

    const hrefPattern = new RegExp(`[?&]portfolioId=(${ID})`);
    for (const anchor of queryAll(env.document, 'a[href*="portfolioId="]')) {
      const match = hrefPattern.exec(anchor.getAttribute('href') || '');
      if (match) return { value: match[1], source: 'link' };
    }
    return null;
  }

  // Overnight account ids visible in the page, used when the account list query fails.
  function findSavingsAccountIds(env) {
    const pattern = new RegExp(`/interest/overnight/(${ID})`);
    const ids = new Set();
    const fromPath = env.location ? pattern.exec(env.location.pathname || '') : null;
    if (fromPath) ids.add(fromPath[1]);
    for (const anchor of queryAll(env.document, 'a[href*="/interest/overnight/"]')) {
      const match = pattern.exec(anchor.getAttribute('href') || '');
      if (match) ids.add(match[1]);
    }
    return Array.from(ids);
  }

  // env.remembered: { personId, portfolioId, savingsAccountIds } seen earlier in this
  // browser session, used for what the current page does not show.
  function discover(env) {
    const person = findPersonId(env);
    const remembered = person && env.remembered && env.remembered.personId === person.value ? env.remembered : null;

    let portfolio = findPortfolioId(env);
    if (!portfolio && remembered && ID_ONLY.test(remembered.portfolioId || '')) {
      portfolio = { value: remembered.portfolioId, source: 'remembered' };
    }

    let savingsAccountIds = findSavingsAccountIds(env);
    let savingsSource = savingsAccountIds.length > 0 ? 'page' : null;
    if (savingsAccountIds.length === 0 && remembered && Array.isArray(remembered.savingsAccountIds)) {
      savingsAccountIds = remembered.savingsAccountIds.filter((id) => typeof id === 'string' && ID_ONLY.test(id));
      savingsSource = savingsAccountIds.length > 0 ? 'remembered' : null;
    }

    return {
      personId: person ? person.value : null,
      personSource: person ? person.source : null,
      portfolioId: portfolio ? portfolio.value : null,
      portfolioSource: portfolio ? portfolio.source : null,
      savingsAccountIds,
      savingsSource,
    };
  }

  const api = { ID_ONLY, findPersonId, findPortfolioId, findSavingsAccountIds, discover };

  root.LFX = root.LFX || {};
  root.LFX.scalable = root.LFX.scalable || {};
  root.LFX.scalable.discovery = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
