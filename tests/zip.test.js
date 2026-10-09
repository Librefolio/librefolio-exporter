'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const zip = require('../src/shared/zip.js');
const { unzip } = require('./unzip.js');

test('the ZIP holds the files, deflated, with their CRC, UTF-8 names and date', async () => {
  const broker = `date;description\n${'2026-10-08;Zinsen für Tagesgeld €\n'.repeat(50)}`;
  const bytes = await zip.create(
    [
      { name: 'scalable-broker_2026-10-08_16-54-21.csv', content: broker },
      { name: 'conto-ü.csv', content: 'a;b\n' },
    ],
    new Date(2026, 9, 8, 16, 54, 21),
  );
  const entries = unzip(bytes);
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.text, entry.method, entry.flags]),
    [
      ['scalable-broker_2026-10-08_16-54-21.csv', broker, 8, 0x0800],
      ['conto-ü.csv', 'a;b\n', 0, 0x0800],
    ],
    'a file that deflate does not shrink is stored',
  );
  assert.equal(entries[0].date, ((2026 - 1980) << 9) | (10 << 5) | 8);
  assert.equal(entries[0].time, (16 << 11) | (54 << 5) | 10);
  assert.ok(bytes.length < broker.length / 4, `compressed: ${bytes.length} bytes`);
});

test('the CRC-32 is the standard one', () => {
  assert.equal(zip.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(zip.crc32(new Uint8Array(0)), 0);
});

test('without CompressionStream the files are stored', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'CompressionStream');
  Object.defineProperty(globalThis, 'CompressionStream', { value: undefined, configurable: true, writable: true });
  try {
    const bytes = await zip.create([{ name: 'a.csv', content: 'x;y\n'.repeat(100) }]);
    assert.deepEqual(
      unzip(bytes).map((entry) => [entry.name, entry.method, entry.text.length]),
      [['a.csv', 0, 400]],
    );
  } finally {
    Object.defineProperty(globalThis, 'CompressionStream', descriptor);
  }
});

test('the system unzip accepts the ZIP, where installed', async (t) => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch (error) {
    t.skip('no unzip command');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lfx-zip-'));
  try {
    const file = path.join(directory, 'export.zip');
    fs.writeFileSync(file, await zip.create([{ name: 'a.csv', content: 'x;y\n'.repeat(100) }, { name: 'b.csv', content: 'é\n' }]));
    assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
    assert.equal(execFileSync('unzip', ['-p', file, 'b.csv'], { encoding: 'utf8' }), 'é\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
