'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { hoursWorked, isDate, isTime, weekStart, addDays, spanMinutes } = require('../src/time');
const v = require('../src/validate');

test('hours come out of the span less the unpaid break', () => {
  assert.strictEqual(hoursWorked({ start_time: '07:00', end_time: '15:30', break_minutes: 30 }), 8);
  assert.strictEqual(hoursWorked({ start_time: '08:00', end_time: '16:00', break_minutes: 0 }), 8);
  assert.strictEqual(hoursWorked({ start_time: '07:45', end_time: '12:15', break_minutes: 0 }), 4.5);
});

test('work past midnight is not negative', () => {
  assert.strictEqual(spanMinutes('22:00', '02:00'), 240);
  assert.strictEqual(hoursWorked({ start_time: '22:00', end_time: '02:00', break_minutes: 0 }), 4);
  assert.strictEqual(hoursWorked({ start_time: '21:30', end_time: '05:30', break_minutes: 30 }), 7.5);
});

test('an unfinished shift, or one the break swallows, is zero', () => {
  assert.strictEqual(hoursWorked({ start_time: '08:00', end_time: null, break_minutes: 0 }), 0);
  assert.strictEqual(hoursWorked({ start_time: '08:00', end_time: '08:30', break_minutes: 60 }), 0);
  assert.strictEqual(hoursWorked(null), 0);
});

test('odd minutes round to two places', () => {
  assert.strictEqual(hoursWorked({ start_time: '08:00', end_time: '08:20', break_minutes: 0 }), 0.33);
  assert.strictEqual(hoursWorked({ start_time: '08:00', end_time: '09:10', break_minutes: 0 }), 1.17);
});

test('the shift check allows a night job but not a mistyped one', () => {
  assert.doesNotThrow(() => v.shiftMakesSense('21:00', '05:00', 30));
  assert.doesNotThrow(() => v.shiftMakesSense('07:00', '15:30', 30));
  assert.doesNotThrow(() => v.shiftMakesSense('08:00', null, 0), 'nothing to check mid-shift');
  assert.doesNotThrow(() => v.shiftMakesSense('08:00', '08:00', 0), 'a zero shift is not an error');
  assert.throws(() => v.shiftMakesSense('18:30', '17:00', 0), /Check the times/);
  assert.throws(() => v.shiftMakesSense('08:00', '08:30', 45), /does not fit/);
});

test('dates and times are checked properly', () => {
  assert.ok(isDate('2026-09-20'));
  assert.ok(!isDate('2026-02-30'));
  assert.ok(!isDate('2026-13-01'));
  assert.ok(!isDate('09/20/2026'));
  assert.ok(isTime('00:00') && isTime('23:59'));
  assert.ok(!isTime('24:00'));
  assert.ok(!isTime('7:00'));
});

test('weeks start on Monday', () => {
  assert.strictEqual(weekStart('2026-09-20'), '2026-09-14'); // Sunday belongs to that week
  assert.strictEqual(weekStart('2026-09-14'), '2026-09-14');
  assert.strictEqual(weekStart('2026-09-18'), '2026-09-14');
  assert.strictEqual(addDays('2026-02-28', 1), '2026-03-01');
});
