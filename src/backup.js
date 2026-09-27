'use strict';

/**
 * Keeping a copy of everything, without anybody having to remember to.
 *
 * Every action in this app is written to the database the moment it happens
 * — there is no save button anywhere, and never was. What there was no
 * answer for is the other half: the whole business lives in one file, and
 * nothing was copying it anywhere. A dead disk took payroll, invoicing and
 * every hour anybody had worked with it.
 *
 * Snapshots are taken with VACUUM INTO, which writes a clean single file
 * from a live database without locking anybody out and without leaving a
 * -wal alongside it to be lost separately. The copy is a real database: it
 * opens in anything that reads SQLite.
 */

const fs = require('node:fs');
const path = require('node:path');

const { pathFor } = require('./db');

const PREFIX = 'custom-outdoor-';
const SUFFIX = '.db';

/** Snapshots are named by when they were taken, so they sort by hand too. */
function nameFor(when = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return PREFIX
    + when.getFullYear() + '-' + p(when.getMonth() + 1) + '-' + p(when.getDate())
    + '-' + p(when.getHours()) + p(when.getMinutes())
    + SUFFIX;
}

/** The other direction, so a filename alone says when it was taken. */
function whenOf(name) {
  const m = /^custom-outdoor-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})\.db$/.exec(name || '');
  if (!m) return null;
  const when = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isNaN(when.getTime()) ? null : when;
}

const dayOf = (when) => when.toISOString().slice(0, 10);
const monthOf = (when) => when.toISOString().slice(0, 7);

/**
 * Which snapshots to keep, given the names of the ones on disk.
 *
 * Grandfather–father–son, because a backup that only goes back a week is no
 * use against a mistake nobody noticed for a fortnight:
 *   - everything from the last couple of days, for an "undo this morning"
 *   - one a day for a month
 *   - one a month after that
 *
 * Pure, so the rules can be checked without writing files anywhere.
 */
function whatToKeep(names, now = new Date(), opts = {}) {
  const recentDays = opts.recentDays == null ? 2 : opts.recentDays;
  const dailyDays = opts.dailyDays == null ? 30 : opts.dailyDays;
  const monthlyMonths = opts.monthlyMonths == null ? 24 : opts.monthlyMonths;

  const dated = names
    .map((name) => ({ name, when: whenOf(name) }))
    .filter((row) => row.when)
    .sort((a, b) => b.when - a.when);

  const keep = new Set();
  const days = new Set();
  const months = new Set();

  const ageInDays = (when) => (now - when) / 86400000;

  for (const row of dated) {
    const age = ageInDays(row.when);

    if (age <= recentDays) { keep.add(row.name); continue; }

    if (age <= dailyDays) {
      const key = dayOf(row.when);
      // The list is newest first, so the first one seen for a day is the
      // latest one from that day, which is the one worth keeping.
      if (!days.has(key)) { days.add(key); keep.add(row.name); }
      continue;
    }

    if (age <= monthlyMonths * 31) {
      const key = monthOf(row.when);
      if (!months.has(key)) { months.add(key); keep.add(row.name); }
    }
  }

  return {
    keep: dated.filter((r) => keep.has(r.name)).map((r) => r.name),
    drop: dated.filter((r) => !keep.has(r.name)).map((r) => r.name),
    // Anything in the folder that is not one of ours is never touched.
    ignored: names.filter((n) => !whenOf(n)),
  };
}

function list(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  return names
    .map((name) => ({ name, when: whenOf(name) }))
    .filter((row) => row.when)
    .map((row) => {
      let bytes = 0;
      try { bytes = fs.statSync(path.join(dir, row.name)).size; } catch { /* vanished */ }
      return { name: row.name, taken_at: row.when.toISOString(), bytes };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * Take one snapshot. Writes to a temporary name first and renames into
 * place, so a half-written file is never mistaken for a good backup.
 */
function snapshot(db, dir, when = new Date()) {
  fs.mkdirSync(dir, { recursive: true });

  const name = nameFor(when);
  const target = path.join(dir, name);
  const working = path.join(dir, '.' + name + '.part');

  try { fs.rmSync(working, { force: true }); } catch { /* nothing there */ }

  // A single-quoted SQL string, so the path must not carry one.
  if (working.includes("'")) throw new Error('Backup folder name cannot contain an apostrophe');

  db.exec(`VACUUM INTO '${working}'`);
  fs.renameSync(working, target);

  return { name, path: target, bytes: fs.statSync(target).size, taken_at: when.toISOString() };
}

function prune(dir, now = new Date(), opts = {}) {
  const names = list(dir).map((row) => row.name);
  const { drop } = whatToKeep(names, now, opts);

  for (const name of drop) {
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* already gone */ }
  }

  return drop;
}

function backupNow(db, dir, now = new Date(), opts = {}) {
  const made = snapshot(db, dir, now);
  const dropped = prune(dir, now, opts);
  return { ...made, dropped };
}

/** Backups live in a folder beside the database itself. */
function defaultDir() {
  if (process.env.BACKUP_DIR) return process.env.BACKUP_DIR;
  const file = pathFor();
  const base = file === ':memory:' ? path.join(__dirname, '..', 'data') : path.dirname(file);
  return path.join(base, 'backups');
}

/**
 * Run it on a timer for as long as the server is up. Never throws into the
 * caller: a failed backup is worth a line in the log, not a dead server.
 */
function start(db, opts = {}) {
  const dir = opts.dir || defaultDir();
  const everyHours = Number(opts.everyHours) || 6;
  const onStart = opts.onStart !== false;
  const log = opts.log || console;

  const run = () => {
    try {
      const made = backupNow(db, dir, new Date(), opts);
      log.log(`Backed up to ${made.name} (${Math.round(made.bytes / 1024)} KB)`
        + (made.dropped.length ? `, ${made.dropped.length} old one(s) cleared` : ''));
      return made;
    } catch (err) {
      log.error('Backup failed:', err.message);
      return null;
    }
  };

  if (onStart) run();

  const timer = setInterval(run, Math.max(1, everyHours) * 3600 * 1000);
  // A backup timer must never be the reason the process stays alive.
  if (timer.unref) timer.unref();

  return { dir, everyHours, run, stop: () => clearInterval(timer) };
}

module.exports = {
  PREFIX, nameFor, whenOf, whatToKeep, list, snapshot, prune, backupNow, start, defaultDir,
};
