'use strict';

// Reads a ZIP for the tests: the central directory, then each entry, inflated and checked
// against its size and CRC. Not a test file: node --test runs only *.test.js.
const zlib = require('node:zlib');

const SIGNATURES = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50 };

function unzip(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || buffer.readUInt32LE(end) !== SIGNATURES.end) throw new Error('no end of central directory');
  const count = buffer.readUInt16LE(end + 10);
  let position = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(position) !== SIGNATURES.central) throw new Error('bad central directory');
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const time = buffer.readUInt16LE(position + 12);
    const date = buffer.readUInt16LE(position + 14);
    const crc = buffer.readUInt32LE(position + 16);
    const size = buffer.readUInt32LE(position + 20);
    const length = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const offset = buffer.readUInt32LE(position + 42);
    const name = buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    if (buffer.readUInt32LE(offset) !== SIGNATURES.local) throw new Error(`bad local header for ${name}`);
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const raw = buffer.subarray(start, start + size);
    let data;
    if (method === 8) data = zlib.inflateRawSync(raw);
    else if (method === 0) data = raw;
    else throw new Error(`unknown method ${method}`);
    if (data.length !== length) throw new Error(`bad size for ${name}`);
    if (typeof zlib.crc32 === 'function' && zlib.crc32(data) >>> 0 !== crc) throw new Error(`bad CRC for ${name}`);
    entries.push({ name, flags, method, time, date, text: data.toString('utf8') });
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

module.exports = { unzip };
