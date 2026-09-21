'use strict';

/**
 * Office settings, including the QuickBooks connection.
 *
 * Everything lives in one key/value table so adding a setting never needs a
 * migration. Reads are typed, because a setting read back as the string
 * "false" would otherwise be true.
 */

const DEFAULTS = {
  // What the customer is charged for labour, per hour. Not what the crew are
  // paid — that is on the employee.
  bill_rate: '0',

  // Names of the products/services in QuickBooks that invoice lines point at.
  // QuickBooks will not take a line without one.
  labour_item: 'Labour',
  parts_item: 'Materials',

  // Send a finished job straight through, or hold it for somebody to look at.
  auto_send: '1',

  // Where the invoice is raised. Sandbox until the office says otherwise, so
  // a wrong setting cannot bill a real customer.
  qbo_env: 'sandbox',

  qbo_client_id: '',
  qbo_client_secret: '',
  qbo_realm_id: '',
  qbo_refresh_token: '',
  qbo_access_token: '',
  qbo_access_expires: '',
  qbo_connected_at: '',
};

function all(db) {
  const out = { ...DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    out[row.key] = row.value == null ? '' : row.value;
  }
  return out;
}

function get(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row && row.value != null) return row.value;
  return DEFAULTS[key] == null ? '' : DEFAULTS[key];
}

function num(db, key) {
  const n = Number(get(db, key));
  return Number.isFinite(n) ? n : 0;
}

function on(db, key) {
  const v = get(db, key);
  return v === '1' || v === 'true';
}

function put(db, key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value == null ? '' : String(value));
}

function putMany(db, pairs) {
  for (const [key, value] of Object.entries(pairs)) put(db, key, value);
}

/** Enough to talk to QuickBooks at all. */
function qboReady(db) {
  const s = all(db);
  return Boolean(s.qbo_client_id && s.qbo_client_secret && s.qbo_realm_id && s.qbo_refresh_token);
}

/** What the office may see. Secrets never leave the server. */
function forOffice(db) {
  const s = all(db);
  return {
    bill_rate: Number(s.bill_rate) || 0,
    labour_item: s.labour_item,
    parts_item: s.parts_item,
    auto_send: s.auto_send === '1',
    qbo_env: s.qbo_env,
    qbo_realm_id: s.qbo_realm_id,
    qbo_connected: qboReady(db),
    qbo_connected_at: s.qbo_connected_at || null,
    // Says whether a secret is on file without handing it back out.
    qbo_has_keys: Boolean(s.qbo_client_id && s.qbo_client_secret),
  };
}

module.exports = { DEFAULTS, all, get, num, on, put, putMany, qboReady, forOffice };
