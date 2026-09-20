'use strict';

const v = require('../validate');
const { HttpError } = require('../http');
const { today, weekStart, addDays } = require('../time');
const { loadJobs, loadJob, loadShifts, loadShift, shiftTotals } = require('../queries');

const CAN_CHANGE = new Set(['open', 'sent', 'question']);

function myShift(db, shiftId, employeeId) {
  const row = db.prepare('SELECT * FROM shifts WHERE id = ? AND employee_id = ?')
    .get(shiftId, employeeId);
  if (!row) throw new HttpError(404, 'Those hours were not found');
  return row;
}

/** A job this person is actually on. */
function myJob(db, jobId, employeeId) {
  if (jobId == null) return null;
  const row = db.prepare(`
    SELECT j.id FROM jobs j
      JOIN crew_on_job c ON c.job_id = j.id
     WHERE j.id = ? AND c.employee_id = ?
  `).get(jobId, employeeId);
  if (!row) throw new HttpError(400, 'That job is not on your list');
  return row.id;
}

function openShift(db, employeeId) {
  return loadShifts(db, "s.employee_id = ? AND s.status = 'open'", [employeeId])[0] || null;
}

module.exports = [
  {
    method: 'GET',
    path: '/api/crew/day',
    handler({ db, user, query }) {
      const date = query.date ? v.date(query.date, 'Date') : today();

      const jobs = loadJobs(db, `
        j.job_date = ? AND EXISTS (
          SELECT 1 FROM crew_on_job c WHERE c.job_id = j.id AND c.employee_id = ?
        )
      `, [date, user.id]);

      const shifts = loadShifts(db, 's.employee_id = ? AND s.work_date = ?', [user.id, date]);

      return {
        date,
        jobs,
        shifts,
        running: openShift(db, user.id),
        totals: shiftTotals(shifts),
      };
    },
  },

  {
    method: 'GET',
    path: '/api/crew/week',
    handler({ db, user, query }) {
      const from = query.from ? v.date(query.from, 'From') : weekStart(today());
      const to = query.to ? v.date(query.to, 'To') : addDays(from, 6);

      const shifts = loadShifts(db, 's.employee_id = ? AND s.work_date BETWEEN ? AND ?',
        [user.id, from, to]);

      return { from, to, shifts, totals: shiftTotals(shifts) };
    },
  },

  {
    method: 'POST',
    path: '/api/crew/clock-in',
    handler({ db, user, body }) {
      if (openShift(db, user.id)) {
        throw new HttpError(409, 'You are already clocked in on something. Finish that one first.');
      }

      const date = body.work_date ? v.date(body.work_date, 'Date') : today();
      const start = v.time(body.start_time, 'Start time');
      const jobId = myJob(db, body.job_id ? v.id(body.job_id, 'Job') : null, user.id);
      const other = v.text(body.other_work, 'What you are working on', { max: 160 });

      if (!jobId && !other) {
        throw new HttpError(400, 'Pick a job off your list, or say what you are working on');
      }

      const info = db.prepare(`
        INSERT INTO shifts (employee_id, job_id, other_work, work_date, start_time, status)
        VALUES (?, ?, ?, ?, ?, 'open')
      `).run(user.id, jobId, other, date, start);

      // Starting work moves the job off "assigned" so the office sees it is live.
      if (jobId) {
        db.prepare("UPDATE jobs SET status = 'working' WHERE id = ? AND status = 'assigned'")
          .run(jobId);
      }

      return { shift: loadShift(db, Number(info.lastInsertRowid)) };
    },
  },

  {
    method: 'POST',
    path: '/api/crew/shifts/:id/clock-out',
    handler({ db, user, params, body }) {
      const shift = myShift(db, params.id, user.id);
      if (shift.status !== 'open') throw new HttpError(409, 'That one is already finished');

      const end = v.time(body.end_time, 'Finish time');
      const breakMinutes = v.whole(body.break_minutes, 'Break', {
        min: 0, max: 24 * 60, fallback: shift.break_minutes,
      });
      const notes = v.text(body.notes, 'Notes', { max: 1000 });

      v.shiftMakesSense(shift.start_time, end, breakMinutes);

      db.prepare(`
        UPDATE shifts
           SET end_time = ?, break_minutes = ?, notes = ?, status = 'sent',
               question = NULL, updated_at = datetime('now')
         WHERE id = ?
      `).run(end, breakMinutes, notes, shift.id);

      return { shift: loadShift(db, shift.id) };
    },
  },

  {
    method: 'POST',
    path: '/api/crew/shifts',
    handler({ db, user, body }) {
      const date = v.date(body.work_date, 'Date');
      const start = v.time(body.start_time, 'Start time');
      const end = v.time(body.end_time, 'Finish time');
      const breakMinutes = v.whole(body.break_minutes, 'Break', { min: 0, max: 24 * 60 });
      const notes = v.text(body.notes, 'Notes', { max: 1000 });
      const jobId = myJob(db, body.job_id ? v.id(body.job_id, 'Job') : null, user.id);
      const other = v.text(body.other_work, 'What you were working on', { max: 160 });

      if (!jobId && !other) {
        throw new HttpError(400, 'Pick a job off your list, or say what you were working on');
      }

      v.shiftMakesSense(start, end, breakMinutes);

      const info = db.prepare(`
        INSERT INTO shifts (employee_id, job_id, other_work, work_date, start_time, end_time,
                            break_minutes, notes, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent')
      `).run(user.id, jobId, other, date, start, end, breakMinutes, notes);

      return { shift: loadShift(db, Number(info.lastInsertRowid)) };
    },
  },

  {
    method: 'PATCH',
    path: '/api/crew/shifts/:id',
    handler({ db, user, params, body }) {
      const shift = myShift(db, params.id, user.id);
      if (!CAN_CHANGE.has(shift.status)) {
        throw new HttpError(409, "The office already OK'd these hours. Ask them to reopen it.");
      }

      const start = body.start_time != null ? v.time(body.start_time, 'Start time') : shift.start_time;
      const end = body.end_time !== undefined
        ? v.time(body.end_time, 'Finish time', { required: false })
        : shift.end_time;
      const breakMinutes = body.break_minutes != null
        ? v.whole(body.break_minutes, 'Break', { min: 0, max: 24 * 60 })
        : shift.break_minutes;
      const notes = body.notes !== undefined
        ? v.text(body.notes, 'Notes', { max: 1000 })
        : shift.notes;

      v.shiftMakesSense(start, end, breakMinutes);

      // Fixing hours the office asked about puts them back in the pile.
      const status = end ? 'sent' : 'open';

      db.prepare(`
        UPDATE shifts
           SET start_time = ?, end_time = ?, break_minutes = ?, notes = ?, status = ?,
               question = NULL, reviewed_by = NULL, reviewed_at = NULL,
               updated_at = datetime('now')
         WHERE id = ?
      `).run(start, end, breakMinutes, notes, status, shift.id);

      return { shift: loadShift(db, shift.id) };
    },
  },

  {
    method: 'DELETE',
    path: '/api/crew/shifts/:id',
    handler({ db, user, params }) {
      const shift = myShift(db, params.id, user.id);
      if (shift.status === 'ok') {
        throw new HttpError(409, "Hours the office OK'd cannot be taken off");
      }
      db.prepare('DELETE FROM shifts WHERE id = ?').run(shift.id);
      return { ok: true };
    },
  },

  {
    method: 'POST',
    path: '/api/crew/jobs/:id/finish',
    handler({ db, user, params, body }) {
      const jobId = myJob(db, v.id(params.id, 'Job'), user.id);
      const wrap = v.text(body.wrap_notes, 'How it went', { max: 1000 });
      const materials = v.text(body.materials, 'Parts used', { max: 1000 });

      db.prepare(`
        UPDATE jobs
           SET status = 'done', wrap_notes = ?, materials = ?,
               finished_at = datetime('now'), finished_by = ?
         WHERE id = ?
      `).run(wrap, materials, user.id, jobId);

      return { job: loadJob(db, jobId) };
    },
  },

  {
    method: 'POST',
    path: '/api/crew/jobs/:id/reopen',
    handler({ db, user, params }) {
      const jobId = myJob(db, v.id(params.id, 'Job'), user.id);
      db.prepare(`
        UPDATE jobs SET status = 'working', finished_at = NULL, finished_by = NULL WHERE id = ?
      `).run(jobId);
      return { job: loadJob(db, jobId) };
    },
  },

  {
    method: 'GET',
    path: '/api/crew/notices',
    handler({ db, user }) {
      const notices = db.prepare(`
        SELECT n.id, n.title, n.body, n.urgent, n.posted_at, e.name AS posted_by_name,
               (SELECT COUNT(*) FROM notice_seen s
                 WHERE s.notice_id = n.id AND s.employee_id = ?) AS seen
          FROM notices n
          LEFT JOIN employees e ON e.id = n.posted_by
         ORDER BY n.urgent DESC, n.posted_at DESC
         LIMIT 30
      `).all(user.id);

      return { notices, unread: notices.filter((n) => !n.seen).length };
    },
  },

  {
    method: 'POST',
    path: '/api/crew/notices/:id/seen',
    handler({ db, user, params }) {
      const noticeId = v.id(params.id, 'Notice');
      db.prepare(`
        INSERT INTO notice_seen (notice_id, employee_id) VALUES (?, ?)
        ON CONFLICT (notice_id, employee_id) DO NOTHING
      `).run(noticeId, user.id);
      return { ok: true };
    },
  },
];
