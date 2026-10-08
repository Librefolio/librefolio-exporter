/*
 * CSV writer: ';' delimiter, LF line endings, UTF-8 without BOM, like the
 * official Scalable export.
 */
(function (root) {
  'use strict';

  const DELIMITER = ';';
  const NEEDS_QUOTES = /[";\r\n]/;

  function field(value, alwaysQuote) {
    const text = value === null || value === undefined ? '' : String(value);
    if (alwaysQuote || NEEDS_QUOTES.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  // columns: [{ name, quote }]; rows: objects keyed by column name.
  function build(columns, rows) {
    const lines = [columns.map((column) => column.name).join(DELIMITER)];
    for (const row of rows) {
      lines.push(columns.map((column) => field(row[column.name], column.quote)).join(DELIMITER));
    }
    return lines.join('\n') + '\n';
  }

  const api = { DELIMITER, field, build };

  root.LFX = root.LFX || {};
  root.LFX.csv = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
