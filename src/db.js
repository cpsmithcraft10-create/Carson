'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  username     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  pin_hash     TEXT    NOT NULL,
  role         TEXT    NOT NULL DEFAULT 'worker' CHECK (role IN ('worker', 'admin')),
  hourly_rate  REAL    NOT NULL DEFAULT 0,
  phone        TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id       INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  work_date       TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  location        TEXT,
  notes           TEXT,
  scheduled_hours REAL,
  created_by      INTEGER REFERENCES workers(id),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_worker_date ON jobs(worker_id, work_date);
CREATE INDEX IF NOT EXISTS idx_jobs_date ON jobs(work_date);

CREATE TABLE IF NOT EXISTS entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id     INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  job_id        INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  work_date     TEXT    NOT NULL,
  start_time    TEXT    NOT NULL,
  end_time      TEXT,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  description   TEXT,
  status        TEXT    NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'submitted', 'approved', 'rejected')),
  review_note   TEXT,
  reviewed_by   INTEGER REFERENCES workers(id),
  reviewed_at   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entries_worker_date ON entries(worker_id, work_date);
CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(work_date);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  worker_id  INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_worker ON sessions(worker_id);
`;

/**
 * Opens (and if needed creates) the timesheet database.
 * Pass ':memory:' for tests.
 */
function open(file) {
  const target = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'timesheets.db');

  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }

  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { open, SCHEMA };
