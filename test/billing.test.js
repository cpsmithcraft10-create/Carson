'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { open } = require('../src/db');
const auth = require('../src/auth');
const { createServer } = require('../server');
const { today } = require('../src/time');
const { buildInvoice, billableHours } = require('../src/billing');
const settingsStore = require('../src/settings');
const invoicing = require('../src/invoicing');
const { consentUrl, quote, readFault, makeClient } = require('../src/quickbooks');

/* ===================== working out what to bill ===================== */

const SETTINGS = { bill_rate: 95, labour_item: 'Labour', parts_item: 'Materials' };

function aJob(over) {
  return {
    id: 1, job_date: '2026-09-21', kind: 'sprinkler', customer: 'Weaver residence',
    address: '1420 Oak Hollow Dr', customer_id: 7, status: 'done',
    quoted_price: null, parts_price: null, materials: null, no_charge: 0, ...over,
  };
}

const okShift = (hours) => ({ status: 'ok', end_time: '16:00', hours });

test('hours times the rate, and only hours the office has OK\'d', () => {
  const built = buildInvoice(aJob(), [
    okShift(4),
    { status: 'sent', end_time: '16:00', hours: 3 },   // not approved yet
    { status: 'open', end_time: null, hours: 0 },      // still on the clock
  ], SETTINGS);

  assert.equal(billableHours([okShift(4), { status: 'sent', end_time: '1', hours: 3 }]), 4);
  assert.equal(built.ok, true);
  assert.equal(built.hours, 4);
  assert.equal(built.total, 380);
  assert.equal(built.lines.length, 1);
  assert.equal(built.lines[0].item, 'Labour');
  assert.equal(built.lines[0].qty, 4);
  assert.equal(built.lines[0].unit, 95);
  assert.match(built.lines[0].description, /Sprinkler system at 1420 Oak Hollow Dr on 2026-09-21/);
});

test('a quoted price wins over the hours, which is the point of quoting', () => {
  const built = buildInvoice(aJob({ quoted_price: 1200 }), [okShift(14)], SETTINGS);

  assert.equal(built.ok, true);
  assert.equal(built.total, 1200);
  assert.equal(built.lines.length, 1);
  assert.equal(built.lines[0].kind, 'quoted');
});

test('parts go on at what the office charges, not what they cost', () => {
  const built = buildInvoice(
    aJob({ materials: '1x 4" pop-up, 2x swing joint', parts_price: 64.5 }),
    [okShift(2)], SETTINGS,
  );

  assert.equal(built.ok, true);
  assert.equal(built.total, 254.5);
  assert.equal(built.lines.length, 2);
  assert.equal(built.lines[1].item, 'Materials');
  assert.match(built.lines[1].description, /pop-up/);
});

test('parts used with no price set are flagged rather than billed at nothing', () => {
  const built = buildInvoice(aJob({ materials: 'a truckload of pipe' }), [okShift(2)], SETTINGS);

  assert.equal(built.ok, false);
  assert.match(built.reasons.join(' '), /no price is set for them/i);
});

test('no rate means no invoice, rather than an invoice for nothing', () => {
  const built = buildInvoice(aJob(), [okShift(6)], { ...SETTINGS, bill_rate: 0 });

  assert.equal(built.ok, false);
  assert.equal(built.total, 0);
  assert.match(built.reasons.join(' '), /No hourly rate set/i);
});

test('a job with nobody to bill is held, not guessed at', () => {
  const built = buildInvoice(aJob({ customer_id: null }), [okShift(3)], SETTINGS);

  assert.equal(built.ok, false);
  assert.match(built.reasons.join(' '), /nobody to bill/i);
});

test('an unfinished job is not billable', () => {
  const built = buildInvoice(aJob({ status: 'working' }), [okShift(3)], SETTINGS);
  assert.equal(built.ok, false);
  assert.match(built.reasons.join(' '), /not marked this finished/i);
});

test('no charge means no charge', () => {
  const built = buildInvoice(aJob({ no_charge: 1, quoted_price: 500 }), [okShift(3)], SETTINGS);
  assert.equal(built.skip, true);
  assert.equal(built.total, 0);
  assert.equal(built.lines.length, 0);
});

test('money lands on two decimal places', () => {
  const built = buildInvoice(aJob(), [okShift(3.33)], { ...SETTINGS, bill_rate: 97.5 });
  assert.equal(built.total, 324.68);
});

/* ======================= the QuickBooks client ====================== */

test('a quote in a customer name cannot break the query', () => {
  assert.equal(quote("O'Brien Landscaping"), "O''Brien Landscaping");
});

test('a QuickBooks fault is read back as something a person can act on', () => {
  const said = readFault({
    Fault: { Error: [{ Message: 'Invalid Reference Id', Detail: 'Item 99 not found' }] },
  }, 400);
  assert.equal(said, 'Invalid Reference Id — Item 99 not found');
});

test('the consent link carries what Intuit needs', () => {
  const url = new URL(consentUrl({
    clientId: 'abc', redirectUri: 'https://example.com/cb', state: 'xyz',
  }));

  assert.equal(url.origin + url.pathname, 'https://appcenter.intuit.com/connect/oauth2');
  assert.equal(url.searchParams.get('client_id'), 'abc');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.com/cb');
  assert.equal(url.searchParams.get('state'), 'xyz');
});

test('an expired access token is refreshed before the call, once', async () => {
  const calls = [];
  const settings = {
    qbo_env: 'sandbox', qbo_realm_id: '9130', qbo_client_id: 'id', qbo_client_secret: 'secret',
    qbo_refresh_token: 'old-refresh', qbo_access_token: 'stale', qbo_access_expires: '1',
  };

  const qbo = makeClient({
    settings,
    fetchImpl: async (url, opts) => {
      calls.push(url);
      if (url.includes('/tokens/bearer')) {
        return new Response(JSON.stringify({
          access_token: 'fresh', refresh_token: 'new-refresh', expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      assert.equal(opts.headers.Authorization, 'Bearer fresh');
      return new Response(JSON.stringify({ QueryResponse: { Customer: [{ Id: '5' }] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const found = await qbo.findCustomer('Weaver residence');
  assert.equal(found.Id, '5');
  assert.equal(calls.length, 2, 'one refresh, then the call');
  assert.equal(settings.qbo_refresh_token, 'new-refresh', 'the rotated token is kept');
  assert.match(calls[1], /sandbox-quickbooks\.api\.intuit\.com\/v3\/company\/9130\/query/);
  assert.match(calls[1], /minorversion=/);
});

/* =================== a finished job, end to end ==================== */

/** A QuickBooks that lives in a variable. */
function fakeQuickBooks(opts = {}) {
  const state = { customers: opts.customers || [], items: opts.items || [{ Id: '1', Name: 'Labour' }, { Id: '2', Name: 'Materials' }], invoices: [], posted: [] };
  let nextId = 100;

  const reply = (body, status = 200) => new Response(JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } });

  const impl = async (url, options = {}) => {
    if (url.includes('/tokens/bearer')) {
      return reply({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600 });
    }

    if (url.includes('/query')) {
      const sql = decodeURIComponent(new URL(url).searchParams.get('query'));
      if (/FROM Customer/i.test(sql)) {
        const name = sql.match(/DisplayName = '(.*)'/)[1].replace(/''/g, "'");
        const hit = state.customers.filter((c) => c.DisplayName === name);
        return reply({ QueryResponse: hit.length ? { Customer: hit } : {} });
      }
      if (/FROM Item/i.test(sql)) {
        const name = sql.match(/Name = '(.*)'/)[1].replace(/''/g, "'");
        const hit = state.items.filter((i) => i.Name === name);
        return reply({ QueryResponse: hit.length ? { Item: hit } : {} });
      }
      return reply({ QueryResponse: {} });
    }

    if (url.includes('/customer') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      const made = { Id: String(nextId++), DisplayName: body.DisplayName };
      state.customers.push(made);
      return reply({ Customer: made });
    }

    if (url.includes('/invoice') && options.method === 'POST') {
      if (opts.failInvoice) return reply(opts.failInvoice.body, opts.failInvoice.status);
      const body = JSON.parse(options.body);
      state.posted.push(body);
      const made = { Id: String(nextId++), DocNumber: '10' + state.invoices.length, ...body };
      state.invoices.push(made);
      return reply({ Invoice: made });
    }

    return reply({}, 404);
  };

  return { impl, state };
}

function seed(db) {
  db.prepare(`INSERT INTO employees (name, username, pin_hash, role) VALUES (?, ?, ?, 'office')`)
    .run('The office', 'office', auth.hashPin('9999'));
  db.prepare(`INSERT INTO employees (name, username, pin_hash, role, hourly_rate)
              VALUES (?, ?, ?, 'crew', 30)`).run('Ray Delgado', 'ray', auth.hashPin('1111'));

  const cust = db.prepare('INSERT INTO customers (name, address, phone) VALUES (?, ?, ?)')
    .run('Weaver residence', '1420 Oak Hollow Dr', '555-0142');

  const job = db.prepare(`
    INSERT INTO jobs (job_date, kind, customer, address, customer_id, status, materials)
    VALUES (?, 'sprinkler', 'Weaver residence', '1420 Oak Hollow Dr', ?, 'done', NULL)
  `).run(today(), Number(cust.lastInsertRowid));

  const jobId = Number(job.lastInsertRowid);

  db.prepare(`
    INSERT INTO shifts (employee_id, job_id, work_date, start_time, end_time, break_minutes, status)
    VALUES (2, ?, ?, '08:00', '12:00', 0, 'ok')
  `).run(jobId, today());

  settingsStore.putMany(db, {
    bill_rate: '95',
    qbo_client_id: 'id', qbo_client_secret: 'secret',
    qbo_realm_id: '9130', qbo_refresh_token: 'refresh',
  });

  return { jobId, customerId: Number(cust.lastInsertRowid) };
}

test('a finished job becomes an invoice on the right customer', async (t) => {
  const db = open(':memory:');
  t.after(() => db.close());
  const { jobId } = seed(db);

  const qb = fakeQuickBooks({ customers: [{ Id: '42', DisplayName: 'Weaver residence' }] });
  const out = await invoicing.send(db, jobId, { fetchImpl: qb.impl });

  assert.equal(out.ok, true);
  assert.equal(out.invoice.status, 'sent');
  assert.equal(out.invoice.total, 380);
  assert.ok(out.invoice.qbo_id);

  const posted = qb.state.posted[0];
  assert.equal(posted.CustomerRef.value, '42', 'billed to the matching QuickBooks customer');
  assert.equal(posted.TxnDate, today());
  assert.match(posted.PrivateNote, new RegExp('job #' + jobId));
  assert.equal(posted.Line.length, 1);
  assert.equal(posted.Line[0].DetailType, 'SalesItemLineDetail');
  assert.equal(posted.Line[0].Amount, 380);
  assert.equal(posted.Line[0].SalesItemLineDetail.ItemRef.value, '1');
  assert.equal(posted.Line[0].SalesItemLineDetail.Qty, 4);
  assert.equal(posted.Line[0].SalesItemLineDetail.UnitPrice, 95);

  // and the customer is remembered, so the next one is a shorter trip
  const saved = db.prepare('SELECT qbo_id FROM customers WHERE name = ?').get('Weaver residence');
  assert.equal(saved.qbo_id, '42');
});

test('a customer QuickBooks has never heard of is created once', async (t) => {
  const db = open(':memory:');
  t.after(() => db.close());
  const { jobId } = seed(db);

  const qb = fakeQuickBooks({ customers: [] });
  const out = await invoicing.send(db, jobId, { fetchImpl: qb.impl });

  assert.equal(out.ok, true);
  assert.equal(qb.state.customers.length, 1);
  assert.equal(qb.state.customers[0].DisplayName, 'Weaver residence');
});

test('the same job never raises a second invoice', async (t) => {
  const db = open(':memory:');
  t.after(() => db.close());
  const { jobId } = seed(db);

  const qb = fakeQuickBooks({ customers: [{ Id: '42', DisplayName: 'Weaver residence' }] });

  const first = await invoicing.send(db, jobId, { fetchImpl: qb.impl });
  const again = await invoicing.send(db, jobId, { fetchImpl: qb.impl });
  const third = await invoicing.send(db, jobId, { fetchImpl: qb.impl });

  assert.equal(first.ok, true);
  assert.equal(again.already, true);
  assert.equal(third.already, true);
  assert.equal(qb.state.invoices.length, 1, 'one job, one invoice');
  assert.equal(again.invoice.qbo_id, first.invoice.qbo_id);
});

test('two sends racing each other still raise exactly one invoice', async (t) => {
  const db = open(':memory:');
  t.after(() => db.close());
  const { jobId } = seed(db);

  const qb = fakeQuickBooks({ customers: [{ Id: '42', DisplayName: 'Weaver residence' }] });

  // The office double-clicks while the auto-send is already on its way.
  const both = await Promise.all([
    invoicing.send(db, jobId, { fetchImpl: qb.impl }),
    invoicing.send(db, jobId, { fetchImpl: qb.impl }),
  ]);

  assert.equal(qb.state.invoices.length, 1, 'the customer is billed once');
  assert.equal(both.filter((r) => r.ok).length, 1, 'one call did the work');
  assert.equal(both.filter((r) => r.busy).length, 1, 'the other was told it is in hand');

  const rows = db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE job_id = ?').get(jobId);
  assert.equal(rows.n, 1);
});

test('a send abandoned half way can be picked up again later', async (t) => {
  const db = open(':memory:');
  t.after(() => db.close());
  const { jobId } = seed(db);

  invoicing.ledger(db, jobId);

  // Somebody's send died mid-flight and left the claim behind.
  const longAgo = new Date(Date.now() - invoicing.STALE_CLAIM_MS - 1000).toISOString();
  db.prepare("UPDATE invoices SET status = 'sending', tried_at = ? WHERE job_id = ?")
    .run(longAgo, jobId);

  const qb = fakeQuickBooks({ customers: [{ Id: '42', DisplayName: 'Weaver residence' }] });
  const out = await invoicing.send(db, jobId, { fetchImpl: qb.impl });

  assert.equal(out.ok, true, 'the stale claim did not wedge the job');
  assert.equal(out.invoice.status, 'sent');

  // but a fresh claim is still respected
  db.prepare("UPDATE invoices SET status = 'sending', qbo_id = NULL, tried_at = ? WHERE job_id = ?")
    .run(new Date().toISOString(), jobId);
  const blocked = await invoicing.send(db, jobId, { fetchImpl: qb.impl });
  assert.equal(blocked.busy, true);
});

test('a missing product in QuickBooks holds the invoice and says which one', async (t) => {
  const db = open(':memory:');
  t.after(() => db.close());
  const { jobId } = seed(db);

  const qb = fakeQuickBooks({ customers: [{ Id: '42', DisplayName: 'Weaver residence' }], items: [] });
  const out = await invoicing.send(db, jobId, { fetchImpl: qb.impl });

  assert.equal(out.ok, false);
  assert.equal(out.invoice.status, 'holding');
  assert.match(out.invoice.why, /no product or service called "Labour"/);
  assert.equal(qb.state.invoices.length, 0);
});

test('a refusal from QuickBooks is kept and readable, and nothing is billed', async (t) => {
  const db = open(':memory:');
  t.after(() => db.close());
  const { jobId } = seed(db);

  const qb = fakeQuickBooks({
    customers: [{ Id: '42', DisplayName: 'Weaver residence' }],
    failInvoice: {
      status: 400,
      body: { Fault: { Error: [{ Message: 'Invalid Reference Id', Detail: 'Item not found' }] } },
    },
  });

  const out = await invoicing.send(db, jobId, { fetchImpl: qb.impl });
  assert.equal(out.ok, false);
  assert.equal(out.invoice.status, 'failed');
  assert.equal(out.invoice.why, 'Invalid Reference Id — Item not found');
  assert.equal(out.invoice.qbo_id, null);
});

test('with QuickBooks not connected the job waits instead of failing', async (t) => {
  const db = open(':memory:');
  t.after(() => db.close());
  const { jobId } = seed(db);
  settingsStore.put(db, 'qbo_refresh_token', '');

  const out = await invoicing.send(db, jobId, { fetchImpl: fakeQuickBooks().impl });
  assert.equal(out.ok, false);
  assert.equal(out.invoice.status, 'holding');
  assert.match(out.invoice.why, /not connected/i);
});

test('finishing a job sends it, and turning auto-send off leaves it waiting', async (t) => {
  const db = open(':memory:');
  t.after(() => db.close());
  const { jobId } = seed(db);

  const qb = fakeQuickBooks({ customers: [{ Id: '42', DisplayName: 'Weaver residence' }] });
  invoicing.setFetch(qb.impl);
  t.after(() => invoicing.setFetch(null));

  const sent = await invoicing.onJobFinished(db, jobId);
  assert.equal(sent.status, 'sent');
  assert.equal(qb.state.invoices.length, 1);

  // a second job, with auto-send turned off
  settingsStore.put(db, 'auto_send', '0');
  const second = db.prepare(`
    INSERT INTO jobs (job_date, kind, customer, customer_id, status)
    VALUES (?, 'lighting', 'Weaver residence', 1, 'done')
  `).run(today());

  const held = await invoicing.onJobFinished(db, Number(second.lastInsertRowid));
  assert.equal(held.status, 'waiting');
  assert.equal(qb.state.invoices.length, 1, 'nothing else went out');
});

/* ========================== through the app ========================= */

async function startApp() {
  const db = open(':memory:');
  const seeded = seed(db);
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    db,
    ...seeded,
    base: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

function client(base) {
  let cookie = null;
  return async function call(path, { method = 'GET', body } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    const json = (res.headers.get('content-type') || '').includes('json');
    return { status: res.status, data: text && json ? JSON.parse(text) : { text } };
  };
}

test('the billing screen shows what is ready and what it comes to', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const office = client(app.base);
  await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });

  const seen = await office('/api/office/billing');
  assert.equal(seen.status, 200);
  assert.equal(seen.data.rows.length, 1);

  const row = seen.data.rows[0];
  assert.equal(row.ready, true);
  assert.equal(row.hours, 4);
  assert.equal(row.total, 380);
  assert.equal(row.status, 'waiting');
  assert.equal(seen.data.totals.ready, 1);
  assert.equal(seen.data.settings.qbo_connected, true);
  assert.equal(seen.data.settings.bill_rate, 95);
});

test('secrets never come back out of the settings', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const office = client(app.base);
  await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });

  const seen = await office('/api/office/billing');
  const text = JSON.stringify(seen.data);
  assert.ok(!text.includes('secret'), 'the client secret is not in the response');
  assert.ok(!text.includes('refresh'), 'the refresh token is not in the response');
  assert.equal(seen.data.settings.qbo_has_keys, true);
});

test('a price set on the job changes what it will bill', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const office = client(app.base);
  await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });

  await office('/api/office/billing/' + app.jobId, {
    method: 'PATCH', body: { quoted_price: 1450, parts_price: 0 },
  });

  const seen = await office('/api/office/billing');
  assert.equal(seen.data.rows[0].total, 1450);
  assert.equal(seen.data.rows[0].ready, true);
});

test('marking a job no charge takes it off the bill', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const office = client(app.base);
  await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });

  await office('/api/office/billing/' + app.jobId, { method: 'PATCH', body: { no_charge: true } });

  const seen = await office('/api/office/billing');
  assert.equal(seen.data.rows[0].no_charge, true);
  assert.equal(seen.data.rows[0].ready, false);
  assert.equal(seen.data.rows[0].total, 0);
});

test('the crew cannot reach billing or the QuickBooks keys', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const ray = client(app.base);
  await ray('/api/signin', { method: 'POST', body: { username: 'ray', pin: '1111' } });

  assert.equal((await ray('/api/office/billing')).status, 403);
  assert.equal((await ray('/api/office/billing/settings', {
    method: 'PUT', body: { bill_rate: 1 },
  })).status, 403);
  assert.equal((await ray('/api/office/quickbooks/disconnect', { method: 'POST' })).status, 403);
});

test('a connect link cannot be handed a state that did not come from us', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const office = client(app.base);
  await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });

  const tried = await office('/api/office/quickbooks/finish', {
    method: 'POST',
    body: { code: 'abc', realm_id: '9130', redirect_uri: 'https://x/cb', state: 'not-ours' },
  });

  assert.equal(tried.status, 400);
  assert.match(tried.data.error, /did not come back the way it went out/i);
});
