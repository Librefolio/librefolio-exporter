/*
 * Content-script entry point: shows the button on the Scalable web app pages
 * and runs an export when the user asks for one.
 */
(function (root) {
  'use strict';

  const LFX = root.LFX;
  if (!LFX || LFX.started) return;
  LFX.started = true;

  const INFO_URL = 'https://github.com/Librefolio/librefolio-exporter#risks';
  const APP_PATH = /^\/(broker|interest|cockpit)(\/|$)/;
  const EXPORTER_ID = 'librefolio-exporter';
  const DEFAULT_SETTINGS = { riskAccepted: false, lastExportDate: '', updateCheckEnabled: true };
  const ERROR_KEYS = {
    noPerson: 'errorNoPerson',
    noPortfolio: 'errorNoPortfolio',
    session: 'errorSession',
    rateLimited: 'errorRateLimited',
    unexpected: 'errorUnexpected',
    graphql: 'errorUnexpected',
    http: 'errorHttp',
    network: 'errorNetwork',
  };
  // Errors whose technical detail helps a bug report: it never contains personal data.
  const SHOW_TECHNICAL = new Set(['unexpected', 'graphql', 'http', 'network']);

  const version = chrome.runtime.getManifest().version;
  const t = LFX.i18n.translator(LFX.i18n.pickLanguage([document.documentElement.lang, navigator.language]));

  let ui = null;
  let controller = null;

  // Diagnostics in the page console: operations, statuses and sources, never
  // identifiers, amounts or descriptions.
  function log(event, data) {
    console.info('[LibreFolio Exporter]', event, data === undefined ? '' : data);
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
    try {
      return await chrome.storage.local.get(DEFAULT_SETTINGS);
    } catch (error) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  async function saveSettings(values) {
    try {
      await chrome.storage.local.set(values);
    } catch (error) {
      // The extension was reloaded or removed: nothing left to save to.
    }
  }

  function webStorage(name) {
    try {
      return root[name];
    } catch (error) {
      return null;
    }
  }

  function download(filename, content) {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function refreshUpdateNotice(settings) {
    if (!settings.updateCheckEnabled) {
      ui.setUpdate(null);
      return;
    }
    try {
      ui.setUpdate(await chrome.runtime.sendMessage({ type: 'lfx:update-status' }));
    } catch (error) {
      ui.setUpdate(null);
    }
  }

  async function onOpen() {
    const settings = await loadSettings();
    ui.setRiskAccepted(settings.riskAccepted === true);
    ui.setUpdateCheck(settings.updateCheckEnabled !== false);
    ui.setLastExport(settings.lastExportDate || '');
    if (!ui.isBusy()) ui.setDefaults({ from: settings.lastExportDate || '', to: '' });
    refreshUpdateNotice(settings);
  }

  async function onAcceptRisk() {
    await saveSettings({ riskAccepted: true });
  }

  async function onToggleUpdateCheck(enabled) {
    await saveSettings({ updateCheckEnabled: enabled });
    try {
      await chrome.storage.local.remove('updateCache');
    } catch (error) {
      // Ignored: the cache only avoids repeated checks.
    }
    refreshUpdateNotice({ updateCheckEnabled: enabled });
  }

  function onCancel() {
    if (controller) controller.abort();
  }

  async function onExport(options) {
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
    try {
      const ids = scalable.discovery.discover({
        location: root.location,
        sessionStorage: webStorage('sessionStorage'),
        localStorage: webStorage('localStorage'),
        document,
      });
      log('identifiers', {
        person: ids.personSource || 'not found',
        portfolio: ids.portfolioSource || 'not found',
        overnightLinks: ids.savingsAccountIds.length,
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
        progress: (key, ...args) => ui.setStatus(t(key, ...args)),
      });

      const allRows = [].concat(outcome.broker || [], outcome.deposit || []);
      if (allRows.length > 0) {
        log('structure of the export (no amounts, descriptions or identifiers)');
        console.table(scalable.exporter.summarize(allRows));
      }

      const stamp = LFX.format.fileTimestamp();
      let files = 0;
      if (outcome.broker && outcome.broker.length > 0) {
        download(`scalable-broker_${stamp}.csv`, scalable.exporter.toCsv(outcome.broker));
        files++;
      }
      if (outcome.deposit && outcome.deposit.length > 0) {
        download(`scalable-deposit_${stamp}.csv`, scalable.exporter.toCsv(outcome.deposit));
        files++;
      }

      const messages = outcome.warnings.map((warning) => t(warning.key, ...(warning.args || [])));
      for (const failure of outcome.errors) {
        const account = t(failure.account === 'broker' ? 'accountBroker' : 'accountDeposit');
        log('account-error', { account: failure.account, code: failure.error.code, detail: failure.error.detail });
        messages.push(t('accountFailed', account, errorText(failure.error)), ...technicalLines(failure.error));
      }
      ui.setWarnings(messages);

      if (files === 0 && outcome.errors.length > 0) {
        ui.setStatus(errorText(outcome.errors[0].error), 'error');
      } else if (files === 0) {
        ui.setStatus(t('nothingToExport'));
      } else {
        ui.setStatus(t('done', (outcome.broker || []).length, (outcome.deposit || []).length), 'success');
        if (outcome.errors.length === 0) {
          const exportedUntil = options.to || LFX.format.todayBerlin();
          await saveSettings({ lastExportDate: exportedUntil });
          ui.setLastExport(exportedUntil);
        }
      }
    } catch (error) {
      const cancelled = error && error.code === 'cancelled';
      log(cancelled ? 'cancelled' : 'error', cancelled ? undefined : { code: error && error.code, detail: error && (error.detail || error.message) });
      ui.setStatus(cancelled ? t('cancelled') : errorText(error), cancelled ? '' : 'error');
      if (!cancelled) ui.setWarnings(technicalLines(error));
    } finally {
      controller = null;
      ui.setBusy(false);
    }
  }

  function ensureUi() {
    if (!ui) {
      ui = LFX.ui.create({ t, version, infoUrl: INFO_URL, onOpen, onExport, onCancel, onAcceptRisk, onToggleUpdateCheck });
    }
    return ui;
  }

  // The web app is a single-page application: follow its route changes.
  function syncRoute() {
    if (APP_PATH.test(root.location.pathname)) ensureUi().show();
    else if (ui && !ui.isBusy()) ui.hide();
  }

  syncRoute();
  setInterval(syncRoute, 1000);
})(globalThis);
