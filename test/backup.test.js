'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { open } = require('../src/db');
const {
  nameFor, whenOf, whatToKeep, list, snapshot, prune, backupNow, start,
} = require('../src/backup');

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cod-backup-'));

/* ========================= names and timestamps ===================== */

test('a snapshot is named by when it was taken, and reads back', () => {
  const when = new Date(2026, 8, 27, 14, 5);           // 27 Sep 2026, 14:05
  assert.equal(nameFor(when), 'custom-outdoor-2026-09-27-1405.db');
  assert.equal(whenOf(nameFor(when)).getTime(), when.getTime());
});

test('anything that is not one of ours is not mistaken for a backup', () => {
  for (const name of ['custom-outdoor.db', 'notes.txt', '', null,
    'custom-outdoor-2026-09-27.db', '.custom-outdoor-2026-09-27-1405.db.part']) {
    assert.equal(whenOf(name), null, `${name} should not parse`);
  }
});

/* =========================== the keep rules ========================= */

const now = new Date(2026, 8, 27, 18, 0);
const ago = (days, hour = 12) =>
  nameFor(new Date(2026, 8, 27 - days, hour, 0));

test('everything from the last couple of days is kept', () => {
  const names = [ago(0, 6), ago(0, 12), ago(0, 18), ago(1, 6), ago(1, 18)];
  const { keep, drop } = whatToKeep(names, now);

  assert.equal(keep.length, 5);
  assert.deepEqual(drop, []);
});

test('older than that, one a day survives — the last one of each day', () => {
  const names = [
    nameFor(new Date(2026, 8, 17, 6, 0)),
    nameFor(new Date(2026, 8, 17, 12, 0)),
    nameFor(new Date(2026, 8, 17, 23, 0)),   // the keeper
    nameFor(new Date(2026, 8, 16, 9, 0)),    // alone, so also a keeper
  ];
  const { keep, drop } = whatToKeep(names, now);

  assert.deepEqual(keep, [
    'custom-outdoor-2026-09-17-2300.db',
    'custom-outdoor-2026-09-16-0900.db',
  ]);
  assert.equal(drop.length, 2);
});

test('past a month, one a month survives', () => {
  const names = [
    nameFor(new Date(2026, 5, 2, 8, 0)),
    nameFor(new Date(2026, 5, 19, 8, 0)),    // the later June one
    nameFor(new Date(2026, 3, 11, 8, 0)),    // April, on its own
  ];
  const { keep, drop } = whatToKeep(names, now);

  assert.deepEqual(keep, [
    'custom-outdoor-2026-06-19-0800.db',
    'custom-outdoor-2026-04-11-0800.db',
  ]);
  assert.deepEqual(drop, ['custom-outdoor-2026-06-02-0800.db']);
});

test('a backup from years back is eventually let go', () => {
  const { keep, drop } = whatToKeep([nameFor(new Date(2019, 0, 4, 8, 0))], now);
  assert.deepEqual(keep, []);
  assert.equal(drop.length, 1);
});

test('the day before last stays whole even when a month of dailies sits behind it', () => {
  // The bug worth guarding: a per-day rule that also claims today's copies
  // would leave only one snapshot of the day somebody needs to undo.
  const names = [ago(0, 8), ago(0, 16), ago(1, 8), ago(1, 16), ago(10, 8), ago(10, 16)];
  const { keep } = whatToKeep(names, now);

  assert.ok(keep.includes(ago(0, 8)) && keep.includes(ago(0, 16)));
  assert.ok(keep.includes(ago(1, 8)) && keep.includes(ago(1, 16)));
  assert.equal(keep.filter((n) => n.startsWith('custom-outdoor-2026-09-17')).length, 1);
});

test('files that are not backups are left alone entirely', () => {
  const { keep, drop, ignored } = whatToKeep(['readme.txt', 'custom-outdoor.db', ago(400)], now);

  assert.deepEqual(ignored, ['readme.txt', 'custom-outdoor.db']);
  assert.ok(!drop.includes('readme.txt'));
  assert.ok(!keep.includes('custom-outdoor.db'));
});

/* ======================= snapshots of a real db ===================== */

test('a snapshot is a working database holding the same rows', () => {
  const dir = folder();
  const db = open(':memory:');
  db.prepare(`INSERT INTO employees (name, username, pin_hash, hourly_rate, role)
              VALUES (?, ?, ?, ?, ?)`).run('Dale Whitlock', 'dale', 'x', 28, 'crew');

  const made = snapshot(db, dir, new Date(2026, 8, 27, 9, 30));

  assert.equal(made.name, 'custom-outdoor-2026-09-27-0930.db');
  assert.ok(made.bytes > 0);

  const copy = open(made.path);
  const rows = copy.prepare('SELECT name FROM employees').all();
  assert.deepEqual(rows.map((r) => r.name), ['Dale Whitlock']);
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  copy.close();

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the live database keeps working, and the snapshot does not follow it', () => {
  const dir = folder();
  const db = open(':memory:');
  const add = db.prepare(`INSERT INTO employees (name, username, pin_hash, hourly_rate, role)
                          VALUES (?, ?, ?, ?, ?)`);
  add.run('Dale Whitlock', 'dale', 'x', 28, 'crew');

  const made = snapshot(db, dir);

  add.run('Rosa Aldrete', 'rosa', 'x', 30, 'crew');
  assert.equal(db.prepare('SELECT count(*) n FROM employees').get().n, 2);

  const copy = open(made.path);
  assert.equal(copy.prepare('SELECT count(*) n FROM employees').get().n, 1,
    'a snapshot is a moment, not a mirror');
  copy.close();

  // No -wal left beside it to be lost separately.
  assert.equal(fs.existsSync(made.path + '-wal'), false);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nothing half-written is left behind under a name that looks finished', () => {
  const dir = folder();
  const db = open(':memory:');

  snapshot(db, dir);

  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.part'));
  assert.deepEqual(leftovers, []);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listing gives newest first with sizes', () => {
  const dir = folder();
  const db = open(':memory:');

  snapshot(db, dir, new Date(2026, 8, 25, 9, 0));
  snapshot(db, dir, new Date(2026, 8, 27, 9, 0));
  snapshot(db, dir, new Date(2026, 8, 26, 9, 0));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a backup');

  const rows = list(dir);
  assert.deepEqual(rows.map((r) => r.name), [
    'custom-outdoor-2026-09-27-0900.db',
    'custom-outdoor-2026-09-26-0900.db',
    'custom-outdoor-2026-09-25-0900.db',
  ]);
  assert.ok(rows.every((r) => r.bytes > 0));

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listing a folder that does not exist yet is empty, not an error', () => {
  assert.deepEqual(list(path.join(os.tmpdir(), 'cod-nothing-here-' + Date.now())), []);
});

test('pruning deletes what the rules dropped and nothing else', () => {
  const dir = folder();
  const db = open(':memory:');

  const old = snapshot(db, dir, new Date(2026, 8, 17, 6, 0));
  const keeper = snapshot(db, dir, new Date(2026, 8, 17, 23, 0));
  const today = snapshot(db, dir, new Date(2026, 8, 27, 9, 0));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a backup');

  const dropped = prune(dir, now);

  assert.deepEqual(dropped, [old.name]);
  assert.equal(fs.existsSync(old.path), false);
  assert.equal(fs.existsSync(keeper.path), true);
  assert.equal(fs.existsSync(today.path), true);
  assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backing up twice in the same minute does not fail or double up', () => {
  const dir = folder();
  const db = open(':memory:');
  const when = new Date(2026, 8, 27, 9, 0);

  backupNow(db, dir, when);
  const second = backupNow(db, dir, when);

  assert.equal(list(dir).length, 1);
  assert.ok(second.bytes > 0);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ============================== the timer =========================== */

test('starting takes one straight away, and can be stopped', () => {
  const dir = folder();
  const db = open(':memory:');
  const said = [];
  const log = { log: (m) => said.push(m), error: (m) => said.push('ERR ' + m) };

  const job = start(db, { dir, everyHours: 6, log });

  assert.equal(list(dir).length, 1);
  assert.match(said[0], /^Backed up to custom-outdoor-/);
  job.stop();

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a backup that cannot be written is logged, not thrown at the server', () => {
  const db = open(':memory:');
  const said = [];
  const log = { log: () => {}, error: (...m) => said.push(m.join(' ')) };

  // A file where the folder should be: nothing can be written inside it.
  const wedge = path.join(folder(), 'in-the-way');
  fs.writeFileSync(wedge, 'x');

  const job = start(db, { dir: wedge, log });

  assert.equal(job.run(), null);
  assert.ok(said.some((m) => m.startsWith('Backup failed:')), said.join('; '));
  job.stop();

  db.close();
});

test('a folder name with an apostrophe is refused rather than mangling the SQL', () => {
  const db = open(':memory:');
  const dir = path.join(folder(), "dad's backups");

  assert.throws(() => snapshot(db, dir), /apostrophe/);

  db.close();
});

/* ======================= what the office screen sees ================= */

const auth = require('../src/auth');
const { createServer } = require('../server');

async function officeApp(dir) {
  process.env.BACKUP_DIR = dir;

  const db = open(':memory:');
  db.prepare(`INSERT INTO employees (name, username, pin_hash, role) VALUES (?, ?, ?, 'office')`)
    .run('The office', 'office', auth.hashPin('9999'));
  db.prepare(`INSERT INTO employees (name, username, pin_hash, role, hourly_rate)
              VALUES (?, ?, ?, 'crew', 30)`).run('Ray Delgado', 'ray', auth.hashPin('1111'));

  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  let cookie = null;
  const call = async (p, { method = 'GET', body, raw = false } = {}) => {
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
    if (raw) return { status: res.status, res, bytes: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    const json = (res.headers.get('content-type') || '').includes('json');
    return { status: res.status, data: text && json ? JSON.parse(text) : { text } };
  };

  const signIn = (username, pin) =>
    call('/api/signin', { method: 'POST', body: { username, pin } });

  return {
    call,
    signIn,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
      delete process.env.BACKUP_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the office can see there are no copies yet, and then make one', async (t) => {
  const app = await officeApp(folder());
  t.after(() => app.stop());
  await app.signIn('office', '9999');

  const empty = await app.call('/api/office/backups');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.backups, []);
  assert.equal(empty.data.newest, null);
  assert.equal(empty.data.on, true);
  assert.equal(empty.data.every_hours, 6);

  const made = await app.call('/api/office/backups', { method: 'POST' });
  assert.equal(made.status, 200);
  assert.ok(made.data.saved.bytes > 0);

  const after = await app.call('/api/office/backups');
  assert.equal(after.data.backups.length, 1);
  assert.equal(after.data.newest.name, made.data.saved.name);
  assert.equal(after.data.kept_bytes, made.data.saved.bytes);
});

test('a copy downloads as a real SQLite file', async (t) => {
  const app = await officeApp(folder());
  t.after(() => app.stop());
  await app.signIn('office', '9999');

  const made = await app.call('/api/office/backups', { method: 'POST' });
  const got = await app.call(`/api/office/backups/${made.data.saved.name}`, { raw: true });

  assert.equal(got.status, 200);
  assert.equal(got.bytes.length, made.data.saved.bytes);
  assert.equal(got.bytes.subarray(0, 15).toString(), 'SQLite format 3');
  assert.match(got.res.headers.get('content-disposition'), /attachment; filename="custom-outdoor-/);
});

test('a name that tries to walk out of the folder gets nothing', async (t) => {
  const app = await officeApp(folder());
  t.after(() => app.stop());
  await app.signIn('office', '9999');

  for (const name of ['..%2F..%2Fserver.js', 'custom-outdoor.db', '..', 'anything.db',
    '.custom-outdoor-2026-09-27-0900.db.part']) {
    const got = await app.call(`/api/office/backups/${name}`);
    assert.equal(got.status, 404, `${name} should not be served`);
  }
});

test('a copy that has been cleared away is a plain not-found', async (t) => {
  const app = await officeApp(folder());
  t.after(() => app.stop());
  await app.signIn('office', '9999');

  const got = await app.call('/api/office/backups/custom-outdoor-2026-09-27-0900.db');
  assert.equal(got.status, 404);
  assert.match(got.data.error, /no longer there/);
});

test('the crew cannot see or take the company database', async (t) => {
  const app = await officeApp(folder());
  t.after(() => app.stop());

  await app.signIn('office', '9999');
  const made = await app.call('/api/office/backups', { method: 'POST' });

  await app.signIn('ray', '1111');
  assert.equal((await app.call('/api/office/backups')).status, 403);
  assert.equal((await app.call('/api/office/backups', { method: 'POST' })).status, 403);
  assert.equal((await app.call(`/api/office/backups/${made.data.saved.name}`)).status, 403);
});

test('signed out, nobody can take the company database', async (t) => {
  const app = await officeApp(folder());
  t.after(() => app.stop());

  // 401 rather than 403: no session at all is caught before the role is.
  assert.equal((await app.call('/api/office/backups')).status, 401);
  assert.equal((await app.call('/api/office/backups/custom-outdoor-2026-09-27-0900.db')).status, 401);
});

test('a copy made mid-shift holds the hours that were already in', async (t) => {
  const app = await officeApp(folder());
  t.after(() => app.stop());
  await app.signIn('office', '9999');

  const ray = (await app.call('/api/office/people')).data.people
    .find((p) => p.username === 'ray');

  const made = await app.call('/api/office/jobs', {
    method: 'POST',
    body: { customer: 'Weaver residence', address: '14 Marsh Lane', kind: 'sprinkler',
            job_date: '2026-09-27', crew_ids: [ray.id] },
  });
  assert.equal(made.status, 200);

  const saved = await app.call('/api/office/backups', { method: 'POST' });
  const copy = open(path.join(process.env.BACKUP_DIR, saved.data.saved.name));

  assert.deepEqual(
    copy.prepare('SELECT customer FROM jobs').all().map((r) => r.customer),
    ['Weaver residence'],
  );
  copy.close();
});
