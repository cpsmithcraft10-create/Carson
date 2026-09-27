'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  sheetNo, hoursOf, tidyNumber, materialWords, whatIsMissing,
  buildSheet, sheetWords, dayTotals, usualParts,
} = require('../src/worksheets');

const job = (over) => ({
  id: 142, job_date: '2026-09-27', kind: 'sprinkler',
  customer: 'Weaver residence', address: '14 Marsh Lane', phone: '555 0142',
  details: 'Zone 3 not coming on', status: 'working', ...over,
});

const shift = (name, start, end, over) => ({
  id: 1, employee_name: name, start_time: start, end_time: end,
  break_minutes: 0, ...over,
});

/* ============================ the number ============================ */

test('a sheet is numbered by its job, so no two ever share one', () => {
  assert.equal(sheetNo({ id: 142 }), 'WS-00142');
  assert.equal(sheetNo({ id: 7 }), 'WS-00007');
  assert.equal(sheetNo({ id: 123456 }), 'WS-123456');
});

test('a job with no id yet has no number rather than a wrong one', () => {
  for (const bad of [{}, { id: 0 }, { id: null }, { id: 'x' }]) {
    assert.equal(sheetNo(bad), null);
  }
});

/* ============================== hours =============================== */

test('a night shift is counted across midnight, less the break', () => {
  assert.equal(hoursOf(shift('Ray', '22:00', '06:30', { break_minutes: 30 })), 8);
});

test('somebody still on the clock has no hours yet, rather than zero', () => {
  assert.equal(hoursOf(shift('Ray', '08:00', null)), null);
});

/* ============================== parts =============================== */

test('quantities read the way somebody wrote them', () => {
  assert.equal(tidyNumber(3), '3');
  assert.equal(tidyNumber(3.5), '3.5');
  assert.equal(tidyNumber(0.75), '0.75');
  assert.equal(tidyNumber('4'), '4');
});

test('a part with a unit reads as a measurement, one without reads as a count', () => {
  assert.equal(materialWords({ item: 'PVC pipe', quantity: 40, unit: 'ft' }), '40 ft — PVC pipe');
  assert.equal(materialWords({ item: 'Rain Bird 5004', quantity: 3 }), '3 × Rain Bird 5004');
});

/* =========================== what is blank ========================== */

test('a sheet with nothing on it says all three things', () => {
  const missing = whatIsMissing({ job: job(), shifts: [], materials: [] });
  assert.deepEqual(missing, [
    'Nobody has put hours on it',
    'What was done is blank',
    'No parts written down',
  ]);
});

test('somebody still on the clock is called out ahead of the rest', () => {
  const missing = whatIsMissing({
    job: job({ wrap_notes: 'Replaced the valve' }),
    shifts: [shift('Ray', '08:00', null)],
    materials: [{ item: 'Valve' }],
  });
  assert.deepEqual(missing, ['Somebody is still on the clock']);
});

test('parts written as a paragraph still count as written down', () => {
  const missing = whatIsMissing({
    job: job({ wrap_notes: 'Replaced the valve', materials: '1 valve, some pipe' }),
    shifts: [shift('Ray', '08:00', '12:00')],
    materials: [],
  });
  assert.deepEqual(missing, []);
});

test('whitespace is not an answer', () => {
  const missing = whatIsMissing({
    job: job({ wrap_notes: '   ', materials: '  ' }),
    shifts: [shift('Ray', '08:00', '12:00')],
    materials: [],
  });
  assert.deepEqual(missing, ['What was done is blank', 'No parts written down']);
});

/* ============================ a whole sheet ========================= */

test('a finished sheet carries the day, the people, the hours and the parts', () => {
  const sheet = buildSheet({
    job: job({ status: 'done', wrap_notes: 'Dug out and replaced the zone 3 valve.',
               next_visit: 'Check the timer in spring', signed_by: 'M. Weaver',
               signed_at: '2026-09-27T16:40:00Z' }),
    shifts: [
      shift('Ray Delgado', '08:00', '12:30', { id: 1, break_minutes: 30 }),
      shift('Tom Feeney', '09:00', '12:30', { id: 2 }),
    ],
    materials: [
      { id: 1, item: 'Rain Bird 5004', quantity: 3 },
      { id: 2, item: 'PVC pipe', quantity: 40, unit: 'ft' },
    ],
  });

  assert.equal(sheet.no, 'WS-00142');
  assert.equal(sheet.kind_words, 'Sprinkler');
  assert.equal(sheet.customer, 'Weaver residence');
  assert.equal(sheet.asked_for, 'Zone 3 not coming on');
  assert.equal(sheet.done, 'Dug out and replaced the zone 3 valve.');
  assert.equal(sheet.next_visit, 'Check the timer in spring');
  assert.equal(sheet.signed_by, 'M. Weaver');

  assert.deepEqual(sheet.people.map((p) => p.name), ['Ray Delgado', 'Tom Feeney']);
  assert.equal(sheet.people[0].hours, 4);
  assert.equal(sheet.people[1].hours, 3.5);
  assert.equal(sheet.hours, 7.5);

  assert.deepEqual(sheet.materials.map((m) => m.words),
    ['3 × Rain Bird 5004', '40 ft — PVC pipe']);

  assert.deepEqual(sheet.missing, []);
  assert.equal(sheet.ready, true);
});

test('people come out in the order they turned up', () => {
  const sheet = buildSheet({
    job: job(),
    shifts: [
      shift('Luis', '11:00', '15:00', { id: 3 }),
      shift('Ray', '07:30', '15:00', { id: 1 }),
      shift('Tom', '09:15', '15:00', { id: 2 }),
    ],
  });
  assert.deepEqual(sheet.people.map((p) => p.name), ['Ray', 'Tom', 'Luis']);
});

test('somebody still on the clock does not drag the total to a wrong number', () => {
  const sheet = buildSheet({
    job: job(),
    shifts: [shift('Ray', '08:00', '12:00', { id: 1 }), shift('Tom', '08:00', null, { id: 2 })],
  });

  assert.equal(sheet.hours, 4, 'only the finished one counts');
  assert.equal(sheet.people[1].still_on, true);
  assert.equal(sheet.people[1].hours, null);
});

test('the job keeps its own address, so an old sheet still reads true', () => {
  const sheet = buildSheet({
    job: job({ address: '14 Marsh Lane' }),
    customer: { address: '88 Cedar Drive', phone: '555 0199' },
  });

  assert.equal(sheet.address, '14 Marsh Lane', 'where the work actually happened');
});

test('a blank on the job is filled from the customer rather than left empty', () => {
  const sheet = buildSheet({
    job: job({ address: null, phone: null }),
    customer: { address: '88 Cedar Drive', phone: '555 0199' },
  });

  assert.equal(sheet.address, '88 Cedar Drive');
  assert.equal(sheet.phone, '555 0199');
});

test('parts written as a paragraph before this screen existed are still shown', () => {
  const sheet = buildSheet({
    job: job({ materials: '1 valve, 20ft of pipe' }),
    materials: [],
  });

  assert.equal(sheet.done_materials_text, '1 valve, 20ft of pipe');
});

test('once there are real lines the old paragraph stops being shown twice', () => {
  const sheet = buildSheet({
    job: job({ materials: '1 valve' }),
    materials: [{ id: 1, item: 'Valve', quantity: 1 }],
  });

  assert.equal(sheet.done_materials_text, null);
  assert.equal(sheet.materials.length, 1);
});

/* ============================== wording ============================= */

test('a sheet says where it stands in one line', () => {
  const done = buildSheet({
    job: job({ status: 'done', wrap_notes: 'All good' }),
    shifts: [shift('Ray', '08:00', '12:00')],
    materials: [{ item: 'Valve', quantity: 1 }],
  });
  assert.equal(sheetWords(done), 'Done and filled in');

  const one = buildSheet({
    job: job({ wrap_notes: 'All good' }),
    shifts: [shift('Ray', '08:00', '12:00')],
    materials: [],
  });
  assert.equal(sheetWords(one), 'No parts written down');

  const none = buildSheet({ job: job(), shifts: [], materials: [] });
  assert.equal(sheetWords(none), '3 things still blank');

  const filled = buildSheet({
    job: job({ status: 'working', wrap_notes: 'All good' }),
    shifts: [shift('Ray', '08:00', '12:00')],
    materials: [{ item: 'Valve', quantity: 1 }],
  });
  assert.equal(sheetWords(filled), 'Filled in, not closed out yet');
});

/* ============================== the day ============================= */

test('a day of sheets adds up, counting each person once', () => {
  const a = buildSheet({
    job: job({ id: 1, wrap_notes: 'Done' }),
    shifts: [shift('Ray', '08:00', '12:00', { id: 1 })],
    materials: [{ item: 'Valve', quantity: 1 }],
  });
  const b = buildSheet({
    job: job({ id: 2 }),
    shifts: [shift('Ray', '13:00', '17:00', { id: 2 }), shift('Tom', '13:00', '17:00', { id: 3 })],
    materials: [],
  });

  const totals = dayTotals([a, b]);
  assert.equal(totals.sheets, 2);
  assert.equal(totals.ready, 1);
  assert.equal(totals.needing, 1);
  assert.equal(totals.hours, 12);
  assert.equal(totals.people, 2, 'Ray was on both, and is one person');
  assert.equal(totals.parts, 1);
});

test('a day with nothing on it totals to nothing rather than breaking', () => {
  const totals = dayTotals([]);
  assert.equal(totals.sheets, 0);
  assert.equal(totals.hours, 0);
  assert.equal(totals.people, 0);
});

/* ======================== what they actually use ==================== */

test('the parts list is learned from what has been written, most-used first', () => {
  const usual = usualParts([
    { item: 'Rain Bird 5004', unit: null },
    { item: 'PVC pipe', unit: 'ft' },
    { item: 'rain bird 5004', unit: null },
    { item: 'Rain Bird 5004', unit: null },
    { item: 'Valve box', unit: null },
    { item: 'PVC pipe', unit: 'ft' },
  ]);

  assert.deepEqual(usual.map((u) => u.item), ['Rain Bird 5004', 'PVC pipe', 'Valve box']);
  assert.equal(usual[0].times, 3, 'spelt with different capitals, still one part');
  assert.equal(usual[1].unit, 'ft', 'and it remembers how it is measured');
});

test('blank and whitespace entries never reach the list', () => {
  assert.deepEqual(usualParts([{ item: '' }, { item: '   ' }, { item: null }]), []);
});

test('the list is capped, so the buttons stay a list and not a wall', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ item: 'Part ' + i }));
  assert.equal(usualParts(many).length, 18);
  assert.equal(usualParts(many, 5).length, 5);
});
