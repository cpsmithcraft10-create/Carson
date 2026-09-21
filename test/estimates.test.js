'use strict';

/* The path a job starts on: somebody fills the form in on the website, it
   lands in front of the office, they ring back, and it becomes a customer. */

const test = require('node:test');
const assert = require('node:assert');

const { open } = require('../src/db');
const auth = require('../src/auth');
const { createServer } = require('../server');

async function startApp() {
  const db = open(':memory:');

  db.prepare(`INSERT INTO employees (name, username, pin_hash, role) VALUES (?, ?, ?, 'office')`)
    .run('The office', 'office', auth.hashPin('9999'));
  db.prepare(`INSERT INTO employees (name, username, pin_hash, role) VALUES (?, ?, ?, 'crew')`)
    .run('Ray', 'ray', auth.hashPin('1111'));

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
    return { status: res.status, data: text ? JSON.parse(text) : {} };
  };
}

const REAL = {
  name: 'Dana Whitfield',
  phone: '(555) 204-8890',
  address: '42 Brookside Lane, Springfield',
  work: ['drainage', 'sprinkler'],
  detail: 'Water sits by the basement window after every storm.',
  reach: 'evening',
};

test('a request off the website reaches the office and becomes a customer', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  // Nobody is signed in — this is a stranger on the website.
  const stranger = client(app.base);
  const sent = await stranger('/api/estimate', { method: 'POST', body: REAL });
  assert.strictEqual(sent.status, 200);
  assert.ok(sent.data.id, 'the request is kept');

  const office = client(app.base);
  await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });

  const inbox = await office('/api/office/estimates');
  assert.strictEqual(inbox.data.estimates.length, 1);

  const lead = inbox.data.estimates[0];
  assert.strictEqual(lead.name, 'Dana Whitfield');
  assert.strictEqual(lead.state, 'new');
  assert.deepStrictEqual(lead.work, ['drainage', 'sprinkler'], 'both trades come through');
  assert.strictEqual(lead.reach, 'evening');

  // It carries a badge until somebody rings back.
  const day = await office('/api/office/day');
  assert.strictEqual(day.data.counts.new_estimates, 1);

  const called = await office(`/api/office/estimates/${lead.id}`, {
    method: 'PATCH', body: { state: 'called' },
  });
  assert.strictEqual(called.data.estimate.state, 'called');

  const made = await office(`/api/office/estimates/${lead.id}/customer`, { method: 'POST' });
  assert.strictEqual(made.status, 200);

  const customers = await office('/api/office/customers');
  const dana = customers.data.customers.find((c) => c.name === 'Dana Whitfield');
  assert.ok(dana, 'they are on the customer list now');
  assert.strictEqual(dana.address, '42 Brookside Lane, Springfield');
  assert.match(dana.notes, /basement window/, 'what they said is kept with them');

  // Booked, and it will not be added to the list twice.
  const again = await office(`/api/office/estimates/${lead.id}/customer`, { method: 'POST' });
  assert.strictEqual(again.status, 400);

  const after = await office('/api/office/day');
  assert.strictEqual(after.data.counts.new_estimates, 0, 'it stops asking once it is handled');
});

test('the form refuses what it cannot call back', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const stranger = client(app.base);

  const nameless = await stranger('/api/estimate', {
    method: 'POST', body: { ...REAL, name: '' },
  });
  assert.strictEqual(nameless.status, 400);

  const short = await stranger('/api/estimate', {
    method: 'POST', body: { ...REAL, phone: '123' },
  });
  assert.strictEqual(short.status, 400);
  assert.match(short.data.error, /phone/i);

  const nowhere = await stranger('/api/estimate', {
    method: 'POST', body: { ...REAL, address: '  ' },
  });
  assert.strictEqual(nowhere.status, 400);

  const inbox = app.db.prepare('SELECT COUNT(*) AS n FROM estimates').get();
  assert.strictEqual(inbox.n, 0, 'none of those were kept');
});

test('a bot that fills in every field is answered and ignored', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const bot = client(app.base);
  const sent = await bot('/api/estimate', {
    method: 'POST',
    body: { ...REAL, fax: 'http://buy-something.example' },
  });

  // It looks like it worked, so nothing is learned by trying again.
  assert.strictEqual(sent.status, 200);
  assert.strictEqual(app.db.prepare('SELECT COUNT(*) AS n FROM estimates').get().n, 0);
});

test('the same phone number cannot fill the inbox', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const keen = client(app.base);
  for (let i = 0; i < 6; i += 1) {
    const res = await keen('/api/estimate', { method: 'POST', body: REAL });
    assert.strictEqual(res.status, 200, `send ${i + 1} should be taken`);
  }

  const seventh = await keen('/api/estimate', { method: 'POST', body: REAL });
  assert.strictEqual(seventh.status, 429);
});

test('the crew cannot read the estimate inbox', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const stranger = client(app.base);
  await stranger('/api/estimate', { method: 'POST', body: REAL });

  const ray = client(app.base);
  await ray('/api/signin', { method: 'POST', body: { username: 'ray', pin: '1111' } });

  const peek = await ray('/api/office/estimates');
  assert.strictEqual(peek.status, 403);
});

test('a site on another host is told it may post', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const ask = await fetch(`${app.base}/api/estimate`, { method: 'OPTIONS' });
  assert.strictEqual(ask.status, 204);
  assert.ok(ask.headers.get('access-control-allow-origin'), 'the browser is given an answer');
  assert.match(ask.headers.get('access-control-allow-methods'), /POST/);
});
