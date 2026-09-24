'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { open } = require('../src/db');
const auth = require('../src/auth');
const { createServer } = require('../server');
const { today, addDays } = require('../src/time');
const settingsStore = require('../src/settings');

async function startApp() {
  const db = open(':memory:');

  db.prepare(`INSERT INTO employees (name, username, pin_hash, role) VALUES (?, ?, ?, 'office')`)
    .run('The office', 'office', auth.hashPin('9999'));
  db.prepare(`INSERT INTO employees (name, username, pin_hash, role, hourly_rate)
              VALUES (?, ?, ?, 'crew', 30)`).run('Ray Delgado', 'ray', auth.hashPin('1111'));

  const cust = db.prepare('INSERT INTO customers (name, address, phone) VALUES (?, ?, ?)')
    .run('Weaver residence', '1420 Oak Hollow Dr', '555-0142');

  settingsStore.put(db, 'bill_rate', '95');

  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    db,
    customerId: Number(cust.lastInsertRowid),
    rayId: 2,
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

async function asOffice(app) {
  const office = client(app.base);
  await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });
  return office;
}

const LINES = [
  { description: 'Replace 6 heads and re-aim', qty: 6, unit_price: 42 },
  { description: 'Valve box and fittings', qty: 1, unit_price: 148 },
];

/* ================================ quotes ============================= */

test('a quote adds its own lines up', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const office = await asOffice(app);

  const made = await office('/api/office/quotes', {
    method: 'POST',
    body: {
      customer_id: app.customerId,
      kind: 'sprinkler',
      title: 'Zone 3 overhaul',
      lines: LINES,
      valid_until: addDays(today(), 30),
    },
  });

  assert.equal(made.status, 200);
  const quote = made.data.quote;
  assert.equal(quote.total, 400, '6 x 42 plus 148');
  assert.equal(quote.status, 'draft');
  assert.equal(quote.customer, 'Weaver residence');
  assert.equal(quote.address, '1420 Oak Hollow Dr', 'filled in from the customer on file');
  assert.equal(quote.lines.length, 2);
});

test('a quote has to have something on it before it goes out', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const office = await asOffice(app);

  const made = await office('/api/office/quotes', {
    method: 'POST', body: { customer: 'Somebody new', lines: [] },
  });

  const sent = await office('/api/office/quotes/' + made.data.quote.id + '/send', { method: 'POST' });
  assert.equal(sent.status, 400);
  assert.match(sent.data.error, /at least one line/i);
});

test('winning a quote puts the work on the board at the price quoted', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const office = await asOffice(app);

  const made = await office('/api/office/quotes', {
    method: 'POST',
    body: { customer_id: app.customerId, kind: 'sprinkler', title: 'Zone 3 overhaul', lines: LINES },
  });
  const id = made.data.quote.id;

  await office('/api/office/quotes/' + id + '/send', { method: 'POST' });

  const won = await office('/api/office/quotes/' + id + '/accept', {
    method: 'POST', body: { job_date: today(), crew_ids: [app.rayId] },
  });

  assert.equal(won.status, 200);
  assert.equal(won.data.quote.status, 'accepted');
  assert.ok(won.data.quote.job_id);

  const job = won.data.job;
  assert.equal(job.customer, 'Weaver residence');
  assert.equal(job.quoted_price, 400, 'the job is billed at what was quoted');
  assert.equal(job.kind, 'sprinkler');
  assert.equal(job.crew.length, 1);
  assert.match(job.details, /Zone 3 overhaul/);
});

test('accepting twice does not put the job on twice', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const office = await asOffice(app);

  const made = await office('/api/office/quotes', {
    method: 'POST', body: { customer_id: app.customerId, lines: LINES },
  });
  const id = made.data.quote.id;
  const accept = { method: 'POST', body: { job_date: today(), crew_ids: [app.rayId] } };

  const first = await office('/api/office/quotes/' + id + '/accept', accept);
  const again = await office('/api/office/quotes/' + id + '/accept', accept);

  assert.equal(first.data.job.id, again.data.job.id);
  const jobs = app.db.prepare('SELECT COUNT(*) AS n FROM jobs').get();
  assert.equal(jobs.n, 1);
});

test('a quote that was won cannot be quietly deleted or repriced', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const office = await asOffice(app);

  const made = await office('/api/office/quotes', {
    method: 'POST', body: { customer_id: app.customerId, lines: LINES },
  });
  const id = made.data.quote.id;
  await office('/api/office/quotes/' + id + '/accept', {
    method: 'POST', body: { job_date: today(), crew_ids: [app.rayId] },
  });

  const repriced = await office('/api/office/quotes/' + id, {
    method: 'PATCH', body: { lines: [{ description: 'Cheaper', qty: 1, unit_price: 5 }] },
  });
  assert.equal(repriced.status, 409);

  const gone = await office('/api/office/quotes/' + id, { method: 'DELETE' });
  assert.equal(gone.status, 409);
});

test('a lost quote keeps why, and the win rate counts it', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const office = await asOffice(app);

  for (const lines of [LINES, LINES]) {
    await office('/api/office/quotes', {
      method: 'POST', body: { customer_id: app.customerId, lines },
    });
  }

  const all = await office('/api/office/quotes');
  const [one, two] = all.data.quotes;

  await office('/api/office/quotes/' + one.id + '/accept', {
    method: 'POST', body: { job_date: today(), crew_ids: [app.rayId] },
  });
  await office('/api/office/quotes/' + two.id + '/decline', {
    method: 'POST', body: { why_lost: 'Went with the cheaper bid' },
  });

  const after = await office('/api/office/quotes');
  assert.equal(after.data.summary.won, 1);
  assert.equal(after.data.summary.lost, 1);
  assert.equal(after.data.summary.pct, 50);

  const lost = after.data.quotes.find((q) => q.status === 'declined');
  assert.equal(lost.why_lost, 'Went with the cheaper bid');
});

/* =============================== expenses ============================ */

test('money out is recorded, against a job or against the business', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const office = await asOffice(app);

  const job = await office('/api/office/jobs', {
    method: 'POST',
    body: { job_date: today(), kind: 'drainage', customer_id: app.customerId, crew_ids: [app.rayId] },
  });

  await office('/api/office/expenses', {
    method: 'POST',
    body: {
      spent_on: today(), kind: 'materials', description: 'Gravel and pipe',
      amount: 318.4, supplier: 'Cedar Falls Supply', job_id: job.data.job.id,
    },
  });

  await office('/api/office/expenses', {
    method: 'POST',
    body: { spent_on: today(), kind: 'insurance', description: 'Monthly liability', amount: 240 },
  });

  const seen = await office('/api/office/expenses');
  assert.equal(seen.data.totals.count, 2);
  assert.equal(seen.data.totals.spent, 558.4);
  assert.equal(seen.data.totals.on_jobs, 318.4, 'the insurance belongs to no job');

  const kinds = Object.fromEntries(seen.data.totals.by_kind.map((k) => [k.kind, k.amount]));
  assert.equal(kinds.materials, 318.4);
  assert.equal(kinds.insurance, 240);
});

test('an expense cannot be hung on a job that does not exist', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const office = await asOffice(app);

  const tried = await office('/api/office/expenses', {
    method: 'POST',
    body: { spent_on: today(), description: 'Nowhere', amount: 10, job_id: 9999 },
  });

  assert.equal(tried.status, 404);
});

/* =============================== reports ============================= */

test('the owner can see what a job actually left in the business', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const office = await asOffice(app);

  const job = await office('/api/office/jobs', {
    method: 'POST',
    body: { job_date: today(), kind: 'sprinkler', customer_id: app.customerId, crew_ids: [app.rayId] },
  });
  const jobId = job.data.job.id;

  // Ray works eight hours at $30, and the office approves it.
  app.db.prepare(`
    INSERT INTO shifts (employee_id, job_id, work_date, start_time, end_time, status)
    VALUES (?, ?, ?, '08:00', '16:00', 'ok')
  `).run(app.rayId, jobId, today());

  await office('/api/office/expenses', {
    method: 'POST',
    body: { spent_on: today(), kind: 'materials', description: 'Heads', amount: 120, job_id: jobId },
  });

  const seen = await office('/api/office/reports');
  assert.equal(seen.status, 200);

  assert.equal(seen.data.totals.jobs, 1);
  assert.equal(seen.data.totals.revenue, 760, '8 hours at the 95 billing rate');
  assert.equal(seen.data.totals.labour, 240, '8 hours at Ray\'s 30');
  assert.equal(seen.data.totals.spend, 120);
  assert.equal(seen.data.totals.margin, 400);
  assert.equal(seen.data.totals.margin_pct, 52.63);

  assert.equal(seen.data.customers[0].customer, 'Weaver residence');
  assert.equal(seen.data.kinds[0].kind, 'sprinkler');
  assert.equal(seen.data.crew.pct, 100, 'every paid hour was on a customer job');
});

test('overheads come out of the month, and a loss-making job is surfaced', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const office = await asOffice(app);

  const job = await office('/api/office/jobs', {
    method: 'POST',
    body: { job_date: today(), kind: 'drainage', customer_id: app.customerId, crew_ids: [app.rayId] },
  });
  const jobId = job.data.job.id;

  // Twelve hours of work, quoted flat at far too little.
  app.db.prepare(`
    INSERT INTO shifts (employee_id, job_id, work_date, start_time, end_time, status)
    VALUES (?, ?, ?, '06:00', '18:00', 'ok')
  `).run(app.rayId, jobId, today());

  await office('/api/office/billing/' + jobId, { method: 'PATCH', body: { quoted_price: 200 } });
  await office('/api/office/expenses', {
    method: 'POST',
    body: { spent_on: today(), kind: 'insurance', description: 'Liability', amount: 300 },
  });

  const seen = await office('/api/office/reports');

  assert.equal(seen.data.overhead, 300);
  assert.equal(seen.data.totals.revenue, 200);
  assert.equal(seen.data.totals.labour, 360, '12 hours at 30');

  const month = seen.data.months[seen.data.months.length - 1];
  assert.equal(month.overhead, 300);
  assert.equal(month.cost, 660);
  assert.equal(month.margin, -460);

  assert.equal(seen.data.worst.length, 1);
  assert.equal(seen.data.worst[0].margin, -160, 'the job itself, before overheads');
});

test('work done with nothing billed against it is pulled out where it can be seen', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const office = await asOffice(app);

  const job = await office('/api/office/jobs', {
    method: 'POST',
    body: { job_date: today(), kind: 'lighting', customer_id: app.customerId, crew_ids: [app.rayId] },
  });

  app.db.prepare(`
    INSERT INTO shifts (employee_id, job_id, work_date, start_time, end_time, status)
    VALUES (?, ?, ?, '09:00', '12:00', 'ok')
  `).run(app.rayId, job.data.job.id, today());

  await office('/api/office/billing/' + job.data.job.id, {
    method: 'PATCH', body: { no_charge: true },
  });

  const seen = await office('/api/office/reports');
  assert.equal(seen.data.unbilled.length, 1);
  assert.equal(seen.data.unbilled[0].nothing_billed, true);
  assert.equal(seen.data.unbilled[0].margin, -90, 'three hours of Ray, given away');
});

/* ============================= who may look ========================== */

test('none of this is open to the crew', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const ray = client(app.base);
  await ray('/api/signin', { method: 'POST', body: { username: 'ray', pin: '1111' } });

  for (const path of ['/api/office/quotes', '/api/office/expenses', '/api/office/reports']) {
    assert.equal((await ray(path)).status, 403, path);
  }

  const tried = await ray('/api/office/expenses', {
    method: 'POST', body: { spent_on: today(), description: 'x', amount: 1 },
  });
  assert.equal(tried.status, 403);
});
