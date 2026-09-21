'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS employees (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  pin_hash    TEXT    NOT NULL,
  role        TEXT    NOT NULL DEFAULT 'crew' CHECK (role IN ('crew', 'office')),
  phone       TEXT,
  hourly_rate REAL    NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  address    TEXT,
  phone      TEXT,
  notes      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);

CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_date     TEXT    NOT NULL,
  kind         TEXT    NOT NULL DEFAULT 'other'
                       CHECK (kind IN ('sprinkler', 'lighting', 'drainage', 'other')),
  customer     TEXT    NOT NULL,
  address      TEXT,
  phone        TEXT,
  customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  details      TEXT,
  est_hours    REAL,
  status       TEXT    NOT NULL DEFAULT 'assigned'
                       CHECK (status IN ('assigned', 'working', 'done')),
  wrap_notes   TEXT,
  materials    TEXT,
  finished_at  TEXT,
  finished_by  INTEGER REFERENCES employees(id),
  created_by   INTEGER REFERENCES employees(id),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_date ON jobs(job_date);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);

-- A job can take a two or three person crew, so this is many-to-many.
CREATE TABLE IF NOT EXISTS crew_on_job (
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_crew_on_job_employee ON crew_on_job(employee_id);

CREATE TABLE IF NOT EXISTS shifts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  job_id        INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  other_work    TEXT,
  work_date     TEXT    NOT NULL,
  start_time    TEXT    NOT NULL,
  end_time      TEXT,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  status        TEXT    NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'sent', 'ok', 'question')),
  question      TEXT,
  reviewed_by   INTEGER REFERENCES employees(id),
  reviewed_at   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shifts_employee_date ON shifts(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);
CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(work_date);

CREATE TABLE IF NOT EXISTS notices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  urgent     INTEGER NOT NULL DEFAULT 0,
  posted_by  INTEGER REFERENCES employees(id),
  posted_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notices_posted ON notices(posted_at);

-- So the office can see who has actually read a notice.
CREATE TABLE IF NOT EXISTS notice_seen (
  notice_id   INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  seen_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (notice_id, employee_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_employee ON sessions(employee_id);
`;

/**
 * Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves an
 * existing table alone, so a database made by an older version needs these
 * filled in by hand.
 */
const LATER_COLUMNS = [
  ['jobs', 'customer_id', 'INTEGER REFERENCES customers(id) ON DELETE SET NULL'],
];

function addMissingColumns(db) {
  for (const [table, column, type] of LATER_COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all()
      .some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** Opens (and if needed creates) the database. Pass ':memory:' for tests. */
function open(file) {
  const target = file || process.env.DB_FILE
    || path.join(__dirname, '..', 'data', 'custom-outdoor.db');

  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });

  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  addMissingColumns(db);
  return db;
}

module.exports = { open, SCHEMA };
