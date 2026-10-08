/*
 * Number and date helpers shared by every exporter.
 *
 * Amounts are copied verbatim: a value received from the broker becomes a plain
 * decimal string without rounding, and sums use exact decimal arithmetic.
 */
(function (root) {
  'use strict';

  const NUMERIC = /^([-+]?)(\d+)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/;
  const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;

  function stripLeadingZeros(digits) {
    return digits.replace(/^0+(?=\d)/, '');
  }

  // "1.23e-7" -> "0.000000123"; strings without an exponent are returned unchanged.
  function expandExponent(text) {
    const match = NUMERIC.exec(text);
    if (!match) return null;
    const sign = match[1] === '-' ? '-' : '';
    const integerPart = match[2];
    const fractionPart = match[3] || '';
    if (match[4] === undefined) {
      return sign + integerPart + (fractionPart ? '.' + fractionPart : '');
    }
    const exponent = parseInt(match[4], 10);
    let digits = integerPart + fractionPart;
    let point = integerPart.length + exponent;
    if (point <= 0) {
      digits = '0'.repeat(1 - point) + digits;
      point = 1;
    } else if (point > digits.length) {
      digits += '0'.repeat(point - digits.length);
    }
    const integer = stripLeadingZeros(digits.slice(0, point));
    const fraction = digits.slice(point).replace(/0+$/, '');
    return sign + integer + (fraction ? '.' + fraction : '');
  }

  // Plain decimal text for a value received from the broker, or '' when absent.
  // Non-numeric text is returned unchanged so that nothing is silently lost.
  function toPlainString(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return '';
      const text = String(value);
      return /e/i.test(text) ? expandExponent(text) : text;
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'string') {
      const text = value.trim();
      if (text === '') return '';
      const expanded = expandExponent(text);
      return expanded === null ? text : expanded;
    }
    return '';
  }

  function toDecimalComma(plain) {
    if (typeof plain !== 'string') return '';
    return PLAIN_DECIMAL.test(plain) ? plain.replace('.', ',') : plain;
  }

  function parseDecimal(plain) {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(plain);
    if (!match) return null;
    const fraction = match[3] || '';
    return { units: BigInt(match[1] + match[2] + fraction), scale: fraction.length };
  }

  function formatDecimal(units, scale) {
    const negative = units < 0n;
    let digits = (negative ? -units : units).toString();
    if (scale > 0) {
      digits = digits.padStart(scale + 1, '0');
      digits = digits.slice(0, digits.length - scale) + '.' + digits.slice(digits.length - scale);
    }
    return (negative ? '-' : '') + digits;
  }

  // Exact sum of decimal values; '' when every value is absent or one is not a number.
  function sumDecimals(values) {
    const parsed = [];
    for (const value of values) {
      const plain = toPlainString(value);
      if (plain === '') continue;
      const decimal = parseDecimal(plain);
      if (!decimal) return '';
      parsed.push(decimal);
    }
    if (parsed.length === 0) return '';
    const scale = Math.max(...parsed.map((decimal) => decimal.scale));
    let total = 0n;
    for (const decimal of parsed) {
      total += decimal.units * 10n ** BigInt(scale - decimal.scale);
    }
    return formatDecimal(total, scale);
  }

  // The official Scalable CSV uses German local time.
  const BERLIN = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  function berlinDateTime(timestamp) {
    if (!timestamp) return { date: '', time: '' };
    const instant = new Date(timestamp);
    if (Number.isNaN(instant.getTime())) return { date: '', time: '' };
    const parts = {};
    for (const part of BERLIN.formatToParts(instant)) parts[part.type] = part.value;
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}:${parts.second}`,
    };
  }

  function todayBerlin(now) {
    return berlinDateTime(now || new Date()).date;
  }

  // "2026-03-31" shifted by -1 month is "2026-02-28": the day is clamped to the month.
  function shiftMonths(date, months) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
    if (!match) return '';
    const monthIndex = Number(match[2]) - 1 + months;
    const year = Number(match[1]) + Math.floor(monthIndex / 12);
    const month = ((monthIndex % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(Number(match[3]), lastDay))).toISOString().slice(0, 10);
  }

  function pad(number) {
    return String(number).padStart(2, '0');
  }

  // Local time, safe in file names: 2026-10-08_16-30-05
  function fileTimestamp(now) {
    const d = now || new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  }

  const api = {
    toPlainString,
    toDecimalComma,
    sumDecimals,
    berlinDateTime,
    todayBerlin,
    shiftMonths,
    fileTimestamp,
  };

  root.LFX = root.LFX || {};
  root.LFX.format = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
