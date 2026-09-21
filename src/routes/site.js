'use strict';

/* The one door the public knocks on. Everything else behind /api needs a
   sign-in; this takes an estimate request off the website and puts it in
   front of the office.

   It is open to anybody on the internet, so it assumes the worst: every
   field is bounded, the honeypot catches the bots that fill in every input
   they find, and one address cannot fill the table faster than a person
   could type. */

const v = require('../validate');
const { HttpError } = require('../http');

const WORK = ['sprinkler', 'lighting', 'drainage', 'repair', 'unsure'];
const REACH = ['any', 'morning', 'afternoon', 'evening'];

/* If the website is hosted somewhere other than the app — a static host, a
   different subdomain — the browser asks permission before it will post.
   Set SITE_ORIGIN to that address to narrow this down from anybody. */
const ORIGIN = process.env.SITE_ORIGIN || '*';

function allow(res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/* Somebody sending the same form over and over, by accident or otherwise.
   Six in an hour from one phone number is already more than anybody means
   to send. */
function tooMany(db, phone) {
  const { n } = db.prepare(
    `SELECT COUNT(*) AS n FROM estimates
      WHERE phone = ? AND created_at > datetime('now', '-1 hour')`,
  ).get(phone);

  return n >= 6;
}

module.exports = [
  {
    method: 'OPTIONS',
    path: '/api/estimate',
    open: true,
    handler({ res }) {
      allow(res);
      res.writeHead(204).end();
    },
  },

  {
    method: 'POST',
    path: '/api/estimate',
    open: true,
    handler({ db, body, res }) {
      allow(res);

      // A field no person can see, so anything in it was not typed by one.
      // It is answered the same as a real request, so nothing is learned.
      if (v.text(body.fax, 'Fax', { max: 200 })) return { ok: true };

      const name = v.text(body.name, 'Your name', { required: true, max: 80 });
      const phone = v.text(body.phone, 'Your phone number', { required: true, max: 40 });
      const address = v.text(body.address, 'The property address', { required: true, max: 200 });
      const email = v.text(body.email, 'Your email', { max: 120 });
      const detail = v.text(body.detail, 'What is going on', { max: 2000 });
      const reach = v.oneOf(body.reach, 'Best time to reach you', REACH,
        { required: false, fallback: 'any' });

      if (phone.replace(/\D/g, '').length < 7) {
        throw new HttpError(400, 'That phone number looks too short to call back.');
      }

      const work = (Array.isArray(body.work) ? body.work : [])
        .filter((kind) => WORK.includes(kind))
        .join(',');

      if (tooMany(db, phone)) {
        throw new HttpError(429, 'We already have your request — we will call you back.');
      }

      const done = db.prepare(
        `INSERT INTO estimates (name, phone, address, email, work, detail, reach)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(name, phone, address, email || null, work, detail || null, reach);

      return { ok: true, id: Number(done.lastInsertRowid) };
    },
  },
];
