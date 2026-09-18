# Timesheets

A small web app for a crew. You give out the day's work; your workers open it on
their phone, log the hours they actually did, and you approve them and export the
totals for payroll.

It runs from a single folder with **no dependencies to install** — just Node 22.5
or newer — and keeps everything in one SQLite file you can copy or back up.

## Getting started

```bash
node --version      # must be 22.5 or newer
npm run setup       # create your manager account (asks for a name, username, PIN)
npm start           # http://localhost:3000
```

Sign in as the manager, go to **Crew**, and add each worker with a username and a
starting PIN. Hand them the address, their username and their PIN — they can
change the PIN themselves once they are in.

To try it before entering real data:

```bash
node scripts/demo.js   # a demo crew, some jobs and some logged hours
```

That prints the demo logins. Delete `data/timesheets.db` to wipe it and start clean.

## How a day runs

**You:** open **Give out work**, write the job, pick the day, tick the workers
doing it, and assign it. Everyone ticked sees it on their phone under that date.

**Your worker:** opens the app, sees their jobs for today, and either

- taps **Start now** when they get on site and **Finish shift** when they're done
  (they enter the unpaid break and what they got done), or
- uses **Add hours by hand** if they forgot to clock in, or worked something
  that wasn't assigned.

Either way the hours land in your **Approve** queue.

**You again:** **Approve** it, or **Send back** with a note ("you finished at 15:00").
Sent-back hours show the note on their phone; when they fix them, the entry
returns to your queue. Approved hours are locked — the worker can't change or
delete them any more, only you can reopen them.

## Getting the hours out

**Reports** totals everyone's hours over any date range, with pay worked out from
each person's hourly rate, and **Download CSV** gives you one row per shift for
your accountant or payroll system.

## Things worth knowing

- **Hours are worked out for you.** Finish minus start, minus the unpaid break.
  A finish time earlier than the start is treated as a night shift (22:00 to
  06:00 is eight hours). If that comes out longer than 16 hours it's rejected as
  a typo, so nobody accidentally banks a 23-hour day.
- **Times are stored as plain dates and clock times**, exactly as they were
  entered. There is no timezone conversion to go wrong. The date a worker sees as
  "today" comes from their own phone.
- **Nobody can see anyone else's hours** except a manager. Workers can only log
  against jobs assigned to them.
- **PINs are hashed** (scrypt) and never stored in plain text. If a worker forgets
  theirs, use **New PIN** on the Crew tab — that also signs them out everywhere.
- **Deactivating a worker** keeps all of their history for reporting but stops
  them signing in.
- **Weeks run Monday to Sunday.**

## Settings

All optional, set as environment variables:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind to |
| `DB_FILE` | `data/timesheets.db` | Where the database lives |
| `TZ` | system | Timezone for "today" on the server |

Showing money in something other than dollars: change `CURRENCY` at the top of
`public/js/api.js` to `GBP`, `EUR`, `AUD` and so on.

## Putting it on the internet

Workers need to reach it from their phones, so it has to run somewhere they can
get to — a cheap VPS, a Raspberry Pi on your office network, or any host that
runs Node.

**Put it behind HTTPS.** Sign-in sends a PIN, and session cookies are only marked
`Secure` when the request arrives over HTTPS. The simplest route is a reverse
proxy (Caddy or nginx) terminating TLS in front of `localhost:3000`, forwarding
`X-Forwarded-Proto`. Don't expose port 3000 to the internet directly.

Back up `data/timesheets.db` — that one file is all your timesheet history.

## Running the tests

```bash
npm test
```

Covers the hours arithmetic (breaks, night shifts, rounding), the full
assign → log → approve → report run, and that workers can't reach the manager
side or edit approved hours.

## Layout

```
server.js            HTTP server and router
src/db.js            SQLite schema
src/auth.js          PIN hashing and sessions
src/hours.js         date and time arithmetic
src/validate.js      input checking
src/entries.js       shared timesheet queries
src/routes/          auth, worker and manager endpoints
public/              the three pages: sign in, worker, manager
scripts/setup.js     creates the first manager
scripts/demo.js      loads sample data
test/                the test suite
```
