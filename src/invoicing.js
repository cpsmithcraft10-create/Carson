'use strict';

/**
 * A finished job, all the way to an invoice in QuickBooks.
 *
 * The one rule this file exists to keep: a job gets one invoice. Whatever
 * happens — a retry, a double click, the auto-send racing the office — the
 * customer must never see the same day's work billed twice. That is what the
 * unique job_id on the invoices table and the stored QuickBooks id are for.
 */

const settingsStore = require('./settings');
const { buildInvoice } = require('./billing');
const { makeClient, QuickBooksError } = require('./quickbooks');
const { loadShifts } = require('./queries');

/**
 * A seam for the tests: they hand in a fake QuickBooks so the whole
 * send-an-invoice path can run without a network, and without anybody's real
 * company file. Production never sets this.
 */
let testFetch = null;
function setFetch(fn) { testFetch = fn; }

/** A send that has been "in progress" longer than this was abandoned. */
const STALE_CLAIM_MS = 2 * 60 * 1000;

/** The ledger row for a job, made if it is not there yet. */
function ledger(db, jobId) {
  const found = db.prepare('SELECT * FROM invoices WHERE job_id = ?').get(jobId);
  if (found) return found;

  db.prepare('INSERT INTO invoices (job_id, status) VALUES (?, ?)').run(jobId, 'waiting');
  return db.prepare('SELECT * FROM invoices WHERE job_id = ?').get(jobId);
}

function mark(db, jobId, patch) {
  const row = ledger(db, jobId);
  const next = { ...row, ...patch };

  db.prepare(`
    UPDATE invoices
       SET status = ?, qbo_id = ?, doc_number = ?, total = ?, why = ?,
           tried_at = ?, sent_at = ?
     WHERE job_id = ?
  `).run(next.status, next.qbo_id || null, next.doc_number || null,
    next.total == null ? null : next.total, next.why || null,
    next.tried_at || null, next.sent_at || null, jobId);

  return db.prepare('SELECT * FROM invoices WHERE job_id = ?').get(jobId);
}

function jobWithCustomer(db, jobId) {
  return db.prepare(`
    SELECT j.*, c.name AS customer_name, c.address AS customer_address,
           c.phone AS customer_phone, c.qbo_id AS customer_qbo_id
      FROM jobs j
      LEFT JOIN customers c ON c.id = j.customer_id
     WHERE j.id = ?
  `).get(jobId);
}

/**
 * What would be billed for this job, and whether it can be. Reads only — the
 * office looks at this before anything is sent.
 */
function preview(db, jobId) {
  const job = jobWithCustomer(db, jobId);
  if (!job) return null;

  const shifts = loadShifts(db, 's.job_id = ?', [jobId]);
  const built = buildInvoice(job, shifts, settingsStore.all(db));
  const row = db.prepare('SELECT * FROM invoices WHERE job_id = ?').get(jobId);

  return { job, shifts, ...built, invoice: row || null };
}

/** The QuickBooks body for an invoice. Kept separate so a test can read it. */
function invoiceBody({ job, built, customerRef, itemRefs }) {
  return {
    CustomerRef: { value: String(customerRef) },
    TxnDate: job.job_date,
    // Ties the invoice back to the job, both for a person reading it in
    // QuickBooks and for us if the stored id is ever lost.
    PrivateNote: `Custom Outdoor Design job #${job.id} on ${job.job_date}`,
    Line: built.lines.map((line) => ({
      DetailType: 'SalesItemLineDetail',
      Amount: line.amount,
      Description: line.description,
      SalesItemLineDetail: {
        ItemRef: { value: String(itemRefs[line.item]) },
        Qty: line.qty,
        UnitPrice: line.unit,
      },
    })),
  };
}

/**
 * Send one job to QuickBooks.
 *
 * Returns the ledger row either way; it does not throw for an ordinary
 * refusal, because "why did this not go" belongs on the screen.
 */
async function send(db, jobId, { fetchImpl, force = false } = {}) {
  const job = jobWithCustomer(db, jobId);
  if (!job) return { ok: false, why: 'That job was not found' };

  const row = ledger(db, jobId);

  // Already billed. This is the guard that matters most.
  if (row.qbo_id && !force) {
    return { ok: true, already: true, invoice: row };
  }

  const settings = settingsStore.all(db);
  const built = buildInvoice(job, loadShifts(db, 's.job_id = ?', [jobId]), settings);

  if (built.skip) {
    return { ok: false, invoice: mark(db, jobId, { status: 'skipped', why: built.reasons[0], total: 0 }) };
  }

  if (!built.ok) {
    return {
      ok: false,
      invoice: mark(db, jobId, {
        status: 'holding',
        why: built.reasons.join('. '),
        total: built.total,
        tried_at: new Date().toISOString(),
      }),
    };
  }

  if (!settingsStore.qboReady(db)) {
    return {
      ok: false,
      invoice: mark(db, jobId, {
        status: 'holding',
        why: 'QuickBooks is not connected yet',
        total: built.total,
      }),
    };
  }

  // Claim the job before going anywhere near QuickBooks. Checking the ledger
  // and then sending is two steps, and two sends that both read "not billed
  // yet" would both raise an invoice — which is the one thing that must never
  // happen. This single UPDATE is the whole guard: only the call that changes
  // a row goes on to send. A claim older than the timeout is treated as
  // abandoned, so a crash mid-send does not wedge the job forever.
  const claimed = db.prepare(`
    UPDATE invoices
       SET status = 'sending', tried_at = ?
     WHERE job_id = ?
       AND qbo_id IS NULL
       AND (status <> 'sending' OR tried_at IS NULL OR tried_at < ?)
  `).run(new Date().toISOString(), jobId,
    new Date(Date.now() - STALE_CLAIM_MS).toISOString());

  if (claimed.changes === 0) {
    const current = db.prepare('SELECT * FROM invoices WHERE job_id = ?').get(jobId);
    if (current && current.qbo_id) return { ok: true, already: true, invoice: current };
    return { ok: false, busy: true, invoice: current, why: 'That one is already being sent' };
  }

  const qbo = makeClient({
    fetchImpl: fetchImpl || testFetch,
    settings,
    saveTokens(tokens) {
      settingsStore.putMany(db, {
        qbo_access_token: tokens.access_token,
        qbo_refresh_token: tokens.refresh_token,
        qbo_access_expires: String(tokens.expires_at),
      });
    },
  });

  try {
    // ---- who to bill ----------------------------------------------------
    let customerRef = job.customer_qbo_id;

    if (!customerRef) {
      const found = await qbo.findCustomer(job.customer_name || job.customer);
      if (found) {
        customerRef = found.Id;
      } else {
        const made = await qbo.createCustomer({
          name: job.customer_name || job.customer,
          address: job.customer_address || job.address,
          phone: job.customer_phone || job.phone,
        });
        if (!made) throw new QuickBooksError('QuickBooks would not take that customer');
        customerRef = made.Id;
      }

      // Remember it, so every later invoice for them is one call shorter and
      // cannot land on a different customer of the same name.
      if (job.customer_id) {
        db.prepare('UPDATE customers SET qbo_id = ? WHERE id = ?').run(String(customerRef), job.customer_id);
      }
    }

    // ---- what to put on it ----------------------------------------------
    const itemRefs = {};
    for (const wanted of [...new Set(built.lines.map((l) => l.item))]) {
      const item = await qbo.findItem(wanted);
      if (!item) {
        return {
          ok: false,
          invoice: mark(db, jobId, {
            status: 'holding',
            total: built.total,
            why: `QuickBooks has no product or service called "${wanted}". `
              + 'Add it there, or change the name under Billing settings.',
            tried_at: new Date().toISOString(),
          }),
        };
      }
      itemRefs[wanted] = item.Id;
    }

    const made = await qbo.createInvoice(invoiceBody({ job, built, customerRef, itemRefs }));
    if (!made || !made.Id) throw new QuickBooksError('QuickBooks did not hand back an invoice');

    return {
      ok: true,
      invoice: mark(db, jobId, {
        status: 'sent',
        qbo_id: String(made.Id),
        doc_number: made.DocNumber || null,
        total: built.total,
        why: null,
        tried_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
      }),
    };
  } catch (err) {
    const why = err instanceof QuickBooksError ? err.message : (err.message || 'That did not send');
    return {
      ok: false,
      retryable: Boolean(err.retryable),
      invoice: mark(db, jobId, {
        status: 'failed',
        total: built.total,
        why,
        tried_at: new Date().toISOString(),
      }),
    };
  }
}

/**
 * Called the moment the crew mark a job finished. Never throws and never
 * blocks the crew: if billing is not set up, or the price is not known yet,
 * the job simply waits in the billing queue for somebody to look at.
 */
async function onJobFinished(db, jobId, { fetchImpl } = {}) {
  try {
    ledger(db, jobId);
    if (!settingsStore.on(db, 'auto_send')) {
      return mark(db, jobId, { status: 'waiting', why: 'Waiting for you to send it' });
    }
    const out = await send(db, jobId, { fetchImpl });
    return out.invoice;
  } catch {
    // The crew's job is finished whatever the accounts think.
    return null;
  }
}

module.exports = {
  ledger, mark, preview, invoiceBody, send, onJobFinished, jobWithCustomer,
  setFetch, STALE_CLAIM_MS,
};
