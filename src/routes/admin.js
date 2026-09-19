'use strict';

const v = require('../validate');
const auth = require('../auth');
const { HttpError } = require('../http');
const { today, startOfWeek, addDays, round2 } = require('../hours');
const { ENTRY_SELECT, ENTRY_ORDER, shape, totals } = require('../entries');

function getWorker(db, id) {
  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(id);
  if (!worker) throw new HttpError(404, 'Nobody by that name');
  return worker;
}

function getEntry(db, id) {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  if (!entry) throw new HttpError(404, 'Those hours were not found');
  return entry;
}

function loadEntry(db, id) {
  return shape(db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(id));
}

function publicWorker(row) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    hourly_rate: row.hourly_rate,
    phone: row.phone,
    active: !!row.active,
  };
}

function review(status) {
  return function handler({ db, user, params, body }) {
    const entry = getEntry(db, params.id);
    if (entry.status === 'open') {
      throw new HttpError(409, 'They are still on the clock. Nothing has been sent in yet.');
    }
    const note = v.text(body.note, 'Note', { max: 500 });

    db.prepare(`
      UPDATE entries
         SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = datetime('now'),
             updated_at = datetime('now')
       WHERE id = ?
    `).run(status, note, user.id, entry.id);

    return { entry: loadEntry(db, entry.id) };
  };
}

/** Rows for the report and its CSV twin: one line per worker over a date range. */
function reportRows(db, from, to, workerId) {
  const params = [from, to];
  let where = 'e.work_date BETWEEN ? AND ?';
  if (workerId) {
    where += ' AND e.worker_id = ?';
    params.push(workerId);
  }

  const entries = db.prepare(`${ENTRY_SELECT} WHERE ${where}${ENTRY_ORDER}`).all(...params).map(shape);
  const byWorker = new Map();

  for (const entry of entries) {
    if (!byWorker.has(entry.worker_id)) {
      byWorker.set(entry.worker_id, {
        worker_id: entry.worker_id,
        worker_name: entry.worker_name,
        hourly_rate: entry.hourly_rate,
        hours: 0,
        approved_hours: 0,
        pending_hours: 0,
        pay: 0,
        entries: 0,
      });
    }
    const row = byWorker.get(entry.worker_id);
    if (entry.status === 'rejected') continue;

    row.entries += 1;
    row.hours = round2(row.hours + entry.hours);
    row.pay = round2(row.pay + entry.pay);
    if (entry.status === 'approved') row.approved_hours = round2(row.approved_hours + entry.hours);
    else row.pending_hours = round2(row.pending_hours + entry.hours);
  }

  return { entries, rows: [...byWorker.values()].sort((a, b) => a.worker_name.localeCompare(b.worker_name)) };
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  // Stop spreadsheets from evaluating a cell that starts with a formula character.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

module.exports = [
  {
    method: 'GET',
    path: '/api/admin/overview',
    handler({ db, query }) {
      const date = query.date ? v.date(query.date, 'Date') : today();

      const entries = db
        .prepare(`${ENTRY_SELECT} WHERE e.work_date = ?${ENTRY_ORDER}`)
        .all(date)
        .map(shape);

      const jobs = db.prepare(`
        SELECT j.id, j.worker_id, j.work_date, j.title, j.location, j.notes, j.scheduled_hours,
               w.name AS worker_name,
               (SELECT COUNT(*) FROM entries e WHERE e.job_id = j.id) AS entry_count
          FROM jobs j
          JOIN workers w ON w.id = j.worker_id
         WHERE j.work_date = ?
         ORDER BY w.name, j.id
      `).all(date);

      const pending = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE status = 'submitted'").get().n;
      const running = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE status = 'open'").get().n;

      return { date, jobs, entries, totals: totals(entries), pending_all_time: pending, running };
    },
  },

  // ---- workers -----------------------------------------------------------

  {
    method: 'GET',
    path: '/api/admin/workers',
    handler({ db, query }) {
      const rows = query.include_inactive === '1'
        ? db.prepare('SELECT * FROM workers ORDER BY active DESC, name').all()
        : db.prepare('SELECT * FROM workers WHERE active = 1 ORDER BY name').all();
      return { workers: rows.map(publicWorker) };
    },
  },

  {
    method: 'POST',
    path: '/api/admin/workers',
    handler({ db, body }) {
      const name = v.text(body.name, 'Name', { required: true, max: 80 });
      const username = v.username(body.username);
      const pin = v.pin(body.pin);
      const role = v.oneOf(body.role, 'Role', ['worker', 'admin'], { required: false, fallback: 'worker' });
      const rate = v.decimal(body.hourly_rate, 'Hourly rate', { max: 10000, fallback: 0 }) ?? 0;
      const phone = v.text(body.phone, 'Phone', { max: 40 });

      const taken = db.prepare('SELECT id FROM workers WHERE username = ? COLLATE NOCASE').get(username);
      if (taken) throw new HttpError(409, 'Somebody already signs in with that name');

      const info = db.prepare(`
        INSERT INTO workers (name, username, pin_hash, role, hourly_rate, phone)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(name, username, auth.hashPin(pin), role, rate, phone);

      return { worker: publicWorker(getWorker(db, Number(info.lastInsertRowid))) };
    },
  },

  {
    method: 'PATCH',
    path: '/api/admin/workers/:id',
    handler({ db, user, params, body }) {
      const worker = getWorker(db, params.id);

      const name = body.name != null ? v.text(body.name, 'Name', { required: true, max: 80 }) : worker.name;
      const role = body.role != null
        ? v.oneOf(body.role, 'Role', ['worker', 'admin'])
        : worker.role;
      const rate = body.hourly_rate != null
        ? v.decimal(body.hourly_rate, 'Hourly rate', { max: 10000, fallback: 0 })
        : worker.hourly_rate;
      const phone = body.phone !== undefined ? v.text(body.phone, 'Phone', { max: 40 }) : worker.phone;
      const active = body.active != null ? (body.active ? 1 : 0) : worker.active;

      // Never let the last manager lock everyone out of the admin side.
      const losingAdmin = worker.role === 'admin' && (role !== 'admin' || !active);
      if (losingAdmin) {
        const admins = db
          .prepare("SELECT COUNT(*) AS n FROM workers WHERE role = 'admin' AND active = 1 AND id != ?")
          .get(worker.id).n;
        if (admins === 0) throw new HttpError(409, 'This is the last office account - keep it working');
      }
      if (worker.id === user.id && !active) {
        throw new HttpError(409, 'You cannot deactivate your own account');
      }

      db.prepare(`
        UPDATE workers SET name = ?, role = ?, hourly_rate = ?, phone = ?, active = ? WHERE id = ?
      `).run(name, role, rate ?? 0, phone, active, worker.id);

      if (!active) auth.destroyWorkerSessions(db, worker.id);

      return { worker: publicWorker(getWorker(db, worker.id)) };
    },
  },

  {
    method: 'POST',
    path: '/api/admin/workers/:id/pin',
    handler({ db, params, body }) {
      const worker = getWorker(db, params.id);
      const pin = v.pin(body.pin);

      db.prepare('UPDATE workers SET pin_hash = ? WHERE id = ?').run(auth.hashPin(pin), worker.id);
      auth.destroyWorkerSessions(db, worker.id);

      return { ok: true };
    },
  },

  // ---- jobs --------------------------------------------------------------

  {
    method: 'GET',
    path: '/api/admin/jobs',
    handler({ db, query }) {
      const from = query.from ? v.date(query.from, 'From date') : today();
      const to = query.to ? v.date(query.to, 'To date') : from;

      const rows = db.prepare(`
        SELECT j.*, w.name AS worker_name,
               (SELECT COUNT(*) FROM entries e WHERE e.job_id = j.id) AS entry_count
          FROM jobs j
          JOIN workers w ON w.id = j.worker_id
         WHERE j.work_date BETWEEN ? AND ?
         ORDER BY j.work_date, w.name, j.id
      `).all(from, to);

      return { from, to, jobs: rows };
    },
  },

  {
    method: 'POST',
    path: '/api/admin/jobs',
    handler({ db, user, body }) {
      const title = v.text(body.title, 'Job', { required: true, max: 120 });
      const workDate = v.date(body.work_date, 'Date');
      const location = v.text(body.location, 'Location', { max: 200 });
      const notes = v.text(body.notes, 'Notes', { max: 1000 });
      const scheduled = v.decimal(body.scheduled_hours, 'Scheduled hours', { max: 24 });

      const ids = Array.isArray(body.worker_ids) ? body.worker_ids : [body.worker_id];
      const workerIds = [...new Set(ids.filter((x) => x != null).map((x) => v.id(x, 'Worker')))];
      if (workerIds.length === 0) v.fail('Pick at least one worker');

      const insert = db.prepare(`
        INSERT INTO jobs (worker_id, work_date, title, location, notes, scheduled_hours, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const created = [];
      for (const workerId of workerIds) {
        getWorker(db, workerId);
        const info = insert.run(workerId, workDate, title, location, notes, scheduled, user.id);
        created.push(Number(info.lastInsertRowid));
      }

      const jobs = created.map((id) => db.prepare(`
        SELECT j.*, w.name AS worker_name FROM jobs j JOIN workers w ON w.id = j.worker_id WHERE j.id = ?
      `).get(id));

      return { jobs };
    },
  },

  {
    method: 'PATCH',
    path: '/api/admin/jobs/:id',
    handler({ db, params, body }) {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(params.id);
      if (!job) throw new HttpError(404, 'Job not found');

      const title = body.title != null ? v.text(body.title, 'Job', { required: true, max: 120 }) : job.title;
      const workDate = body.work_date != null ? v.date(body.work_date, 'Date') : job.work_date;
      const location = body.location !== undefined
        ? v.text(body.location, 'Location', { max: 200 }) : job.location;
      const notes = body.notes !== undefined ? v.text(body.notes, 'Notes', { max: 1000 }) : job.notes;
      const scheduled = body.scheduled_hours !== undefined
        ? v.decimal(body.scheduled_hours, 'Scheduled hours', { max: 24 }) : job.scheduled_hours;
      const workerId = body.worker_id != null ? v.id(body.worker_id, 'Worker') : job.worker_id;
      if (workerId !== job.worker_id) getWorker(db, workerId);

      db.prepare(`
        UPDATE jobs SET worker_id = ?, work_date = ?, title = ?, location = ?, notes = ?,
                        scheduled_hours = ?
         WHERE id = ?
      `).run(workerId, workDate, title, location, notes, scheduled, job.id);

      return {
        job: db.prepare(`
          SELECT j.*, w.name AS worker_name FROM jobs j JOIN workers w ON w.id = j.worker_id WHERE j.id = ?
        `).get(job.id),
      };
    },
  },

  {
    method: 'DELETE',
    path: '/api/admin/jobs/:id',
    handler({ db, params }) {
      const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(params.id);
      if (!job) throw new HttpError(404, 'Job not found');

      // Hours already logged against the job survive; they just lose the label.
      db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
      return { ok: true };
    },
  },

  // ---- timesheet entries -------------------------------------------------

  {
    method: 'GET',
    path: '/api/admin/entries',
    handler({ db, query }) {
      const from = query.from ? v.date(query.from, 'From date') : startOfWeek(today());
      const to = query.to ? v.date(query.to, 'To date') : addDays(from, 6);

      const clauses = ['e.work_date BETWEEN ? AND ?'];
      const params = [from, to];

      if (query.worker_id) {
        clauses.push('e.worker_id = ?');
        params.push(v.id(query.worker_id, 'Worker'));
      }
      if (query.status) {
        clauses.push('e.status = ?');
        params.push(v.oneOf(query.status, 'Status', ['open', 'submitted', 'approved', 'rejected']));
      }

      const entries = db
        .prepare(`${ENTRY_SELECT} WHERE ${clauses.join(' AND ')}${ENTRY_ORDER}`)
        .all(...params)
        .map(shape);

      return { from, to, entries, totals: totals(entries) };
    },
  },

  {
    method: 'GET',
    path: '/api/admin/pending',
    handler({ db }) {
      const entries = db
        .prepare(`${ENTRY_SELECT} WHERE e.status = 'submitted'${ENTRY_ORDER}`)
        .all()
        .map(shape);
      return { entries, totals: totals(entries) };
    },
  },

  { method: 'POST', path: '/api/admin/entries/:id/approve', handler: review('approved') },
  { method: 'POST', path: '/api/admin/entries/:id/reject', handler: review('rejected') },

  {
    method: 'POST',
    path: '/api/admin/entries/:id/reopen',
    handler({ db, params }) {
      const entry = getEntry(db, params.id);
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
    method: 'PATCH',
    path: '/api/admin/entries/:id',
    handler({ db, params, body }) {
      const entry = getEntry(db, params.id);

      const workDate = body.work_date != null ? v.date(body.work_date, 'Date') : entry.work_date;
      const start = body.start_time != null ? v.time(body.start_time, 'Start time') : entry.start_time;
      const end = body.end_time !== undefined
        ? v.time(body.end_time, 'Finish time', { required: false }) : entry.end_time;
      const breakMinutes = body.break_minutes != null
        ? v.integer(body.break_minutes, 'Break', { min: 0, max: 24 * 60 }) : entry.break_minutes;
      const description = body.description !== undefined
        ? v.text(body.description, 'Notes', { max: 1000 }) : entry.description;
      v.shift(start, end, breakMinutes);

      db.prepare(`
        UPDATE entries
           SET work_date = ?, start_time = ?, end_time = ?, break_minutes = ?, description = ?,
               updated_at = datetime('now')
         WHERE id = ?
      `).run(workDate, start, end, breakMinutes, description, entry.id);

      return { entry: loadEntry(db, entry.id) };
    },
  },

  {
    method: 'DELETE',
    path: '/api/admin/entries/:id',
    handler({ db, params }) {
      const entry = getEntry(db, params.id);
      db.prepare('DELETE FROM entries WHERE id = ?').run(entry.id);
      return { ok: true };
    },
  },

  // ---- reporting ---------------------------------------------------------

  {
    method: 'GET',
    path: '/api/admin/report',
    handler({ db, query }) {
      const from = query.from ? v.date(query.from, 'From date') : startOfWeek(today());
      const to = query.to ? v.date(query.to, 'To date') : addDays(from, 6);
      const workerId = query.worker_id ? v.id(query.worker_id, 'Worker') : null;

      const { entries, rows } = reportRows(db, from, to, workerId);

      return {
        from,
        to,
        rows,
        entries,
        totals: {
          hours: round2(rows.reduce((sum, r) => sum + r.hours, 0)),
          approved_hours: round2(rows.reduce((sum, r) => sum + r.approved_hours, 0)),
          pay: round2(rows.reduce((sum, r) => sum + r.pay, 0)),
        },
      };
    },
  },

  {
    method: 'GET',
    path: '/api/admin/report.csv',
    handler({ db, query, res }) {
      const from = query.from ? v.date(query.from, 'From date') : startOfWeek(today());
      const to = query.to ? v.date(query.to, 'To date') : addDays(from, 6);
      const workerId = query.worker_id ? v.id(query.worker_id, 'Worker') : null;

      const { entries } = reportRows(db, from, to, workerId);

      const header = ['Day', 'Name', 'Job', 'Where', 'Started', 'Finished', 'Break (min)',
                      'Hours', 'Rate', 'Pay', 'Where it is at', 'What they said',
                      'What the office asked'];

      const lines = [header.map(csvCell).join(',')];
      for (const e of entries) {
        lines.push([
          e.work_date, e.worker_name, e.job_title || '', e.job_location || '',
          e.start_time, e.end_time || '', e.break_minutes, e.hours,
          e.hourly_rate, e.pay, e.status, e.description || '', e.review_note || '',
        ].map(csvCell).join(','));
      }

      const body = `﻿${lines.join('\r\n')}\r\n`;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="hours-${from}-to-${to}.csv"`,
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return undefined;
    },
  },
];
