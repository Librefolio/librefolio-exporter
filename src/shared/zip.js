/*
 * A small ZIP writer, to save both accounts as one file: entries deflated with the
 * browser's CompressionStream (stored when that does not help), CRC-32, UTF-8 names.
 * No ZIP64: an export is far below 4 GB.
 */
(function (root) {
  'use strict';

  const UTF8_NAMES = 0x0800;
  const DEFLATE = 8;
  const STORE = 0;

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // Raw deflate; null where the browser cannot compress, and the entry is stored.
  async function deflateRaw(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      return null;
    }
  }

  // MS-DOS date and time, in local time, as ZIP files keep them.
  function dosDateTime(when) {
    const year = Math.min(Math.max(when.getFullYear(), 1980), 2107);
    return {
      time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    };
  }

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  // entries: [{ name, content }], content a string (written as UTF-8) or bytes.
  async function create(entries, when) {
    const encoder = new TextEncoder();
    const stamp = dosDateTime(when || new Date());
    const parts = [];
    const directory = [];
    let offset = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const data = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content;
      const crc = crc32(data);
      const deflated = await deflateRaw(data);
      const method = deflated && deflated.length < data.length ? DEFLATE : STORE;
      const body = method === DEFLATE ? deflated : data;

      const local = new Uint8Array(30 + name.length);
      const head = new DataView(local.buffer);
      head.setUint32(0, 0x04034b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, UTF8_NAMES, true);
      head.setUint16(8, method, true);
      head.setUint16(10, stamp.time, true);
      head.setUint16(12, stamp.date, true);
      head.setUint32(14, crc, true);
      head.setUint32(18, body.length, true);
      head.setUint32(22, data.length, true);
      head.setUint16(26, name.length, true);
      local.set(name, 30);

      const central = new Uint8Array(46 + name.length);
      const record = new DataView(central.buffer);
      record.setUint32(0, 0x02014b50, true);
      record.setUint16(4, 20, true);
      record.setUint16(6, 20, true);
      record.setUint16(8, UTF8_NAMES, true);
      record.setUint16(10, method, true);
      record.setUint16(12, stamp.time, true);
      record.setUint16(14, stamp.date, true);
      record.setUint32(16, crc, true);
      record.setUint32(20, body.length, true);
      record.setUint32(24, data.length, true);
      record.setUint16(28, name.length, true);
      record.setUint32(42, offset, true);
      central.set(name, 46);

      parts.push(local, body);
      directory.push(central);
      offset += local.length + body.length;
    }
    const size = directory.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const tail = new DataView(end.buffer);
    tail.setUint32(0, 0x06054b50, true);
    tail.setUint16(8, entries.length, true);
    tail.setUint16(10, entries.length, true);
    tail.setUint32(12, size, true);
    tail.setUint32(16, offset, true);
    return concat([...parts, ...directory, end]);
  }

  const api = { create, crc32 };

  root.LFX = root.LFX || {};
  root.LFX.zip = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
