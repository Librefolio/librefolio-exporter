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
.fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; display: flex; align-items: center;
  padding: 6px; border: none; border-radius: 999px; background: #2f6b3a; color: #fff; font-size: 14px;
  font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25); transition: padding 0.2s ease; }
.fab:hover { background: #255830; }
.fab-label { display: inline-flex; align-items: center; gap: 8px; max-width: 0; overflow: hidden; white-space: nowrap;
  opacity: 0; transition: max-width 0.22s ease, opacity 0.18s ease, margin 0.22s ease; }
.fab:hover, .fab:focus-visible, .fab[aria-expanded="true"] { padding-right: 14px; }
.fab:hover .fab-label, .fab:focus-visible .fab-label, .fab[aria-expanded="true"] .fab-label { max-width: 160px; opacity: 1; margin-left: 8px; }
.logo-wrap { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 30px; height: 30px;
  border-radius: 50%; background: #fff; overflow: hidden; }
.logo { display: block; width: 24px; height: 24px; border-radius: 50%; }
@media (prefers-reduced-motion: reduce) { .fab, .fab-label { transition: none; } }
button:focus-visible, input:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid #e8781e; outline-offset: 2px; }
.panel { position: fixed; right: 20px; bottom: 76px; z-index: 2147483647; width: 380px; max-width: calc(100vw - 40px);
  max-height: calc(100vh - 100px); overflow: auto; padding: 16px; border-radius: 12px; background: #fff; color: #1f2933;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3); font-size: 13px; line-height: 1.45; color-scheme: light dark; }
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.title { display: flex; align-items: center; gap: 8px; }
h2 { margin: 0; font-size: 15px; }
h3 { margin: 12px 0 6px; font-size: 13px; }
p { margin: 6px 0; }
.icon-button { border: none; background: transparent; color: inherit; font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 6px; }
.notice { padding: 10px; border-radius: 8px; margin-bottom: 10px; }
.risk { background: #fff4e5; border: 1px solid #f0c48a; }
.versionbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: -2px 0 10px; color: #52606d; font-size: 12px; }
.versionbar.available { padding: 8px 10px; border-radius: 8px; background: #e8f1fb; border: 1px solid #9fc0e6; color: #1f2933; font-size: 13px; }
.grow { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.small-button { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border: 1px solid #b8c2cc; border-radius: 999px;
  background: transparent; color: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.small-button:hover { border-color: #2f6b3a; }
.small-button:disabled { opacity: 0.6; cursor: default; }
.names { margin: 2px 0 0; padding-left: 18px; }
.names li { overflow-wrap: anywhere; }
.names .names { margin: 0; list-style: circle; }
.row { display: flex; align-items: flex-start; gap: 8px; margin: 4px 0; }
.tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.tile { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 12px 8px 10px;
  border: 2px solid #d5dbe1; border-radius: 12px; background: transparent; color: inherit; cursor: pointer; text-align: center; font: inherit; }
.tile:hover { border-color: #9aa5b1; }
.tile[aria-pressed="true"] { border-color: #2f6b3a; background: rgba(47, 107, 58, 0.07); }
.tile:disabled { opacity: 0.6; cursor: default; }
.tile-icon { display: inline-flex; align-items: center; justify-content: center; width: 46px; height: 46px; border-radius: 50%; color: #fff; }
.tile-icon.broker { background: #3a63a8; }
.tile-icon.deposit { background: #e8781e; }
.tile[aria-pressed="false"] .tile-icon { filter: grayscale(1); opacity: 0.55; }
.tile-title { font-weight: 600; font-size: 13px; }
.tile-subtitle { color: #52606d; font-size: 11px; line-height: 1.3; }
.tile-check { position: absolute; top: 6px; right: 6px; display: none; align-items: center; justify-content: center;
  width: 18px; height: 18px; border-radius: 50%; background: #2f6b3a; color: #fff; }
.tile[aria-pressed="true"] .tile-check { display: inline-flex; }
.progress-box { display: grid; gap: 8px; margin-top: 12px; }
.progress-head { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
.progress-head strong { font-weight: 600; white-space: nowrap; }
.progress-head .step { margin-left: auto; color: #52606d; text-align: right; overflow-wrap: anywhere; }
.progress-row.done .step { color: #2f6b3a; }
.progress-row.error .step { color: #b42318; }
.dot { flex: none; align-self: center; width: 8px; height: 8px; border-radius: 50%; }
.dot.broker, .progress-row.broker .bar { background: #3a63a8; }
.dot.deposit, .progress-row.deposit .bar { background: #e8781e; }
.progress-row.error .bar { background: #b42318; }
.progress { position: relative; height: 6px; margin-top: 4px; border-radius: 999px; background: rgba(127, 127, 127, 0.22); overflow: hidden; }
.progress .bar { position: absolute; top: 0; bottom: 0; left: 0; width: 0; border-radius: 999px; background: #2f6b3a; transition: width 0.2s ease; }
.progress.indeterminate .bar { width: 35%; animation: lfx-slide 1.2s ease-in-out infinite; }
@keyframes lfx-slide { from { left: -35%; } to { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .progress.indeterminate .bar { animation: none; width: 100%; opacity: 0.5; } }
.grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; }
input[type="date"], input[type="text"] { width: 100%; padding: 4px 6px; border: 1px solid #b8c2cc; border-radius: 6px;
  font-size: 13px; background: transparent; color: inherit; }
input:disabled { opacity: 0.55; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 8px; }
.chip { padding: 3px 10px; border: 1px solid #b8c2cc; border-radius: 999px; background: transparent; color: inherit;
  font-size: 12px; cursor: pointer; }
.chip:hover { border-color: #2f6b3a; }
.hint { color: #52606d; font-size: 12px; overflow-wrap: anywhere; }
.actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.actions .primary { margin-left: auto; }
.progress-label { margin: 6px 0 0; }
.result-box { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
.result-file, .result-folder { margin: 0; color: #2f6b3a; overflow-wrap: anywhere; }
.result-folder { font-size: 12px; }
.result-box .small-button { align-self: flex-end; margin-top: 2px; }
.primary, .secondary { padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
.primary { border: none; background: #2f6b3a; color: #fff; }
.primary:disabled { background: #9aa5b1; cursor: not-allowed; }
.secondary { border: 1px solid #b8c2cc; background: transparent; color: inherit; }
.status { margin-top: 10px; min-height: 1.2em; }
.status:empty { margin-top: 0; min-height: 0; }
.status.error { color: #b42318; }
.status.success { color: #2f6b3a; }
.warnings { margin: 6px 0 0; padding-left: 18px; color: #8a4b08; }
footer { margin-top: 12px; padding-top: 8px; border-top: 1px solid #e4e7eb; color: #52606d; font-size: 11px; }
a { color: #3a63a8; }
@media (prefers-color-scheme: dark) {
  .panel { background: #1f2933; color: #e4e7eb; }
  .risk { background: #3b2a12; border-color: #8a5a1c; }
  .versionbar { color: #9aa5b1; }
  .versionbar.available { background: #172b45; border-color: #2f5a8a; color: #e4e7eb; }
  .hint, footer, .tile-subtitle { color: #9aa5b1; }
  .tile { border-color: #3e4c59; }
  .tile[aria-pressed="true"] { border-color: #8fd19e; background: rgba(143, 209, 158, 0.08); }
  footer { border-top-color: #3e4c59; }
  .warnings { color: #f7c27a; }
  .status.error { color: #ff8a80; }
  .status.success, .result-file, .result-folder, .progress-row.done .step { color: #8fd19e; }
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

  // Stroked icons drawn for this project, on a 24-unit grid.
  const STROKED = {
    download: ['M12 3v12m0 0l-5-5m5 5l5-5M4 20h16'],
    refresh: ['M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7'],
  };

  // Phosphor Icons (MIT), filled, on a 256-unit grid: chart-line-fill, piggy-bank-fill and
  // check-bold, from github.com/phosphor-icons/core. See THIRD_PARTY_NOTICES.md.
  const FILLED = {
    chart:
      'M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM200,176a8,8,0,0,1,0,16H56a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v62.92l34.88-29.07a8,8,0,0,1,9.56-.51l43,28.69,43.41-36.18a8,8,0,0,1,10.24,12.3l-48,40a8,8,0,0,1-9.56.51l-43-28.69L64,155.75V176Z',
    piggy:
      'M226,88.08c-.4-1-.82-2-1.25-3a87.93,87.93,0,0,0-30.17-37H216a8,8,0,0,0,0-16H112a88.12,88.12,0,0,0-87.72,81A32,32,0,0,0,0,144a8,8,0,0,0,16,0,16,16,0,0,1,8.57-14.16A87.69,87.69,0,0,0,46,178.22l12.56,35.16A16,16,0,0,0,73.64,224H86.36a16,16,0,0,0,15.07-10.62l1.92-5.38h57.3l1.92,5.38A16,16,0,0,0,177.64,224h12.72a16,16,0,0,0,15.07-10.62L221.64,168H224a24,24,0,0,0,24-24V112A24,24,0,0,0,226,88.08ZM152,72H112a8,8,0,0,1,0-16h40a8,8,0,0,1,0,16Zm28,56a12,12,0,1,1,12-12A12,12,0,0,1,180,128Z',
    check: 'M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z',
  };

  function icon(name, size) {
    const ns = 'http://www.w3.org/2000/svg';
    const filled = Object.prototype.hasOwnProperty.call(FILLED, name);
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', filled ? '0 0 256 256' : '0 0 24 24');
    svg.setAttribute('width', String(size || 16));
    svg.setAttribute('height', String(size || 16));
    svg.setAttribute('aria-hidden', 'true');
    for (const d of filled ? [FILLED[name]] : STROKED[name]) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      if (filled) {
        path.setAttribute('fill', 'currentColor');
      } else {
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '2.2');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
      }
      svg.appendChild(path);
    }
    return svg;
  }

  // The logo is a data: URL; a page that forbids those images only loses the logo.
  function logoBadge(url, onError) {
    const image = el('img', { class: 'logo', alt: '' });
    const badge = el('span', { class: 'logo-wrap', 'aria-hidden': 'true' }, [image]);
    image.addEventListener('error', () => {
      badge.hidden = true;
      if (onError) onError();
    });
    if (url) image.src = url;
    else badge.hidden = true;
    return badge;
  }

  function create(options) {
    const t = options.t;
    const state = { busy: false, riskAccepted: false, unavailable: false, lastExports: {} };

    const host = el('div', { id: 'librefolio-exporter-root', 'data-testid': 'lfx-root' });
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.appendChild(el('style', { text: STYLE }));

    const fab = el(
      'button',
      { class: 'fab', type: 'button', title: t('buttonTitle'), 'aria-label': t('buttonTitle'), 'aria-expanded': 'false', 'data-testid': 'lfx-open' },
      [logoBadge(options.logoUrl, options.onLogoError), el('span', { class: 'fab-label' }, [el('span', { text: t('buttonLabel') }), icon('download')])],
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

    // Version and update check, at the top: checked when the panel opens, and on request.
    const updateText = el('span', { 'data-testid': 'lfx-update-text', text: t('version', options.version) });
    const updateLink = el('a', { target: '_blank', rel: 'noopener noreferrer', hidden: true, 'data-testid': 'lfx-update-link', text: t('updateDownload') });
    const updateButton = el('button', { class: 'small-button', type: 'button', 'data-testid': 'lfx-update-check' }, [icon('refresh', 13), el('span', { text: t('updateCheckButton') })]);
    const updateBar = el('div', { class: 'versionbar', role: 'status', 'data-state': 'idle', 'data-testid': 'lfx-update' }, [
      el('span', { class: 'grow' }, [updateText, ' ', updateLink]),
      updateButton,
    ]);

    // Accounts: two tiles, pressed when chosen.
    const isPressed = (button) => button.getAttribute('aria-pressed') === 'true';
    const setPressed = (button, pressed) => button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    function accountTile(account, iconName) {
      const button = el('button', { class: 'tile', type: 'button', 'aria-pressed': 'true', 'data-testid': `lfx-account-${account}` }, [
        el('span', { class: `tile-icon ${account}` }, [icon(iconName, 26)]),
        el('span', { class: 'tile-title', text: t(account === 'broker' ? 'accountBroker' : 'accountDeposit') }),
        el('span', { class: 'tile-subtitle', text: t(account === 'broker' ? 'accountBrokerHint' : 'accountDepositHint') }),
        el('span', { class: 'tile-check', 'aria-hidden': 'true' }, [icon('check', 11)]),
      ]);
      button.addEventListener('click', () => {
        setPressed(button, !isPressed(button));
        refreshSinceLast();
        refreshSaveSection();
        formChanged();
      });
      return button;
    }
    const brokerTile = accountTile('broker', 'chart');
    const depositTile = accountTile('deposit', 'piggy');

    const fromInput = el('input', { type: 'date', id: 'lfx-from', 'data-testid': 'lfx-from' });
    const toInput = el('input', { type: 'date', id: 'lfx-to', 'data-testid': 'lfx-to' });
    const detailsBox = el('input', { type: 'checkbox', checked: true, 'data-testid': 'lfx-details' });
    const lastExportLine = el('p', { class: 'hint', hidden: true, 'data-testid': 'lfx-last-export' });

    function formValues() {
      return {
        broker: isPressed(brokerTile),
        deposit: isPressed(depositTile),
        details: detailsBox.checked,
        from: fromInput.value || '',
        to: toInput.value || '',
      };
    }

    function formChanged() {
      if (options.onFormChange) options.onFormChange(formValues());
    }

    // "Since last export": the oldest last export of the chosen accounts, and none when one
    // of them was never exported, so that nothing is skipped.
    function sinceLastDate() {
      const dates = [];
      if (isPressed(brokerTile)) dates.push(state.lastExports.broker || '');
      if (isPressed(depositTile)) dates.push(state.lastExports.deposit || '');
      if (dates.length === 0 || dates.some((date) => !date)) return '';
      return dates.sort()[0];
    }

    function applyPreset(months) {
      const today = options.today();
      toInput.value = today;
      fromInput.value = months > 0 ? options.shiftMonths(today, -months) : '';
      formChanged();
    }
    const presets = [
      ['presetMonth', 1, 'lfx-preset-1m'],
      ['presetThreeMonths', 3, 'lfx-preset-3m'],
      ['presetYear', 12, 'lfx-preset-1y'],
      ['presetAll', 0, 'lfx-preset-all'],
    ].map(([key, months, testId]) => el('button', { class: 'chip', type: 'button', 'data-testid': testId, text: t(key), onclick: () => applyPreset(months) }));
    const sinceLastChip = el('button', {
      class: 'chip',
      type: 'button',
      hidden: true,
      title: t('presetSinceLastHint'),
      'data-testid': 'lfx-preset-last',
      text: t('presetSinceLast'),
      onclick: () => {
        fromInput.value = sinceLastDate();
        toInput.value = options.today();
        formChanged();
      },
    });

    function refreshSinceLast() {
      sinceLastChip.hidden = !sinceLastDate();
    }

    // Saving: Chrome's "Save as" window picks the folder at every export; only the start of
    // the file names is a setting. Both accounts come as one ZIP holding their CSVs.
    const prefixInput = el('input', { type: 'text', id: 'lfx-prefix', maxlength: '60', spellcheck: 'false', autocomplete: 'off', 'data-testid': 'lfx-prefix' });
    const namesList = el('ul', { class: 'names' });
    const namesHint = el('div', { class: 'hint', 'data-testid': 'lfx-file-names' }, [el('span', { text: t('fileNamesLabel') }), namesList]);
    const saveSection = [
      el('h3', { text: t('saving') }),
      el('div', { class: 'grid' }, [el('label', { for: 'lfx-prefix', text: t('filePrefix') }), prefixInput]),
      namesHint,
    ];

    function refreshSaveSection() {
      const names = options.fileNames(prefixInput.value);
      const chosen = [
        ['broker', brokerTile],
        ['deposit', depositTile],
      ].filter(([, tile]) => isPressed(tile));
      const items = chosen.map(([account]) => el('li', { 'data-testid': `lfx-file-name-${account}`, text: names[account] }));
      if (items.length > 1) {
        namesList.replaceChildren(el('li', { 'data-testid': 'lfx-file-name-archive' }, [el('span', { text: t('archiveWith', names.archive) }), el('ul', { class: 'names' }, items)]));
      } else {
        namesList.replaceChildren(...items);
      }
      namesHint.hidden = items.length === 0;
    }

    async function storeSaveSettings() {
      const stored = await options.onSaveSettings({ filePrefix: prefixInput.value });
      if (stored) api.setSaveSettings(stored);
    }

    const exportButton = el('button', { class: 'primary', type: 'button', disabled: true, 'data-testid': 'lfx-export', text: t('exportButton') });
    const cancelButton = el('button', { class: 'secondary', type: 'button', hidden: true, 'data-testid': 'lfx-cancel', text: t('cancelButton') });
    // Progress: one row per account, read side by side.
    function progressRow(account) {
      const name = t(account === 'broker' ? 'accountBroker' : 'accountDeposit');
      const bar = el('div', { class: 'bar' });
      const track = el('div', { class: 'progress indeterminate', role: 'progressbar', 'aria-label': name }, [bar]);
      const step = el('span', { class: 'step', 'aria-live': 'polite', 'data-testid': `lfx-progress-${account}-step` });
      const row = el('div', { class: `progress-row ${account}`, hidden: true, 'data-testid': `lfx-progress-${account}` }, [
        el('div', { class: 'progress-head' }, [el('span', { class: `dot ${account}` }), el('strong', { text: name }), step]),
        track,
      ]);
      return { account, row, bar, track, step };
    }
    const progressRows = { broker: progressRow('broker'), deposit: progressRow('deposit') };
    const progress = el('div', { class: 'progress-box', hidden: true, 'data-testid': 'lfx-progress' }, [progressRows.broker.row, progressRows.deposit.row]);

    function showAccountProgress(entry, fraction, text, kind) {
      const known = typeof fraction === 'number' && Number.isFinite(fraction);
      const percent = known ? Math.round(Math.min(1, Math.max(0, fraction)) * 100) : 0;
      entry.track.className = known ? 'progress' : 'progress indeterminate';
      entry.bar.style.width = known ? `${percent}%` : '';
      entry.track.setAttribute('aria-valuenow', known ? String(percent) : '');
      entry.step.textContent = text || '';
      entry.kind = kind || '';
      entry.row.className = kind ? `progress-row ${entry.account} ${kind}` : `progress-row ${entry.account}`;
    }
    const progressLabel = el('p', { class: 'hint progress-label', hidden: true, 'aria-live': 'polite', 'data-testid': 'lfx-progress-label' });
    // The saved file and its folder, under the account rows; the button shows the file there.
    const resultFile = el('p', { class: 'result-file', 'data-testid': 'lfx-result-file' });
    const resultFolder = el('p', { class: 'result-folder', hidden: true, 'data-testid': 'lfx-result-folder' });
    const showButton = el('button', { class: 'small-button', type: 'button', hidden: true, 'data-testid': 'lfx-result-show', text: options.showLabel || '' });
    const resultBox = el('div', { class: 'result-box', hidden: true, 'data-testid': 'lfx-result-box' }, [resultFile, resultFolder, showButton]);
    const status = el('div', { class: 'status', role: 'status', 'aria-live': 'polite', 'data-testid': 'lfx-status' });
    const warnings = el('ul', { class: 'warnings', hidden: true, 'data-testid': 'lfx-warnings' });
    const riskFooterLink = el('a', { href: options.infoUrl, target: '_blank', rel: 'noopener noreferrer', hidden: true, text: t('riskLink') });

    const panel = el('section', { class: 'panel', hidden: true, role: 'dialog', 'aria-label': t('panelTitle'), 'data-testid': 'lfx-panel' }, [
      el('header', {}, [el('div', { class: 'title' }, [logoBadge(options.logoUrl), el('h2', { text: t('panelTitle') })]), closeButton]),
      updateBar,
      riskBox,
      el('h3', { text: t('accounts') }),
      el('div', { class: 'tiles' }, [brokerTile, depositTile]),
      el('h3', { text: t('period') }),
      el('div', { class: 'chips' }, [...presets, sinceLastChip]),
      el('p', { class: 'hint', text: t('rangeHint') }),
      el('div', { class: 'grid' }, [
        el('label', { for: 'lfx-from', text: t('fromDate') }),
        fromInput,
        el('label', { for: 'lfx-to', text: t('toDate') }),
        toInput,
      ]),
      lastExportLine,
      el('label', { class: 'row' }, [detailsBox, el('span', { text: t('includeDetails') })]),
      ...saveSection,
      el('div', { class: 'actions' }, [cancelButton, exportButton]),
      progress,
      progressLabel,
      status,
      resultBox,
      warnings,
      el('footer', {}, [el('div', {}, [t('notAffiliated'), ' ', riskFooterLink])]),
    ]);

    shadow.appendChild(fab);
    shadow.appendChild(panel);

    function refreshExportButton() {
      exportButton.disabled = state.busy || state.unavailable || !state.riskAccepted;
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
    exportButton.addEventListener('click', () => options.onExport(formValues()));
    for (const input of [detailsBox, fromInput, toInput]) input.addEventListener('change', formChanged);
    cancelButton.addEventListener('click', () => options.onCancel());
    updateButton.addEventListener('click', () => options.onCheckUpdates());
    showButton.addEventListener('click', () => options.onShowFile());
    prefixInput.addEventListener('input', refreshSaveSection);
    prefixInput.addEventListener('change', storeSaveSettings);

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
      // The extension was reloaded or updated while the page was open: the panel only says so.
      setUnavailable(text) {
        state.unavailable = true;
        riskBox.hidden = true;
        updateButton.disabled = true;
        api.setStatus(text, 'error');
        refreshExportButton();
      },
      // info: { status: 'checking' | 'current' | 'available' | 'failed', latest, url }
      setUpdate(info) {
        let status = (info && info.status) || 'failed';
        const validLink = info && typeof info.url === 'string' && info.url.startsWith('https://github.com/Librefolio/librefolio-exporter/');
        if (status === 'available' && !(validLink && info.latest)) status = 'failed';
        updateBar.setAttribute('data-state', status);
        updateBar.className = status === 'available' ? 'versionbar available' : 'versionbar';
        updateButton.disabled = status === 'checking' || state.unavailable;
        updateLink.hidden = status !== 'available';
        if (status === 'available') {
          updateLink.href = info.url;
          updateText.textContent = t('updateAvailable', info.latest);
        } else if (status === 'checking') {
          updateText.textContent = t('updateChecking');
        } else if (status === 'current') {
          updateText.textContent = t('updateCurrent', options.version);
        } else {
          updateText.textContent = t('updateFailed', options.version);
        }
      },
      // dates: { broker, deposit }: YYYY-MM-DD of each account's last complete export.
      setLastExport(dates) {
        state.lastExports = Object.assign({}, dates || {});
        const broker = state.lastExports.broker || '';
        const deposit = state.lastExports.deposit || '';
        let text = '';
        if (broker && broker === deposit) text = t('lastExport', broker);
        else if (broker || deposit) {
          text = t('lastExport', `${t('accountBroker')} ${broker || t('lastExportNever')} · ${t('accountDeposit')} ${deposit || t('lastExportNever')}`);
        }
        lastExportLine.textContent = text;
        lastExportLine.hidden = !text;
        refreshSinceLast();
      },
      // "To" is never left empty: it means today.
      fillEmptyTo(date) {
        if (!state.busy && !toInput.value) toInput.value = date;
      },
      setDefaults(values) {
        fromInput.value = values.from || '';
        toInput.value = values.to || '';
        if (typeof values.broker === 'boolean') setPressed(brokerTile, values.broker);
        if (typeof values.deposit === 'boolean') setPressed(depositTile, values.deposit);
        if (typeof values.details === 'boolean') detailsBox.checked = values.details;
        refreshSinceLast();
        refreshSaveSection();
      },
      setSaveSettings(values) {
        prefixInput.value = values.filePrefix || '';
        refreshSaveSection();
      },
      setBusy(busy) {
        state.busy = Boolean(busy);
        cancelButton.hidden = !state.busy;
        for (const control of [brokerTile, depositTile, fromInput, toInput, detailsBox, prefixInput, ...presets, sinceLastChip]) {
          control.disabled = state.busy;
        }
        progressLabel.hidden = !state.busy;
        if (state.busy) {
          const chosen = formValues();
          for (const entry of Object.values(progressRows)) {
            entry.row.hidden = !chosen[entry.account];
            showAccountProgress(entry, null, '');
          }
          progressLabel.textContent = '';
          progress.hidden = false;
        } else {
          // The rows stay with the outcome of each account, unless the export stopped first.
          const shown = Object.values(progressRows).filter((entry) => !entry.row.hidden);
          progress.hidden = shown.length === 0 || shown.some((entry) => !entry.kind);
        }
        refreshExportButton();
      },
      // fraction: from 0 to 1, or null while the amount of work is not known; text: the step;
      // kind: 'done' or 'error' when the account is over.
      setAccountProgress(account, fraction, text, kind) {
        if (progressRows[account]) showAccountProgress(progressRows[account], fraction, text, kind);
      },
      // What happens after the accounts are read, such as Chrome's "Save as" window.
      setProgressLabel(text) {
        progressLabel.textContent = text || '';
      },
      setStatus(text, kind) {
        status.textContent = text || '';
        status.className = kind ? `status ${kind}` : 'status';
      },
      // file: { name, archive, folder, canShow }, the saved file: a ZIP when archive is true;
      // folder: the text of its folder; canShow: it can be shown there. null clears it.
      setResult(file) {
        resultBox.hidden = !file;
        resultFile.textContent = file ? `${file.archive ? '📦' : '📄'} ${file.name}` : '';
        resultFolder.textContent = file && file.folder ? `📁 ${file.folder}` : '';
        resultFolder.hidden = !resultFolder.textContent;
        showButton.hidden = !(file && file.canShow);
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
