'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { open } = require('../src/db');
const auth = require('../src/auth');
const { createServer } = require('../server');
const { today, addDays, weekStart } = require('../src/time');

async function startApp() {
  const db = open(':memory:');
  db.prepare(`INSERT INTO employees (name, username, pin_hash, role) VALUES (?, ?, ?, 'office')`)
    .run('The office', 'office', auth.hashPin('9999'));

  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    db,
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

async function officeWithCrew() {
  const app = await startApp();
  const office = client(app.base);
  await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });

  const ray = await office('/api/office/people', {
    method: 'POST', body: { name: 'Ray Delgado', username: 'ray', pin: '1111', hourly_rate: 30 },
  });
  const tom = await office('/api/office/people', {
    method: 'POST', body: { name: 'Tom Feeney', username: 'tom', pin: '2222', hourly_rate: 25 },
  });

  return { app, office, rayId: ray.data.person.id, tomId: tom.data.person.id };
}

test('a customer remembers their details and their history', async (t) => {
  const { app, office, rayId } = await officeWithCrew();
  t.after(() => app.stop());

  const made = await office('/api/office/customers', {
    method: 'POST',
    body: {
      name: 'Weaver residence',
      address: '1420 Oak Hollow Dr',
      phone: '555-0142',
      notes: 'Gate code 4471. Dog is friendly but loud.',
    },
  });
  assert.strictEqual(made.status, 200);
  const customerId = made.data.customer.id;

  await t.test('booking against a customer fills the blanks', async () => {
    const job = await office('/api/office/jobs', {
      method: 'POST',
      body: {
        customer_id: customerId,
        job_date: today(),
        kind: 'sprinkler',
        details: 'Zone 3 not coming on',
        crew_ids: [rayId],
      },
    });

    assert.strictEqual(job.status, 200);
    assert.strictEqual(job.data.job.customer, 'Weaver residence', 'name came from the record');
    assert.strictEqual(job.data.job.address, '1420 Oak Hollow Dr');
    assert.strictEqual(job.data.job.phone, '555-0142');
    assert.strictEqual(job.data.job.customer_id, customerId);
  });

  await t.test('a job can still be booked for somebody not on the books', async () => {
    const job = await office('/api/office/jobs', {
      method: 'POST',
      body: { customer: 'Cash job on Elm', job_date: today(), crew_ids: [rayId] },
    });
    assert.strictEqual(job.status, 200);
    assert.strictEqual(job.data.job.customer_id, null);

    const nameless = await office('/api/office/jobs', {
      method: 'POST', body: { job_date: today(), crew_ids: [rayId] },
    });
    assert.strictEqual(nameless.status, 400, 'with no customer at all it is refused');
  });

  await t.test('the customer page shows what has been done for them', async () => {
    const page = await office('/api/office/customers/' + customerId);
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.data.customer.job_count, 1);
    assert.strictEqual(page.data.jobs.length, 1);
    assert.strictEqual(page.data.customer.last_job, today());
  });

  await t.test('customers can be searched by name, address or phone', async () => {
    for (const term of ['weaver', 'Oak Hollow', '0142']) {
      const hits = await office('/api/office/customers?q=' + encodeURIComponent(term));
      assert.strictEqual(hits.data.customers.length, 1, `"${term}" should find them`);
    }

    const miss = await office('/api/office/customers?q=nobodyhere');
    assert.strictEqual(miss.data.customers.length, 0);
  });

  await t.test('their details can be corrected without touching old jobs', async () => {
    const moved = await office('/api/office/customers/' + customerId, {
      method: 'PATCH', body: { address: '9 New Street' },
    });
    assert.strictEqual(moved.status, 200);
    assert.strictEqual(moved.data.customer.address, '9 New Street');

    const page = await office('/api/office/customers/' + customerId);
    assert.strictEqual(page.data.jobs[0].address, '1420 Oak Hollow Dr',
      'the old job keeps the address it was done at');
  });
});

test('a job can be repeated, which is how the seasons work', async (t) => {
  const { app, office, rayId, tomId } = await officeWithCrew();
  t.after(() => app.stop());

  const job = await office('/api/office/jobs', {
    method: 'POST',
    body: {
      customer: 'Kestrel Ridge HOA',
      job_date: today(),
      kind: 'lighting',
      details: 'Monthly lamp check',
      crew_ids: [rayId, tomId],
    },
  });
  const jobId = job.data.job.id;

  await t.test('repeating weekly makes one a week, same crew', async () => {
    const copied = await office(`/api/office/jobs/${jobId}/copy`, {
      method: 'POST', body: { every_weeks_for: 3 },
    });

    assert.strictEqual(copied.status, 200);
    assert.strictEqual(copied.data.made, 3);
    assert.deepStrictEqual(
      copied.data.jobs.map((j) => j.job_date),
      [addDays(today(), 7), addDays(today(), 14), addDays(today(), 21)],
    );
    assert.deepStrictEqual(copied.data.jobs[0].crew.map((c) => c.name), ['Ray Delgado', 'Tom Feeney']);
    assert.strictEqual(copied.data.jobs[0].status, 'assigned', 'a copy starts fresh');
    assert.strictEqual(copied.data.jobs[0].details, 'Monthly lamp check');
  });

  await t.test('or it can be dropped on named days', async () => {
    const copied = await office(`/api/office/jobs/${jobId}/copy`, {
      method: 'POST', body: { dates: [addDays(today(), 1), addDays(today(), 2)] },
    });
    assert.strictEqual(copied.data.made, 2);
  });

  await t.test('asking for nothing, or for far too much, is refused', async () => {
    const nothing = await office(`/api/office/jobs/${jobId}/copy`, { method: 'POST', body: {} });
    assert.strictEqual(nothing.status, 400);

    const silly = await office(`/api/office/jobs/${jobId}/copy`, {
      method: 'POST', body: { every_weeks_for: 99 },
    });
    assert.strictEqual(silly.status, 400);
  });
});

test('the week view lays the board out seven days at a time', async (t) => {
  const { app, office, rayId } = await officeWithCrew();
  t.after(() => app.stop());

  const monday = weekStart(today());

  await office('/api/office/jobs', {
    method: 'POST',
    body: { customer: 'Monday job', job_date: monday, crew_ids: [rayId] },
  });
  await office('/api/office/jobs', {
    method: 'POST',
    body: { customer: 'Wednesday job', job_date: addDays(monday, 2), crew_ids: [rayId] },
  });

  const week = await office('/api/office/week?from=' + monday);
  assert.strictEqual(week.status, 200);
  assert.strictEqual(week.data.days.length, 7, 'always seven days, empty or not');
  assert.strictEqual(week.data.days[0].jobs.length, 1);
  assert.strictEqual(week.data.days[1].jobs.length, 0);
  assert.strictEqual(week.data.days[2].jobs[0].customer, 'Wednesday job');
  assert.strictEqual(week.data.totals.jobs, 2);
  assert.ok(week.data.people.some((p) => p.id === rayId));
});

test('search reaches customers and the detail inside jobs', async (t) => {
  const { app, office, rayId } = await officeWithCrew();
  t.after(() => app.stop());

  await office('/api/office/customers', {
    method: 'POST', body: { name: 'Halvorsen', address: '77 Kestrel Rd' },
  });
  await office('/api/office/jobs', {
    method: 'POST',
    body: {
      customer: 'Someone else',
      job_date: today(),
      details: 'Replace the backflow preventer',
      crew_ids: [rayId],
    },
  });

  const byName = await office('/api/office/search?q=halvorsen');
  assert.strictEqual(byName.data.customers.length, 1);

  const byDetail = await office('/api/office/search?q=backflow');
  assert.strictEqual(byDetail.data.jobs.length, 1);
  assert.strictEqual(byDetail.data.jobs[0].customer, 'Someone else');

  const tooShort = await office('/api/office/search?q=a');
  assert.deepStrictEqual(tooShort.data.jobs, [], 'one letter matches everything, so it matches nothing');
});

test('payroll flags a long week and gathers the parts used', async (t) => {
  const { app, office, rayId } = await officeWithCrew();
  t.after(() => app.stop());

  const ray = client(app.base);
  await ray('/api/signin', { method: 'POST', body: { username: 'ray', pin: '1111' } });

  const monday = weekStart(today());

  const job = await office('/api/office/jobs', {
    method: 'POST',
    body: { customer: 'Long week place', job_date: monday, crew_ids: [rayId] },
  });

  // Five nine-hour days puts them over forty.
  for (let i = 0; i < 5; i += 1) {
    const res = await ray('/api/crew/shifts', {
      method: 'POST',
      body: {
        job_id: job.data.job.id,
        work_date: addDays(monday, i),
        start_time: '07:00',
        end_time: '16:00',
        break_minutes: 0,
      },
    });
    assert.strictEqual(res.status, 200);
  }

  await ray(`/api/crew/jobs/${job.data.job.id}/finish`, {
    method: 'POST',
    body: { wrap_notes: 'All in', materials: '3 rotors, 40ft of poly' },
  });

  const pay = await office(`/api/office/payroll?from=${monday}&to=${addDays(monday, 6)}`);
  const row = pay.data.rows.find((r) => r.name === 'Ray Delgado');

  assert.strictEqual(row.hours, 45);
  assert.strictEqual(row.over_40, 5, 'five hours past forty');
  assert.strictEqual(pay.data.totals.over_40, 5);
  assert.strictEqual(pay.data.days, 7);

  assert.strictEqual(pay.data.parts.length, 1);
  assert.strictEqual(pay.data.parts[0].materials, '3 rotors, 40ft of poly');
  assert.strictEqual(pay.data.parts[0].customer, 'Long week place');
});

test('every office screen carries the tab-bar counts, so it asks once', async (t) => {
  const { app, office, rayId } = await officeWithCrew();
  t.after(() => app.stop());

  const ray = client(app.base);
  await ray('/api/signin', { method: 'POST', body: { username: 'ray', pin: '1111' } });

  const job = await office('/api/office/jobs', {
    method: 'POST', body: { customer: 'Counts test', job_date: today(), crew_ids: [rayId] },
  });

  await ray('/api/crew/clock-in', {
    method: 'POST',
    body: { job_id: job.data.job.id, work_date: today(), start_time: '07:00' },
  });

  for (const path of ['/api/office/day', '/api/office/week', '/api/office/customers',
                      '/api/office/notices', '/api/office/people', '/api/office/waiting']) {
    const res = await office(path);
    assert.strictEqual(res.status, 200, path);
    assert.ok(res.data.counts, `${path} should carry the counts`);
    assert.strictEqual(res.data.counts.on_the_clock, 1, path);
    assert.strictEqual(res.data.counts.waiting, 0, path);
  }

  const csv = await office(`/api/office/payroll.csv?from=${today()}&to=${today()}`);
  assert.strictEqual(csv.status, 200, 'the download is left alone');
  assert.match(csv.data.text, /"Day","Name"/);
});

test('the crew cannot reach any of the new office screens', async (t) => {
  const { app, office } = await officeWithCrew();
  t.after(() => app.stop());

  const ray = client(app.base);
  await ray('/api/signin', { method: 'POST', body: { username: 'ray', pin: '1111' } });

  for (const path of ['/api/office/customers', '/api/office/week', '/api/office/search?q=weaver']) {
    assert.strictEqual((await ray(path)).status, 403, path);
  }

  assert.strictEqual((await office('/api/office/customers')).status, 200);
});
