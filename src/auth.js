'use strict';

const crypto = require('node:crypto');

const SESSION_DAYS = 30;
const COOKIE = 'cod_session';

/** scrypt hash, stored as 'scrypt$<salt-hex>$<key-hex>'. */
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pin), salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function checkPin(pin, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function startSession(db, employeeId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();

  db.prepare('INSERT INTO sessions (token, employee_id, expires_at) VALUES (?, ?, ?)')
    .run(token, employeeId, expires);

  return token;
}

/** The signed-in person, or null. Expired rows are tidied up on the way past. */
function whoIs(db, token) {
  if (!token) return null;

  const row = db.prepare(`
    SELECT s.expires_at, e.id, e.name, e.username, e.role, e.hourly_rate, e.active
      FROM sessions s
      JOIN employees e ON e.id = s.employee_id
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

function endSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Signs someone out everywhere - used when their PIN changes or they leave. */
function endAllSessions(db, employeeId) {
  db.prepare('DELETE FROM sessions WHERE employee_id = ?').run(employeeId);
}

module.exports = {
  SESSION_DAYS, COOKIE, hashPin, checkPin, startSession, whoIs, endSession, endAllSessions,
};
