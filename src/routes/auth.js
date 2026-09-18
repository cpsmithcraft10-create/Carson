'use strict';

const auth = require('../auth');
const v = require('../validate');
const { HttpError, setCookie, clearCookie } = require('../http');

const { COOKIE } = auth;

module.exports = [
  {
    method: 'POST',
    path: '/api/login',
    public: true,
    handler({ db, body, res, req }) {
      const username = v.text(body.username, 'Username', { required: true, max: 32 }).toLowerCase();
      const pin = v.text(body.pin, 'PIN', { required: true, max: 64 });

      const worker = db.prepare('SELECT * FROM workers WHERE username = ? COLLATE NOCASE').get(username);

      // Same message either way so a wrong username cannot be told from a wrong PIN.
      if (!worker || !worker.active || !auth.verifyPin(pin, worker.pin_hash)) {
        throw new HttpError(401, 'That username and PIN did not match');
      }

      const token = auth.createSession(db, worker.id);
      setCookie(res, COOKIE, token, {
        maxAge: auth.SESSION_DAYS * 86400,
        secure: req.headers['x-forwarded-proto'] === 'https',
      });

      return {
        user: { id: worker.id, name: worker.name, username: worker.username, role: worker.role },
      };
    },
  },

  {
    method: 'POST',
    path: '/api/logout',
    public: true,
    handler({ db, token, res }) {
      auth.destroySession(db, token);
      clearCookie(res, COOKIE);
      return { ok: true };
    },
  },

  {
    method: 'GET',
    path: '/api/me',
    handler({ user }) {
      return { user };
    },
  },

  {
    method: 'POST',
    path: '/api/me/pin',
    handler({ db, user, body, token }) {
      const current = v.text(body.current_pin, 'Current PIN', { required: true, max: 64 });
      const next = v.pin(body.new_pin);

      const row = db.prepare('SELECT pin_hash FROM workers WHERE id = ?').get(user.id);
      if (!auth.verifyPin(current, row.pin_hash)) {
        throw new HttpError(400, 'Your current PIN is not right');
      }

      db.prepare('UPDATE workers SET pin_hash = ? WHERE id = ?').run(auth.hashPin(next), user.id);

      // Sign out other devices, but keep this one signed in.
      db.prepare('DELETE FROM sessions WHERE worker_id = ? AND token != ?').run(user.id, token);

      return { ok: true };
    },
  },
];
