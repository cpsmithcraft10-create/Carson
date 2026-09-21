'use strict';

/**
 * Turning a finished job into the lines of an invoice.
 *
 * Nothing here talks to QuickBooks or to the database. It takes a job, the
 * hours put against it and the office's settings, and says either "here is
 * what to bill" or "here is why I am not going to guess". Keeping it pure is
 * what makes it safe to test every awkward case, and an invoice is not a
 * thing you want to find out about in production.
 */

const { round2 } = require('./time');

/** Two decimal places, and never a signed zero. */
function money(n) {
  const v = round2(Number(n) || 0);
  return v === 0 ? 0 : v;
}

/**
 * Hours that may be charged for: OK'd by the office and actually finished.
 * Hours still waiting to be approved are not billable — a customer should
 * never be invoiced from a timesheet nobody has looked at.
 */
function billableHours(shifts) {
  return money((shifts || [])
    .filter((s) => s.status === 'ok' && s.end_time)
    .reduce((total, s) => total + (Number(s.hours) || 0), 0));
}

/**
 * Work out the invoice for a job. Always returns a decision; it never throws,
 * because "why can I not bill this" is something the office needs to read on
 * the screen rather than as a stack trace.
 */
function buildInvoice(job, shifts, settings) {
  const reasons = [];
  const rate = money(settings.bill_rate);
  const hours = billableHours(shifts);

  if (!job) return { ok: false, reasons: ['That job was not found'], lines: [], total: 0 };

  if (job.status !== 'done') {
    reasons.push('The crew have not marked this finished yet');
  }

  if (job.no_charge) {
    return {
      ok: false, skip: true, hours, lines: [], total: 0,
      reasons: ['Marked as no charge'],
    };
  }

  if (!job.customer_id) {
    reasons.push('Not linked to a customer, so there is nobody to bill');
  }

  const lines = [];

  // A quoted job is billed at what was quoted, whatever the hours came to.
  // That is the whole point of quoting it.
  if (job.quoted_price != null && Number(job.quoted_price) > 0) {
    lines.push({
      kind: 'quoted',
      item: settings.labour_item,
      description: describe(job),
      qty: 1,
      unit: money(job.quoted_price),
      amount: money(job.quoted_price),
    });
  } else if (hours > 0 && rate > 0) {
    lines.push({
      kind: 'labour',
      item: settings.labour_item,
      description: describe(job),
      qty: hours,
      unit: rate,
      amount: money(hours * rate),
    });
  } else if (hours > 0 && rate <= 0) {
    reasons.push('No hourly rate set, so there is no price for ' + hours + ' hours');
  } else if (!job.quoted_price) {
    reasons.push("No hours have been OK'd against this job yet");
  }

  // Parts are billed at what the office says to charge, which is not what
  // they cost. An amount of zero means "do not put parts on the bill".
  const parts = money(job.parts_price);
  if (parts > 0) {
    lines.push({
      kind: 'parts',
      item: settings.parts_item,
      description: job.materials ? 'Parts used: ' + job.materials : 'Parts and materials',
      qty: 1,
      unit: parts,
      amount: parts,
    });
  } else if (job.materials && parts <= 0) {
    // Not a blocker — plenty of work uses parts that are not charged on —
    // but worth saying out loud so nobody bills a truckload of pipe at zero.
    reasons.push('Parts were used but no price is set for them');
  }

  const total = money(lines.reduce((t, l) => t + l.amount, 0));
  if (lines.length && total <= 0) reasons.push('That comes to nothing, so there is no invoice');

  return {
    ok: reasons.length === 0 && lines.length > 0 && total > 0,
    skip: false,
    hours,
    rate,
    lines,
    total,
    reasons,
  };
}

/** The line a customer reads on their bill. */
function describe(job) {
  const kind = {
    sprinkler: 'Sprinkler system',
    lighting: 'Landscape lighting',
    drainage: 'Drainage',
    other: 'Grounds work',
  }[job.kind] || 'Grounds work';

  const where = job.address ? ' at ' + job.address : '';
  return kind + where + ' on ' + job.job_date;
}

module.exports = { money, billableHours, buildInvoice, describe };
