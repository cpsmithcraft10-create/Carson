'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  jobMoney, totalUp, byMonth, byCustomer, byKind, utilisation, winRate, marginPct,
} = require('../src/money');

const job = (over) => ({
  id: 1, job_date: '2026-09-21', customer: 'Weaver residence', kind: 'sprinkler', ...over,
});

const worked = (hours, pay, over) => ({ end_time: '16:00', hours, pay, job_id: 1, ...over });

/* ========================= one job's economics ====================== */

test('revenue less what the crew and the parts cost is the margin', () => {
  const out = jobMoney({
    job: job(),
    shifts: [worked(4, 120), worked(4, 100)],
    expenses: [{ amount: 64.5 }],
    invoice: { status: 'sent', total: 560 },
  });

  assert.equal(out.revenue, 560);
  assert.equal(out.invoiced, true);
  assert.equal(out.hours, 8);
  assert.equal(out.labour, 220);
  assert.equal(out.spend, 64.5);
  assert.equal(out.cost, 284.5);
  assert.equal(out.margin, 275.5);
  assert.equal(out.margin_pct, 49.2);
});

test('a job that lost money says so rather than showing a cheerful zero', () => {
  const out = jobMoney({
    job: job(),
    shifts: [worked(12, 380)],
    expenses: [{ amount: 220 }],
    invoice: { status: 'sent', total: 450 },
  });

  assert.equal(out.margin, -150);
  assert.equal(out.margin_pct, -33.33);
});

test('an unsent invoice counts as money hoped for, and is flagged as such', () => {
  const out = jobMoney({
    job: job(),
    shifts: [worked(4, 120)],
    invoice: { status: 'holding', total: 400 },
    wouldBill: 380,
  });

  assert.equal(out.revenue, 380, 'what it would bill, not what the ledger last wrote');
  assert.equal(out.invoiced, false);
  assert.equal(out.unbilled, true);
});

test('work done with nothing against it is called out', () => {
  const out = jobMoney({ job: job(), shifts: [worked(6, 180)], wouldBill: 0 });

  assert.equal(out.revenue, 0);
  assert.equal(out.nothing_billed, true);
  assert.equal(out.margin, -180);
});

test('hours still on the clock are not counted as cost yet', () => {
  const out = jobMoney({
    job: job(),
    shifts: [worked(4, 120), { end_time: null, hours: 0, pay: 0 }],
    invoice: { status: 'sent', total: 400 },
  });

  assert.equal(out.hours, 4);
  assert.equal(out.labour, 120);
});

test('hours waiting to be approved still cost the business', () => {
  // The wage is owed whether or not anybody has signed the timesheet off.
  const out = jobMoney({
    job: job(),
    shifts: [worked(4, 120, { status: 'sent' }), worked(2, 60, { status: 'ok' })],
    invoice: { status: 'sent', total: 600 },
  });

  assert.equal(out.labour, 180);
});

test('no revenue means no percentage, rather than a division by zero', () => {
  assert.equal(marginPct(0, -180), null);
  assert.equal(jobMoney({ job: job(), shifts: [], wouldBill: 0 }).margin_pct, null);
});

/* ============================== roll-ups ============================ */

const rows = [
  jobMoney({ job: job({ id: 1, job_date: '2026-08-04', customer: 'Weaver residence', kind: 'sprinkler' }),
    shifts: [worked(4, 120)], invoice: { status: 'sent', total: 400 } }),
  jobMoney({ job: job({ id: 2, job_date: '2026-09-02', customer: 'Kestrel Ridge HOA', kind: 'drainage' }),
    shifts: [worked(8, 240)], expenses: [{ amount: 100 }], invoice: { status: 'sent', total: 900 } }),
  jobMoney({ job: job({ id: 3, job_date: '2026-09-21', customer: 'Weaver residence', kind: 'sprinkler' }),
    shifts: [worked(2, 60)], invoice: { status: 'sent', total: 250 } }),
];

test('a set of jobs adds up', () => {
  const sum = totalUp(rows);
  assert.equal(sum.jobs, 3);
  assert.equal(sum.revenue, 1550);
  assert.equal(sum.labour, 420);
  assert.equal(sum.spend, 100);
  assert.equal(sum.margin, 1030);
});

test('months are separated, oldest first, and overheads come out of them', () => {
  const months = byMonth(rows, [
    { spent_on: '2026-09-14', amount: 300 },   // insurance, belongs to no job
    { spent_on: '2026-08-20', amount: 50 },
  ]);

  assert.deepEqual(months.map((m) => m.month), ['2026-08', '2026-09']);

  assert.equal(months[0].revenue, 400);
  assert.equal(months[0].overhead, 50);
  assert.equal(months[0].cost, 170, '120 of wages plus 50 of overhead');
  assert.equal(months[0].margin, 230);

  assert.equal(months[1].revenue, 1150);
  assert.equal(months[1].overhead, 300);
  assert.equal(months[1].cost, 700, '300 of wages, 100 of parts, 300 of overhead');
  assert.equal(months[1].margin, 450);
});

test('a month with overheads and no work still shows the loss', () => {
  const months = byMonth([], [{ spent_on: '2026-07-03', amount: 480 }]);
  assert.equal(months.length, 1);
  assert.equal(months[0].revenue, 0);
  assert.equal(months[0].margin, -480);
  assert.equal(months[0].margin_pct, null);
});

test('customers are ranked by what they are actually worth', () => {
  const top = byCustomer(rows);
  assert.equal(top[0].customer, 'Kestrel Ridge HOA');
  assert.equal(top[0].revenue, 900);
  assert.equal(top[1].customer, 'Weaver residence');
  assert.equal(top[1].revenue, 650, 'both of their jobs, added up');
  assert.equal(top[1].jobs, 2);
});

test('and so are the trades', () => {
  const trades = byKind(rows);
  assert.equal(trades[0].kind, 'drainage');
  assert.equal(trades[1].kind, 'sprinkler');
  assert.equal(trades[1].jobs, 2);
});

/* =========================== the other two ========================== */

test('utilisation is the share of paid hours that were on a customer job', () => {
  const out = utilisation([
    { end_time: '16:00', hours: 6, job_id: 1 },
    { end_time: '16:00', hours: 2, job_id: null },
    { end_time: null, hours: 0, job_id: 1 },
  ]);

  assert.equal(out.hours, 8);
  assert.equal(out.on_jobs, 6);
  assert.equal(out.off_jobs, 2);
  assert.equal(out.pct, 75);
});

test('win rate counts decided quotes, and keeps what is still out there separate', () => {
  const out = winRate([
    { status: 'accepted', total: 1200 },
    { status: 'accepted', total: 800 },
    { status: 'declined', total: 600 },
    { status: 'sent', total: 2400 },
    { status: 'draft', total: 100 },
  ]);

  assert.equal(out.sent, 4, 'a draft has not gone anywhere');
  assert.equal(out.won, 2);
  assert.equal(out.won_value, 2000);
  assert.equal(out.lost, 1);
  assert.equal(out.pct, 66.67, 'two of the three that came back');
  assert.equal(out.open, 1);
  assert.equal(out.open_value, 2400);
});

test('nothing decided yet means no win rate, not zero percent', () => {
  assert.equal(winRate([{ status: 'sent', total: 500 }]).pct, null);
});
