// Calendar-date helpers. Dates are plain 'YYYY-MM-DD' strings so that the browser
// timezone can never shift a business date. Instants (timestamps) are ISO strings
// with an explicit offset and are only used for "last read at" style labels.

import { intlLocale } from './i18n.mjs';

const SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30); // spreadsheet serial 0
const DAY_MS = 86400000;

export const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function serialToIso(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;
  const days = Math.floor(serial);
  if (days < 20000 || days > 80000) return null; // outside 1954..2119: not a plausible date serial
  return new Date(SERIAL_EPOCH_MS + days * DAY_MS).toISOString().slice(0, 10);
}

export function isoToSerial(iso) {
  if (!isIsoDate(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - SERIAL_EPOCH_MS) / DAY_MS);
}

const pad = n => String(n).padStart(2, '0');

function build(y, m, d) {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return isIsoDate(iso) ? iso : null;
}

// Parse a cell into a calendar date. `order` decides how ambiguous numeric text
// (12/08/2026) is read: 'dmy' (default for Malaysia/UK), 'mdy', or 'ymd'.
export function parseDate(value, { order = 'dmy' } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return serialToIso(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (ISO_DATE.test(text)) return isIsoDate(text) ? text : null;
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}/); // ISO date-time: keep the calendar part
  if (m) return build(+m[1], +m[2], +m[3]);
  m = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    return order === 'mdy' ? build(y, a, b) : build(y, b, a);
  }
  m = text.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/);
  if (m) return build(+m[1], +m[2], +m[3]);
  m = text.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (m) {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    return month ? build(+m[3], month, +m[1]) : null;
  }
  m = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    return month ? build(+m[3], month, +m[2]) : null;
  }
  if (/^\d+(\.\d+)?$/.test(text)) return serialToIso(Number(text));
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function addDays(iso, days) {
  if (!isIsoDate(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  const a = isoToSerial(fromIso), b = isoToSerial(toIso);
  return a === null || b === null ? null : b - a;
}

export function monthStart(iso) { return iso.slice(0, 7) + '-01'; }

export function monthEnd(iso) {
  const [y, m] = iso.split('-').map(Number);
  return build(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) && addDays(build(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1), -1);
}

export function daysInMonth(iso) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Same day-numbers in the previous month: Aug 1-30 -> Jul 1-30. If the prior month is
// shorter than the requested day, the range is clamped to that month's end and flagged.
export function priorMonthSameDays(start, end) {
  const [y, m, d1] = start.split('-').map(Number);
  const d2 = Number(end.slice(8, 10));
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return {
    start: build(py, pm, Math.min(d1, lastDay)),
    end: build(py, pm, Math.min(d2, lastDay)),
    clamped: d2 > lastDay,
  };
}

export function todayIso(timeZone, now = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return fmt.format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function nowIso() { return new Date().toISOString(); }

export function formatDate(iso, locale = intlLocale()) {
  if (!isIsoDate(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(y, m - 1, d)));
  } catch {
    return iso;
  }
}
