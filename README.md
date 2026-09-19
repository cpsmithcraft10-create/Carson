# Crew hours

Hours for an irrigation, drainage and lighting crew. The office gives out the
day's work; the crew opens it on their phone, hits **Start this job**, hits
**I'm done** when they finish, and the office OKs the hours and runs payroll.

It is built for people who do not want to fight with a screen: big buttons,
plain words, nothing hidden behind menus.

Runs with **no dependencies to install** — just Node 22.5 or newer — and keeps
everything in one SQLite file you can copy or back up.

## Getting started

```bash
node --version      # must be 22.5 or newer
npm run setup       # make the office account (asks a name, a sign-in name, a number)
npm start           # http://localhost:3000
```

Sign in as the office, open **The crew**, and add each person with a sign-in
name and a starting number. Give them the address, their sign-in name and their
number. They can change the number themselves.

To poke at it before putting anything real in:

```bash
node scripts/demo.js
```

That loads a sample crew with a few jobs and prints the sign-ins. Delete
`data/timesheets.db` to wipe it and start clean.

## How a day runs

**The office** opens **Give out work**, writes the job, the address and
anything they need to know ("gate code 4471, valve box is by the driveway"),
ticks who is doing it, and puts it on their list.

**The crew** open the app and see their jobs for the day. Then either

- **Start this job** when they get on site, and **I'm done** when they finish —
  the finish time is filled in for them but they can change it, and they type
  the break in minutes or tap one of the quick buttons; or
- **Start something that is not on the list** for a call-out nobody wrote down; or
- **Put hours down by hand** if they forgot to hit start. That one stays open so
  they can put in three houses in a row without reopening it.

Either way the hours land in the office's **Waiting on you** pile.

**The office** hits *These look right*, or *Ask about it* with a question
("you finished at 15:00, not 16:00"). A question shows up in red on that
person's phone; when they fix the times it comes straight back. Hours the
office OK'd are locked — only the office can put them back.

## Getting the hours out

**Payroll** totals everyone over any stretch of dates, works out the pay from
each person's hourly rate, and **Download CSV** gives one row per job for
whoever does the books.

## Things worth knowing

- **Hours work themselves out.** Finish minus start, minus the unpaid break.
  A finish time earlier than the start is treated as work that ran past
  midnight (22:00 to 06:00 is eight hours). If that comes out over 16 hours it
  is refused as a typo, so nobody accidentally banks a 23-hour day.
- **Times are stored as plain dates and clock times**, exactly as they were put
  in. There is no timezone conversion to go wrong. "Today" comes from the
  crew's own phone.
- **Nobody sees anyone else's hours** except the office, and people can only log
  against jobs on their own list (or something they type themselves).
- **Sign-in numbers are hashed** (scrypt) and never stored as plain text. If
  somebody forgets theirs, use **New number** on the crew list — that also signs
  them out everywhere.
- **Taking somebody off** keeps all their old hours for payroll but stops them
  signing in.
- **Weeks run Monday to Sunday.**

## Settings

All optional, set as environment variables:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind to |
| `DB_FILE` | `data/timesheets.db` | Where the database lives |
| `TZ` | system | Timezone the server calls "today" |

Money showing in the wrong currency: change `CASH` at the top of
`public/js/api.js` to `GBP`, `EUR`, `AUD` and so on.

The company name across the top is in the three page files
(`public/index.html`, `public/app.html`, `public/office.html`) — search for
`Crew hours` and the line under it.

The pages ask Google Fonts for Roboto Slab and Source Sans 3. If that is
blocked or the phone has no signal, they fall back to fonts already on the
device and everything still works.

## Putting it where the crew can reach it

They need to get to it from their phones, so it has to run somewhere they can
reach — a cheap VPS, a box in the office, or any host that runs Node.

**Put it behind HTTPS.** Signing in sends their number, and the session cookie
is only marked `Secure` when the request arrives over HTTPS. The simplest route
is a reverse proxy (Caddy or nginx) doing TLS in front of `localhost:3000` and
forwarding `X-Forwarded-Proto`. Do not put port 3000 straight on the internet.

Back up `data/timesheets.db` — that one file is every hour anybody has worked.

## Running the tests

```bash
npm test
```

Covers the hours arithmetic (breaks, work past midnight, rounding), the whole
give-out-work → log → OK → payroll run, work that was never on a list, and that
the crew cannot reach the office side or change hours already OK'd.

## Layout

```
server.js            HTTP server and router
src/db.js            SQLite schema
src/auth.js          sign-in numbers and sessions
src/hours.js         date and time arithmetic
src/validate.js      checking what comes in
src/entries.js       shared queries for hours
src/routes/          sign-in, crew and office endpoints
public/index.html    sign in
public/app.html      the crew screen
public/office.html   the office screen
scripts/setup.js     makes the first office account
scripts/demo.js      loads a sample crew
test/                the tests
```
