'use strict';

const { hoursWorked, round2 } = require('./time');

const JOB_COLUMNS = `
  j.id, j.job_date, j.kind, j.customer, j.address, j.phone, j.customer_id,
  j.details, j.est_hours, j.status, j.wrap_notes, j.materials, j.finished_at,
  j.created_at, f.name AS finished_by_name
`;

const SHIFT_COLUMNS = `
  s.id, s.employee_id, s.job_id, s.other_work, s.work_date, s.start_time, s.end_time,
  s.break_minutes, s.notes, s.status, s.question, s.reviewed_at,
  e.name AS employee_name, e.hourly_rate,
  j.customer AS job_customer, j.address AS job_address, j.kind AS job_kind,
  r.name AS reviewed_by_name
`;

/**
 * Runs a job query and attaches each job's crew in one extra round trip,
 * rather than trying to unpick a group_concat of names that contain commas.
 */
function loadJobs(db, where, params = []) {
  const jobs = db.prepare(`
    SELECT ${JOB_COLUMNS}
      FROM jobs j
      LEFT JOIN employees f ON f.id = j.finished_by
     ${where ? `WHERE ${where}` : ''}
     ORDER BY j.job_date, j.id
  `).all(...params);

  if (jobs.length === 0) return [];

  const slots = jobs.map(() => '?').join(', ');
  const crew = db.prepare(`
    SELECT c.job_id, e.id, e.name
      FROM crew_on_job c
      JOIN employees e ON e.id = c.employee_id
     WHERE c.job_id IN (${slots})
     ORDER BY e.name
  `).all(...jobs.map((j) => j.id));

  const byJob = new Map();
  for (const row of crew) {
    if (!byJob.has(row.job_id)) byJob.set(row.job_id, []);
    byJob.get(row.job_id).push({ id: row.id, name: row.name });
  }

  return jobs.map((job) => ({ ...job, crew: byJob.get(job.id) || [] }));
}

function loadJob(db, jobId) {
  return loadJobs(db, 'j.id = ?', [jobId])[0] || null;
}

function loadShifts(db, where, params = []) {
  return db.prepare(`
    SELECT ${SHIFT_COLUMNS}
      FROM shifts s
      JOIN employees e       ON e.id = s.employee_id
      LEFT JOIN jobs j       ON j.id = s.job_id
      LEFT JOIN employees r  ON r.id = s.reviewed_by
     ${where ? `WHERE ${where}` : ''}
     ORDER BY s.work_date DESC, s.start_time DESC, s.id DESC
  `).all(...params).map(shapeShift);
}

function loadShift(db, shiftId) {
  return loadShifts(db, 's.id = ?', [shiftId])[0] || null;
}

/** Adds the figures the browser should never work out for itself. */
function shapeShift(row) {
  const hours = hoursWorked(row);
  return {
    ...row,
    hours,
    pay: round2(hours * (Number(row.hourly_rate) || 0)),
    what: row.job_customer || row.other_work || 'Other work',
  };
}

function shiftTotals(list) {
  const counted = list.filter((s) => s.status !== 'question');
  return {
    shifts: list.length,
    hours: round2(counted.reduce((sum, s) => sum + s.hours, 0)),
    pay: round2(counted.reduce((sum, s) => sum + s.pay, 0)),
    ok_hours: round2(list.filter((s) => s.status === 'ok').reduce((sum, s) => sum + s.hours, 0)),
    waiting: list.filter((s) => s.status === 'sent').length,
  };
}

/**
 * The two numbers the office bar always shows. Kept as counts so switching
 * tabs does not drag whole shift rows across the wire just to length them.
 */
function officeCounts(db) {
  return {
    waiting: db.prepare("SELECT COUNT(*) AS n FROM shifts WHERE status = 'sent'").get().n,
    on_the_clock: db.prepare("SELECT COUNT(*) AS n FROM shifts WHERE status = 'open'").get().n,
  };
}

/** One customer, with enough history for the office to recognise them. */
function loadCustomers(db, search) {
  const like = search ? `%${search}%` : null;

  return db.prepare(`
    SELECT c.id, c.name, c.address, c.phone, c.notes, c.active,
           (SELECT COUNT(*) FROM jobs j WHERE j.customer_id = c.id) AS job_count,
           (SELECT MAX(j.job_date) FROM jobs j WHERE j.customer_id = c.id) AS last_job
      FROM customers c
     ${like ? 'WHERE c.name LIKE ? OR c.address LIKE ? OR c.phone LIKE ?' : ''}
     ORDER BY c.active DESC, c.name
  `).all(...(like ? [like, like, like] : []));
}

function loadCustomer(db, id) {
  return loadCustomers(db).find((c) => c.id === Number(id)) || null;
}

module.exports = {
  loadJobs, loadJob, loadShifts, loadShift, shapeShift, shiftTotals,
  officeCounts, loadCustomers, loadCustomer,
};
