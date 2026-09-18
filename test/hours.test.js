'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { hoursWorked, isValidDate, isValidTime, startOfWeek, addDays } = require('../src/hours');

test('hoursWorked subtracts the unpaid break', () => {
  assert.strictEqual(hoursWorked({ start_time: '08:00', end_time: '16:30', break_minutes: 30 }), 8);
  assert.strictEqual(hoursWorked({ start_time: '09:00', end_time: '17:00', break_minutes: 0 }), 8);
  assert.strictEqual(hoursWorked({ start_time: '07:45', end_time: '12:15', break_minutes: 0 }), 4.5);
});

test('a shift running past midnight is not negative', () => {
  assert.strictEqual(hoursWorked({ start_time: '22:00', end_time: '02:00', break_minutes: 0 }), 4);
  assert.strictEqual(hoursWorked({ start_time: '23:30', end_time: '07:30', break_minutes: 30 }), 7.5);
});

test('an unfinished or fully-broken shift counts as zero', () => {
  assert.strictEqual(hoursWorked({ start_time: '08:00', end_time: null, break_minutes: 0 }), 0);
  assert.strictEqual(hoursWorked({ start_time: '08:00', end_time: '08:30', break_minutes: 60 }), 0);
  assert.strictEqual(hoursWorked(null), 0);
});

test('odd minutes round to two decimals', () => {
  assert.strictEqual(hoursWorked({ start_time: '08:00', end_time: '08:20', break_minutes: 0 }), 0.33);
  assert.strictEqual(hoursWorked({ start_time: '08:00', end_time: '09:10', break_minutes: 0 }), 1.17);
});

test('the shift guard allows night shifts but not mistyped ones', () => {
  const v = require('../src/validate');
  assert.doesNotThrow(() => v.shift('22:00', '06:00', 30));
  assert.doesNotThrow(() => v.shift('08:00', '16:00', 30));
  assert.doesNotThrow(() => v.shift('08:00', null, 0), 'a running shift has nothing to check yet');
  assert.throws(() => v.shift('18:30', '17:00', 0), /Check the times/);
  assert.throws(() => v.shift('08:00', '08:30', 30), /does not fit/);
});

test('date and time validation rejects the usual junk', () => {
  assert.ok(isValidDate('2026-09-18'));
  assert.ok(!isValidDate('2026-02-30'));
  assert.ok(!isValidDate('2026-13-01'));
  assert.ok(!isValidDate('18/09/2026'));
  assert.ok(isValidTime('00:00') && isValidTime('23:59'));
  assert.ok(!isValidTime('24:00'));
  assert.ok(!isValidTime('8:00'));
});

test('weeks start on Monday', () => {
  assert.strictEqual(startOfWeek('2026-09-18'), '2026-09-14'); // Friday -> Monday
  assert.strictEqual(startOfWeek('2026-09-14'), '2026-09-14');
  assert.strictEqual(startOfWeek('2026-09-20'), '2026-09-14'); // Sunday stays in that week
  assert.strictEqual(addDays('2026-02-28', 1), '2026-03-01');
});
