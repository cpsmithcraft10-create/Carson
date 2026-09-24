'use strict';

/**
 * Did we make money, and where?
 *
 * The app already knew what it charged and what it paid people. It never put
 * the two side by side, which means the one number an owner actually needs —
 * what a job left in the business after the crew and the parts were paid for
 * — did not exist anywhere.
 *
 * Nothing here touches the database or the network, so every awkward case
 * (a job billed but not worked, a job worked but never billed, a loss) can
 * be pinned down in a test.
 */

const { round2 } = require('./time');

function money(n) {
  const v = round2(Number(n) || 0);
  return v === 0 ? 0 : v;
}

/** Margin as a percentage of revenue. No revenue means no percentage. */
function marginPct(revenue, margin) {
  const r = Number(revenue) || 0;
  if (r <= 0) return null;
  return round2((margin / r) * 100);
}

/**
 * One job's economics.
 *
 * Revenue is what was actually billed where an invoice exists, and what
 * would be billed where one does not — flagged, because an owner reading a
 * margin needs to know whether the money is real or still hoped for.
 *
 * Labour is what the crew were paid for the hours put against the job,
 * including hours still waiting to be approved: the wage is owed whether or
 * not anybody has signed the timesheet off.
 */
function jobMoney({ job, shifts = [], expenses = [], invoice = null, wouldBill = 0 }) {
  const billed = invoice && invoice.status === 'sent' && invoice.total != null
    ? money(invoice.total)
    : null;

  const revenue = billed == null ? money(wouldBill) : billed;

  const hours = money(shifts
    .filter((s) => s.end_time)
    .reduce((t, s) => t + (Number(s.hours) || 0), 0));

  const labour = money(shifts
    .filter((s) => s.end_time)
    .reduce((t, s) => t + (Number(s.pay) || 0), 0));

  const spend = money(expenses.reduce((t, e) => t + (Number(e.amount) || 0), 0));

  const cost = money(labour + spend);
  const margin = money(revenue - cost);

  return {
    job_id: job.id,
    job_date: job.job_date,
    customer: job.customer,
    kind: job.kind,
    revenue,
    invoiced: billed != null,
    hours,
    labour,
    spend,
    cost,
    margin,
    margin_pct: marginPct(revenue, margin),
    // Worth surfacing rather than burying: a job with hours on it and no
    // money against it is either unbilled or a favour, and the owner needs
    // to know which.
    unbilled: billed == null && revenue > 0,
    nothing_billed: revenue <= 0 && cost > 0,
  };
}

/** Add up a set of job rows into one line. */
function totalUp(rows) {
  const revenue = money(rows.reduce((t, r) => t + r.revenue, 0));
  const labour = money(rows.reduce((t, r) => t + r.labour, 0));
  const spend = money(rows.reduce((t, r) => t + r.spend, 0));
  const cost = money(labour + spend);
  const margin = money(revenue - cost);

  return {
    jobs: rows.length,
    hours: money(rows.reduce((t, r) => t + r.hours, 0)),
    revenue,
    labour,
    spend,
    cost,
    margin,
    margin_pct: marginPct(revenue, margin),
  };
}

/** Group job rows by calendar month, oldest first. */
function byMonth(rows, overheads = []) {
  const months = new Map();

  const slot = (key) => {
    if (!months.has(key)) months.set(key, { month: key, rows: [], overhead: 0 });
    return months.get(key);
  };

  for (const row of rows) slot(String(row.job_date).slice(0, 7)).rows.push(row);

  // Money that belongs to the business rather than to any one job still has
  // to come out of the month, or the margin flatters itself.
  for (const spent of overheads) {
    const bucket = slot(String(spent.spent_on).slice(0, 7));
    bucket.overhead = money(bucket.overhead + (Number(spent.amount) || 0));
  }

  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      const sum = totalUp(m.rows);
      const cost = money(sum.cost + m.overhead);
      const margin = money(sum.revenue - cost);
      return {
        ...sum,
        month: m.month,
        overhead: m.overhead,
        cost,
        margin,
        margin_pct: marginPct(sum.revenue, margin),
      };
    });
}

/** Who the money actually comes from. */
function byCustomer(rows, limit = 10) {
  const seen = new Map();

  for (const row of rows) {
    const key = row.customer || 'Nobody';
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(row);
  }

  return [...seen.entries()]
    .map(([customer, list]) => ({ customer, ...totalUp(list) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

/** And which trade it comes from. */
function byKind(rows) {
  const seen = new Map();

  for (const row of rows) {
    const key = row.kind || 'other';
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(row);
  }

  return [...seen.entries()]
    .map(([kind, list]) => ({ kind, ...totalUp(list) }))
    .sort((a, b) => b.revenue - a.revenue);
}

/**
 * How much of what the crew were paid for went on a customer's job, rather
 * than on something with nobody to bill. The number that tells an owner
 * whether he needs more work or more people.
 */
function utilisation(shifts) {
  const done = shifts.filter((s) => s.end_time);
  const total = money(done.reduce((t, s) => t + (Number(s.hours) || 0), 0));
  const onJobs = money(done.filter((s) => s.job_id)
    .reduce((t, s) => t + (Number(s.hours) || 0), 0));

  return {
    hours: total,
    on_jobs: onJobs,
    off_jobs: money(total - onJobs),
    pct: total > 0 ? round2((onJobs / total) * 100) : null,
  };
}

/** Quotes out, quotes won, and what that is worth. */
function winRate(quotes) {
  const decided = quotes.filter((q) => q.status === 'accepted' || q.status === 'declined');
  const won = quotes.filter((q) => q.status === 'accepted');
  const out = quotes.filter((q) => q.status === 'sent');

  return {
    sent: quotes.filter((q) => q.status !== 'draft').length,
    open: out.length,
    open_value: money(out.reduce((t, q) => t + (Number(q.total) || 0), 0)),
    won: won.length,
    won_value: money(won.reduce((t, q) => t + (Number(q.total) || 0), 0)),
    lost: quotes.filter((q) => q.status === 'declined').length,
    pct: decided.length > 0 ? round2((won.length / decided.length) * 100) : null,
  };
}

module.exports = {
  money, marginPct, jobMoney, totalUp, byMonth, byCustomer, byKind, utilisation, winRate,
};
