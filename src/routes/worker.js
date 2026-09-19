'use strict';

const v = require('../validate');
const { HttpError } = require('../http');
const { today, startOfWeek, addDays } = require('../hours');
const { ENTRY_SELECT, ENTRY_ORDER, shape, totals } = require('../entries');

const EDITABLE = new Set(['open', 'submitted', 'rejected']);

function ownEntry(db, entryId, workerId) {
  const row = db.prepare('SELECT * FROM entries WHERE id = ? AND worker_id = ?').get(entryId, workerId);
  if (!row) throw new HttpError(404, 'Those hours were not found');
  return row;
}

function loadEntry(db, entryId) {
  return shape(db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(entryId));
}

/** A job the worker may log against: assigned to them, or none at all. */
function checkJob(db, jobId, workerId) {
  if (jobId == null) return null;
  const job = db.prepare('SELECT id FROM jobs WHERE id = ? AND worker_id = ?').get(jobId, workerId);
  if (!job) throw new HttpError(400, 'That job is not on your list');
  return job.id;
}

module.exports = [
  {
    method: 'GET',
    path: '/api/my/day',
    handler({ db, user, query }) {
      const date = query.date ? v.date(query.date, 'Date') : today();

      const jobs = db.prepare(`
        SELECT id, title, location, notes, scheduled_hours
          FROM jobs
         WHERE worker_id = ? AND work_date = ?
         ORDER BY id
      `).all(user.id, date);

      const entries = db
        .prepare(`${ENTRY_SELECT} WHERE e.worker_id = ? AND e.work_date = ?${ENTRY_ORDER}`)
        .all(user.id, date)
        .map(shape);

      const running = shape(
        db.prepare(`${ENTRY_SELECT} WHERE e.worker_id = ? AND e.status = 'open' ORDER BY e.id DESC`)
          .get(user.id),
      );

      return { date, jobs, entries, running, totals: totals(entries) };
    },
  },

  {
    method: 'GET',
    path: '/api/my/entries',
    handler({ db, user, query }) {
      const from = query.from ? v.date(query.from, 'From date') : startOfWeek(today());
      const to = query.to ? v.date(query.to, 'To date') : addDays(from, 6);

      const entries = db
        .prepare(`${ENTRY_SELECT} WHERE e.worker_id = ? AND e.work_date BETWEEN ? AND ?${ENTRY_ORDER}`)
        .all(user.id, from, to)
        .map(shape);

      return { from, to, entries, totals: totals(entries) };
    },
  },

  {
    method: 'POST',
    path: '/api/my/entries',
    handler({ db, user, body }) {
      const workDate = v.date(body.work_date, 'Date');
      const start = v.time(body.start_time, 'Start time');
      const end = v.time(body.end_time, 'Finish time', { required: false });
      const breakMinutes = v.integer(body.break_minutes, 'Break', { min: 0, max: 24 * 60 });
      const description = v.text(body.description, 'Notes', { max: 1000 });
      const jobId = checkJob(db, body.job_id ? v.id(body.job_id, 'Job') : null, user.id);
      v.shift(start, end, breakMinutes);

      const info = db.prepare(`
        INSERT INTO entries (worker_id, job_id, work_date, start_time, end_time,
                             break_minutes, description, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(user.id, jobId, workDate, start, end, breakMinutes, description,
             end ? 'submitted' : 'open');

      return { entry: loadEntry(db, Number(info.lastInsertRowid)) };
    },
  },

  {
    method: 'POST',
    path: '/api/my/clock-in',
    handler({ db, user, body }) {
      const open = db.prepare("SELECT id FROM entries WHERE worker_id = ? AND status = 'open'")
        .get(user.id);
      if (open) throw new HttpError(409, 'You are already clocked in on something. Finish that one first.');

      const workDate = body.work_date ? v.date(body.work_date, 'Date') : today();
      const start = v.time(body.start_time, 'Start time');
      const jobId = checkJob(db, body.job_id ? v.id(body.job_id, 'Job') : null, user.id);

      // A call-out that was never on anyone's list carries its own description.
      const description = v.text(body.description, 'Job', { max: 1000 });
      if (!jobId && !description) {
        throw new HttpError(400, 'Pick a job from your list, or say what you are working on');
      }

      const info = db.prepare(`
        INSERT INTO entries (worker_id, job_id, work_date, start_time, description, status)
        VALUES (?, ?, ?, ?, ?, 'open')
      `).run(user.id, jobId, workDate, start, description);

      return { entry: loadEntry(db, Number(info.lastInsertRowid)) };
    },
  },

  {
    method: 'POST',
    path: '/api/my/entries/:id/clock-out',
    handler({ db, user, params, body }) {
      const entry = ownEntry(db, params.id, user.id);
      if (entry.status !== 'open') throw new HttpError(409, 'That job is already finished');

      const end = v.time(body.end_time, 'Finish time');
      const breakMinutes = v.integer(body.break_minutes, 'Break', {
        min: 0, max: 24 * 60, fallback: entry.break_minutes,
      });
      const description = v.text(body.description, 'Notes', { max: 1000 }) ?? entry.description;
      v.shift(entry.start_time, end, breakMinutes);

      db.prepare(`
        UPDATE entries
           SET end_time = ?, break_minutes = ?, description = ?, status = 'submitted',
               updated_at = datetime('now')
         WHERE id = ?
      `).run(end, breakMinutes, description, entry.id);

      return { entry: loadEntry(db, entry.id) };
    },
  },

  {
    method: 'PATCH',
    path: '/api/my/entries/:id',
    handler({ db, user, params, body }) {
      const entry = ownEntry(db, params.id, user.id);
      if (!EDITABLE.has(entry.status)) {
        throw new HttpError(409, 'The office already OK\'d these hours. Ask them to put it back if it is wrong.');
      }

      const workDate = body.work_date != null ? v.date(body.work_date, 'Date') : entry.work_date;
      const start = body.start_time != null ? v.time(body.start_time, 'Start time') : entry.start_time;
      const end = body.end_time !== undefined
        ? v.time(body.end_time, 'Finish time', { required: false })
        : entry.end_time;
      const breakMinutes = body.break_minutes != null
        ? v.integer(body.break_minutes, 'Break', { min: 0, max: 24 * 60 })
        : entry.break_minutes;
      const description = body.description !== undefined
        ? v.text(body.description, 'Notes', { max: 1000 })
        : entry.description;
      const jobId = body.job_id !== undefined
        ? checkJob(db, body.job_id ? v.id(body.job_id, 'Job') : null, user.id)
        : entry.job_id;

      v.shift(start, end, breakMinutes);

      // Editing a rejected entry puts it back in the queue for review.
      const status = end ? 'submitted' : 'open';

      db.prepare(`
        UPDATE entries
           SET job_id = ?, work_date = ?, start_time = ?, end_time = ?, break_minutes = ?,
               description = ?, status = ?, review_note = NULL, reviewed_by = NULL,
               reviewed_at = NULL, updated_at = datetime('now')
         WHERE id = ?
      `).run(jobId, workDate, start, end, breakMinutes, description, status, entry.id);

      return { entry: loadEntry(db, entry.id) };
    },
  },

  {
    method: 'POST',
    path: '/api/my/entries/:id/submit',
    handler({ db, user, params }) {
      const entry = ownEntry(db, params.id, user.id);
      if (entry.status === 'approved') throw new HttpError(409, 'That entry is already approved');
      if (!entry.end_time) throw new HttpError(400, 'Put in a finish time before sending it in');

      db.prepare(`
        UPDATE entries
           SET status = 'submitted', review_note = NULL, reviewed_by = NULL, reviewed_at = NULL,
               updated_at = datetime('now')
         WHERE id = ?
      `).run(entry.id);

      return { entry: loadEntry(db, entry.id) };
    },
  },

  {
    method: 'DELETE',
    path: '/api/my/entries/:id',
    handler({ db, user, params }) {
      const entry = ownEntry(db, params.id, user.id);
      if (entry.status === 'approved') {
        throw new HttpError(409, "Hours the office OK'd cannot be taken off");
      }
      db.prepare('DELETE FROM entries WHERE id = ?').run(entry.id);
      return { ok: true };
    },
  },
];
