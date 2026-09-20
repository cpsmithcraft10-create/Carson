'use strict';

/** Loads a sample crew, a few jobs and some hours, so you can click around
 *  before putting anything real in. Safe to skip. */

const { open } = require('../src/db');
const auth = require('../src/auth');
const { today, addDays } = require('../src/time');

const db = open();

const people = [
  { name: 'The office', username: 'office', pin: '1234', role: 'office', rate: 0 },
  { name: 'Ray Delgado', username: 'ray', pin: '1111', role: 'crew', rate: 27 },
  { name: 'Tom Feeney', username: 'tom', pin: '2222', role: 'crew', rate: 25 },
  { name: 'Luis Barrera', username: 'luis', pin: '3333', role: 'crew', rate: 29 },
];

const id = {};
for (const person of people) {
  const found = db.prepare('SELECT id FROM employees WHERE username = ?').get(person.username);
  if (found) { id[person.username] = found.id; continue; }

  const info = db.prepare(`
    INSERT INTO employees (name, username, pin_hash, role, hourly_rate, phone)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(person.name, person.username, auth.hashPin(person.pin), person.role, person.rate, null);

  id[person.username] = Number(info.lastInsertRowid);
}

const now = today();
const yesterday = addDays(now, -1);

const jobs = [
  {
    date: now, kind: 'sprinkler', customer: 'Weaver residence',
    address: '1420 Oak Hollow Dr', phone: '555-0142',
    details: 'Zone 3 not coming on. Gate code 4471, valve box is by the driveway.',
    est: 3, crew: ['ray'],
  },
  {
    date: now, kind: 'drainage', customer: 'Kestrel Ridge HOA',
    address: '88 Willow Creek Ct', phone: '555-0188',
    details: 'French drain along the back fence. Dig starts once the locate is marked.',
    est: 8, crew: ['tom', 'luis'],
  },
  {
    date: now, kind: 'lighting', customer: 'Stoneridge — Mrs. Patel',
    address: '15 Stoneridge Way', phone: '555-0115',
    details: 'Two path lights out and the transformer is humming. She wants them on by dark.',
    est: 4, crew: ['luis'],
  },
  {
    date: yesterday, kind: 'drainage', customer: 'Brookside Commons',
    address: '210 Brookside Ln', phone: null,
    details: 'Catch basin cleanout before the storm.',
    est: 6, crew: ['ray'],
  },
];

const jobIds = [];
const addJob = db.prepare(`
  INSERT INTO jobs (job_date, kind, customer, address, phone, details, est_hours, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const addCrew = db.prepare('INSERT INTO crew_on_job (job_id, employee_id) VALUES (?, ?)');

for (const job of jobs) {
  const already = db.prepare('SELECT id FROM jobs WHERE job_date = ? AND customer = ?')
    .get(job.date, job.customer);

  if (already) { jobIds.push(already.id); continue; }

  const info = addJob.run(job.date, job.kind, job.customer, job.address, job.phone,
    job.details, job.est, id.office);
  const jobId = Number(info.lastInsertRowid);

  for (const who of job.crew) addCrew.run(jobId, id[who]);
  jobIds.push(jobId);
}

const shifts = [
  ['ray', jobIds[3], yesterday, '07:30', '14:30', 30, 'Basin and the run to the street are clear', 'ok'],
  ['tom', jobIds[1], now, '07:00', '11:45', 0, 'Trench is open, waiting on the gravel truck', 'sent'],
  ['luis', jobIds[2], now, '08:15', '16:00', 30, 'Ran new wire to the two front fixtures', 'sent'],
];

const addShift = db.prepare(`
  INSERT INTO shifts (employee_id, job_id, work_date, start_time, end_time, break_minutes,
                      notes, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const [who, jobId, date, start, end, brk, notes, status] of shifts) {
  const already = db.prepare('SELECT id FROM shifts WHERE employee_id = ? AND work_date = ? AND start_time = ?')
    .get(id[who], date, start);
  if (!already) addShift.run(id[who], jobId, date, start, end, brk, notes, status);
}

// Mark yesterday's job finished, the way the crew would have.
db.prepare(`
  UPDATE jobs SET status = 'done', finished_at = datetime('now'), finished_by = ?,
                  wrap_notes = 'All clear, no root damage', materials = 'None'
   WHERE id = ? AND status != 'done'
`).run(id.ray, jobIds[3]);

db.prepare("UPDATE jobs SET status = 'working' WHERE id IN (?, ?) AND status = 'assigned'")
  .run(jobIds[1], jobIds[2]);

const notices = [
  ['Freeze warning Thursday night', 'Blowouts move up a week. If you are on a sprinkler call '
    + 'before then, talk the customer through shutting the backflow off.', 1],
  ['New gravel supplier', 'We are on account at Riverbend now, not Tucker. Give them the job '
    + 'number at the scale house.', 0],
];

for (const [title, body, urgent] of notices) {
  if (!db.prepare('SELECT id FROM notices WHERE title = ?').get(title)) {
    db.prepare('INSERT INTO notices (title, body, urgent, posted_by) VALUES (?, ?, ?, ?)')
      .run(title, body, urgent, id.office);
  }
}

db.close();

console.log('Sample data loaded. Sign in with:');
console.log('  office:  office / 1234');
console.log('  crew:    ray / 1111, tom / 2222, luis / 3333');
console.log('\nChange these numbers before using it for real.');
