'use strict';

const { hoursWorked, round2 } = require('./hours');

const ENTRY_SELECT = `
  SELECT e.id, e.worker_id, e.job_id, e.work_date, e.start_time, e.end_time,
         e.break_minutes, e.description, e.status, e.review_note, e.reviewed_at,
         e.created_at, e.updated_at,
         j.title AS job_title, j.location AS job_location,
         w.name AS worker_name, w.hourly_rate AS hourly_rate,
         r.name AS reviewed_by_name
    FROM entries e
    LEFT JOIN jobs j    ON j.id = e.job_id
    JOIN workers w      ON w.id = e.worker_id
    LEFT JOIN workers r ON r.id = e.reviewed_by
`;

const ENTRY_ORDER = ' ORDER BY e.work_date DESC, e.start_time DESC, e.id DESC';

/** Adds the derived hours (and pay) that the client should never compute itself. */
function shape(row) {
  if (!row) return null;
  const hours = hoursWorked(row);
  return {
    ...row,
    hours,
    pay: round2(hours * (Number(row.hourly_rate) || 0)),
  };
}

function totals(rows) {
  const counted = rows.filter((r) => r.status !== 'rejected');
  return {
    entries: rows.length,
    hours: round2(counted.reduce((sum, r) => sum + r.hours, 0)),
    pay: round2(counted.reduce((sum, r) => sum + r.pay, 0)),
    approved_hours: round2(
      rows.filter((r) => r.status === 'approved').reduce((sum, r) => sum + r.hours, 0),
    ),
    pending: rows.filter((r) => r.status === 'submitted').length,
  };
}

module.exports = { ENTRY_SELECT, ENTRY_ORDER, shape, totals };
