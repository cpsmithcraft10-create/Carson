'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { open } = require('../src/db');
const auth = require('../src/auth');
const { createServer } = require('../server');
const { today } = require('../src/hours');

/** Starts the real server against a throwaway in-memory database. */
async function startApp() {
  const db = open(':memory:');

  db.prepare(`INSERT INTO workers (name, username, pin_hash, role) VALUES (?, ?, ?, 'admin')`)
    .run('Boss', 'boss', auth.hashPin('9999'));

  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    db,
    base,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

/** A tiny client that remembers its session cookie, like a browser would. */
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

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];

    const text = await res.text();
    let data = {};
    if (text && (res.headers.get('content-type') || '').includes('json')) data = JSON.parse(text);
    else data = { text };

    return { status: res.status, data };
  };
}

test('the whole run: assign work, log hours, approve, report', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const boss = client(app.base);
  const worker = client(app.base);
  const date = today();

  await t.test('the manager signs in', async () => {
    const wrong = await boss('/api/login', { method: 'POST', body: { username: 'boss', pin: '0000' } });
    assert.strictEqual(wrong.status, 401);

    const ok = await boss('/api/login', { method: 'POST', body: { username: 'boss', pin: '9999' } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.user.role, 'admin');
  });

  let workerId;
  await t.test('the manager adds a worker', async () => {
    const res = await boss('/api/admin/workers', {
      method: 'POST',
      body: { name: 'Dana', username: 'dana', pin: '1234', hourly_rate: 30 },
    });
    assert.strictEqual(res.status, 200);
    workerId = res.data.worker.id;

    const dupe = await boss('/api/admin/workers', {
      method: 'POST',
      body: { name: 'Other Dana', username: 'DANA', pin: '4321' },
    });
    assert.strictEqual(dupe.status, 409);

    const badPin = await boss('/api/admin/workers', {
      method: 'POST',
      body: { name: 'Nope', username: 'nope', pin: '12' },
    });
    assert.strictEqual(badPin.status, 400);
  });

  let jobId;
  await t.test('the manager gives out a job for the day', async () => {
    const res = await boss('/api/admin/jobs', {
      method: 'POST',
      body: {
        title: 'Riverside fit-out',
        work_date: date,
        location: '14 Riverside Ave',
        scheduled_hours: 8,
        worker_ids: [workerId],
      },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.jobs.length, 1);
    jobId = res.data.jobs[0].id;
  });

  await t.test('the worker signs in and sees only their own job', async () => {
    const login = await worker('/api/login', { method: 'POST', body: { username: 'dana', pin: '1234' } });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.data.user.role, 'worker');

    const day = await worker(`/api/my/day?date=${date}`);
    assert.strictEqual(day.status, 200);
    assert.strictEqual(day.data.jobs.length, 1);
    assert.strictEqual(day.data.jobs[0].title, 'Riverside fit-out');
    assert.strictEqual(day.data.running, null);
  });

  let entryId;
  await t.test('clocking in and out records the hours', async () => {
    const inRes = await worker('/api/my/clock-in', {
      method: 'POST',
      body: { job_id: jobId, work_date: date, start_time: '07:30' },
    });
    assert.strictEqual(inRes.status, 200);
    assert.strictEqual(inRes.data.entry.status, 'open');
    entryId = inRes.data.entry.id;

    const twice = await worker('/api/my/clock-in', {
      method: 'POST',
      body: { job_id: jobId, work_date: date, start_time: '08:00' },
    });
    assert.strictEqual(twice.status, 409, 'cannot be clocked in twice');

    const outRes = await worker(`/api/my/entries/${entryId}/clock-out`, {
      method: 'POST',
      body: { end_time: '16:00', break_minutes: 30, description: 'Framing done' },
    });
    assert.strictEqual(outRes.status, 200);
    assert.strictEqual(outRes.data.entry.status, 'submitted');
    assert.strictEqual(outRes.data.entry.hours, 8);
    assert.strictEqual(outRes.data.entry.pay, 240);
  });

  await t.test('a worker cannot log against someone else\'s job', async () => {
    const other = await boss('/api/admin/workers', {
      method: 'POST',
      body: { name: 'Miguel', username: 'miguel', pin: '2468' },
    });
    const theirJob = await boss('/api/admin/jobs', {
      method: 'POST',
      body: { title: 'Somewhere else', work_date: date, worker_ids: [other.data.worker.id] },
    });

    const res = await worker('/api/my/entries', {
      method: 'POST',
      body: {
        job_id: theirJob.data.jobs[0].id,
        work_date: date,
        start_time: '09:00',
        end_time: '10:00',
      },
    });
    assert.strictEqual(res.status, 400);
  });

  await t.test('the manager approves the shift', async () => {
    const pending = await boss('/api/admin/pending');
    assert.strictEqual(pending.data.entries.length, 1);
    assert.strictEqual(pending.data.entries[0].worker_name, 'Dana');

    const res = await boss(`/api/admin/entries/${entryId}/approve`, { method: 'POST', body: {} });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.entry.status, 'approved');
    assert.strictEqual(res.data.entry.reviewed_by_name, 'Boss');

    const after = await boss('/api/admin/pending');
    assert.strictEqual(after.data.entries.length, 0);
  });

  await t.test('approved hours are locked for the worker', async () => {
    const edit = await worker(`/api/my/entries/${entryId}`, {
      method: 'PATCH',
      body: { end_time: '19:00' },
    });
    assert.strictEqual(edit.status, 409);

    const remove = await worker(`/api/my/entries/${entryId}`, { method: 'DELETE' });
    assert.strictEqual(remove.status, 409);
  });

  await t.test('a sent-back shift can be fixed and resubmitted', async () => {
    await boss(`/api/admin/entries/${entryId}/reject`, {
      method: 'POST',
      body: { note: 'You finished at 15:00, not 16:00' },
    });

    const day = await worker(`/api/my/day?date=${date}`);
    const entry = day.data.entries.find((e) => e.id === entryId);
    assert.strictEqual(entry.status, 'rejected');
    assert.strictEqual(entry.review_note, 'You finished at 15:00, not 16:00');

    const fixed = await worker(`/api/my/entries/${entryId}`, {
      method: 'PATCH',
      body: { end_time: '15:00' },
    });
    assert.strictEqual(fixed.status, 200);
    assert.strictEqual(fixed.data.entry.status, 'submitted', 'a fix goes back for review');
    assert.strictEqual(fixed.data.entry.review_note, null);
    assert.strictEqual(fixed.data.entry.hours, 7);

    await boss(`/api/admin/entries/${entryId}/approve`, { method: 'POST', body: {} });
  });

  await t.test('the report and CSV add up', async () => {
    const report = await boss(`/api/admin/report?from=${date}&to=${date}`);
    assert.strictEqual(report.status, 200);

    const dana = report.data.rows.find((r) => r.worker_name === 'Dana');
    assert.strictEqual(dana.hours, 7);
    assert.strictEqual(dana.approved_hours, 7);
    assert.strictEqual(dana.pay, 210);
    assert.strictEqual(report.data.totals.hours, 7);

    const csv = await boss(`/api/admin/report.csv?from=${date}&to=${date}`);
    assert.strictEqual(csv.status, 200);
    assert.match(csv.data.text, /"Dana"/);
    assert.match(csv.data.text, /"Riverside fit-out"/);
  });

  await t.test('work that was never on the list can still be clocked', async () => {
    const nameless = await worker('/api/my/clock-in', {
      method: 'POST',
      body: { work_date: date, start_time: '13:00' },
    });
    assert.strictEqual(nameless.status, 400, 'a shift with no job and no description is refused');
    assert.match(nameless.data.error, /say what you are working on/);

    const callOut = await worker('/api/my/clock-in', {
      method: 'POST',
      body: { work_date: date, start_time: '13:00', description: 'Broken head at the Weaver place' },
    });
    assert.strictEqual(callOut.status, 200);
    assert.strictEqual(callOut.data.entry.job_id, null);
    assert.strictEqual(callOut.data.entry.description, 'Broken head at the Weaver place');

    const out = await worker(`/api/my/entries/${callOut.data.entry.id}/clock-out`, {
      method: 'POST',
      body: { end_time: '15:00', break_minutes: 0 },
    });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.data.entry.hours, 2);
    assert.strictEqual(out.data.entry.description, 'Broken head at the Weaver place',
      'clocking out without notes keeps what the job was');

    await worker(`/api/my/entries/${callOut.data.entry.id}`, { method: 'DELETE' });
  });

  await t.test('a mistyped finish time is caught, a real night shift is not', async () => {
    const typo = await worker('/api/my/entries', {
      method: 'POST',
      body: { work_date: date, start_time: '18:30', end_time: '17:00' },
    });
    assert.strictEqual(typo.status, 400);
    assert.match(typo.data.error, /22\.5 hours/);

    const longBreak = await worker('/api/my/entries', {
      method: 'POST',
      body: { work_date: date, start_time: '08:00', end_time: '08:30', break_minutes: 60 },
    });
    assert.strictEqual(longBreak.status, 400);
    assert.match(longBreak.data.error, /does not fit/);

    const nightShift = await worker('/api/my/entries', {
      method: 'POST',
      body: { work_date: date, start_time: '22:00', end_time: '06:00', break_minutes: 30 },
    });
    assert.strictEqual(nightShift.status, 200);
    assert.strictEqual(nightShift.data.entry.hours, 7.5);

    await worker(`/api/my/entries/${nightShift.data.entry.id}`, { method: 'DELETE' });
  });

  await t.test('workers are kept out of the manager side', async () => {
    for (const path of ['/api/admin/workers', '/api/admin/pending', `/api/admin/report?from=${date}&to=${date}`]) {
      const res = await worker(path);
      assert.strictEqual(res.status, 403, `${path} should be managers only`);
    }
  });

  await t.test('signed-out requests are refused', async () => {
    const stranger = client(app.base);
    assert.strictEqual((await stranger('/api/my/day')).status, 401);
    assert.strictEqual((await stranger('/api/admin/pending')).status, 401);
  });

  await t.test('bad input is rejected with a readable message', async () => {
    const res = await worker('/api/my/entries', {
      method: 'POST',
      body: { work_date: 'yesterday', start_time: '08:00', end_time: '09:00' },
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.data.error, /Date must be a date/);

    const badTime = await worker('/api/my/entries', {
      method: 'POST',
      body: { work_date: date, start_time: '25:00', end_time: '09:00' },
    });
    assert.strictEqual(badTime.status, 400);
  });
});

test('deactivating a worker ends their session', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const boss = client(app.base);
  const worker = client(app.base);

  await boss('/api/login', { method: 'POST', body: { username: 'boss', pin: '9999' } });
  const added = await boss('/api/admin/workers', {
    method: 'POST',
    body: { name: 'Temp', username: 'temp', pin: '5555' },
  });

  await worker('/api/login', { method: 'POST', body: { username: 'temp', pin: '5555' } });
  assert.strictEqual((await worker('/api/my/day')).status, 200);

  await boss(`/api/admin/workers/${added.data.worker.id}`, { method: 'PATCH', body: { active: false } });

  assert.strictEqual((await worker('/api/my/day')).status, 401, 'session dies with the account');

  const retry = await worker('/api/login', { method: 'POST', body: { username: 'temp', pin: '5555' } });
  assert.strictEqual(retry.status, 401, 'an inactive worker cannot sign back in');
});

test('the last manager account cannot lock everyone out', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const boss = client(app.base);
  await boss('/api/login', { method: 'POST', body: { username: 'boss', pin: '9999' } });

  const me = await boss('/api/me');
  const res = await boss(`/api/admin/workers/${me.data.user.id}`, {
    method: 'PATCH',
    body: { role: 'worker' },
  });

  assert.strictEqual(res.status, 409);
});

test('static files never escape the public directory', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const res = await fetch(`${app.base}/../server.js`, { redirect: 'manual' });
  assert.ok(res.status === 404 || res.status === 403 || res.status === 301, `got ${res.status}`);

  const home = await fetch(`${app.base}/`);
  assert.strictEqual(home.status, 200);
  assert.match(await home.text(), /Crew hours/);
});
