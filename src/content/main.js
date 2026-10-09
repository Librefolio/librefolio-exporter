/*
 * Content-script entry point: shows the button on the Scalable web app pages
 * and runs an export when the user asks for one.
 */
(function (root) {
  'use strict';

  const LFX = root.LFX;
  if (!LFX || LFX.started) return;
  LFX.started = true;

  const INFO_URL = 'https://github.com/Librefolio/librefolio-exporter/blob/main/docs/RISKS.md';
  const APP_PATH = /^\/(broker|interest|cockpit|savings|account)(\/|$)/;
  const TRANSACTIONS_PAGE = /^\/interest\/overnight\/([^/]+)\/transactions\/?$/;
  const EXPORTER_ID = 'librefolio-exporter';
  const DEFAULT_SETTINGS = {
    riskAccepted: false,
    lastExportDates: {},
    lastExportDate: '',
    filePrefix: LFX.files.DEFAULT_PREFIX,
    formDraft: null,
    // Not in the panel: automated tests turn Chrome's "Save as" window off.
    saveDialog: true,
  };
  const ACCOUNTS = ['broker', 'deposit'];
  // Progress of each account, from the exporter's steps: the text of its row in the panel
  // and, for the steps that count, how far it is.
  const STEPS = {
    progressBrokerList: (page) => ({ account: 'broker', text: t('stepPage', page) }),
    progressBrokerDetails: (current, total) => ({ account: 'broker', text: t('stepDetails', current, total), fraction: (current - 1) / total }),
    progressDeposit: (index, total) => ({ account: 'deposit', text: total > 1 ? t('stepAccount', index, total) : t('stepTransactions') }),
    progressDepositDetails: (current, total) => ({ account: 'deposit', text: t('stepDetails', current, total), fraction: (current - 1) / total }),
  };
  const SAVE_POLL_MS = 500;
  const SAVE_WAIT_MS = 15 * 60 * 1000;
  const ERROR_KEYS = {
    noPerson: 'errorNoPerson',
    noPortfolio: 'errorNoPortfolio',
    noDepositAccount: 'errorNoDepositAccount',
    depositPage: 'errorDepositPage',
    session: 'errorSession',
    denied: 'errorDenied',
    rateLimited: 'errorRateLimited',
    unexpected: 'errorUnexpected',
    graphql: 'errorUnexpected',
    http: 'errorHttp',
    network: 'errorNetwork',
  };
  // Errors whose technical detail helps a bug report: it never contains personal data.
  const SHOW_TECHNICAL = new Set(['unexpected', 'graphql', 'http', 'network', 'denied', 'depositPage']);

  const version = chrome.runtime.getManifest().version;
  const t = LFX.i18n.translator(LFX.i18n.pickLanguage([document.documentElement.lang, navigator.language]));

  let ui = null;
  let controller = null;
  let defaultsApplied = false;
  let lastRemembered = '';
  let updateRequest = 0;
  let recipePath = null;
  let recipeOfPage = null;
  let lastSavedId = null;

  // Diagnostics in the page console, as plain text: operations, statuses and sources,
  // never identifiers, amounts or descriptions.
  function log(event, data) {
    if (data === undefined) console.info('[LibreFolio Exporter]', event);
    else console.info('[LibreFolio Exporter]', event, JSON.stringify(data));
  }

  function errorText(error) {
    const key = error && ERROR_KEYS[error.code];
    if (!key) return t('errorGeneric', (error && error.message) || String(error));
    return t(key, error.detail || '');
  }

  function technicalLines(error) {
    if (!error || !SHOW_TECHNICAL.has(error.code)) return [];
    return [t('technicalDetails', error.detail ? `${error.code}: ${error.detail}` : error.code)];
  }

  async function loadSettings() {
    let settings;
    try {
      settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
    } catch (error) {
      settings = Object.assign({}, DEFAULT_SETTINGS);
    }
    const dates = settings.lastExportDates && typeof settings.lastExportDates === 'object' ? Object.assign({}, settings.lastExportDates) : {};
    // Before one date per account, a single date covered both.
    if (Object.keys(dates).length === 0 && settings.lastExportDate) for (const account of ACCOUNTS) dates[account] = settings.lastExportDate;
    settings.lastExportDates = dates;
    return settings;
  }

  // The oldest last export of the given accounts; '' when one of them was never exported.
  function sinceLast(dates, accounts) {
    const found = accounts.map((account) => dates[account] || '');
    return found.length > 0 && found.every(Boolean) ? found.sort()[0] : '';
  }

  async function saveSettings(values) {
    try {
      await chrome.storage.local.set(values);
    } catch (error) {
      // The extension was reloaded or removed: nothing left to save to.
    }
  }

  // Message to the background service worker; null when it cannot answer.
  async function message(payload) {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (error) {
      return null;
    }
  }

  // Once the extension is reloaded or updated, the pages already open keep this script, cut
  // off from the extension: Chrome then takes its id away. Only reloading the page helps.
  function extensionAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }

  function webStorage(name) {
    try {
      return root[name];
    } catch (error) {
      return null;
    }
  }

  function pageEnv(extra) {
    return Object.assign(
      { location: root.location, sessionStorage: webStorage('sessionStorage'), localStorage: webStorage('localStorage'), document },
      extra || {},
    );
  }

  function personInTab() {
    return LFX.scalable.discovery.findPersonId({ sessionStorage: webStorage('sessionStorage'), localStorage: webStorage('localStorage'), document: null });
  }

  // A web-app page: a known path, or any page where the app keeps the person id in the tab.
  function isAppPage() {
    return APP_PATH.test(root.location.pathname) || Boolean(personInTab());
  }

  // On an overnight account's Transactions page, the recipe of its transaction list,
  // read from the page's own data (once per page address).
  function pageDepositRecipe() {
    const path = root.location.pathname;
    if (path !== recipePath) {
      recipePath = path;
      recipeOfPage = null;
      const match = TRANSACTIONS_PAGE.exec(path);
      if (match) {
        const savingsAccountId = decodeURIComponent(match[1]);
        const flight = LFX.scalable.flight;
        const recipe = flight.findDepositRecipe(flight.textFromDocument(document));
        if (flight.isUsableDepositRecipe(recipe, savingsAccountId)) recipeOfPage = { savingsAccountId, recipe };
      }
    }
    return recipeOfPage;
  }

  // The broker's pages show the portfolio, the overnight pages show their account and,
  // on the Transactions page, the recipe of its list: the background keeps them, so
  // each account can be exported from any page.
  function rememberIdsFromPage() {
    const person = personInTab();
    if (!person) return;
    const env = { location: root.location, document };
    const portfolio = LFX.scalable.discovery.findPortfolioId(env);
    const savingsAccountIds = LFX.scalable.discovery.findSavingsAccountIds(env);
    const fromPage = pageDepositRecipe();
    if (!portfolio && savingsAccountIds.length === 0 && !fromPage) return;
    const depositRecipe = fromPage ? Object.assign({ savingsAccountId: fromPage.savingsAccountId }, fromPage.recipe) : null;
    const key = JSON.stringify([person.value, portfolio && portfolio.value, savingsAccountIds, depositRecipe]);
    if (key === lastRemembered) return;
    lastRemembered = key;
    message({
      type: 'lfx:remember-ids',
      personId: person.value,
      portfolioId: portfolio ? portfolio.value : null,
      savingsAccountIds,
      depositRecipe,
    });
  }

  // Recipes of the overnight accounts' lists: this page's first, then those remembered
  // for the same person.
  function depositRecipes(remembered, ids) {
    const recipes = {};
    const flight = LFX.scalable.flight;
    if (remembered && ids.personId && remembered.personId === ids.personId && remembered.depositRecipes) {
      for (const [savingsAccountId, recipe] of Object.entries(remembered.depositRecipes)) {
        if (flight.isUsableDepositRecipe(recipe, savingsAccountId)) recipes[savingsAccountId] = { recipe, source: 'memory' };
      }
    }
    const fromPage = pageDepositRecipe();
    if (fromPage) recipes[fromPage.savingsAccountId] = { recipe: fromPage.recipe, source: 'page' };
    return recipes;
  }

  function anchorDownload(filename, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // Polls the background while Chrome's "Save as" window is open: each question keeps the
  // background awake, which a single long wait would not.
  async function waitForChoice(id) {
    const end = Date.now() + SAVE_WAIT_MS;
    while (Date.now() < end) {
      const answer = await message({ type: 'lfx:download-state', id });
      if (!answer) return { state: 'failed', error: 'no answer from the extension' };
      if (answer.state !== 'pending') return answer;
      await new Promise((resolve) => setTimeout(resolve, SAVE_POLL_MS));
    }
    return { state: 'failed', error: 'timeout' };
  }

  // The export as one file, so that one "Save as" window saves it in any folder: the CSV of
  // the only account, or one ZIP holding the CSVs of both.
  async function exportFile(files, names) {
    if (files.length === 1) {
      const [file] = files;
      return {
        name: file.name,
        archive: false,
        dataUrl: LFX.files.toDataUrl(file.content),
        blob: () => new Blob([file.content], { type: 'text/csv;charset=utf-8' }),
      };
    }
    const bytes = await LFX.zip.create(files.map((file) => ({ name: file.name, content: file.content })));
    return { name: names.archive, archive: true, dataUrl: LFX.files.zipDataUrl(bytes), blob: () => new Blob([bytes], { type: 'application/zip' }) };
  }

  // Chrome's "Save as" window; from the page, into Downloads, when the file is too large for
  // the extension or the extension does not answer. Saved: { ok, id, folder }, id being the
  // download (null from the page); otherwise { cancelled } or { error }.
  async function saveFile(file, settings) {
    const fromPage = (reason) => {
      log('download-fallback', { reason });
      anchorDownload(file.name, file.blob());
      return { ok: true, id: null, folder: t('downloadsName') };
    };
    if (!LFX.files.isDownloadUrl(file.dataUrl)) return fromPage('file too large for the extension');
    const payload = { name: file.name, dataUrl: file.dataUrl };
    if (settings.saveDialog === false) {
      const answer = await message({ type: 'lfx:download', files: [payload], folder: '' });
      if (answer && answer.ok) return { ok: true, id: answer.ids[0], folder: t('downloadsName') };
      if (answer && answer.error) return { ok: false, error: answer.error };
      return fromPage('no answer from the extension');
    }
    const started = await message({ type: 'lfx:save-as', file: payload });
    if (!started) return fromPage('no answer from the extension');
    if (!started.ok) return { ok: false, error: started.error };
    const chosen = await waitForChoice(started.id);
    log('save', { file: file.archive ? 'zip' : 'csv', state: chosen.state });
    if (chosen.state === 'cancelled') return { ok: false, cancelled: true };
    if (chosen.state !== 'chosen') return { ok: false, error: chosen.error || chosen.state };
    return { ok: true, id: started.id, folder: chosen.directory };
  }

  // The exporter's steps: the full message in the console, the short one in the account's
  // row; accountDone and accountFailed close the row.
  function onProgress(key, ...args) {
    if (key === 'accountDone') {
      const [account, count] = args;
      log('account-done', { account, rows: count });
      ui.setAccountProgress(account, 1, t(account === 'broker' ? 'stepDoneBroker' : 'stepDoneDeposit', count), 'done');
      return;
    }
    if (key === 'accountFailed') {
      ui.setAccountProgress(args[0], 1, t('stepFailed'), 'error');
      return;
    }
    log(t(key, ...args));
    const step = STEPS[key] ? STEPS[key](...args) : null;
    if (step) ui.setAccountProgress(step.account, Number.isFinite(step.fraction) ? step.fraction : null, step.text);
  }

  // The last saved file, in its folder (Finder, Explorer).
  function onShowFile() {
    if (lastSavedId !== null) message({ type: 'lfx:show-download', id: lastSavedId });
  }

  // force: ask GitHub now; otherwise the background answers from its daily cache.
  async function checkUpdates(force) {
    const request = ++updateRequest;
    ui.setUpdate({ status: 'checking' });
    const answer = await message({ type: 'lfx:update-status', force: force === true });
    if (request !== updateRequest) return;
    if (!answer || answer.ok === false) ui.setUpdate({ status: 'failed' });
    else ui.setUpdate({ status: answer.available ? 'available' : 'current', latest: answer.latest, url: answer.url });
  }

  async function onOpen() {
    if (!extensionAlive()) {
      ui.setUnavailable(t('reloadPage'));
      return;
    }
    const settings = await loadSettings();
    ui.setRiskAccepted(settings.riskAccepted === true);
    ui.setLastExport(settings.lastExportDates);
    ui.setSaveSettings(settings);
    const today = LFX.format.todayBerlin();
    if (!defaultsApplied && !ui.isBusy()) {
      const draft = settings.formDraft;
      // The form survives page changes for the day; afterwards it starts from the last export.
      if (draft && typeof draft === 'object' && draft.day === today) ui.setDefaults(draft);
      else ui.setDefaults({ from: sinceLast(settings.lastExportDates, ACCOUNTS), to: today, broker: true, deposit: true });
      defaultsApplied = true;
    }
    ui.fillEmptyTo(today);
    checkUpdates(false);
  }

  async function onFormChange(values) {
    await saveSettings({ formDraft: Object.assign({}, values, { day: LFX.format.todayBerlin() }) });
  }

  async function onAcceptRisk() {
    await saveSettings({ riskAccepted: true });
  }

  async function onSaveSettings(values) {
    const cleaned = { filePrefix: LFX.files.sanitizePrefix(values.filePrefix) };
    await saveSettings(cleaned);
    return cleaned;
  }

  function onCancel() {
    if (controller) controller.abort();
  }

  async function onExport(options) {
    if (!extensionAlive()) {
      ui.setUnavailable(t('reloadPage'));
      return;
    }
    if (!options.broker && !options.deposit) {
      ui.setStatus(t('selectAccount'), 'error');
      return;
    }
    if (options.from && options.to && options.from > options.to) {
      ui.setStatus(t('invalidRange'), 'error');
      return;
    }

    const scalable = LFX.scalable;
    controller = new AbortController();
    ui.setBusy(true);
    ui.setWarnings([]);
    ui.setStatus('');
    ui.setResult(null);
    lastSavedId = null;
    // One collapsed group per export keeps the page's console readable.
    console.groupCollapsed(`[LibreFolio Exporter] ${t('exporting')} ${new Date().toLocaleTimeString()}`);
    try {
      const settings = await loadSettings();
      rememberIdsFromPage();
      const person = personInTab();
      const remembered = person ? await message({ type: 'lfx:recall-ids', personId: person.value }) : null;
      const ids = scalable.discovery.discover(pageEnv({ remembered }));
      ids.depositRecipes = depositRecipes(remembered, ids);
      log('identifiers', {
        person: ids.personSource || 'not found',
        portfolio: ids.portfolioSource || 'not found',
        overnight: ids.savingsSource || 'not found',
        overnightAccounts: ids.savingsAccountIds.length,
        overnightRecipes: Object.values(ids.depositRecipes).map((entry) => entry.source),
      });
      const api = scalable.client.createClient({
        fetchImpl: (url, init) => fetch(url, init),
        origin: root.location.origin,
        signal: controller.signal,
        log,
      });
      const outcome = await scalable.exporter.runExport({
        api,
        ids,
        options,
        context: { exporter: `${EXPORTER_ID}/${version}` },
        progress: onProgress,
        diagnostics: log,
      });

      const allRows = [].concat(outcome.broker || [], outcome.deposit || []);
      if (allRows.length > 0) {
        const structure = scalable.exporter.summarize(allRows);
        log('structure of the export (no amounts, descriptions or identifiers)', structure);
      }

      const names = LFX.files.fileNames(settings.filePrefix, LFX.format.fileTimestamp());
      const files = [];
      for (const account of ACCOUNTS) {
        const rows = outcome[account];
        if (rows && rows.length > 0) files.push({ account, name: names[account], content: scalable.exporter.toCsv(rows), count: rows.length });
      }

      const messages = outcome.warnings.map((warning) => t(warning.key, ...(warning.args || [])));
      for (const failure of outcome.errors) {
        const account = t(failure.account === 'broker' ? 'accountBroker' : 'accountDeposit');
        log('account-error', { account: failure.account, code: failure.error.code, detail: failure.error.detail });
        messages.push(t('accountFailed', account, errorText(failure.error)), ...technicalLines(failure.error));
      }
      ui.setWarnings(messages);

      if (files.length === 0 && outcome.errors.length > 0) {
        ui.setStatus(errorText(outcome.errors[0].error), 'error');
        return;
      }
      let saved = null;
      if (files.length > 0) {
        const output = await exportFile(files, names);
        if (settings.saveDialog !== false) ui.setProgressLabel(t(output.archive ? 'progressSavingZip' : 'progressSavingOne'));
        saved = await saveFile(output, settings);
        lastSavedId = saved.ok && typeof saved.id === 'number' ? saved.id : null;
        if (saved.ok) {
          ui.setResult({ name: output.name, archive: output.archive, folder: t('resultFolder', saved.folder), canShow: lastSavedId !== null });
        } else if (saved.cancelled) {
          ui.setStatus(t('saveCancelled'));
        } else {
          log('save-error', { error: saved.error });
          ui.setStatus(t('saveFailed', saved.error), 'error');
        }
      } else {
        ui.setStatus(t('nothingToExport'));
      }
      // An account read without errors is up to date until "to" once the file is saved, or
      // when it had nothing to export.
      const exportedUntil = options.to || LFX.format.todayBerlin();
      const dates = Object.assign({}, settings.lastExportDates);
      const savedFile = Boolean(saved && saved.ok);
      const updated = ACCOUNTS.filter((account) => Array.isArray(outcome[account]) && (outcome[account].length === 0 || savedFile));
      for (const account of updated) dates[account] = exportedUntil;
      if (updated.length > 0) {
        await saveSettings({ lastExportDates: dates });
        ui.setLastExport(dates);
      }
    } catch (error) {
      const cancelled = error && error.code === 'cancelled';
      if (cancelled) log('cancelled');
      else log('error', { code: error && error.code, detail: error && (error.detail || error.message) });
      ui.setStatus(cancelled ? t('cancelled') : errorText(error), cancelled ? '' : 'error');
      if (!cancelled) ui.setWarnings(technicalLines(error));
    } finally {
      controller = null;
      ui.setBusy(false);
      console.groupEnd();
    }
  }

  function ensureUi() {
    if (!ui) {
      ui = LFX.ui.create({
        t,
        version,
        infoUrl: INFO_URL,
        logoUrl: LFX.logoDataUrl,
        today: () => LFX.format.todayBerlin(),
        shiftMonths: LFX.format.shiftMonths,
        fileNames: (prefix) => LFX.files.fileNames(prefix, LFX.format.fileTimestamp()),
        showLabel: t('showFolder'),
        onShowFile,
        onOpen,
        onExport,
        onCancel,
        onAcceptRisk,
        onCheckUpdates: () => checkUpdates(true),
        onSaveSettings,
        onFormChange,
        onLogoError: () => log('logo blocked by the page'),
      });
    }
    return ui;
  }

  // The web app is a single-page application: follow its route changes.
  function syncRoute() {
    rememberIdsFromPage();
    if (isAppPage()) ensureUi().show();
    else if (ui && !ui.isBusy()) ui.hide();
  }

  syncRoute();
  setInterval(syncRoute, 1000);
})(globalThis);
