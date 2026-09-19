'use strict';

/** Loads a sample crew, a few jobs and some hours already put down, so you can
 *  click around before entering anything real. Safe to skip entirely. */

const { open } = require('../src/db');
const auth = require('../src/auth');
const { today, addDays } = require('../src/hours');

const db = open();

const people = [
  { name: 'The office', username: 'office', pin: '1234', role: 'admin', rate: 0 },
  { name: 'Ray Delgado', username: 'ray', pin: '1111', role: 'worker', rate: 27 },
  { name: 'Tom Feeney', username: 'tom', pin: '2222', role: 'worker', rate: 25 },
  { name: 'Luis Barrera', username: 'luis', pin: '3333', role: 'worker', rate: 29 },
];

const ids = {};
for (const person of people) {
  const existing = db.prepare('SELECT id FROM workers WHERE username = ?').get(person.username);
  if (existing) {
    ids[person.username] = existing.id;
    continue;
  }
  const info = db.prepare(`
    INSERT INTO workers (name, username, pin_hash, role, hourly_rate) VALUES (?, ?, ?, ?, ?)
  `).run(person.name, person.username, auth.hashPin(person.pin), person.role, person.rate);
  ids[person.username] = Number(info.lastInsertRowid);
}

const now = today();
const yesterday = addDays(now, -1);

const jobs = [
  [ids.ray, now, 'Sprinkler zone 3 not coming on', '1420 Oak Hollow Dr',
    'Gate code 4471. Check the valve box by the driveway.', 3],
  [ids.tom, now, 'French drain along the back fence', '88 Willow Creek Ct',
    'Dig starts once the locate is marked.', 8],
  [ids.luis, now, 'Two path lights out and a bad transformer', '15 Stoneridge Way',
    'Homeowner wants them coming on by dark.', 4],
  [ids.ray, yesterday, 'Catch basin cleanout', '210 Brookside Ln', null, 6],
];

const insertJob = db.prepare(`
  INSERT INTO jobs (worker_id, work_date, title, location, notes, scheduled_hours, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const jobIds = [];
for (const job of jobs) {
  const already = db
    .prepare('SELECT id FROM jobs WHERE worker_id = ? AND work_date = ? AND title = ?')
    .get(job[0], job[1], job[2]);
  jobIds.push(already ? already.id : Number(insertJob.run(...job, ids.office).lastInsertRowid));
}

const entries = [
  [ids.ray, jobIds[3], yesterday, '07:30', '14:30', 30,
    'Basin and the run to the street are clear', 'approved'],
  [ids.tom, jobIds[1], now, '07:00', '11:45', 0,
    'Trench is open, waiting on the gravel truck', 'submitted'],
  [ids.luis, jobIds[2], now, '08:15', '16:00', 30,
    'Ran new wire to the two front fixtures', 'submitted'],
];

const insertEntry = db.prepare(`
  INSERT INTO entries (worker_id, job_id, work_date, start_time, end_time, break_minutes,
                       description, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const entry of entries) {
  const already = db
    .prepare('SELECT id FROM entries WHERE worker_id = ? AND work_date = ? AND start_time = ?')
    .get(entry[0], entry[2], entry[3]);
  if (!already) insertEntry.run(...entry);
}

db.close();

console.log('Demo data loaded. Sign in with:');
console.log('  office:  office / 1234');
console.log('  crew:    ray / 1111, tom / 2222, luis / 3333');
console.log('\nChange these PINs before using this for real work.');
