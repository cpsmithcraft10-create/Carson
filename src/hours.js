'use strict';

/** Time / date helpers. Everything is stored as plain strings so there are no
 *  timezone surprises: dates are 'YYYY-MM-DD', times are 'HH:MM' local to the
 *  crew that worked them. */

/** Longest single shift we will accept. Anything more is a mistyped time. */
const MAX_SHIFT_HOURS = 16;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= 1 && d <= daysInMonth;
}

function isValidTime(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}

function toMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Minutes between two times, wrapping past midnight when the finish is the
 * smaller of the two (22:00 -> 02:00 is 240 minutes).
 */
function spanMinutes(start, end) {
  const from = toMinutes(start);
  const to = toMinutes(end);
  return to >= from ? to - from : to + 24 * 60 - from;
}

/**
 * Worked hours for one entry, minus the unpaid break.
 * An end time earlier than the start time is treated as a shift that ran past
 * midnight (22:00 -> 02:00 is six hours, not negative).
 * Returns 0 for an entry that is still running or whose break swallows the shift.
 */
function hoursWorked(entry) {
  if (!entry || !isValidTime(entry.start_time) || !isValidTime(entry.end_time)) return 0;

  const span = spanMinutes(entry.start_time, entry.end_time);
  const breakMinutes = Number(entry.break_minutes) || 0;
  const worked = span - breakMinutes;

  return worked <= 0 ? 0 : Math.round((worked / 60) * 100) / 100;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Monday-based start of the week containing `date`. */
function startOfWeek(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const shift = (dt.getUTCDay() + 6) % 7; // 0 = Monday
  dt.setUTCDate(dt.getUTCDate() - shift);
  return dt.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Today in the server's local timezone (set TZ to the crew's zone). */
function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

module.exports = {
  isValidDate,
  isValidTime,
  toMinutes,
  spanMinutes,
  hoursWorked,
  MAX_SHIFT_HOURS,
  round2,
  startOfWeek,
  addDays,
  today,
};
