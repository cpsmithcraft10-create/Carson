'use strict';

const { HttpError } = require('./http');
const { isDate, isTime, spanMinutes, LONGEST_SHIFT_HOURS } = require('./time');

function fail(message) {
  throw new HttpError(400, message);
}

function text(value, label, { required = false, max = 500 } = {}) {
  if (value == null || value === '') {
    if (required) fail(`${label} is needed`);
    return null;
  }
  if (typeof value !== 'string') fail(`${label} has to be text`);

  const trimmed = value.trim();
  if (required && !trimmed) fail(`${label} is needed`);
  if (trimmed.length > max) fail(`${label} has to be ${max} characters or fewer`);
  return trimmed || null;
}

function date(value, label, { required = true } = {}) {
  if (value == null || value === '') {
    if (required) fail(`${label} is needed`);
    return null;
  }
  if (!isDate(value)) fail(`${label} has to be a date like 2026-09-20`);
  return value;
}

function time(value, label, { required = true } = {}) {
  if (value == null || value === '') {
    if (required) fail(`${label} is needed`);
    return null;
  }
  if (!isTime(value)) fail(`${label} has to be a time like 07:30`);
  return value;
}

function whole(value, label, { min = 0, max = 100000, fallback = 0 } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) fail(`${label} has to be a whole number`);
  if (n < min || n > max) fail(`${label} has to be between ${min} and ${max}`);
  return n;
}

function decimal(value, label, { min = 0, max = 100000, fallback = null } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${label} has to be a number`);
  if (n < min || n > max) fail(`${label} has to be between ${min} and ${max}`);
  return Math.round(n * 100) / 100;
}

function id(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${label} is not valid`);
  return n;
}

function oneOf(value, label, allowed, { required = true, fallback = null } = {}) {
  if (value == null || value === '') {
    if (required) fail(`${label} is needed`);
    return fallback;
  }
  if (!allowed.includes(value)) fail(`${label} has to be one of: ${allowed.join(', ')}`);
  return value;
}

function username(value) {
  const name = text(value, 'Sign-in name', { required: true, max: 32 });
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    fail('A sign-in name can only have letters, numbers, dots, dashes and underscores');
  }
  return name.toLowerCase();
}

function pin(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4,10}$/.test(raw)) fail('The sign-in number has to be 4 to 10 digits');
  return raw;
}

/**
 * Catches the two ways a shift comes out nonsense: a finish that wraps so far
 * round the clock it has to be a typo, and a break longer than the shift.
 * A finish before the start is still fine - that is work past midnight.
 */
function shiftMakesSense(start, end, breakMinutes) {
  if (!start || !end) return;

  const span = spanMinutes(start, end);
  const asHours = Math.round((span / 60) * 10) / 10;

  if (span > LONGEST_SHIFT_HOURS * 60) {
    fail(`${start} to ${end} works out as ${asHours} hours. Check the times — if the work ` +
         'ran past midnight, put each day down on its own.');
  }
  if (breakMinutes > 0 && breakMinutes >= span) {
    fail(`A ${breakMinutes} minute break does not fit inside ${asHours} hours on the job.`);
  }
}

module.exports = {
  fail, text, date, time, whole, decimal, id, oneOf, username, pin, shiftMakesSense,
};
