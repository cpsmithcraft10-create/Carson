'use strict';

const v = require('../validate');
const auth = require('../auth');
const { HttpError } = require('../http');
const { today, weekStart, addDays, round2 } = require('../time');
const {
  loadJobs, loadJob, loadShifts, loadShift, shiftTotals,
  officeCounts, loadCustomers, loadCustomer,
} = require('../queries');
const { readCustomers, sameName, MOST_ROWS } = require('../import');
const settingsStore = require('../settings');
const invoicing = require('../invoicing');
const { consentUrl } = require('../quickbooks');

const KINDS = ['sprinkler', 'lighting', 'drainage', 'other'];

function getPerson(db, id) {
  const row = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Nobody by that name');
  return row;
}

function getShift(db, id) {
  const row = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Those hours were not found');
  return row;
}

function publicPerson(row) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    phone: row.phone,
    hourly_rate: row.hourly_rate,
    active: !!row.active,
  };
}

/** Replaces the crew on a job with exactly this set of people. */
function setCrew(db, jobId, employeeIds) {
  db.prepare('DELETE FROM crew_on_job WHERE job_id = ?').run(jobId);
  const add = db.prepare('INSERT INTO crew_on_job (job_id, employee_id) VALUES (?, ?)');
  for (const id of employeeIds) {
    getPerson(db, id);
    add.run(jobId, id);
  }
}

function review(status) {
  return function handler({ db, user, params, body }) {
    const shift = getShift(db, params.id);
    if (shift.status === 'open') {
      throw new HttpError(409, 'They are still on the clock. Nothing has been sent in yet.');
    }
    const question = v.text(body.question, 'Question', { max: 500 });

    db.prepare(`
      UPDATE shifts
         SET status = ?, question = ?, reviewed_by = ?, reviewed_at = datetime('now'),
             updated_at = datetime('now')
       WHERE id = ?
    `).run(status, status === 'question' ? (question || 'Please check these times.') : null,
           user.id, shift.id);

    return { shift: loadShift(db, shift.id) };
  };
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  // Stop a spreadsheet from treating a cell as a formula.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

module.exports = [
  // ---- the day -----------------------------------------------------------

  {
    method: 'GET',
    path: '/api/office/day',
    handler({ db, query }) {
      const date = query.date ? v.date(query.date, 'Date') : today();

      const jobs = loadJobs(db, 'j.job_date = ?', [date]);
      const shifts = loadShifts(db, 's.work_date = ?', [date]);

      const onTheClock = loadShifts(db, "s.status = 'open'");
      const waiting = db.prepare("SELECT COUNT(*) AS n FROM shifts WHERE status = 'sent'").get().n;

      return {
        date,
        jobs,
        shifts,
        on_the_clock: onTheClock,
        waiting,
        totals: shiftTotals(shifts),
        job_counts: {
          assigned: jobs.filter((j) => j.status === 'assigned').length,
          working: jobs.filter((j) => j.status === 'working').length,
          done: jobs.filter((j) => j.status === 'done').length,
        },
      };
    },
  },

  // ---- jobs --------------------------------------------------------------

  {
    method: 'GET',
    path: '/api/office/jobs',
    handler({ db, query }) {
      const from = query.from ? v.date(query.from, 'From') : today();
      const to = query.to ? v.date(query.to, 'To') : addDays(from, 13);
      return { from, to, jobs: loadJobs(db, 'j.job_date BETWEEN ? AND ?', [from, to]) };
    },
  },

  {
    method: 'POST',
    path: '/api/office/jobs',
    handler({ db, user, body }) {
      const date = v.date(body.job_date, 'Day');
      const kind = v.oneOf(body.kind, 'Type of work', KINDS, { required: false, fallback: 'other' });

      // Picking a known customer fills the blanks; the job keeps its own copy
      // so old paperwork still reads true after they move house.
      const known = body.customer_id
        ? db.prepare('SELECT * FROM customers WHERE id = ?').get(v.id(body.customer_id, 'Customer'))
        : null;
      if (body.customer_id && !known) throw new HttpError(404, 'That customer was not found');

      const customer = v.text(body.customer, 'Customer', { required: !known, max: 120 })
        || known.name;
      const address = v.text(body.address, 'Address', { max: 200 })
        || (known ? known.address : null);
      const phone = v.text(body.phone, 'Phone', { max: 40 }) || (known ? known.phone : null);
      const details = v.text(body.details, 'What needs doing', { max: 2000 });
      const estHours = v.decimal(body.est_hours, 'Hours it should take', { max: 24 });

      const ids = Array.isArray(body.crew_ids) ? body.crew_ids : [];
      const crewIds = [...new Set(ids.filter((x) => x != null).map((x) => v.id(x, 'Crew member')))];
      if (crewIds.length === 0) v.fail('Pick at least one person for this job');

      const info = db.prepare(`
        INSERT INTO jobs (job_date, kind, customer, address, phone, customer_id, details,
                          est_hours, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(date, kind, customer, address, phone, known ? known.id : null,
             details, estHours, user.id);

      const jobId = Number(info.lastInsertRowid);
      setCrew(db, jobId, crewIds);

      return { job: loadJob(db, jobId) };
    },
  },

  {
    method: 'PATCH',
    path: '/api/office/jobs/:id',
    handler({ db, params, body }) {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(params.id);
      if (!job) throw new HttpError(404, 'That job was not found');

      const customer = body.customer != null
        ? v.text(body.customer, 'Customer', { required: true, max: 120 }) : job.customer;
      const date = body.job_date != null ? v.date(body.job_date, 'Day') : job.job_date;
      const kind = body.kind != null ? v.oneOf(body.kind, 'Type of work', KINDS) : job.kind;
      const address = body.address !== undefined
        ? v.text(body.address, 'Address', { max: 200 }) : job.address;
      const phone = body.phone !== undefined ? v.text(body.phone, 'Phone', { max: 40 }) : job.phone;
      const details = body.details !== undefined
        ? v.text(body.details, 'What needs doing', { max: 2000 }) : job.details;
      const estHours = body.est_hours !== undefined
        ? v.decimal(body.est_hours, 'Hours it should take', { max: 24 }) : job.est_hours;
      const status = body.status != null
        ? v.oneOf(body.status, 'Status', ['assigned', 'working', 'done']) : job.status;
      const customerId = body.customer_id !== undefined
        ? (body.customer_id ? v.id(body.customer_id, 'Customer') : null) : job.customer_id;

      db.prepare(`
        UPDATE jobs SET job_date = ?, kind = ?, customer = ?, address = ?, phone = ?,
                        customer_id = ?, details = ?, est_hours = ?, status = ?
         WHERE id = ?
      `).run(date, kind, customer, address, phone, customerId, details, estHours, status, job.id);

      if (Array.isArray(body.crew_ids)) {
        const crewIds = [...new Set(body.crew_ids.map((x) => v.id(x, 'Crew member')))];
        if (crewIds.length === 0) v.fail('A job needs at least one person on it');
        setCrew(db, job.id, crewIds);
      }

      return { job: loadJob(db, job.id) };
    },
  },

  {
    method: 'DELETE',
    path: '/api/office/jobs/:id',
    handler({ db, params }) {
      const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(params.id);
      if (!job) throw new HttpError(404, 'That job was not found');
      // Hours already put against the job survive; they just lose the customer name.
      db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
      return { ok: true };
    },
  },

  // ---- customers ---------------------------------------------------------

  {
    method: 'GET',
    path: '/api/office/customers',
    handler({ db, query }) {
      const search = v.text(query.q, 'Search', { max: 80 });
      return { customers: loadCustomers(db, search) };
    },
  },

  {
    method: 'GET',
    path: '/api/office/customers/:id',
    handler({ db, params }) {
      const customer = loadCustomer(db, v.id(params.id, 'Customer'));
      if (!customer) throw new HttpError(404, 'That customer was not found');

      const jobs = loadJobs(db, 'j.customer_id = ?', [customer.id]).reverse();
      const shifts = loadShifts(db,
        's.job_id IN (SELECT id FROM jobs WHERE customer_id = ?)', [customer.id]);

      return { customer, jobs, totals: shiftTotals(shifts) };
    },
  },

  {
    method: 'POST',
    path: '/api/office/customers',
    handler({ db, body }) {
      const name = v.text(body.name, 'Customer name', { required: true, max: 120 });
      const address = v.text(body.address, 'Address', { max: 200 });
      const phone = v.text(body.phone, 'Phone', { max: 40 });
      const notes = v.text(body.notes, 'Notes', { max: 2000 });

      const info = db.prepare(`
        INSERT INTO customers (name, address, phone, notes) VALUES (?, ?, ?, ?)
      `).run(name, address, phone, notes);

      return { customer: loadCustomer(db, Number(info.lastInsertRowid)) };
    },
  },

  {
    method: 'PATCH',
    path: '/api/office/customers/:id',
    handler({ db, params, body }) {
      const current = db.prepare('SELECT * FROM customers WHERE id = ?').get(params.id);
      if (!current) throw new HttpError(404, 'That customer was not found');

      const name = body.name != null
        ? v.text(body.name, 'Customer name', { required: true, max: 120 }) : current.name;
      const address = body.address !== undefined
        ? v.text(body.address, 'Address', { max: 200 }) : current.address;
      const phone = body.phone !== undefined
        ? v.text(body.phone, 'Phone', { max: 40 }) : current.phone;
      const notes = body.notes !== undefined
        ? v.text(body.notes, 'Notes', { max: 2000 }) : current.notes;
      const active = body.active != null ? (body.active ? 1 : 0) : current.active;

      db.prepare(`
        UPDATE customers SET name = ?, address = ?, phone = ?, notes = ?, active = ? WHERE id = ?
      `).run(name, address, phone, notes, active, current.id);

      return { customer: loadCustomer(db, current.id) };
    },
  },

  // ---- bringing a customer list in ---------------------------------------

  {
    method: 'POST',
    path: '/api/office/customers/import',
    handler({ db, body }) {
      const text = v.text(body.text, 'The list', { required: true, max: 1000000 });
      const onMatch = v.oneOf(body.on_match, 'What to do about matches',
        ['skip', 'update'], { required: false, fallback: 'skip' });
      const lookFirst = body.look_first !== false;

      const read = readCustomers(text);
      if (!read.customers.length) {
        throw new HttpError(400, read.problems.length
          ? 'Nothing in that had a customer name in it'
          : 'There was nothing in that to read');
      }

      // Everybody already on file, by name, so a second run over the same
      // list updates or skips rather than doubling everybody up.
      const onFile = new Map();
      for (const row of db.prepare('SELECT * FROM customers').all()) {
        onFile.set(sameName(row.name), row);
      }

      const seen = new Set();
      const toAdd = [];
      const toUpdate = [];
      const doubled = [];
      const matched = [];

      for (const one of read.customers) {
        const key = sameName(one.name);

        // The same name twice in one file: the first one wins.
        if (seen.has(key)) { doubled.push(one); continue; }
        seen.add(key);

        const already = onFile.get(key);
        if (!already) { toAdd.push(one); continue; }

        matched.push({ ...one, id: already.id });

        // Fill blanks only. What is on the books was typed by somebody who
        // had been to the house; a stale export must not talk over it.
        const next = {
          address: already.address || one.address,
          phone: already.phone || one.phone,
          notes: already.notes || one.notes,
        };
        const changes = Object.keys(next).filter((k) => (next[k] || '') !== (already[k] || ''));
        if (onMatch === 'update' && changes.length) {
          toUpdate.push({ ...one, id: already.id, changes, next });
        }
      }

      const summary = {
        read: read.customers.length,
        add: toAdd.length,
        update: toUpdate.length,
        already: matched.length - toUpdate.length,
        doubled: doubled.length,
        problems: read.problems,
        headed: read.headed,
        // What the office should check before committing: did the columns
        // land where they think they did?
        columns: read.columns ? Object.keys(read.columns) : [],
        look: [...toAdd, ...toUpdate].slice(0, 8).map((one) => ({
          name: one.name, address: one.address, phone: one.phone, notes: one.notes,
        })),
        most_rows: MOST_ROWS,
      };

      if (lookFirst) return { looked: true, ...summary };

      const insert = db.prepare(
        'INSERT INTO customers (name, address, phone, notes) VALUES (?, ?, ?, ?)',
      );
      const change = db.prepare(
        'UPDATE customers SET address = ?, phone = ?, notes = ? WHERE id = ?',
      );

      // All of it or none of it: a list half in is worse than one not in.
      db.exec('BEGIN');
      try {
        for (const one of toAdd) {
          insert.run(one.name, one.address || null, one.phone || null, one.notes || null);
        }
        for (const one of toUpdate) {
          change.run(one.next.address || null, one.next.phone || null,
            one.next.notes || null, one.id);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      return { looked: false, ...summary, customers: loadCustomers(db, null) };
    },
  },

  // ---- billing, and QuickBooks -------------------------------------------

  {
    method: 'GET',
    path: '/api/office/billing',
    handler({ db, query }) {
      const from = query.from ? v.date(query.from, 'From') : addDays(today(), -30);
      const to = query.to ? v.date(query.to, 'To') : today();

      // Every finished job in the window, with whatever the ledger knows.
      const jobs = db.prepare(`
        SELECT j.id FROM jobs j
         WHERE j.status = 'done' AND j.job_date BETWEEN ? AND ?
         ORDER BY j.job_date DESC, j.id DESC
      `).all(from, to);

      const rows = jobs.map((r) => {
        const seen = invoicing.preview(db, r.id);
        return {
          job_id: r.id,
          job_date: seen.job.job_date,
          customer: seen.job.customer,
          customer_id: seen.job.customer_id,
          kind: seen.job.kind,
          address: seen.job.address,
          materials: seen.job.materials,
          quoted_price: seen.job.quoted_price,
          parts_price: seen.job.parts_price,
          no_charge: Boolean(seen.job.no_charge),
          hours: seen.hours,
          rate: seen.rate,
          total: seen.total,
          lines: seen.lines,
          reasons: seen.reasons,
          ready: seen.ok,
          status: seen.invoice ? seen.invoice.status : 'waiting',
          qbo_id: seen.invoice ? seen.invoice.qbo_id : null,
          doc_number: seen.invoice ? seen.invoice.doc_number : null,
          why: seen.invoice ? seen.invoice.why : null,
          sent_at: seen.invoice ? seen.invoice.sent_at : null,
        };
      });

      const billed = rows.filter((r) => r.status === 'sent');

      return {
        from,
        to,
        rows,
        settings: settingsStore.forOffice(db),
        totals: {
          ready: rows.filter((r) => r.ready && r.status !== 'sent').length,
          held: rows.filter((r) => r.status === 'holding' || r.status === 'failed').length,
          sent: billed.length,
          billed: round2(billed.reduce((t, r) => t + (r.total || 0), 0)),
          waiting: round2(rows.filter((r) => r.status !== 'sent' && !r.no_charge)
            .reduce((t, r) => t + (r.total || 0), 0)),
        },
      };
    },
  },

  // What to charge for one job. The office sets this, not the crew.
  {
    method: 'PATCH',
    path: '/api/office/billing/:id',
    handler({ db, params, body }) {
      const jobId = v.id(params.id, 'Job');
      const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(jobId);
      if (!job) throw new HttpError(404, 'That job was not found');

      if (body.quoted_price !== undefined) {
        const price = body.quoted_price === null || body.quoted_price === ''
          ? null : v.decimal(body.quoted_price, 'Quoted price', { max: 1000000 });
        db.prepare('UPDATE jobs SET quoted_price = ? WHERE id = ?').run(price, jobId);
      }

      if (body.parts_price !== undefined) {
        const price = body.parts_price === null || body.parts_price === ''
          ? null : v.decimal(body.parts_price, 'Parts price', { max: 1000000 });
        db.prepare('UPDATE jobs SET parts_price = ? WHERE id = ?').run(price, jobId);
      }

      if (body.no_charge !== undefined) {
        db.prepare('UPDATE jobs SET no_charge = ? WHERE id = ?').run(body.no_charge ? 1 : 0, jobId);
      }

      return { job: invoicing.preview(db, jobId) };
    },
  },

  {
    method: 'POST',
    path: '/api/office/billing/:id/send',
    async handler({ db, params, body }) {
      const jobId = v.id(params.id, 'Job');
      const out = await invoicing.send(db, jobId, { force: Boolean(body && body.force) });
      if (!out.invoice && !out.ok) throw new HttpError(400, out.why || 'That did not send');
      return out;
    },
  },

  // Send everything that is ready, in one go.
  {
    method: 'POST',
    path: '/api/office/billing/send-ready',
    async handler({ db }) {
      const waiting = db.prepare(`
        SELECT j.id FROM jobs j
        LEFT JOIN invoices i ON i.job_id = j.id
         WHERE j.status = 'done' AND (i.qbo_id IS NULL)
         ORDER BY j.job_date ASC, j.id ASC
         LIMIT 100
      `).all();

      let sent = 0;
      const stuck = [];

      for (const row of waiting) {
        const seen = invoicing.preview(db, row.id);
        if (!seen || !seen.ok) continue;

        // eslint-disable-next-line no-await-in-loop
        const out = await invoicing.send(db, row.id);
        if (out.ok) sent += 1;
        else stuck.push({ job_id: row.id, why: out.invoice ? out.invoice.why : 'Did not send' });
      }

      return { sent, stuck };
    },
  },

  {
    method: 'PUT',
    path: '/api/office/billing/settings',
    handler({ db, body }) {
      const patch = {};

      if (body.bill_rate !== undefined) {
        patch.bill_rate = String(v.decimal(body.bill_rate, 'Hourly rate to charge', { max: 10000 }) || 0);
      }
      if (body.labour_item !== undefined) {
        patch.labour_item = v.text(body.labour_item, 'Labour item', { required: true, max: 100 });
      }
      if (body.parts_item !== undefined) {
        patch.parts_item = v.text(body.parts_item, 'Parts item', { required: true, max: 100 });
      }
      if (body.auto_send !== undefined) patch.auto_send = body.auto_send ? '1' : '0';
      if (body.qbo_env !== undefined) {
        patch.qbo_env = v.oneOf(body.qbo_env, 'Which company file', ['sandbox', 'production']);
      }
      if (body.qbo_client_id !== undefined) {
        patch.qbo_client_id = v.text(body.qbo_client_id, 'Client ID', { max: 200 }) || '';
      }
      if (body.qbo_client_secret !== undefined) {
        patch.qbo_client_secret = v.text(body.qbo_client_secret, 'Client secret', { max: 200 }) || '';
      }
      if (body.qbo_realm_id !== undefined) {
        patch.qbo_realm_id = v.text(body.qbo_realm_id, 'Company ID', { max: 100 }) || '';
      }

      settingsStore.putMany(db, patch);
      return { settings: settingsStore.forOffice(db) };
    },
  },

  // Step one of connecting: where to send the office to say yes.
  {
    method: 'GET',
    path: '/api/office/quickbooks/link',
    handler({ db, query }) {
      const s = settingsStore.all(db);
      if (!s.qbo_client_id) throw new HttpError(400, 'Put your QuickBooks keys in first');

      const redirectUri = v.text(query.redirect_uri, 'Return address', { required: true, max: 500 });
      const state = require('node:crypto').randomBytes(16).toString('hex');
      settingsStore.put(db, 'qbo_state', state);

      return { url: consentUrl({ clientId: s.qbo_client_id, redirectUri, state }) };
    },
  },

  // Step two: QuickBooks sends them back with a code.
  {
    method: 'POST',
    path: '/api/office/quickbooks/finish',
    async handler({ db, body }) {
      const code = v.text(body.code, 'Code from QuickBooks', { required: true, max: 500 });
      const realm = v.text(body.realm_id, 'Company ID', { required: true, max: 100 });
      const redirectUri = v.text(body.redirect_uri, 'Return address', { required: true, max: 500 });
      const state = v.text(body.state, 'State', { max: 200 });

      const expected = settingsStore.get(db, 'qbo_state');
      if (!expected || state !== expected) {
        throw new HttpError(400, 'That sign-in did not come back the way it went out. Try again.');
      }
      settingsStore.put(db, 'qbo_state', '');
      settingsStore.put(db, 'qbo_realm_id', realm);

      const live = settingsStore.all(db);
      const qbo = require('../quickbooks').makeClient({
        settings: live,
        saveTokens(tokens) {
          settingsStore.putMany(db, {
            qbo_access_token: tokens.access_token,
            qbo_refresh_token: tokens.refresh_token,
            qbo_access_expires: String(tokens.expires_at),
            qbo_connected_at: new Date().toISOString(),
          });
        },
      });

      await qbo.exchangeCode({ code, redirectUri });
      return { settings: settingsStore.forOffice(db) };
    },
  },

  {
    method: 'POST',
    path: '/api/office/quickbooks/disconnect',
    async handler({ db }) {
      try {
        const live = settingsStore.all(db);
        if (live.qbo_refresh_token) {
          await require('../quickbooks').makeClient({ settings: live }).revoke();
        }
      } catch {
        // Losing our copy matters more than tidying up their end.
      }

      settingsStore.putMany(db, {
        qbo_access_token: '', qbo_refresh_token: '', qbo_access_expires: '',
        qbo_connected_at: '', qbo_realm_id: '',
      });

      return { settings: settingsStore.forOffice(db) };
    },
  },

  // ---- the week at a glance ----------------------------------------------

  {
    method: 'GET',
    path: '/api/office/week',
    handler({ db, query }) {
      const from = query.from ? v.date(query.from, 'From') : weekStart(today());
      const to = addDays(from, 6);

      const jobs = loadJobs(db, 'j.job_date BETWEEN ? AND ?', [from, to]);
      const shifts = loadShifts(db, 's.work_date BETWEEN ? AND ?', [from, to]);

      const days = [];
      for (let i = 0; i < 7; i += 1) {
        const date = addDays(from, i);
        const onDay = jobs.filter((j) => j.job_date === date);
        const worked = shifts.filter((s) => s.work_date === date && s.status !== 'question');

        days.push({
          date,
          jobs: onDay,
          hours: round2(worked.reduce((t, s) => t + s.hours, 0)),
          pay: round2(worked.reduce((t, s) => t + s.pay, 0)),
          done: onDay.filter((j) => j.status === 'done').length,
        });
      }

      // Who is spoken for on each day, so double-booking is visible.
      const people = db.prepare("SELECT id, name FROM employees WHERE active = 1 AND role = 'crew' ORDER BY name").all();

      return {
        from,
        to,
        days,
        people,
        totals: {
          jobs: jobs.length,
          hours: round2(days.reduce((t, d) => t + d.hours, 0)),
          pay: round2(days.reduce((t, d) => t + d.pay, 0)),
        },
      };
    },
  },

  // ---- put the same job out again ----------------------------------------

  {
    method: 'POST',
    path: '/api/office/jobs/:id/copy',
    handler({ db, user, params, body }) {
      const source = db.prepare('SELECT * FROM jobs WHERE id = ?').get(params.id);
      if (!source) throw new HttpError(404, 'That job was not found');

      const crew = db.prepare('SELECT employee_id FROM crew_on_job WHERE job_id = ?')
        .all(source.id).map((r) => r.employee_id);

      let dates = [];

      if (Array.isArray(body.dates) && body.dates.length) {
        dates = body.dates.map((d) => v.date(d, 'Day'));
      } else {
        // Seasonal work repeats: same day of the week, so many weeks running.
        const weeks = v.whole(body.every_weeks_for, 'Number of weeks',
          { min: 1, max: 26, fallback: 0 });
        if (!weeks) v.fail('Say which days to copy it to, or how many weeks to repeat it');
        for (let i = 1; i <= weeks; i += 1) dates.push(addDays(source.job_date, i * 7));
      }

      if (dates.length > 26) v.fail('That is more copies than this will make at once');

      const insert = db.prepare(`
        INSERT INTO jobs (job_date, kind, customer, address, phone, customer_id, details,
                          est_hours, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const addCrew = db.prepare('INSERT INTO crew_on_job (job_id, employee_id) VALUES (?, ?)');

      const made = [];
      for (const date of dates) {
        const info = insert.run(date, source.kind, source.customer, source.address,
          source.phone, source.customer_id, source.details, source.est_hours, user.id);
        const jobId = Number(info.lastInsertRowid);
        for (const employeeId of crew) addCrew.run(jobId, employeeId);
        made.push(jobId);
      }

      return { made: made.length, jobs: made.map((id) => loadJob(db, id)) };
    },
  },

  // ---- find anything -----------------------------------------------------

  {
    method: 'GET',
    path: '/api/office/search',
    handler({ db, query }) {
      const term = v.text(query.q, 'Search', { max: 80 });
      if (!term || term.length < 2) return { term: term || '', customers: [], jobs: [] };

      const like = `%${term}%`;

      return {
        term,
        customers: loadCustomers(db, term).slice(0, 12),
        jobs: loadJobs(db,
          '(j.customer LIKE ? OR j.address LIKE ? OR j.details LIKE ? OR j.materials LIKE ?)',
          [like, like, like, like]).reverse().slice(0, 25),
      };
    },
  },

  // ---- hours -------------------------------------------------------------

  {
    method: 'GET',
    path: '/api/office/waiting',
    handler({ db }) {
      const shifts = loadShifts(db, "s.status = 'sent'");
      return { shifts, totals: shiftTotals(shifts) };
    },
  },

  { method: 'POST', path: '/api/office/shifts/:id/ok', handler: review('ok') },
  { method: 'POST', path: '/api/office/shifts/:id/question', handler: review('question') },

  {
    method: 'POST',
    path: '/api/office/shifts/:id/reopen',
    handler({ db, params }) {
      const shift = getShift(db, params.id);
      db.prepare(`
        UPDATE shifts SET status = 'sent', question = NULL, reviewed_by = NULL,
                          reviewed_at = NULL, updated_at = datetime('now')
         WHERE id = ?
      `).run(shift.id);
      return { shift: loadShift(db, shift.id) };
    },
  },

  {
    method: 'PATCH',
    path: '/api/office/shifts/:id',
    handler({ db, params, body }) {
      const shift = getShift(db, params.id);

      const start = body.start_time != null ? v.time(body.start_time, 'Start time') : shift.start_time;
      const end = body.end_time !== undefined
        ? v.time(body.end_time, 'Finish time', { required: false }) : shift.end_time;
      const breakMinutes = body.break_minutes != null
        ? v.whole(body.break_minutes, 'Break', { min: 0, max: 24 * 60 }) : shift.break_minutes;
      const notes = body.notes !== undefined
        ? v.text(body.notes, 'Notes', { max: 1000 }) : shift.notes;

      v.shiftMakesSense(start, end, breakMinutes);

      db.prepare(`
        UPDATE shifts SET start_time = ?, end_time = ?, break_minutes = ?, notes = ?,
                          updated_at = datetime('now')
         WHERE id = ?
      `).run(start, end, breakMinutes, notes, shift.id);

      return { shift: loadShift(db, shift.id) };
    },
  },

  {
    method: 'DELETE',
    path: '/api/office/shifts/:id',
    handler({ db, params }) {
      const shift = getShift(db, params.id);
      db.prepare('DELETE FROM shifts WHERE id = ?').run(shift.id);
      return { ok: true };
    },
  },

  // ---- the crew ----------------------------------------------------------

  {
    method: 'GET',
    path: '/api/office/people',
    handler({ db, query }) {
      const rows = query.include_past === '1'
        ? db.prepare('SELECT * FROM employees ORDER BY active DESC, name').all()
        : db.prepare('SELECT * FROM employees WHERE active = 1 ORDER BY name').all();
      return { people: rows.map(publicPerson) };
    },
  },

  {
    method: 'POST',
    path: '/api/office/people',
    handler({ db, body }) {
      const name = v.text(body.name, 'Name', { required: true, max: 80 });
      const username = v.username(body.username);
      const pin = v.pin(body.pin);
      const role = v.oneOf(body.role, 'Where they work', ['crew', 'office'],
        { required: false, fallback: 'crew' });
      const rate = v.decimal(body.hourly_rate, 'Hourly rate', { max: 10000, fallback: 0 }) ?? 0;
      const phone = v.text(body.phone, 'Phone', { max: 40 });

      if (db.prepare('SELECT id FROM employees WHERE username = ? COLLATE NOCASE').get(username)) {
        throw new HttpError(409, 'Somebody already signs in with that name');
      }

      const info = db.prepare(`
        INSERT INTO employees (name, username, pin_hash, role, hourly_rate, phone)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(name, username, auth.hashPin(pin), role, rate, phone);

      return { person: publicPerson(getPerson(db, Number(info.lastInsertRowid))) };
    },
  },

  {
    method: 'PATCH',
    path: '/api/office/people/:id',
    handler({ db, user, params, body }) {
      const person = getPerson(db, params.id);

      const name = body.name != null ? v.text(body.name, 'Name', { required: true, max: 80 }) : person.name;
      const role = body.role != null ? v.oneOf(body.role, 'Where they work', ['crew', 'office']) : person.role;
      const rate = body.hourly_rate != null
        ? v.decimal(body.hourly_rate, 'Hourly rate', { max: 10000, fallback: 0 }) : person.hourly_rate;
      const phone = body.phone !== undefined ? v.text(body.phone, 'Phone', { max: 40 }) : person.phone;
      const active = body.active != null ? (body.active ? 1 : 0) : person.active;

      // Never let the last office account lock everybody out.
      if (person.role === 'office' && (role !== 'office' || !active)) {
        const others = db.prepare(
          "SELECT COUNT(*) AS n FROM employees WHERE role = 'office' AND active = 1 AND id != ?"
        ).get(person.id).n;
        if (others === 0) throw new HttpError(409, 'This is the last office account — keep it working');
      }
      if (person.id === user.id && !active) {
        throw new HttpError(409, 'You cannot switch off your own account');
      }

      db.prepare(`
        UPDATE employees SET name = ?, role = ?, hourly_rate = ?, phone = ?, active = ? WHERE id = ?
      `).run(name, role, rate ?? 0, phone, active, person.id);

      if (!active) auth.endAllSessions(db, person.id);

      return { person: publicPerson(getPerson(db, person.id)) };
    },
  },

  {
    method: 'POST',
    path: '/api/office/people/:id/pin',
    handler({ db, params, body }) {
      const person = getPerson(db, params.id);
      const pin = v.pin(body.pin);

      db.prepare('UPDATE employees SET pin_hash = ? WHERE id = ?').run(auth.hashPin(pin), person.id);
      auth.endAllSessions(db, person.id);

      return { ok: true };
    },
  },

  // ---- notices -----------------------------------------------------------

  {
    method: 'GET',
    path: '/api/office/notices',
    handler({ db }) {
      const notices = db.prepare(`
        SELECT n.id, n.title, n.body, n.urgent, n.posted_at, e.name AS posted_by_name
          FROM notices n
          LEFT JOIN employees e ON e.id = n.posted_by
         ORDER BY n.urgent DESC, n.posted_at DESC
         LIMIT 50
      `).all();

      if (notices.length === 0) return { notices: [] };

      const slots = notices.map(() => '?').join(', ');
      const seen = db.prepare(`
        SELECT s.notice_id, e.name
          FROM notice_seen s
          JOIN employees e ON e.id = s.employee_id
         WHERE s.notice_id IN (${slots})
         ORDER BY e.name
      `).all(...notices.map((n) => n.id));

      const crewCount = db.prepare(
        "SELECT COUNT(*) AS n FROM employees WHERE active = 1 AND role = 'crew'"
      ).get().n;

      const byNotice = new Map();
      for (const row of seen) {
        if (!byNotice.has(row.notice_id)) byNotice.set(row.notice_id, []);
        byNotice.get(row.notice_id).push(row.name);
      }

      return {
        notices: notices.map((n) => ({
          ...n,
          seen_by: byNotice.get(n.id) || [],
          crew_count: crewCount,
        })),
      };
    },
  },

  {
    method: 'POST',
    path: '/api/office/notices',
    handler({ db, user, body }) {
      const title = v.text(body.title, 'Heading', { required: true, max: 120 });
      const text = v.text(body.body, 'The message', { required: true, max: 3000 });
      const urgent = body.urgent ? 1 : 0;

      const info = db.prepare(`
        INSERT INTO notices (title, body, urgent, posted_by) VALUES (?, ?, ?, ?)
      `).run(title, text, urgent, user.id);

      return {
        notice: db.prepare('SELECT * FROM notices WHERE id = ?').get(Number(info.lastInsertRowid)),
      };
    },
  },

  {
    method: 'DELETE',
    path: '/api/office/notices/:id',
    handler({ db, params }) {
      const notice = db.prepare('SELECT id FROM notices WHERE id = ?').get(params.id);
      if (!notice) throw new HttpError(404, 'That announcement was not found');
      db.prepare('DELETE FROM notices WHERE id = ?').run(notice.id);
      return { ok: true };
    },
  },

  // ---- payroll -----------------------------------------------------------

  {
    method: 'GET',
    path: '/api/office/payroll',
    handler({ db, query }) {
      const from = query.from ? v.date(query.from, 'From') : weekStart(today());
      const to = query.to ? v.date(query.to, 'To') : addDays(from, 6);

      const where = ['s.work_date BETWEEN ? AND ?'];
      const params = [from, to];
      if (query.employee_id) {
        where.push('s.employee_id = ?');
        params.push(v.id(query.employee_id, 'Crew member'));
      }

      const shifts = loadShifts(db, where.join(' AND '), params);
      const perPerson = new Map();

      for (const shift of shifts) {
        if (shift.status === 'question') continue;

        if (!perPerson.has(shift.employee_id)) {
          perPerson.set(shift.employee_id, {
            employee_id: shift.employee_id,
            name: shift.employee_name,
            hourly_rate: shift.hourly_rate,
            shifts: 0, hours: 0, ok_hours: 0, waiting_hours: 0, pay: 0,
          });
        }

        const row = perPerson.get(shift.employee_id);
        row.shifts += 1;
        row.hours = round2(row.hours + shift.hours);
        row.pay = round2(row.pay + shift.pay);
        if (shift.status === 'ok') row.ok_hours = round2(row.ok_hours + shift.hours);
        else row.waiting_hours = round2(row.waiting_hours + shift.hours);
      }

      const rows = [...perPerson.values()]
        .map((row) => ({ ...row, over_40: round2(Math.max(0, row.hours - 40)) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      // What went into the ground over the period, for billing and restocking.
      const parts = loadJobs(db, `
        j.job_date BETWEEN ? AND ? AND j.status = 'done'
        AND j.materials IS NOT NULL AND TRIM(j.materials) != ''
      `, [from, to]).map((j) => ({
        job_id: j.id,
        job_date: j.job_date,
        customer: j.customer,
        kind: j.kind,
        materials: j.materials,
      }));

      return {
        from,
        to,
        rows,
        shifts,
        parts,
        days: Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1,
        totals: {
          hours: round2(rows.reduce((t, r) => t + r.hours, 0)),
          ok_hours: round2(rows.reduce((t, r) => t + r.ok_hours, 0)),
          over_40: round2(rows.reduce((t, r) => t + r.over_40, 0)),
          pay: round2(rows.reduce((t, r) => t + r.pay, 0)),
        },
      };
    },
  },

  {
    method: 'GET',
    path: '/api/office/payroll.csv',
    handler({ db, query, res }) {
      const from = query.from ? v.date(query.from, 'From') : weekStart(today());
      const to = query.to ? v.date(query.to, 'To') : addDays(from, 6);

      const where = ['s.work_date BETWEEN ? AND ?'];
      const params = [from, to];
      if (query.employee_id) {
        where.push('s.employee_id = ?');
        params.push(v.id(query.employee_id, 'Crew member'));
      }

      const shifts = loadShifts(db, where.join(' AND '), params)
        .filter((s) => s.status !== 'question');

      const head = ['Day', 'Name', 'Customer', 'Address', 'Type of work', 'Started', 'Finished',
                    'Break (min)', 'Hours', 'Rate', 'Pay', 'Where it is at', 'Notes'];

      const lines = [head.map(csvCell).join(',')];
      for (const s of shifts) {
        lines.push([
          s.work_date, s.employee_name, s.job_customer || s.other_work || 'Other work',
          s.job_address || '', s.job_kind || '', s.start_time, s.end_time || '',
          s.break_minutes, s.hours, s.hourly_rate, s.pay,
          s.status === 'ok' ? "OK'd" : 'Waiting', s.notes || '',
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

/*
 * Every office screen shows the same two numbers up in its tab bar. Rather
 * than the browser asking for them again after each switch, each GET carries
 * them home — one round trip per screen instead of two.
 */
module.exports = module.exports.map((route) => {
  if (route.method !== 'GET' || route.path.endsWith('.csv')) return route;

  const inner = route.handler;

  return {
    ...route,
    handler(ctx) {
      const result = inner(ctx);
      if (!result || typeof result !== 'object') return result;
      return { ...result, counts: officeCounts(ctx.db) };
    },
  };
});
