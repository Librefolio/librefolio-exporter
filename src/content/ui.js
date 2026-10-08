/*
 * Floating button and export panel, isolated from the page in a closed shadow
 * root. All text is set with textContent: no HTML is ever parsed.
 */
(function (root) {
  'use strict';

  const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
[hidden] { display: none !important; }
.fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border: none; border-radius: 999px; background: #2f6b3a; color: #fff; font-size: 14px;
  font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25); }
.fab:hover { background: #255830; }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 3px solid #e8781e; outline-offset: 2px; }
.panel { position: fixed; right: 20px; bottom: 76px; z-index: 2147483647; width: 370px; max-width: calc(100vw - 40px);
  max-height: calc(100vh - 100px); overflow: auto; padding: 16px; border-radius: 12px; background: #fff; color: #1f2933;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3); font-size: 13px; line-height: 1.45; color-scheme: light dark; }
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
h2 { margin: 0; font-size: 15px; }
h3 { margin: 12px 0 6px; font-size: 13px; }
p { margin: 6px 0; }
.icon-button { border: none; background: transparent; color: inherit; font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 6px; }
.notice { padding: 10px; border-radius: 8px; margin-bottom: 10px; }
.risk { background: #fff4e5; border: 1px solid #f0c48a; }
.update { background: #e8f1fb; border: 1px solid #9fc0e6; }
.row { display: flex; align-items: flex-start; gap: 8px; margin: 4px 0; }
.dates { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; }
input[type="date"] { padding: 4px 6px; border: 1px solid #b8c2cc; border-radius: 6px; font-size: 13px; }
.hint { color: #52606d; font-size: 12px; }
.actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.primary, .secondary { padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
.primary { border: none; background: #2f6b3a; color: #fff; }
.primary:disabled { background: #9aa5b1; cursor: not-allowed; }
.secondary { border: 1px solid #b8c2cc; background: transparent; color: inherit; }
.status { margin-top: 10px; min-height: 1.2em; }
.status.error { color: #b42318; }
.status.success { color: #2f6b3a; }
.warnings { margin: 6px 0 0; padding-left: 18px; color: #8a4b08; }
footer { margin-top: 12px; padding-top: 8px; border-top: 1px solid #e4e7eb; color: #52606d; font-size: 11px; }
a { color: #3a63a8; }
@media (prefers-color-scheme: dark) {
  .panel { background: #1f2933; color: #e4e7eb; }
  .risk { background: #3b2a12; border-color: #8a5a1c; }
  .update { background: #172b45; border-color: #2f5a8a; }
  .hint, footer { color: #9aa5b1; }
  footer { border-top-color: #3e4c59; }
  .warnings { color: #f7c27a; }
  .status.error { color: #ff8a80; }
  .status.success { color: #8fd19e; }
  a { color: #8fb5ec; }
}
`;

  function el(tag, attributes, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children || []) {
      if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function downloadIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M12 3v12m0 0l-5-5m5 5l5-5M4 20h16');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function create(options) {
    const t = options.t;
    const state = { busy: false, riskAccepted: false };

    const host = el('div', { id: 'librefolio-exporter-root', 'data-testid': 'lfx-root' });
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.appendChild(el('style', { text: STYLE }));

    const fab = el(
      'button',
      { class: 'fab', type: 'button', title: t('buttonTitle'), 'aria-label': t('buttonTitle'), 'aria-expanded': 'false', 'data-testid': 'lfx-open' },
      [downloadIcon(), el('span', { text: t('buttonLabel') })],
    );

    const closeButton = el('button', { class: 'icon-button', type: 'button', title: t('close'), 'aria-label': t('close'), 'data-testid': 'lfx-close', text: '×' });
    const riskAccept = el('button', { class: 'secondary', type: 'button', 'data-testid': 'lfx-risk-accept', text: t('riskAccept') });
    const riskBox = el('div', { class: 'notice risk', role: 'note', 'data-testid': 'lfx-risk' }, [
      el('strong', { text: t('riskTitle') }),
      el('p', { text: t('riskText') }),
      el('div', { class: 'actions' }, [
        riskAccept,
        el('a', { href: options.infoUrl, target: '_blank', rel: 'noopener noreferrer', text: t('riskLink') }),
      ]),
    ]);

    const updateText = el('span', { 'data-testid': 'lfx-update-text' });
    const updateLink = el('a', { target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'lfx-update-link', text: t('updateDownload') });
    const updateBox = el('div', { class: 'notice update', role: 'status', hidden: true, 'data-testid': 'lfx-update' }, [updateText, ' ', updateLink]);

    const brokerBox = el('input', { type: 'checkbox', checked: true, 'data-testid': 'lfx-account-broker' });
    const depositBox = el('input', { type: 'checkbox', checked: true, 'data-testid': 'lfx-account-deposit' });
    const fromInput = el('input', { type: 'date', id: 'lfx-from', 'data-testid': 'lfx-from' });
    const toInput = el('input', { type: 'date', id: 'lfx-to', 'data-testid': 'lfx-to' });
    const detailsBox = el('input', { type: 'checkbox', checked: true, 'data-testid': 'lfx-details' });
    const lastExportLine = el('p', { class: 'hint', hidden: true, 'data-testid': 'lfx-last-export' });
    const exportButton = el('button', { class: 'primary', type: 'button', disabled: true, 'data-testid': 'lfx-export', text: t('exportButton') });
    const cancelButton = el('button', { class: 'secondary', type: 'button', hidden: true, 'data-testid': 'lfx-cancel', text: t('cancelButton') });
    const status = el('div', { class: 'status', role: 'status', 'aria-live': 'polite', 'data-testid': 'lfx-status' });
    const warnings = el('ul', { class: 'warnings', hidden: true, 'data-testid': 'lfx-warnings' });
    const updateToggle = el('input', { type: 'checkbox', checked: true, 'data-testid': 'lfx-update-check' });
    const riskFooterLink = el('a', { href: options.infoUrl, target: '_blank', rel: 'noopener noreferrer', hidden: true, text: t('riskLink') });

    const panel = el('section', { class: 'panel', hidden: true, role: 'dialog', 'aria-label': t('panelTitle'), 'data-testid': 'lfx-panel' }, [
      el('header', {}, [el('h2', { text: t('panelTitle') }), closeButton]),
      riskBox,
      updateBox,
      el('h3', { text: t('accounts') }),
      el('label', { class: 'row' }, [brokerBox, el('span', { text: t('accountBroker') })]),
      el('label', { class: 'row' }, [depositBox, el('span', { text: t('accountDeposit') })]),
      el('h3', { text: t('period') }),
      el('div', { class: 'dates' }, [
        el('label', { for: 'lfx-from', text: t('fromDate') }),
        fromInput,
        el('label', { for: 'lfx-to', text: t('toDate') }),
        toInput,
      ]),
      el('p', { class: 'hint', text: t('rangeHint') }),
      lastExportLine,
      el('label', { class: 'row' }, [detailsBox, el('span', { text: t('includeDetails') })]),
      el('div', { class: 'actions' }, [exportButton, cancelButton]),
      status,
      warnings,
      el('footer', {}, [
        el('label', { class: 'row' }, [updateToggle, el('span', { text: t('updateCheck') })]),
        el('div', {}, [t('version', options.version), ' · ', t('notAffiliated'), ' ', riskFooterLink]),
      ]),
    ]);

    shadow.appendChild(fab);
    shadow.appendChild(panel);

    function refreshExportButton() {
      exportButton.disabled = state.busy || !state.riskAccepted;
    }

    function openPanel() {
      panel.hidden = false;
      fab.setAttribute('aria-expanded', 'true');
      options.onOpen();
    }

    function closePanel() {
      panel.hidden = true;
      fab.setAttribute('aria-expanded', 'false');
    }

    fab.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
    closeButton.addEventListener('click', closePanel);
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closePanel();
    });
    riskAccept.addEventListener('click', () => {
      options.onAcceptRisk();
      api.setRiskAccepted(true);
    });
    exportButton.addEventListener('click', () =>
      options.onExport({
        broker: brokerBox.checked,
        deposit: depositBox.checked,
        details: detailsBox.checked,
        from: fromInput.value || '',
        to: toInput.value || '',
      }),
    );
    cancelButton.addEventListener('click', () => options.onCancel());
    updateToggle.addEventListener('change', () => options.onToggleUpdateCheck(updateToggle.checked));

    const api = {
      show() {
        if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
      },
      hide() {
        closePanel();
        host.remove();
      },
      isBusy: () => state.busy,
      setRiskAccepted(accepted) {
        state.riskAccepted = Boolean(accepted);
        riskBox.hidden = state.riskAccepted;
        riskFooterLink.hidden = !state.riskAccepted;
        refreshExportButton();
      },
      setUpdateCheck(enabled) {
        updateToggle.checked = Boolean(enabled);
      },
      setUpdate(info) {
        const valid =
          info &&
          info.available &&
          info.latest &&
          typeof info.url === 'string' &&
          info.url.startsWith('https://github.com/Librefolio/librefolio-exporter/');
        if (valid) {
          updateText.textContent = t('updateAvailable', info.latest);
          updateLink.href = info.url;
        }
        updateBox.hidden = !valid;
      },
      setLastExport(date) {
        lastExportLine.textContent = date ? t('lastExport', date) : '';
        lastExportLine.hidden = !date;
      },
      setDefaults(values) {
        fromInput.value = values.from || '';
        toInput.value = values.to || '';
      },
      setBusy(busy) {
        state.busy = Boolean(busy);
        cancelButton.hidden = !state.busy;
        for (const input of [brokerBox, depositBox, fromInput, toInput, detailsBox]) input.disabled = state.busy;
        refreshExportButton();
      },
      setStatus(text, kind) {
        status.textContent = text || '';
        status.className = kind ? `status ${kind}` : 'status';
      },
      setWarnings(list) {
        warnings.replaceChildren(...list.map((text) => el('li', { text })));
        warnings.hidden = list.length === 0;
      },
    };
    return api;
  }

  root.LFX = root.LFX || {};
  root.LFX.ui = { create };
})(globalThis);
