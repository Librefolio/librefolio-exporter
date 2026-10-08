// Drives a real export in the browser started by run.sh: usage `node e2e.mjs <cdpPort> <httpsPort> <workDir>`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';

const [cdpPort, httpsPort, workDir] = process.argv.slice(2);
const DOWNLOADS = path.join(workDir, 'downloads');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cdp = await connect(Number(cdpPort));
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true });
const { targetId } = await cdp.send('Target.createTarget', {
  url: `https://de.scalable.capital:${httpsPort}/broker/transactions?portfolioId=pf-123456`,
});
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('DOM.enable', {}, sessionId);

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

const click = 'function () { this.click(); return true; }';
const visible = 'function () { return !this.hidden; }';

await waitFor('button injected', async () => (await testIds()).some((item) => item.testId === 'lfx-open'));
await on('lfx-open', click);
await waitFor('panel open', () => on('lfx-panel', visible));
await waitFor('settings loaded', () => on('lfx-risk', visible));
assert.equal(await on('lfx-export', 'function () { return this.disabled; }'), true, 'no export before the notice is accepted');
assert.equal(await on('lfx-panel', 'function () { return this.querySelector("h2").textContent; }'), 'Esporta per LibreFolio');

await on('lfx-risk-accept', click);
await waitFor('export enabled', () => on('lfx-export', 'function () { return !this.disabled; }'));
assert.equal(await on('lfx-risk', visible), false);

await on('lfx-export', click);
const status = await waitFor(
  'export finished',
  async () => {
    const value = await on('lfx-status', 'function () { return { className: this.className, text: this.textContent }; }');
    return /success|error/.test(value.className) ? value : null;
  },
  30000,
);
assert.deepEqual(status, { className: 'status success', text: 'Fatto: 2 transazioni del broker, 1 del conto deposito.' });

const csvFiles = () => fs.readdirSync(DOWNLOADS).filter((name) => name.endsWith('.csv')).sort();
await waitFor('two downloads', () => csvFiles().length === 2, 10000);
const [brokerFile, depositFile] = csvFiles();
assert.match(brokerFile, /^scalable-broker_.*\.csv$/);
assert.match(depositFile, /^scalable-deposit_.*\.csv$/);
const broker = fs.readFileSync(path.join(DOWNLOADS, brokerFile), 'utf8').split('\n');
assert.ok(broker[1].startsWith('2026-09-01;10:00:00;Executed;"R1";"Some ETF";Security;Savings plan;IE00TEST0001;2,5;100;-250;0,99;0;EUR;broker;1;t1;'));
assert.ok(broker[2].includes(';"Deposit; ""SEPA""";Cash;Deposit;'));
const deposit = fs.readFileSync(path.join(DOWNLOADS, depositFile), 'utf8').split('\n');
assert.ok(deposit[1].startsWith('2026-10-01;01:00:00;Executed;"d1";"Interest";Cash;Interest;;;;1,23;;;EUR;deposit;1;d1;'));

const requests = fs.readFileSync(path.join(workDir, 'requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
assert.deepEqual(
  requests.map((request) => request.operation),
  ['moreTransactions', 'getTransactionDetails', 'getSavingsProducts', 'OvernightTransactions'],
);
for (const request of requests) {
  assert.equal(request.cookie, true, 'the browser attaches the session cookie by itself');
  assert.equal(request.origin, `https://de.scalable.capital:${httpsPort}`, 'same-origin requests only');
}

cdp.close();
console.log(`✓ real-browser export: ${brokerFile}, ${depositFile}, ${requests.length} requests`);
