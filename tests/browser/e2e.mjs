// Drives a real export in the browser started by run.sh: usage `node e2e.mjs <cdpPort> <httpsPort> <workDir>`.
// With SHOTS_DIR set, it also saves screenshots of the button and the panel there.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { connect } from './cdp.mjs';

const { unzip } = createRequire(import.meta.url)('../unzip.js');

const [cdpPort, httpsPort, workDir] = process.argv.slice(2);
const DOWNLOADS = path.join(workDir, 'downloads');
// Chrome's "Save as" window cannot open in a headless browser: the test turns it off
// (saveDialog), so the export lands in the profile's download directory, with its name.
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
// While reading: one row per account, both moving from the start.
await waitFor(
  'both accounts in progress',
  async () => (await on('lfx-progress-broker-step', 'function () { return this.textContent; }')) && (await on('lfx-progress-deposit-step', 'function () { return this.textContent; }')),
  10000,
);
await shot('panel-progress', await box('lfx-panel'));
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
assert.match(await on('lfx-result-archive', 'function () { return this.textContent; }'), /^📦 scalable_\S+\.zip, con:$/);
assert.equal(await on('lfx-result-folder', 'function () { return this.textContent; }'), '📁 Cartella: Download');
assert.equal(await on('lfx-result-show', visible), true, 'the button that shows the file in its folder');
assert.equal(await on('lfx-result-show', 'function () { return this.textContent; }'), 'Mostra cartella');
assert.equal(await on('lfx-progress-broker-step', 'function () { return this.textContent; }'), '✓ 2 transazioni');
assert.equal(await on('lfx-progress-deposit-step', 'function () { return this.textContent; }'), '✓ 2 movimenti');
await shot('result');
await shot('panel-result', await box('lfx-panel'));
// After a few seconds the list folds to one line; the folder button stays.
await waitFor('result folded', async () => (await on('lfx-result-details', 'function () { return this.open; }')) === false, 15000);
assert.match(await on('lfx-result-summary', 'function () { return this.textContent; }'), /^✅ scalable_\S+\.zip salvato$/);
assert.equal(await on('lfx-result-summary', 'function () { return getComputedStyle(this).display !== "none"; }'), true);
assert.equal(await on('lfx-result-show', visible), true, 'the folder button stays');
await shot('panel-folded', await box('lfx-panel'));

// Only complete files: Chromium writes into .crdownload first.
const savedFiles = () => (fs.existsSync(SAVED) ? fs.readdirSync(SAVED).filter((name) => /\.(zip|csv)$/.test(name)).sort() : []);
try {
  await waitFor('one download', () => savedFiles().length === 1, 15000);
} catch (error) {
  console.error('download events:', JSON.stringify(downloadEvents));
  console.error('downloads tree:', JSON.stringify(listTree(DOWNLOADS)));
  throw error;
}
const [zipFile] = savedFiles();
assert.match(zipFile, /^scalable_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/, 'both accounts in one ZIP');
const zipPath = path.join(SAVED, zipFile);
try {
  assert.match(execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' }), /No errors detected/);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const entries = unzip(fs.readFileSync(zipPath));
const stamp = zipFile.slice('scalable_'.length, -'.zip'.length);
assert.deepEqual(
  entries.map((entry) => entry.name),
  [`scalable-broker_${stamp}.csv`, `scalable-deposit_${stamp}.csv`],
);
const broker = entries[0].text.split('\n');
assert.ok(broker[1].startsWith('2026-09-01;10:00:00;Executed;"R1";"Some ETF";Security;Savings plan;IE00TEST0001;2,5;100;-250;0,99;0;EUR;broker;1;t1;'));
assert.ok(broker[2].includes(';"Deposit; ""SEPA""";Cash;Deposit;'));
const deposit = entries[1].text.split('\n');
assert.ok(deposit[1].startsWith('2026-10-01;01:00:00;Executed;"RI-1";"Interest";Cash;Interest;;;;1,23;;0,44;EUR;deposit;1;d1;'), deposit[1]);
assert.ok(deposit[1].includes(';0.44;1.67;'), 'tax and gross amount of the interest');
assert.ok(deposit[2].startsWith('2026-09-29;12:00:00;Executed;"d2";"Withdrawal";Cash;Withdrawal;;;;-2,5;;;EUR;deposit;1;d2;'), deposit[2]);

const requests = fs
  .readFileSync(path.join(workDir, 'requests.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const names = requests.map((request) => `${request.operation} ${request.path}`);
assert.deepEqual(
  names.filter((name) => name.includes('/broker/')),
  ['moreTransactions /broker/api/data', 'getTransactionDetails /broker/api/data'],
);
assert.deepEqual(
  names.filter((name) => !name.includes('/broker/')),
  [`GET ${TRANSACTIONS_PAGE}`, `Transactions ${INTEREST_PATH}`, `OvernightTransactionDetails ${INTEREST_PATH}`],
  'the overnight account comes from the link in the page; its list, with the recipe of its Transactions page',
);
assert.equal(names[1], `GET ${TRANSACTIONS_PAGE}`, 'the two accounts are read side by side');
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
assert.deepEqual(events().filter(([event]) => event === 'new-fields'), [], 'every field of the responses is known or excluded');

const consoleText = JSON.stringify(consoleLines);
for (const secret of SECRETS) assert.ok(!consoleText.includes(secret), `the console must not show ${secret}`);

assert.deepEqual(exceptions, [], 'no uncaught exception in the page');

cdp.close();
console.log(`✓ real-browser export: ${zipFile} (${entries.map((entry) => entry.name).join(', ')}), ${requests.length} requests`);
