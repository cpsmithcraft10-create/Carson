'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { open } = require('../src/db');
const auth = require('../src/auth');
const { createServer } = require('../server');

async function app() {
  const db = open(':memory:');
  db.prepare(`INSERT INTO employees (name, username, pin_hash, role) VALUES (?, ?, ?, 'office')`)
    .run('The office', 'office', auth.hashPin('9999'));

  const server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let cookie = null;
  const call = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, {
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

  const signIn = (u, pin) => call('/api/signin', { method: 'POST', body: { username: u, pin } });

  await signIn('office', '9999');
  const ray = await call('/api/office/people', {
    method: 'POST', body: { name: 'Ray Delgado', username: 'ray', pin: '1111', hourly_rate: 30 },
  });
  const tom = await call('/api/office/people', {
    method: 'POST', body: { name: 'Tom Feeney', username: 'tom', pin: '2222', hourly_rate: 28 },
  });

  return {
    call,
    signIn,
    rayId: ray.data.person.id,
    tomId: tom.data.person.id,
    async stop() {
      await new Promise((r) => server.close(r));
      db.close();
    },
  };
}

const makeJob = (a, crew, over = {}) => a.call('/api/office/jobs', {
  method: 'POST',
  body: {
    job_date: '2026-09-27', kind: 'sprinkler', customer: 'Weaver residence',
    address: '14 Marsh Lane', details: 'Zone 3 not coming on', crew_ids: crew, ...over,
  },
});

/* ========================== reading the day ========================= */

test('the day comes back as sheets, numbered, with what is still blank', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const job = await makeJob(a, [a.rayId]);
  const got = await a.call('/api/office/worksheets?from=2026-09-27');

  assert.equal(got.status, 200);
  assert.equal(got.data.sheets.length, 1);

  const sheet = got.data.sheets[0];
  assert.equal(sheet.no, 'WS-' + String(job.data.job.id).padStart(5, '0'));
  assert.equal(sheet.customer, 'Weaver residence');
  assert.equal(sheet.asked_for, 'Zone 3 not coming on');
  assert.deepEqual(sheet.missing, [
    'Nobody has put hours on it', 'What was done is blank', 'No parts written down',
  ]);
  assert.equal(sheet.words, '3 things still blank');
  assert.equal(got.data.totals.needing, 1);
});

test('a day with no work says so rather than erroring', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const got = await a.call('/api/office/worksheets?from=2026-01-01');
  assert.deepEqual(got.data.sheets, []);
  assert.equal(got.data.totals.sheets, 0);
  assert.equal(got.data.totals.hours, 0);
});

test('a range brings back the whole week in one go', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  await makeJob(a, [a.rayId], { job_date: '2026-09-21' });
  await makeJob(a, [a.rayId], { job_date: '2026-09-24' });
  await makeJob(a, [a.rayId], { job_date: '2026-10-02' });

  const got = await a.call('/api/office/worksheets?from=2026-09-21&to=2026-09-27');
  assert.deepEqual(got.data.sheets.map((s) => s.date), ['2026-09-21', '2026-09-24']);
});

/* ============================== filling in ========================== */

test('the office can write what was done and what to come back for', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const job = await makeJob(a, [a.rayId]);
  const saved = await a.call(`/api/office/worksheets/${job.data.job.id}`, {
    method: 'PATCH',
    body: { done: 'Dug out and replaced the zone 3 valve.',
            next_visit: 'Check the timer in spring' },
  });

  assert.equal(saved.status, 200);
  assert.equal(saved.data.sheet.done, 'Dug out and replaced the zone 3 valve.');
  assert.equal(saved.data.sheet.next_visit, 'Check the timer in spring');
});

test('the time a sheet was signed is set once and does not creep on later edits',
  async (t) => {
    const a = await app();
    t.after(() => a.stop());

    const job = await makeJob(a, [a.rayId]);
    const id = job.data.job.id;

    const first = await a.call(`/api/office/worksheets/${id}`, {
      method: 'PATCH', body: { done: 'Valve replaced', signed_by: 'M. Weaver' },
    });
    const signedAt = first.data.sheet.signed_at;
    assert.ok(signedAt, 'a name going on stamps the time');

    await new Promise((r) => setTimeout(r, 15));

    const second = await a.call(`/api/office/worksheets/${id}`, {
      method: 'PATCH',
      body: { done: 'Valve replaced, and the head straightened', signed_by: 'M. Weaver' },
    });

    assert.equal(second.data.sheet.signed_at, signedAt,
      'editing the sheet must not claim it was signed later');
  });

test('taking the name off clears the time with it', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const job = await makeJob(a, [a.rayId]);
  const id = job.data.job.id;

  await a.call(`/api/office/worksheets/${id}`, {
    method: 'PATCH', body: { done: 'Done', signed_by: 'M. Weaver' },
  });
  const cleared = await a.call(`/api/office/worksheets/${id}`, {
    method: 'PATCH', body: { done: 'Done', signed_by: '' },
  });

  assert.equal(cleared.data.sheet.signed_by, null);
  assert.equal(cleared.data.sheet.signed_at, null);
});

test('a worksheet that does not exist is a plain not-found', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  assert.equal((await a.call('/api/office/worksheets/9999')).status, 404);
  assert.equal((await a.call('/api/office/worksheets/9999', {
    method: 'PATCH', body: { done: 'x' } })).status, 404);
});

/* ================================ parts ============================= */

test('parts go on as lines and read back the way they were meant', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const job = await makeJob(a, [a.rayId]);
  const id = job.data.job.id;

  await a.call(`/api/office/worksheets/${id}/parts`, {
    method: 'POST', body: { item: 'Rain Bird 5004', quantity: 3 },
  });
  const two = await a.call(`/api/office/worksheets/${id}/parts`, {
    method: 'POST', body: { item: 'PVC pipe', quantity: 40, unit: 'ft' },
  });

  assert.deepEqual(two.data.sheet.materials.map((m) => m.words),
    ['3 × Rain Bird 5004', '40 ft — PVC pipe']);
});

test('a part with no number against it is one of it', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const job = await makeJob(a, [a.rayId]);
  const got = await a.call(`/api/office/worksheets/${job.data.job.id}/parts`, {
    method: 'POST', body: { item: 'Valve box' },
  });

  assert.equal(got.data.sheet.materials[0].quantity, 1);
});

test('a part with no name, or none of it, is refused', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const job = await makeJob(a, [a.rayId]);
  const id = job.data.job.id;

  assert.equal((await a.call(`/api/office/worksheets/${id}/parts`, {
    method: 'POST', body: { item: '  ' } })).status, 400);
  assert.equal((await a.call(`/api/office/worksheets/${id}/parts`, {
    method: 'POST', body: { item: 'Pipe', quantity: 0 } })).status, 400);
});

test('a part can only be taken off the sheet it is actually on', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const one = await makeJob(a, [a.rayId]);
  const other = await makeJob(a, [a.rayId], { customer: 'Kestrel Ridge HOA' });

  const added = await a.call(`/api/office/worksheets/${one.data.job.id}/parts`, {
    method: 'POST', body: { item: 'Valve', quantity: 1 },
  });
  const partId = added.data.sheet.materials[0].id;

  const wrong = await a.call(
    `/api/office/worksheets/${other.data.job.id}/parts/${partId}`, { method: 'DELETE' });
  assert.equal(wrong.status, 404, 'a part id must not reach into another sheet');

  const right = await a.call(
    `/api/office/worksheets/${one.data.job.id}/parts/${partId}`, { method: 'DELETE' });
  assert.equal(right.status, 200);
  assert.deepEqual(right.data.sheet.materials, []);
});

test('the usual parts are learned from what has been written down', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const job = await makeJob(a, [a.rayId]);
  const id = job.data.job.id;

  for (const item of ['PVC pipe', 'PVC pipe', 'Rain Bird 5004']) {
    await a.call(`/api/office/worksheets/${id}/parts`, {
      method: 'POST', body: { item, quantity: 1, unit: item === 'PVC pipe' ? 'ft' : null },
    });
  }

  const got = await a.call('/api/office/worksheets?from=2026-09-27');
  assert.deepEqual(got.data.usual_parts.map((u) => u.item), ['PVC pipe', 'Rain Bird 5004']);
  assert.equal(got.data.usual_parts[0].unit, 'ft');
});

/* ============================== the crew ============================ */

test('the crew put parts on their own sheet as they use them', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const job = await makeJob(a, [a.rayId]);
  const id = job.data.job.id;

  await a.signIn('ray', '1111');
  const added = await a.call(`/api/crew/jobs/${id}/parts`, {
    method: 'POST', body: { item: 'Rain Bird 5004', quantity: 2 },
  });

  assert.equal(added.status, 200);
  assert.deepEqual(added.data.sheet.materials.map((m) => m.words), ['2 × Rain Bird 5004']);

  const sheet = await a.call(`/api/crew/jobs/${id}/sheet`);
  assert.equal(sheet.data.sheet.customer, 'Weaver residence');
  assert.deepEqual(sheet.data.usual_parts.map((u) => u.item), ['Rain Bird 5004']);
});

test('a crew member cannot touch the sheet for a job they are not on', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const job = await makeJob(a, [a.rayId]);
  const id = job.data.job.id;

  await a.signIn('tom', '2222');
  assert.equal((await a.call(`/api/crew/jobs/${id}/sheet`)).status, 400);
  assert.equal((await a.call(`/api/crew/jobs/${id}/parts`, {
    method: 'POST', body: { item: 'Valve' } })).status, 400);
});

test('finishing a job fills in the rest of the sheet', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const job = await makeJob(a, [a.rayId]);
  const id = job.data.job.id;

  await a.signIn('ray', '1111');
  await a.call(`/api/crew/jobs/${id}/parts`, {
    method: 'POST', body: { item: 'Valve', quantity: 1 },
  });
  const done = await a.call(`/api/crew/jobs/${id}/finish`, {
    method: 'POST',
    body: { wrap_notes: 'Replaced the zone 3 valve.', next_visit: 'Timer in spring',
            signed_by: 'M. Weaver' },
  });
  assert.equal(done.status, 200);

  await a.signIn('office', '9999');
  const sheet = await a.call(`/api/office/worksheets/${id}`);

  assert.equal(sheet.data.sheet.done, 'Replaced the zone 3 valve.');
  assert.equal(sheet.data.sheet.next_visit, 'Timer in spring');
  assert.equal(sheet.data.sheet.signed_by, 'M. Weaver');
  assert.ok(sheet.data.sheet.signed_at);
});

test('the crew cannot reach the office worksheet screens', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const job = await makeJob(a, [a.rayId]);
  await a.signIn('ray', '1111');

  assert.equal((await a.call('/api/office/worksheets')).status, 403);
  assert.equal((await a.call(`/api/office/worksheets/${job.data.job.id}`)).status, 403);
});

/* ========================= hours reach the sheet ==================== */

test('hours clocked on a job land on its worksheet', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const job = await makeJob(a, [a.rayId, a.tomId]);
  const id = job.data.job.id;

  await a.call('/api/office/shifts', { method: 'POST' }).catch(() => {});

  // Put the hours in the way the office does when somebody forgets to clock.
  await a.signIn('ray', '1111');
  await a.call('/api/crew/shifts', {
    method: 'POST',
    body: { job_id: id, work_date: '2026-09-27', start_time: '08:00', end_time: '12:30',
            break_minutes: 30 },
  });

  await a.signIn('office', '9999');
  const sheet = await a.call(`/api/office/worksheets/${id}`);

  assert.equal(sheet.data.sheet.hours, 4);
  assert.deepEqual(sheet.data.sheet.people.map((p) => p.name), ['Ray Delgado']);
  assert.ok(!sheet.data.sheet.missing.includes('Nobody has put hours on it'));
});

test('the learned parts list comes with the sheet being filled in, not just the day',
  async (t) => {
    const a = await app();
    t.after(() => a.stop());

    const job = await makeJob(a, [a.rayId]);
    const id = job.data.job.id;

    await a.call(`/api/office/worksheets/${id}/parts`, {
      method: 'POST', body: { item: 'PVC pipe', quantity: 10, unit: 'ft' },
    });

    // Opening one sheet is exactly where tapping a name instead of spelling
    // one matters, and it was the one place the list was not being sent.
    const one = await a.call(`/api/office/worksheets/${id}`);
    assert.deepEqual(one.data.usual_parts.map((u) => u.item), ['PVC pipe']);
  });

/* ========================= worksheets-only mode ===================== */

test('the trimmed-down mode is off until somebody asks for it, and rides every screen',
  async (t) => {
    const a = await app();
    t.after(() => a.stop());

    assert.equal((await a.call('/api/office/worksheets')).data.simple, false);
    assert.equal((await a.call('/api/office/day?date=2026-09-27')).data.simple, false);

    const on = await a.call('/api/office/simple-mode', { method: 'POST', body: { only: true } });
    assert.equal(on.data.simple, true);

    // Every office screen has to know, or the rail would flick back on the
    // first tab that did not carry it.
    assert.equal((await a.call('/api/office/worksheets')).data.simple, true);
    assert.equal((await a.call('/api/office/customers')).data.simple, true);
    assert.equal((await a.call('/api/office/people')).data.simple, true);

    const off = await a.call('/api/office/simple-mode', { method: 'POST', body: { only: false } });
    assert.equal(off.data.simple, false);
    assert.equal((await a.call('/api/office/worksheets')).data.simple, false);
  });

test('turning the rail down puts nothing away for good', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  const job = await makeJob(a, [a.rayId]);
  await a.call('/api/office/simple-mode', { method: 'POST', body: { only: true } });

  // The screens are hidden in the rail, not switched off underneath.
  assert.equal((await a.call('/api/office/quotes?status=all')).status, 200);
  assert.equal((await a.call('/api/office/payroll')).status, 200);
  assert.equal((await a.call(`/api/office/worksheets/${job.data.job.id}`)).status, 200);
});

test('the crew are not shown the switch', async (t) => {
  const a = await app();
  t.after(() => a.stop());

  await a.signIn('ray', '1111');
  assert.equal((await a.call('/api/office/simple-mode', {
    method: 'POST', body: { only: true } })).status, 403);
});
