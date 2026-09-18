'use strict';

/** Loads a small demo crew, a few jobs and some logged hours so you can click
 *  around before entering real data. Safe to skip entirely. */

const { open } = require('../src/db');
const auth = require('../src/auth');
const { today, addDays } = require('../src/hours');

const db = open();

const people = [
  { name: 'Carson Smith', username: 'carson', pin: '1234', role: 'admin', rate: 0 },
  { name: 'Dana Whitfield', username: 'dana', pin: '1111', role: 'worker', rate: 28 },
  { name: 'Miguel Ortiz', username: 'miguel', pin: '2222', role: 'worker', rate: 26.5 },
  { name: 'Priya Raman', username: 'priya', pin: '3333', role: 'worker', rate: 31 },
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
  [ids.dana, now, 'Riverside fit-out - second floor', '14 Riverside Ave', 'Gear is on site already', 8],
  [ids.miguel, now, 'Riverside fit-out - second floor', '14 Riverside Ave', null, 8],
  [ids.priya, now, 'Maple St callback - fix the leak', '9 Maple St', 'Customer home after 10am', 4],
  [ids.dana, yesterday, 'Warehouse shelving', 'Unit 7, Dock Road', null, 7.5],
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
  jobIds.push(already ? already.id : Number(insertJob.run(...job, ids.carson).lastInsertRowid));
}

const entries = [
  [ids.dana, jobIds[3], yesterday, '07:30', '15:00', 30, 'Shelving up to bay 12', 'approved'],
  [ids.dana, jobIds[0], now, '07:45', '12:15', 0, 'Framing done, waiting on delivery', 'submitted'],
  [ids.miguel, jobIds[1], now, '08:00', '16:30', 45, 'Second floor ceiling grid', 'submitted'],
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
console.log('  manager:  carson / 1234');
console.log('  workers:  dana / 1111, miguel / 2222, priya / 3333');
console.log('\nChange these PINs before using this for real work.');
