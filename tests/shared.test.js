'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const format = require('../src/shared/format.js');
const version = require('../src/shared/version.js');
const csv = require('../src/shared/csv.js');
const files = require('../src/shared/files.js');

test('toPlainString keeps values verbatim', () => {
  assert.equal(format.toPlainString(-499.99278), '-499.99278');
  assert.equal(format.toPlainString(2500), '2500');
  assert.equal(format.toPlainString('12.500'), '12.500');
  assert.equal(format.toPlainString(' +3.5 '), '3.5');
  assert.equal(format.toPlainString(10n), '10');
});

test('toPlainString expands exponent notation without rounding', () => {
  assert.equal(format.toPlainString(1.23e-7), '0.000000123');
  assert.equal(format.toPlainString(-4.5e-7), '-0.00000045');
  assert.equal(format.toPlainString(1e21), '1000000000000000000000');
  assert.equal(format.toPlainString('2.5E3'), '2500');
});

test('toPlainString returns empty text for missing values and keeps non-numeric text', () => {
  for (const value of [null, undefined, '', '   ', Number.NaN, Infinity, {}]) {
    assert.equal(format.toPlainString(value), '');
  }
  assert.equal(format.toPlainString('n/a'), 'n/a');
});

test('toDecimalComma converts plain decimals only', () => {
  assert.equal(format.toDecimalComma('-499.99278'), '-499,99278');
  assert.equal(format.toDecimalComma('2500'), '2500');
  assert.equal(format.toDecimalComma(''), '');
  assert.equal(format.toDecimalComma('n/a'), 'n/a');
  assert.equal(format.toDecimalComma(undefined), '');
});

test('sumDecimals is exact', () => {
  assert.equal(format.sumDecimals([0.1, 0.2]), '0.3');
  assert.equal(format.sumDecimals(['0.99', 0, null]), '0.99');
  assert.equal(format.sumDecimals(['-1.5', '0.25']), '-1.25');
  assert.equal(format.sumDecimals([-0.5, 0.25]), '-0.25');
  assert.equal(format.sumDecimals([null, undefined, '']), '');
  assert.equal(format.sumDecimals(['1', 'x']), '');
});

test('berlinDateTime follows German summer and winter time', () => {
  assert.deepEqual(format.berlinDateTime('2025-01-15T10:00:00Z'), { date: '2025-01-15', time: '11:00:00' });
  assert.deepEqual(format.berlinDateTime('2025-07-01T22:30:00.000Z'), { date: '2025-07-02', time: '00:30:00' });
  assert.deepEqual(format.berlinDateTime('not a date'), { date: '', time: '' });
  assert.deepEqual(format.berlinDateTime(''), { date: '', time: '' });
});

test('fileTimestamp is safe in file names', () => {
  assert.equal(format.fileTimestamp(new Date(2026, 9, 8, 16, 5, 9)), '2026-10-08_16-05-09');
});

test('compareVersions orders releases and pre-releases', () => {
  assert.equal(version.compareVersions('0.10.0', '0.9.3'), 1);
  assert.equal(version.compareVersions('v1.0.0', '1.0'), 0);
  assert.equal(version.compareVersions('0.9.3-beta.1', '0.9.3'), -1);
  assert.equal(version.compareVersions('0.9.3', '0.9.3-beta.1'), 1);
  assert.equal(version.compareVersions('0.2.0-beta.1', '0.2.0-beta.2'), -1);
  assert.equal(version.compareVersions('garbage', '1.0.0'), 0);
  assert.equal(version.isNewer('0.2.0', '0.1.9'), true);
  assert.equal(version.isNewer('0.1.0', '0.1.0'), false);
  assert.equal(version.isNewer(null, '0.1.0'), false);
});

test('csv quotes only when needed, or always for quoted columns', () => {
  assert.equal(csv.field('plain', false), 'plain');
  assert.equal(csv.field('a;b', false), '"a;b"');
  assert.equal(csv.field('say "hi"', false), '"say ""hi"""');
  assert.equal(csv.field('line\nbreak', false), '"line\nbreak"');
  assert.equal(csv.field('', true), '""');
  assert.equal(csv.field(null, false), '');
});

test('csv build writes header, rows and a final LF', () => {
  const columns = [{ name: 'date' }, { name: 'description', quote: true }, { name: 'amount' }];
  const text = csv.build(columns, [{ date: '2025-01-01', description: 'ETF', amount: '-1,5' }]);
  assert.equal(text, 'date;description;amount\n2025-01-01;"ETF";-1,5\n');
});

test('shiftMonths moves by calendar months and clamps the day', () => {
  assert.equal(format.shiftMonths('2026-10-08', -1), '2026-09-08');
  assert.equal(format.shiftMonths('2026-10-08', -12), '2025-10-08');
  assert.equal(format.shiftMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(format.shiftMonths('2024-03-31', -1), '2024-02-29');
  assert.equal(format.shiftMonths('2026-01-15', -3), '2025-10-15');
  assert.equal(format.shiftMonths('2026-12-31', 2), '2027-02-28');
  assert.equal(format.shiftMonths('not a date', -1), '');
});

test('file prefix and folder are cleaned for every operating system', () => {
  assert.equal(files.sanitizePrefix(''), 'scalable');
  assert.equal(files.sanitizePrefix('  my:export*?  '), 'myexport');
  assert.equal(files.sanitizePrefix('...hidden.'), 'hidden');
  assert.equal(files.sanitizeFolder('LibreFolio'), 'LibreFolio');
  assert.equal(files.sanitizeFolder('/a//b\\c/'), 'a/b/c');
  assert.equal(files.sanitizeFolder('../../etc'), 'etc', 'never outside the download directory');
  assert.equal(files.sanitizeFolder('1/2/3/4/5/6/7'), '1/2/3/4/5');
  assert.equal(files.sanitizeFolder(''), '');
  assert.equal(files.sanitizeFolder(undefined), '');
});

test('file names and download paths', () => {
  assert.deepEqual(files.fileNames('my', '2026-10-08_16-54-20'), {
    broker: 'my-broker_2026-10-08_16-54-20.csv',
    deposit: 'my-deposit_2026-10-08_16-54-20.csv',
    archive: 'my_2026-10-08_16-54-20.zip',
  });
  assert.equal(files.fileNames('', 'x').broker, 'scalable-broker_x.csv');
  assert.equal(files.downloadPath('LibreFolio', 'a.csv'), 'LibreFolio/a.csv');
  assert.equal(files.downloadPath('', 'a.csv'), 'a.csv');
  assert.equal(files.downloadPath('x', '../a?.csv'), 'x/a.csv');
});

test('data URLs carry the UTF-8 bytes of a CSV or the bytes of a ZIP, within a size limit', () => {
  const text = 'date;description\n2026-10-08;Zinsen für Tagesgeld €\n';
  const url = files.toDataUrl(text);
  assert.ok(url.startsWith('data:text/csv;charset=utf-8;base64,'));
  assert.equal(Buffer.from(url.split(',')[1], 'base64').toString('utf8'), text);
  assert.equal(files.isDownloadUrl(url), true);
  const zip = files.zipDataUrl(new Uint8Array([80, 75, 5, 6, 0, 255]));
  assert.ok(zip.startsWith('data:application/zip;base64,'));
  assert.deepEqual([...Buffer.from(zip.split(',')[1], 'base64')], [80, 75, 5, 6, 0, 255]);
  assert.equal(files.isDownloadUrl(zip), true);

  const prefix = 'data:text/csv;charset=utf-8;base64,';
  const longest = Math.floor((files.MAX_DATA_URL_LENGTH - prefix.length) / 4) * 4;
  assert.equal(files.isDownloadUrl(prefix + 'A'.repeat(longest)), true);
  assert.equal(files.isDownloadUrl(prefix + 'A'.repeat(longest + 4)), false, 'too long for Chrome');
  for (const other of ['data:text/html;base64,PGI+', 'https://example.com/a.csv', `${prefix}<b>`, 'javascript:alert(1)', null, 42]) {
    assert.equal(files.isDownloadUrl(other), false, String(other));
  }
});
