// Drives a real export in the browser started by run.sh: usage `node e2e.mjs <cdpPort> <httpsPort> <workDir>`.
// With SHOTS_DIR set, it also saves screenshots of the button and the panel there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';

const [cdpPort, httpsPort, workDir] = process.argv.slice(2);
const DOWNLOADS = path.join(workDir, 'downloads');
// Chrome's "Save as" window cannot open in a headless browser: the test turns it off
// (saveDialog), so the files land in the profile's download directory, with their names.
const SAVED = DOWNLOADS;
const INTEREST_PATH = '/interest/api/graphql/';
const TRANSACTIONS_PAGE = '/interest/overnight/sav-123456/transactions/';
const SECRETS = ['person-123456', 'pf-123456', 'sav-123456', 'short-123456', 'Some ETF', 'SEPA', 'IE00TEST0001', '-250', 'R1', 'RI-1'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SHOTS_DIR = process.env.SHOTS_DIR || '';
const TODAY_BERLIN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const cdp = await connect(Number(cdpPort));
const downloadEvents = [];
cdp.on('Browser.downloadWillBegin', (params) => downloadEvents.push({ begin: params.suggestedFilename, url: params.url.slice(0, 30) }));
cdp.on('Browser.downloadProgress', (params) => {
  if (params.state !== 'inProgress') downloadEvents.push({ state: params.state, guid: params.guid });
});
// 'default' keeps Chromium's own download handling, which honours the file name chosen
// by the extension; 'allow' would hand downloads to DevTools, which ignores it. The
// directory comes from the profile preferences written by run.sh.
await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });

function listTree(directory, prefix = '') {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? [`${prefix}${entry.name}/`, ...listTree(path.join(directory, entry.name), `${prefix}${entry.name}/`)] : [`${prefix}${entry.name}`],
  );
}
const { targetId } = await cdp.send('Target.createTarget', {
  url: `https://de.scalable.capital:${httpsPort}/broker/transactions?portfolioId=pf-123456`,
});
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('DOM.enable', {}, sessionId);

// The extension's console lines: [prefix, event, JSON text].
const consoleLines = [];
cdp.on('Runtime.consoleAPICalled', (params) => {
  const values = params.args.map((arg) => (arg.value !== undefined ? arg.value : arg.description));
  if (values[0] === '[LibreFolio Exporter]') consoleLines.push(values);
});
const exceptions = [];
cdp.on('Runtime.exceptionThrown', (params) => exceptions.push(params.exceptionDetails.exception ? params.exceptionDetails.exception.description : params.exceptionDetails.text));
// The worlds of the page, among them the one where the extension's content scripts run.
const contexts = [];
cdp.on('Runtime.executionContextCreated', (params, eventSession) => {
  if (eventSession === sessionId) contexts.push(params.context);
});
await cdp.send('Runtime.enable', {}, sessionId);

function collect(node, found) {
  const attributes = node.attributes || [];
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === 'data-testid') found.push({ testId: attributes[index + 1], backendNodeId: node.backendNodeId });
  }
  for (const child of node.children || []) collect(child, found);
  for (const shadow of node.shadowRoots || []) collect(shadow, found);
  return found;
}

// pierce: true also walks the extension's closed shadow root.
async function testIds() {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
  return collect(root, []);
}

async function on(testId, functionDeclaration) {
  const node = (await testIds()).find((item) => item.testId === testId);
  if (!node) throw new Error(`no node ${testId}`);
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId }, sessionId);
  const result = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function waitFor(label, predicate, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      // not ready yet
    }
    await sleep(250);
  }
  throw new Error(`timeout: ${label}`);
}

async function box(testId) {
  const node = (await testIds()).find((item) => item.testId === testId);
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }, sessionId);
  const [x1, y1, , , x3, y3] = model.border;
  return { x: x1, y: y1, width: x3 - x1, height: y3 - y1 };
}

async function shot(name, clip) {
  if (!SHOTS_DIR) return;
  const margin = 12;
  const params = { format: 'png', captureBeyondViewport: false };
  if (clip) params.clip = { x: clip.x - margin, y: clip.y - margin, width: clip.width + 2 * margin, height: clip.height + 2 * margin, scale: 2 };
  const { data } = await cdp.send('Page.captureScreenshot', params, sessionId);
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOTS_DIR, `${name}.png`), Buffer.from(data, 'base64'));
}

const click = 'function () { this.click(); return true; }';
const visible = 'function () { return !this.hidden; }';

// The extension's service worker: its storage holds the setting that only tests change.
const worker = await waitFor('extension service worker', async () => {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.find((target) => target.type === 'service_worker' && /^chrome-extension:\/\/[a-z]+\/src\/background\.js$/.test(target.url));
});
const { sessionId: workerSession } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
const setting = await cdp.send(
  'Runtime.evaluate',
  { expression: 'chrome.storage.local.set({ saveDialog: false }).then(() => true)', awaitPromise: true, returnByValue: true },
  workerSession,
);
assert.equal(setting.result && setting.result.value, true, `the "Save as" window is turned off for the test: ${JSON.stringify(setting).slice(0, 400)}`);

await waitFor('button injected', async () => (await testIds()).some((item) => item.testId === 'lfx-open'));
const collapsed = await box('lfx-open');
assert.ok(collapsed.width < 60, `the button starts folded (${collapsed.width}px)`);
await sleep(300);
await shot('fab-folded', collapsed);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: collapsed.x + collapsed.width / 2, y: collapsed.y + collapsed.height / 2 }, sessionId);
await sleep(400);
const expanded = await box('lfx-open');
assert.ok(expanded.width > collapsed.width + 60, `the button unfolds on hover (${expanded.width}px)`);
await shot('fab-hover', expanded);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }, sessionId);
await on('lfx-open', click);
await waitFor('panel open', () => on('lfx-panel', visible));
await waitFor('settings loaded', () => on('lfx-risk', visible));
await waitFor('"to" filled', async () => (await on('lfx-to', 'function () { return this.value; }')) === TODAY_BERLIN, 5000);
await waitFor('update check done', async () => (await on('lfx-update', 'function () { return this.dataset.state; }')) !== 'checking', 15000);
await shot('panel');
assert.equal(await on('lfx-export', 'function () { return this.disabled; }'), true, 'no export before the notice is accepted');
assert.equal(await on('lfx-panel', 'function () { return this.querySelector("h2").textContent; }'), 'Esporta per LibreFolio');

await on('lfx-risk-accept', click);
await waitFor('export enabled', () => on('lfx-export', 'function () { return !this.disabled; }'));
assert.equal(await on('lfx-risk', visible), false);

await on('lfx-export', click);
const outcome = await waitFor(
  'export finished',
  async () => {
    const error = await on('lfx-status', 'function () { return /error/.test(this.className) ? this.textContent : ""; }');
    if (error) return { error };
    const items = await on('lfx-result', 'function () { return this.hidden ? null : Array.from(this.children, (item) => item.textContent); }');
    return items ? { items } : null;
  },
  30000,
);
assert.equal(outcome.error, undefined, outcome.error);
assert.equal(outcome.items.length, 2);
assert.match(outcome.items[0], /^✅ scalable-broker_\S+\.csv — 2 transazioni del conto broker$/);
assert.match(outcome.items[1], /^✅ scalable-deposit_\S+\.csv — 2 movimenti del conto deposito$/);
assert.equal(await on('lfx-result-folder', 'function () { return this.textContent; }'), '📁 Cartella: Download');
await shot('result');
await shot('panel-result', await box('lfx-panel'));

// Only complete files: Chromium writes into .crdownload first.
const csvFiles = () => (fs.existsSync(SAVED) ? fs.readdirSync(SAVED).filter((name) => name.endsWith('.csv')).sort() : []);
try {
  await waitFor('two downloads', () => csvFiles().length === 2, 15000);
} catch (error) {
  console.error('download events:', JSON.stringify(downloadEvents));
  console.error('downloads tree:', JSON.stringify(listTree(DOWNLOADS)));
  throw error;
}
const [brokerFile, depositFile] = csvFiles();
assert.match(brokerFile, /^scalable-broker_.*\.csv$/);
assert.match(depositFile, /^scalable-deposit_.*\.csv$/);
const broker = fs.readFileSync(path.join(SAVED, brokerFile), 'utf8').split('\n');
assert.ok(broker[1].startsWith('2026-09-01;10:00:00;Executed;"R1";"Some ETF";Security;Savings plan;IE00TEST0001;2,5;100;-250;0,99;0;EUR;broker;1;t1;'));
assert.ok(broker[2].includes(';"Deposit; ""SEPA""";Cash;Deposit;'));
const deposit = fs.readFileSync(path.join(SAVED, depositFile), 'utf8').split('\n');
assert.ok(deposit[1].startsWith('2026-10-01;01:00:00;Executed;"RI-1";"Interest";Cash;Interest;;;;1,23;;0,44;EUR;deposit;1;d1;'), deposit[1]);
assert.ok(deposit[1].includes(';0.44;1.67;'), 'tax and gross amount of the interest');
assert.ok(deposit[2].startsWith('2026-09-29;12:00:00;Executed;"d2";"Withdrawal";Cash;Withdrawal;;;;-2,5;;;EUR;deposit;1;d2;'), deposit[2]);

const requests = fs
  .readFileSync(path.join(workDir, 'requests.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert.deepEqual(
  requests.map((request) => `${request.operation} ${request.path}`),
  [
    'moreTransactions /broker/api/data',
    'getTransactionDetails /broker/api/data',
    `GET ${TRANSACTIONS_PAGE}`,
    `Transactions ${INTEREST_PATH}`,
    `OvernightTransactionDetails ${INTEREST_PATH}`,
  ],
  'the overnight account comes from the link in the page; its list, with the recipe of its Transactions page',
);
for (const request of requests) {
  assert.equal(request.cookie, true, 'the browser attaches the session cookie by itself');
  assert.equal(request.fetchSite, 'same-origin', 'same-origin requests only');
  if (request.operation !== 'GET') assert.equal(request.origin, `https://de.scalable.capital:${httpsPort}`);
  assert.equal(Boolean(request.features), request.path === '/broker/api/data', 'the feature header goes to the broker only');
}

const events = () => consoleLines.map((values) => [values[1], values[2] === undefined ? undefined : JSON.parse(values[2])]);
const identifiers = events().find(([event]) => event === 'identifiers');
assert.deepEqual(identifiers[1], { person: 'sessionStorage', portfolio: 'url', overnight: 'page', overnightAccounts: 1, overnightRecipes: [] });
assert.deepEqual(events().find(([event]) => event === 'overnight-recipe')[1], { source: 'download', operation: 'Transactions' });

// Second export, with Chrome's folder picker. Headless, its window cannot open: in the
// world of the content scripts, the picker gives a folder of the page's private file system
// (OPFS), where the extension writes through Chrome's own File System Access code.
const extensionOrigin = worker.url.replace(/\/src\/background\.js$/, '');
const world = contexts.find((context) => context.origin === extensionOrigin && context.auxData && context.auxData.type === 'isolated');
assert.ok(world, `the content scripts' world: ${JSON.stringify(contexts.map((context) => [context.origin, context.auxData]))}`);
async function inExtensionWorld(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, contextId: world.id, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
  return result.result.value;
}
assert.equal(await inExtensionWorld('typeof showDirectoryPicker'), 'function', 'Chrome gives content scripts the folder picker');
await inExtensionWorld(`(() => {
  globalThis.lfxPicks = [];
  globalThis.showDirectoryPicker = async (options) => {
    globalThis.lfxPicks.push(options);
    const storage = await navigator.storage.getDirectory();
    return storage.getDirectoryHandle('LibreFolio', { create: true });
  };
  return true;
})()`);
const dialogOn = await cdp.send(
  'Runtime.evaluate',
  { expression: 'chrome.storage.local.set({ saveDialog: true }).then(() => true)', awaitPromise: true, returnByValue: true },
  workerSession,
);
assert.equal(dialogOn.result && dialogOn.result.value, true);
await on('lfx-export', click);
const folderLine = await waitFor(
  'export into the folder',
  async () => {
    const error = await on('lfx-status', 'function () { return /error/.test(this.className) ? this.textContent : ""; }');
    if (error) return { error };
    const line = await on('lfx-result-folder', 'function () { return this.hidden ? "" : this.textContent; }');
    return line === '📁 Cartella: LibreFolio' ? { line } : null;
  },
  30000,
);
assert.equal(folderLine.error, undefined, folderLine.error);
const written = await inExtensionWorld(`(async () => {
  const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('LibreFolio');
  const files = {};
  for await (const [name, handle] of folder.entries()) files[name] = await (await handle.getFile()).text();
  return { picks: globalThis.lfxPicks, files };
})()`);
assert.deepEqual(written.picks, [{ id: 'librefolio-exporter', mode: 'readwrite', startIn: 'downloads' }]);
const folderNames = Object.keys(written.files).sort();
assert.equal(folderNames.length, 2, JSON.stringify(folderNames));
assert.match(folderNames[0], /^scalable-broker_\S+\.csv$/);
assert.match(folderNames[1], /^scalable-deposit_\S+\.csv$/);
assert.equal(written.files[folderNames[0]].split('\n')[1], broker[1], 'the same broker file as through the downloads');
assert.equal(written.files[folderNames[1]].split('\n')[1], deposit[1], 'the same overnight file as through the downloads');
assert.deepEqual(csvFiles(), [brokerFile, depositFile], 'nothing more in the download folder');
assert.deepEqual(events().filter(([event]) => event === 'folder-picker' || event === 'folder-write'), [
  ['folder-picker', { permission: 'granted' }],
  ['folder-write', { files: 2 }],
]);

const consoleText = JSON.stringify(consoleLines);
for (const secret of SECRETS) assert.ok(!consoleText.includes(secret), `the console must not show ${secret}`);

assert.deepEqual(exceptions, [], 'no uncaught exception in the page');

cdp.close();
console.log(`✓ real-browser export: ${brokerFile}, ${depositFile}, ${requests.length} requests; then ${folderNames.length} files in the chosen folder`);
