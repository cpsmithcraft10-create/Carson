'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { readCustomers, parseDelimited, sniffSeparator } = require('../src/import');
const { open } = require('../src/db');
const auth = require('../src/auth');
const { createServer } = require('../server');

/* ======================= reading the file ======================= */

test('a plain CSV with headings comes through', () => {
  const { customers, headed, problems } = readCustomers(
    'Name,Address,Phone,Notes\n'
    + 'Weaver residence,1420 Oak Hollow Dr,555-0142,Gate code 4471\n'
    + 'Kestrel Ridge HOA,88 Willow Creek Ct,555-0188,Call Dana first\n',
  );

  assert.equal(headed, true);
  assert.equal(problems.length, 0);
  assert.equal(customers.length, 2);
  assert.deepEqual(
    { ...customers[0], line: undefined },
    {
      line: undefined,
      name: 'Weaver residence',
      address: '1420 Oak Hollow Dr',
      phone: '555-0142',
      notes: 'Gate code 4471',
    },
  );
  assert.equal(customers[0].line, 2, 'the row number counts the heading');
});

test('a spreadsheet pasted straight in arrives as tabs', () => {
  const pasted = 'Customer\tService Address\tPhone\n'
    + 'Halvorsen place\t2233 Juniper Way\t555-0177\n';

  assert.equal(sniffSeparator(pasted.split('\n')[0]), '\t');

  const { customers, headed } = readCustomers(pasted);
  assert.equal(headed, true);
  assert.equal(customers.length, 1);
  assert.equal(customers[0].address, '2233 Juniper Way');
  assert.equal(customers[0].phone, '555-0177');
});

test('a comma inside a quoted address does not split the row', () => {
  const { customers } = readCustomers(
    'Name,Address,Phone\n'
    + '"Ibarra, Marisol","507 Cedar Bluff Ln, Unit B",555-0121\n',
  );

  assert.equal(customers.length, 1);
  assert.equal(customers[0].name, 'Ibarra, Marisol');
  assert.equal(customers[0].address, '507 Cedar Bluff Ln, Unit B');
});

test('doubled quotes and a newline inside a cell survive', () => {
  const rows = parseDelimited('a,"he said ""go"" then\nleft",c\n', ',');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], ['a', 'he said "go" then\nleft', 'c']);
});

test('an accounts export with the address in pieces gets one line back', () => {
  // The shape QuickBooks hands over.
  const { customers } = readCustomers(
    'Customer,Bill to Street,Bill to City,Bill to State,Bill to Zip,Phone Numbers\n'
    + 'Weaver residence,1420 Oak Hollow Dr,Cedar Falls,TX,75002,555-0142\n',
  );

  assert.equal(customers.length, 1);
  assert.equal(customers[0].address, '1420 Oak Hollow Dr Cedar Falls, TX 75002');
  assert.equal(customers[0].phone, '555-0142');
});

test('a list with no headings is read in the order somebody would write it', () => {
  const { customers, headed } = readCustomers(
    'Weaver residence,1420 Oak Hollow Dr,555-0142\n'
    + 'Halvorsen place,2233 Juniper Way,555-0177\n',
  );

  assert.equal(headed, false, 'nothing here looks like a heading row');
  assert.equal(customers.length, 2, 'so the first row is a customer, not a heading');
  assert.equal(customers[0].name, 'Weaver residence');
  assert.equal(customers[1].phone, '555-0177');
});

test('rows with no name are left out and said so', () => {
  const { customers, problems } = readCustomers(
    'Name,Address\n'
    + 'Weaver residence,1420 Oak Hollow Dr\n'
    + ',88 Willow Creek Ct\n'
    + 'Halvorsen place,2233 Juniper Way\n',
  );

  assert.equal(customers.length, 2);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, 3);
  assert.match(problems[0].why, /name/i);
});

test('a byte-order mark on a saved file does not become part of the first name', () => {
  const { customers, headed } = readCustomers('﻿Name,Phone\nWeaver residence,555-0142\n');
  assert.equal(headed, true);
  assert.equal(customers[0].name, 'Weaver residence');
});

test('blank lines and trailing newlines are ignored', () => {
  const { customers } = readCustomers(
    'Name,Phone\n\nWeaver residence,555-0142\n\n\nHalvorsen place,555-0177\n\n',
  );
  assert.equal(customers.length, 2);
});

/* ==================== bringing it into the app ==================== */

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

async function officeApp() {
  const app = await startApp();
  const office = client(app.base);
  await office('/api/signin', { method: 'POST', body: { username: 'office', pin: '9999' } });
  return { app, office };
}

const LIST = 'Name,Address,Phone,Notes\n'
  + 'Weaver residence,1420 Oak Hollow Dr,555-0142,Gate code 4471\n'
  + 'Kestrel Ridge HOA,88 Willow Creek Ct,555-0188,Call Dana first\n'
  + 'Halvorsen place,2233 Juniper Way,555-0177,Back gate sticks\n';

test('a look first changes nothing, then the same call brings them in', async (t) => {
  const { app, office } = await officeApp();
  t.after(() => app.stop());

  const look = await office('/api/office/customers/import', {
    method: 'POST', body: { text: LIST },
  });

  assert.equal(look.status, 200);
  assert.equal(look.data.looked, true);
  assert.equal(look.data.read, 3);
  assert.equal(look.data.add, 3);
  assert.equal(look.data.look[0].name, 'Weaver residence');

  const still = await office('/api/office/customers');
  assert.equal(still.data.customers.length, 0, 'a look puts nothing in');

  const done = await office('/api/office/customers/import', {
    method: 'POST', body: { text: LIST, look_first: false },
  });

  assert.equal(done.data.looked, false);
  assert.equal(done.data.add, 3);
  assert.equal(done.data.customers.length, 3);

  const now = await office('/api/office/customers');
  assert.equal(now.data.customers.length, 3);
  const weaver = now.data.customers.find((c) => c.name === 'Weaver residence');
  assert.equal(weaver.address, '1420 Oak Hollow Dr');
  assert.equal(weaver.notes, 'Gate code 4471');
});

test('running the same list twice does not double everybody up', async (t) => {
  const { app, office } = await officeApp();
  t.after(() => app.stop());

  await office('/api/office/customers/import', { method: 'POST', body: { text: LIST, look_first: false } });
  const again = await office('/api/office/customers/import', {
    method: 'POST', body: { text: LIST, look_first: false },
  });

  assert.equal(again.data.add, 0);
  assert.equal(again.data.already, 3);
  assert.equal(again.data.customers.length, 3);
});

test('a newer list can fill in what was blank before', async (t) => {
  const { app, office } = await officeApp();
  t.after(() => app.stop());

  await office('/api/office/customers', {
    method: 'POST', body: { name: 'Weaver residence' },
  });

  const skip = await office('/api/office/customers/import', {
    method: 'POST', body: { text: LIST, look_first: false },
  });
  assert.equal(skip.data.add, 2, 'the two new ones go in');
  assert.equal(skip.data.update, 0, 'and the one on file is left alone');

  const bare = skip.data.customers.find((c) => c.name === 'Weaver residence');
  assert.equal(bare.address, null);

  const fill = await office('/api/office/customers/import', {
    method: 'POST', body: { text: LIST, look_first: false, on_match: 'update' },
  });

  assert.equal(fill.data.update, 1);
  const filled = fill.data.customers.find((c) => c.name === 'Weaver residence');
  assert.equal(filled.address, '1420 Oak Hollow Dr');
  assert.equal(filled.phone, '555-0142');
});

test('filling blanks never talks over what is already written down', async (t) => {
  const { app, office } = await officeApp();
  t.after(() => app.stop());

  // Somebody who has been to the house wrote the real note.
  await office('/api/office/customers', {
    method: 'POST',
    body: { name: 'Weaver residence', notes: 'Gate code 4471. Dog in the back yard.' },
  });

  const done = await office('/api/office/customers/import', {
    method: 'POST', body: { text: LIST, look_first: false, on_match: 'update' },
  });

  const weaver = done.data.customers.find((c) => c.name === 'Weaver residence');
  assert.equal(weaver.notes, 'Gate code 4471. Dog in the back yard.',
    'the export must not overwrite a note somebody wrote on site');
  assert.equal(weaver.address, '1420 Oak Hollow Dr', 'but the blank address does get filled');
  assert.equal(weaver.phone, '555-0142');
});

test('the same name twice in one file only goes in once', async (t) => {
  const { app, office } = await officeApp();
  t.after(() => app.stop());

  const done = await office('/api/office/customers/import', {
    method: 'POST',
    body: {
      look_first: false,
      text: 'Name,Phone\nWeaver residence,555-0142\nweaver  RESIDENCE,555-9999\n',
    },
  });

  assert.equal(done.data.add, 1);
  assert.equal(done.data.doubled, 1);
  assert.equal(done.data.customers[0].phone, '555-0142', 'the first spelling wins');
});

test('an imported customer can be given a job straight away', async (t) => {
  const { app, office } = await officeApp();
  t.after(() => app.stop());

  const ray = await office('/api/office/people', {
    method: 'POST', body: { name: 'Ray Delgado', username: 'ray', pin: '1111', hourly_rate: 30 },
  });

  const done = await office('/api/office/customers/import', {
    method: 'POST', body: { text: LIST, look_first: false },
  });

  const weaver = done.data.customers.find((c) => c.name === 'Weaver residence');
  const job = await office('/api/office/jobs', {
    method: 'POST',
    body: {
      job_date: require('../src/time').today(),
      kind: 'sprinkler',
      customer_id: weaver.id,
      crew_ids: [ray.data.person.id],
    },
  });

  assert.equal(job.status, 200);
  assert.equal(job.data.job.customer, 'Weaver residence');
  assert.equal(job.data.job.address, '1420 Oak Hollow Dr', 'the address came over with them');
});

test('nothing readable is refused rather than half-imported', async (t) => {
  const { app, office } = await officeApp();
  t.after(() => app.stop());

  const nothing = await office('/api/office/customers/import', {
    method: 'POST', body: { text: ',,,\n,,,\n', look_first: false },
  });

  assert.equal(nothing.status, 400);
  assert.equal((await office('/api/office/customers')).data.customers.length, 0);
});

test('the crew cannot bring a customer list in', async (t) => {
  const { app, office } = await officeApp();
  t.after(() => app.stop());

  await office('/api/office/people', {
    method: 'POST', body: { name: 'Ray Delgado', username: 'ray', pin: '1111', hourly_rate: 30 },
  });

  const ray = client(app.base);
  await ray('/api/signin', { method: 'POST', body: { username: 'ray', pin: '1111' } });

  const tried = await ray('/api/office/customers/import', {
    method: 'POST', body: { text: LIST, look_first: false },
  });

  assert.equal(tried.status, 403);
});
