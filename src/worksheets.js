'use strict';

/**
 * The worksheet: what actually happened at a property on a day.
 *
 * A job on a day already held all of this — who was there, how long, what got
 * done, what went in — but never as one thing you could read, hand over or
 * file. A worksheet is that job read as a document: numbered, complete or
 * visibly not, and printable without anybody retyping it.
 *
 * Everything here is arithmetic and wording. Nothing touches the database or
 * the clock, so every half-filled, night-shift and nobody-turned-up case can
 * be pinned down in a test.
 */

const { hoursWorked, round2 } = require('./time');

const KIND_WORDS = {
  sprinkler: 'Sprinkler',
  lighting: 'Landscape lighting',
  drainage: 'Drainage',
  other: 'Other work',
};

/**
 * A worksheet needs a number a person can say out loud down a phone. The job's
 * own id is already unique and never reused, so it becomes the number — no
 * counter to get out of step, no two sheets ever sharing one.
 */
function sheetNo(job) {
  const n = Number(job && job.id);
  if (!Number.isFinite(n) || n <= 0) return null;
  return 'WS-' + String(n).padStart(5, '0');
}

/** Hours one person put in, or null while they are still on the clock. */
function hoursOf(shift) {
  return shift.end_time ? hoursWorked(shift) : null;
}

/** "3", "3.5", "0.75" — never "3.00". */
function tidyNumber(n) {
  const v = round2(Number(n) || 0);
  return String(v);
}

function materialWords(line) {
  const qty = tidyNumber(line.quantity);
  const unit = (line.unit || '').trim();
  return unit ? `${qty} ${unit} — ${line.item}` : `${qty} × ${line.item}`;
}

/**
 * What is still blank, said the way somebody would say it.
 *
 * This is the whole point of the screen: a worksheet that tells you what it
 * needs beats one that looks finished and is not. Order matters — the first
 * one is what the crew are asked for next.
 */
function whatIsMissing({ job, shifts, materials }) {
  const missing = [];

  if (!shifts.length) missing.push('Nobody has put hours on it');
  else if (shifts.some((s) => !s.end_time)) missing.push('Somebody is still on the clock');

  if (!(job.wrap_notes || '').trim()) missing.push('What was done is blank');
  if (!materials.length && !(job.materials || '').trim()) missing.push('No parts written down');

  return missing;
}

/**
 * One worksheet, ready to read or print.
 *
 * `customer` is the customer record where the job was raised against one, and
 * is only ever used to fill a blank the job itself does not carry — a job
 * keeps its own copy of the address so an old sheet still reads true after
 * somebody moves house.
 */
function buildSheet({ job, shifts = [], materials = [], customer = null }) {
  const people = shifts
    .slice()
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))
    .map((s) => ({
      shift_id: s.id,
      name: s.employee_name,
      start: s.start_time,
      end: s.end_time,
      break_minutes: s.break_minutes || 0,
      hours: hoursOf(s),
      still_on: !s.end_time,
      notes: s.notes || null,
    }));

  const hours = round2(people.reduce((t, p) => t + (p.hours || 0), 0));

  const lines = materials.map((m) => ({
    id: m.id,
    item: m.item,
    quantity: round2(Number(m.quantity) || 0),
    unit: m.unit || null,
    words: materialWords(m),
  }));

  const missing = whatIsMissing({ job, shifts, materials });

  return {
    no: sheetNo(job),
    job_id: job.id,
    date: job.job_date,
    kind: job.kind,
    kind_words: KIND_WORDS[job.kind] || KIND_WORDS.other,

    customer: job.customer,
    address: job.address || (customer ? customer.address : null),
    phone: job.phone || (customer ? customer.phone : null),
    customer_id: job.customer_id || null,

    asked_for: job.details || null,
    done: job.wrap_notes || null,
    // Parts written as a paragraph before this screen existed. Shown rather
    // than dropped, because it is somebody's record of a real job.
    done_materials_text: lines.length ? null : (job.materials || null),
    next_visit: job.next_visit || null,

    people,
    hours,
    materials: lines,

    signed_by: job.signed_by || null,
    signed_at: job.signed_at || null,

    status: job.status,
    finished_at: job.finished_at || null,
    missing,
    ready: missing.length === 0,
  };
}

/** One line saying where a sheet stands, for a list of them. */
function sheetWords(sheet) {
  if (sheet.ready && sheet.status === 'done') return 'Done and filled in';
  if (sheet.missing.length === 1) return sheet.missing[0];
  if (sheet.missing.length > 1) return `${sheet.missing.length} things still blank`;
  return 'Filled in, not closed out yet';
}

/** The day's sheets, added up for the top of the screen. */
function dayTotals(sheets) {
  return {
    sheets: sheets.length,
    ready: sheets.filter((s) => s.ready).length,
    needing: sheets.filter((s) => !s.ready).length,
    hours: round2(sheets.reduce((t, s) => t + s.hours, 0)),
    people: new Set(sheets.flatMap((s) => s.people.map((p) => p.name))).size,
    parts: sheets.reduce((t, s) => t + s.materials.length, 0),
  };
}

/**
 * What this crew actually use, most-used first, so putting parts on a sheet is
 * tapping a name rather than spelling one. Learned from what has already been
 * written down — no list for anybody to maintain.
 */
function usualParts(rows, limit = 18) {
  const seen = new Map();

  for (const row of rows) {
    const item = String(row.item || '').trim();
    if (!item) continue;

    const key = item.toLowerCase();
    const at = seen.get(key);
    if (at) { at.times += 1; continue; }
    seen.set(key, { item, unit: row.unit || null, times: 1 });
  }

  return [...seen.values()]
    .sort((a, b) => b.times - a.times || a.item.localeCompare(b.item))
    .slice(0, limit);
}

module.exports = {
  KIND_WORDS, sheetNo, hoursOf, tidyNumber, materialWords,
  whatIsMissing, buildSheet, sheetWords, dayTotals, usualParts,
};
