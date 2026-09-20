'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { open } = require('../src/db');
const auth = require('../src/auth');
const { createServer } = require('../server');
const { today, addDays } = require('../src/time');

/** The real server against a throwaway in-memory database. */
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

/** A client that remembers its cookie, the way a phone would. */
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

test('a full day: give out a job, work it, send hours, office OKs them', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const office = client(app.base);
  const ray = client(app.base);
  const tom = client(app.base);
  const date = today();

  await t.test('the office signs in', async () => {
    const wrong = await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '0000' } });
    assert.strictEqual(wrong.status, 401);

    const ok = await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.user.role, 'office');
  });

  let rayId; let tomId;
  await t.test('the office adds two crew', async () => {
    const a = await office('/api/office/people', {
      method: 'POST',
      body: { name: 'Ray Delgado', username: 'ray', pin: '1111', hourly_rate: 27 },
    });
    assert.strictEqual(a.status, 200);
    rayId = a.data.person.id;

    const b = await office('/api/office/people', {
      method: 'POST',
      body: { name: 'Tom Feeney', username: 'tom', pin: '2222', hourly_rate: 25 },
    });
    tomId = b.data.person.id;

    const dupe = await office('/api/office/people', {
      method: 'POST',
      body: { name: 'Another Ray', username: 'RAY', pin: '4321' },
    });
    assert.strictEqual(dupe.status, 409);

    const shortPin = await office('/api/office/people', {
      method: 'POST',
      body: { name: 'Nope', username: 'nope', pin: '12' },
    });
    assert.strictEqual(shortPin.status, 400);
  });

  let jobId;
  await t.test('a job goes out to a two-person crew', async () => {
    const res = await office('/api/office/jobs', {
      method: 'POST',
      body: {
        customer: 'Kestrel Ridge HOA',
        job_date: date,
        kind: 'drainage',
        address: '88 Willow Creek Ct',
        details: 'French drain along the back fence',
        est_hours: 8,
        crew_ids: [rayId, tomId],
      },
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.job.status, 'assigned');
    assert.strictEqual(res.data.job.crew.length, 2, 'both people are on the job');
    jobId = res.data.job.id;

    const nobody = await office('/api/office/jobs', {
      method: 'POST',
      body: { customer: 'Nobody', job_date: date, crew_ids: [] },
    });
    assert.strictEqual(nobody.status, 400);
    assert.match(nobody.data.error, /at least one person/);
  });

  await t.test('both crew see the job, and nobody else does', async () => {
    await ray('/api/signin', { method: 'POST', body: { username: 'ray', pin: '1111' } });
    await tom('/api/signin', { method: 'POST', body: { username: 'tom', pin: '2222' } });

    const rayDay = await ray(`/api/crew/day?date=${date}`);
    assert.strictEqual(rayDay.status, 200);
    assert.strictEqual(rayDay.data.jobs.length, 1);
    assert.strictEqual(rayDay.data.jobs[0].customer, 'Kestrel Ridge HOA');
    assert.strictEqual(rayDay.data.jobs[0].address, '88 Willow Creek Ct');
    assert.strictEqual(rayDay.data.running, null);

    const tomDay = await tom(`/api/crew/day?date=${date}`);
    assert.strictEqual(tomDay.data.jobs.length, 1, 'the second person sees it too');

    const outsider = await office('/api/office/people', {
      method: 'POST',
      body: { name: 'Luis Barrera', username: 'luis', pin: '3333' },
    });
    const luis = client(app.base);
    await luis('/api/signin', { method: 'POST', body: { username: 'luis', pin: '3333' } });
    const luisDay = await luis(`/api/crew/day?date=${date}`);
    assert.strictEqual(luisDay.data.jobs.length, 0, 'somebody not on the job sees nothing');
    assert.ok(outsider.data.person.id);
  });

  let shiftId;
  await t.test('clocking on moves the job to working, and clocking off sends the hours', async () => {
    const on = await ray('/api/crew/clock-in', {
      method: 'POST',
      body: { job_id: jobId, work_date: date, start_time: '07:00' },
    });
    assert.strictEqual(on.status, 200);
    assert.strictEqual(on.data.shift.status, 'open');
    shiftId = on.data.shift.id;

    const job = await office(`/api/office/jobs?from=${date}&to=${date}`);
    assert.strictEqual(job.data.jobs[0].status, 'working', 'the office sees it is live');

    const twice = await ray('/api/crew/clock-in', {
      method: 'POST',
      body: { job_id: jobId, work_date: date, start_time: '08:00' },
    });
    assert.strictEqual(twice.status, 409);

    const off = await ray(`/api/crew/shifts/${shiftId}/clock-out`, {
      method: 'POST',
      body: { end_time: '15:30', break_minutes: 30, notes: 'Trench open, gravel tomorrow' },
    });
    assert.strictEqual(off.status, 200);
    assert.strictEqual(off.data.shift.status, 'sent');
    assert.strictEqual(off.data.shift.hours, 8);
    assert.strictEqual(off.data.shift.pay, 216);
  });

  await t.test('a crew member cannot log against a job they are not on', async () => {
    const other = await office('/api/office/jobs', {
      method: 'POST',
      body: { customer: 'Somewhere else', job_date: date, crew_ids: [tomId] },
    });

    const res = await ray('/api/crew/shifts', {
      method: 'POST',
      body: {
        job_id: other.data.job.id,
        work_date: date,
        start_time: '16:00',
        end_time: '17:00',
      },
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.data.error, /not on your list/);
  });

  await t.test('work nobody wrote down can still be clocked', async () => {
    const nameless = await ray('/api/crew/clock-in', {
      method: 'POST', body: { work_date: date, start_time: '16:00' },
    });
    assert.strictEqual(nameless.status, 400);
    assert.match(nameless.data.error, /say what you are working on/);

    const callOut = await ray('/api/crew/clock-in', {
      method: 'POST',
      body: { work_date: date, start_time: '16:00', other_work: 'Broken head at the Weaver place' },
    });
    assert.strictEqual(callOut.status, 200);
    assert.strictEqual(callOut.data.shift.job_id, null);
    assert.strictEqual(callOut.data.shift.what, 'Broken head at the Weaver place');

    await ray(`/api/crew/shifts/${callOut.data.shift.id}`, { method: 'DELETE' });
  });

  await t.test('the crew can close the job out with notes and parts', async () => {
    const res = await tom(`/api/crew/jobs/${jobId}/finish`, {
      method: 'POST',
      body: { wrap_notes: 'Drain in and backfilled', materials: '60ft of 4in pipe, two catch basins' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.job.status, 'done');
    assert.strictEqual(res.data.job.materials, '60ft of 4in pipe, two catch basins');
    assert.strictEqual(res.data.job.finished_by_name, 'Tom Feeney');
  });

  await t.test('the office OKs the hours', async () => {
    const waiting = await office('/api/office/waiting');
    assert.strictEqual(waiting.data.shifts.length, 1);
    assert.strictEqual(waiting.data.shifts[0].employee_name, 'Ray Delgado');

    const res = await office(`/api/office/shifts/${shiftId}/ok`, { method: 'POST', body: {} });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.shift.status, 'ok');
    assert.strictEqual(res.data.shift.reviewed_by_name, 'The office');

    const after = await office('/api/office/waiting');
    assert.strictEqual(after.data.shifts.length, 0);
  });

  await t.test("hours the office OK'd are locked to the crew", async () => {
    const edit = await ray(`/api/crew/shifts/${shiftId}`, {
      method: 'PATCH', body: { end_time: '19:00' },
    });
    assert.strictEqual(edit.status, 409);

    const gone = await ray(`/api/crew/shifts/${shiftId}`, { method: 'DELETE' });
    assert.strictEqual(gone.status, 409);
  });

  await t.test('a question goes back, gets fixed, and returns to the pile', async () => {
    await office(`/api/office/shifts/${shiftId}/question`, {
      method: 'POST', body: { question: 'You finished at 15:00, not 15:30' },
    });

    const day = await ray(`/api/crew/day?date=${date}`);
    const mine = day.data.shifts.find((s) => s.id === shiftId);
    assert.strictEqual(mine.status, 'question');
    assert.strictEqual(mine.question, 'You finished at 15:00, not 15:30');

    const fixed = await ray(`/api/crew/shifts/${shiftId}`, {
      method: 'PATCH', body: { end_time: '15:00' },
    });
    assert.strictEqual(fixed.status, 200);
    assert.strictEqual(fixed.data.shift.status, 'sent', 'a fix goes back for another look');
    assert.strictEqual(fixed.data.shift.question, null);
    assert.strictEqual(fixed.data.shift.hours, 7.5);

    await office(`/api/office/shifts/${shiftId}/ok`, { method: 'POST', body: {} });
  });

  await t.test('announcements reach the crew and the office sees who read them', async () => {
    const posted = await office('/api/office/notices', {
      method: 'POST',
      body: { title: 'Freeze warning Thursday', body: 'Blowouts move up a week.', urgent: true },
    });
    assert.strictEqual(posted.status, 200);
    const noticeId = posted.data.notice.id;

    const mine = await ray('/api/crew/notices');
    assert.strictEqual(mine.data.notices.length, 1);
    assert.strictEqual(mine.data.unread, 1, 'it starts unread');

    await ray(`/api/crew/notices/${noticeId}/seen`, { method: 'POST' });
    await ray(`/api/crew/notices/${noticeId}/seen`, { method: 'POST' });

    const again = await ray('/api/crew/notices');
    assert.strictEqual(again.data.unread, 0, 'marking it twice is harmless');

    const seen = await office('/api/office/notices');
    assert.deepStrictEqual(seen.data.notices[0].seen_by, ['Ray Delgado']);
  });

  await t.test('payroll and the CSV add up', async () => {
    const report = await office(`/api/office/payroll?from=${date}&to=${date}`);
    assert.strictEqual(report.status, 200);

    const line = report.data.rows.find((r) => r.name === 'Ray Delgado');
    assert.strictEqual(line.hours, 7.5);
    assert.strictEqual(line.ok_hours, 7.5);
    assert.strictEqual(line.pay, 202.5);

    const csv = await office(`/api/office/payroll.csv?from=${date}&to=${date}`);
    assert.strictEqual(csv.status, 200);
    assert.match(csv.data.text, /"Ray Delgado"/);
    assert.match(csv.data.text, /"Kestrel Ridge HOA"/);
  });

  await t.test('a mistyped finish is caught; a night job is not', async () => {
    const typo = await ray('/api/crew/shifts', {
      method: 'POST',
      body: { work_date: date, other_work: 'Callback', start_time: '18:30', end_time: '17:00' },
    });
    assert.strictEqual(typo.status, 400);
    assert.match(typo.data.error, /22\.5 hours/);

    const night = await ray('/api/crew/shifts', {
      method: 'POST',
      body: {
        work_date: date, other_work: 'Lighting timer callback',
        start_time: '21:00', end_time: '05:00', break_minutes: 30,
      },
    });
    assert.strictEqual(night.status, 200);
    assert.strictEqual(night.data.shift.hours, 7.5);
  });

  await t.test('the crew are kept out of the office side', async () => {
    for (const path of ['/api/office/people', '/api/office/waiting', '/api/office/notices']) {
      const res = await ray(path);
      assert.strictEqual(res.status, 403, `${path} should be office only`);
    }
  });

  await t.test('signed-out requests are refused', async () => {
    const stranger = client(app.base);
    assert.strictEqual((await stranger('/api/crew/day')).status, 401);
    assert.strictEqual((await stranger('/api/office/day')).status, 401);
  });
});

test('switching somebody off ends their session', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const office = client(app.base);
  const temp = client(app.base);

  await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });
  const added = await office('/api/office/people', {
    method: 'POST', body: { name: 'Temp Hand', username: 'temp', pin: '5555' },
  });

  await temp('/api/signin', { method: 'POST', body: { username: 'temp', pin: '5555' } });
  assert.strictEqual((await temp('/api/crew/day')).status, 200);

  await office(`/api/office/people/${added.data.person.id}`, {
    method: 'PATCH', body: { active: false },
  });

  assert.strictEqual((await temp('/api/crew/day')).status, 401, 'the session dies with the account');

  const retry = await temp('/api/signin', { method: 'POST', body: { username: 'temp', pin: '5555' } });
  assert.strictEqual(retry.status, 401, 'and they cannot sign back in');
});

test('the last office account cannot lock everybody out', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const office = client(app.base);
  await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });

  const me = await office('/api/me');
  const res = await office(`/api/office/people/${me.data.user.id}`, {
    method: 'PATCH', body: { role: 'crew' },
  });

  assert.strictEqual(res.status, 409);
});

test('the crew of a job can be changed without losing the job', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const office = client(app.base);
  await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });

  const a = await office('/api/office/people', {
    method: 'POST', body: { name: 'Ray', username: 'ray', pin: '1111' },
  });
  const b = await office('/api/office/people', {
    method: 'POST', body: { name: 'Tom', username: 'tom', pin: '2222' },
  });

  const job = await office('/api/office/jobs', {
    method: 'POST',
    body: { customer: 'Weaver', job_date: today(), crew_ids: [a.data.person.id] },
  });

  const moved = await office(`/api/office/jobs/${job.data.job.id}`, {
    method: 'PATCH', body: { crew_ids: [b.data.person.id] },
  });

  assert.strictEqual(moved.status, 200);
  assert.deepStrictEqual(moved.data.job.crew.map((c) => c.name), ['Tom']);

  const emptied = await office(`/api/office/jobs/${job.data.job.id}`, {
    method: 'PATCH', body: { crew_ids: [] },
  });
  assert.strictEqual(emptied.status, 400, 'a job cannot be left with nobody on it');
});

test('static files never escape the public directory', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const climb = await fetch(`${app.base}/../server.js`, { redirect: 'manual' });
  assert.ok([301, 403, 404].includes(climb.status), `got ${climb.status}`);
});

test('a job spanning two days keeps its own hours', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const office = client(app.base);
  const ray = client(app.base);

  await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });
  const person = await office('/api/office/people', {
    method: 'POST', body: { name: 'Ray', username: 'ray', pin: '1111', hourly_rate: 20 },
  });

  const yesterday = addDays(today(), -1);
  const job = await office('/api/office/jobs', {
    method: 'POST',
    body: { customer: 'Brookside', job_date: yesterday, crew_ids: [person.data.person.id] },
  });

  await ray('/api/signin', { method: 'POST', body: { username: 'ray', pin: '1111' } });

  for (const [date, start, end] of [[yesterday, '08:00', '12:00'], [today(), '08:00', '10:00']]) {
    const res = await ray('/api/crew/shifts', {
      method: 'POST',
      body: { job_id: job.data.job.id, work_date: date, start_time: start, end_time: end },
    });
    assert.strictEqual(res.status, 200);
  }

  const week = await ray(`/api/crew/week?from=${yesterday}&to=${today()}`);
  assert.strictEqual(week.data.totals.hours, 6);
  assert.strictEqual(week.data.totals.pay, 120);

  const dayOnly = await ray(`/api/crew/day?date=${today()}`);
  assert.strictEqual(dayOnly.data.totals.hours, 2, 'the day view only counts that day');
});
