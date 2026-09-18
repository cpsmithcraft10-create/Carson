'use strict';

const crypto = require('node:crypto');

const SESSION_DAYS = 30;
const COOKIE = 'ts_session';

/** scrypt hash, stored as 'scrypt$<salt-hex>$<key-hex>'. */
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pin), salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPin(pin, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function createSession(db, workerId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();

  db.prepare('INSERT INTO sessions (token, worker_id, expires_at) VALUES (?, ?, ?)')
    .run(token, workerId, expires);

  return token;
}

/** Returns the signed-in worker, or null. Expired rows are cleaned up as we go. */
function sessionWorker(db, token) {
  if (!token) return null;

  const row = db.prepare(`
    SELECT s.token, s.expires_at, w.id, w.name, w.username, w.role, w.hourly_rate, w.active
      FROM sessions s
      JOIN workers w ON w.id = s.worker_id
     WHERE s.token = ?
  `).get(token);

  if (!row) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  if (!row.active) return null;

  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    hourly_rate: row.hourly_rate,
  };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Drops every session for a worker - used when their PIN changes or they are deactivated. */
function destroyWorkerSessions(db, workerId) {
  db.prepare('DELETE FROM sessions WHERE worker_id = ?').run(workerId);
}

module.exports = {
  hashPin,
  verifyPin,
  createSession,
  sessionWorker,
  destroySession,
  destroyWorkerSessions,
  SESSION_DAYS,
  COOKIE,
};
