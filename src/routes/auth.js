'use strict';

const auth = require('../auth');
const v = require('../validate');
const { HttpError, setCookie, clearCookie } = require('../http');

module.exports = [
  {
    method: 'POST',
    path: '/api/signin',
    open: true,
    handler({ db, body, res, req }) {
      const username = v.text(body.username, 'Sign-in name', { required: true, max: 32 }).toLowerCase();
      const pin = v.text(body.pin, 'Sign-in number', { required: true, max: 64 });

      const person = db.prepare('SELECT * FROM employees WHERE username = ? COLLATE NOCASE')
        .get(username);

      // Same message either way, so a wrong name cannot be told from a wrong number.
      if (!person || !person.active || !auth.checkPin(pin, person.pin_hash)) {
        throw new HttpError(401, 'That name and number did not match. Try again.');
      }

      const token = auth.startSession(db, person.id);
      setCookie(res, auth.COOKIE, token, {
        maxAge: auth.SESSION_DAYS * 86400,
        secure: req.headers['x-forwarded-proto'] === 'https',
      });

      return { user: { id: person.id, name: person.name, username: person.username, role: person.role } };
    },
  },

  {
    method: 'POST',
    path: '/api/signout',
    open: true,
    handler({ db, token, res }) {
      auth.endSession(db, token);
      clearCookie(res, auth.COOKIE);
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
      const current = v.text(body.current_pin, 'The number you use now', { required: true, max: 64 });
      const next = v.pin(body.new_pin);

      const row = db.prepare('SELECT pin_hash FROM employees WHERE id = ?').get(user.id);
      if (!auth.checkPin(current, row.pin_hash)) {
        throw new HttpError(400, 'The number you use now is not right');
      }

      db.prepare('UPDATE employees SET pin_hash = ? WHERE id = ?').run(auth.hashPin(next), user.id);

      // Sign out other phones, but keep this one signed in.
      db.prepare('DELETE FROM sessions WHERE employee_id = ? AND token != ?').run(user.id, token);

      return { ok: true };
    },
  },
];
