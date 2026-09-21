'use strict';

/**
 * Reading a customer list out of whatever the office already has.
 *
 * Nobody is going to retype four hundred customers. Every place they might
 * live — QuickBooks, a spreadsheet, Jobber, the contacts on a phone — will
 * hand over a CSV, and a spreadsheet pasted straight into a box arrives as
 * tab-separated text. Both come through here.
 */

const MOST_ROWS = 2000;

/** Pasting out of Excel gives tabs; a saved file gives commas, or semicolons
 *  where the spreadsheet was set up for a comma decimal point. */
function sniffSeparator(line) {
  const counts = [
    ['\t', (line.match(/\t/g) || []).length],
    [',', (line.match(/,/g) || []).length],
    [';', (line.match(/;/g) || []).length],
  ].sort((a, b) => b[1] - a[1]);

  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/**
 * Split delimited text into rows of cells, the way a spreadsheet wrote it:
 * quoted cells may hold the separator, newlines and doubled quotes.
 */
function parseDelimited(text, separator) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => { endCell(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];

    if (quoted) {
      if (c !== '"') { cell += c; continue; }
      if (text[i + 1] === '"') { cell += '"'; i += 1; continue; }
      quoted = false;
      continue;
    }

    if (c === '"' && cell.trim() === '') { quoted = true; cell = ''; continue; }
    if (c === separator) { endCell(); continue; }

    if (c === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
      continue;
    }
    if (c === '\n') { endRow(); continue; }

    cell += c;
  }

  if (cell !== '' || row.length) endRow();

  // A trailing newline leaves one empty row behind; so do blank lines.
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const HEADINGS = {
  name: ['name', 'customer', 'customer name', 'client', 'client name', 'company',
    'company name', 'display name', 'display name as printed on check', 'account',
    'account name', 'full name', 'bill to', 'bill to name', 'contact', 'contact name',
    'organization', 'title'],
  address: ['address', 'street', 'street address', 'service address', 'job address',
    'billing address', 'bill to street', 'bill to street1', 'address 1', 'address1',
    'address line 1', 'shipping address', 'ship to street', 'location', 'property address',
    'home address', 'work address'],
  address2: ['address 2', 'address2', 'address line 2', 'bill to street2', 'street 2',
    'suite', 'unit'],
  city: ['city', 'town', 'bill to city', 'ship to city', 'city/town'],
  region: ['state', 'province', 'region', 'bill to state', 'ship to state', 'state/province'],
  postcode: ['zip', 'zip code', 'postcode', 'postal code', 'bill to zip', 'ship to zip'],
  phone: ['phone', 'phone number', 'phone numbers', 'telephone', 'tel', 'mobile',
    'mobile phone', 'cell', 'cell phone', 'main phone', 'primary phone', 'home phone',
    'work phone', 'business phone', 'phone 1', 'contact number'],
  notes: ['notes', 'note', 'comments', 'comment', 'memo', 'description', 'details',
    'remarks', 'instructions', 'special instructions'],
};

function tidyHeading(cell) {
  return String(cell || '')
    .replace(/^﻿/, '')          // a byte-order mark rides in on saved files
    .replace(/[_.]+/g, ' ')
    .replace(/[^a-z0-9 /]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Work out which column is which, or say the row is not a heading at all. */
function readHeadings(cells) {
  const found = {};
  let hits = 0;

  cells.forEach((cell, at) => {
    const tidied = tidyHeading(cell);
    if (!tidied) return;

    for (const field of Object.keys(HEADINGS)) {
      if (found[field] != null) continue;
      if (HEADINGS[field].includes(tidied)) { found[field] = at; hits += 1; return; }
    }
  });

  // One stray match is a coincidence; a name column plus anything else is a
  // heading row. A sheet with nothing but names counts too.
  const enough = found.name != null && (hits > 1 || cells.length === 1);
  return enough ? found : null;
}

function tidy(value, max) {
  const out = String(value == null ? '' : value)
    .replace(/^﻿/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > max ? out.slice(0, max) : out;
}

/** Sheets keep the address in pieces; a job sheet wants one line. */
function joinAddress(row, columns) {
  const street = [tidy(row[columns.address], 200), tidy(row[columns.address2], 200)]
    .filter(Boolean).join(' ');

  const town = [tidy(row[columns.city], 80), tidy(row[columns.region], 40)]
    .filter(Boolean).join(', ');

  const whole = [street, town, tidy(row[columns.postcode], 20)].filter(Boolean).join(' ');
  return tidy(whole, 200);
}

/**
 * Turn pasted text into customers, saying what could not be read and why.
 * Nothing is written here — the caller decides what to do with the rows.
 */
function readCustomers(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { customers: [], problems: [], columns: null, headed: false };

  const separator = sniffSeparator(raw.split(/\r?\n/, 1)[0] || '');
  const rows = parseDelimited(raw, separator);
  if (!rows.length) return { customers: [], problems: [], columns: null, headed: false };

  const headings = readHeadings(rows[0]);
  const headed = headings != null;

  // With no heading row, take the columns in the order somebody would write
  // them down: who, where, what number, anything else.
  const columns = headed ? headings : { name: 0, address: 1, phone: 2, notes: 3 };
  const body = headed ? rows.slice(1) : rows;

  const customers = [];
  const problems = [];

  body.forEach((row, at) => {
    const line = at + (headed ? 2 : 1);

    if (customers.length >= MOST_ROWS) {
      if (problems.length < 50) {
        problems.push({ line, why: `More than ${MOST_ROWS} rows — bring the rest in after` });
      }
      return;
    }

    const name = tidy(row[columns.name], 120);
    if (!name) {
      if (problems.length < 50) problems.push({ line, why: 'No customer name in this row' });
      return;
    }

    customers.push({
      line,
      name,
      address: joinAddress(row, columns),
      phone: tidy(row[columns.phone], 40),
      notes: tidy(row[columns.notes], 2000),
    });
  });

  return { customers, problems, columns, headed, separator };
}

/** Two spellings of the same customer should not both go in. */
function sameName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

module.exports = {
  MOST_ROWS, sniffSeparator, parseDelimited, readHeadings, readCustomers, sameName,
};
