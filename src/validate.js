'use strict';

const { HttpError } = require('./http');
const { isValidDate, isValidTime, spanMinutes, MAX_SHIFT_HOURS } = require('./hours');

function fail(message) {
  throw new HttpError(400, message);
}

function text(value, label, { required = false, max = 500 } = {}) {
  if (value == null || value === '') {
    if (required) fail(`${label} is required`);
    return null;
  }
  if (typeof value !== 'string') fail(`${label} must be text`);

  const trimmed = value.trim();
  if (required && !trimmed) fail(`${label} is required`);
  if (trimmed.length > max) fail(`${label} must be ${max} characters or fewer`);
  return trimmed || null;
}

function date(value, label, { required = true } = {}) {
  if (value == null || value === '') {
    if (required) fail(`${label} is required`);
    return null;
  }
  if (!isValidDate(value)) fail(`${label} must be a date like 2026-09-18`);
  return value;
}

function time(value, label, { required = true } = {}) {
  if (value == null || value === '') {
    if (required) fail(`${label} is required`);
    return null;
  }
  if (!isValidTime(value)) fail(`${label} must be a time like 08:30`);
  return value;
}

function integer(value, label, { min = 0, max = 100000, required = false, fallback = 0 } = {}) {
  if (value == null || value === '') {
    if (required) fail(`${label} is required`);
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) fail(`${label} must be a whole number`);
  if (n < min || n > max) fail(`${label} must be between ${min} and ${max}`);
  return n;
}

function decimal(value, label, { min = 0, max = 100000, required = false, fallback = null } = {}) {
  if (value == null || value === '') {
    if (required) fail(`${label} is required`);
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${label} must be a number`);
  if (n < min || n > max) fail(`${label} must be between ${min} and ${max}`);
  return Math.round(n * 100) / 100;
}

function id(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${label} is not valid`);
  return n;
}

function oneOf(value, label, allowed, { required = true, fallback = null } = {}) {
  if (value == null || value === '') {
    if (required) fail(`${label} is required`);
    return fallback;
  }
  if (!allowed.includes(value)) fail(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
}

function username(value) {
  const name = text(value, 'Username', { required: true, max: 32 });
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    fail('Username can only contain letters, numbers, dots, dashes and underscores');
  }
  return name.toLowerCase();
}

function pin(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4,10}$/.test(raw)) fail('The sign-in number must be 4 to 10 digits');
  return raw;
}

/**
 * Catches the two ways a shift comes out nonsense: a finish time that wraps so
 * far round the clock it must be a typo, and a break longer than the shift.
 * A finish time before the start is still allowed - that is a night shift.
 */
function shift(start, end, breakMinutes) {
  if (!start || !end) return;

  const span = spanMinutes(start, end);
  const hours = Math.round((span / 60) * 10) / 10;

  if (span > MAX_SHIFT_HOURS * 60) {
    fail(`${start} to ${end} works out as ${hours} hours. Check the times - if the shift ran over ` +
         'two days, log each day separately.');
  }
  if (breakMinutes >= span) {
    fail(`A ${breakMinutes} minute break does not fit inside a ${hours} hour shift`);
  }
}

module.exports = { fail, text, date, time, integer, decimal, id, oneOf, username, pin, shift };
