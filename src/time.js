'use strict';

/** Dates are 'YYYY-MM-DD' and times are 'HH:MM', stored exactly as entered.
 *  No timezone conversion means nothing to get wrong at 6am in the truck. */

const LONGEST_SHIFT_HOURS = 16;

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SHAPE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isDate(value) {
  if (typeof value !== 'string' || !DATE_SHAPE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  return d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isTime(value) {
  return typeof value === 'string' && TIME_SHAPE.test(value);
}

function toMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Minutes worked, wrapping past midnight when the finish is the smaller time. */
function spanMinutes(start, end) {
  const from = toMinutes(start);
  const to = toMinutes(end);
  return to >= from ? to - from : to + 24 * 60 - from;
}

/** Paid hours for a shift: the span, less the unpaid break, to two places. */
function hoursWorked(shift) {
  if (!shift || !isTime(shift.start_time) || !isTime(shift.end_time)) return 0;
  const worked = spanMinutes(shift.start_time, shift.end_time) - (Number(shift.break_minutes) || 0);
  return worked <= 0 ? 0 : round2(worked / 60);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Monday-based start of the week holding `date`. */
function weekStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

/** Today in the server's own timezone. Set TZ to the crew's zone. */
function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

module.exports = {
  LONGEST_SHIFT_HOURS,
  isDate,
  isTime,
  toMinutes,
  spanMinutes,
  hoursWorked,
  round2,
  addDays,
  weekStart,
  today,
};
