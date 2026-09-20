# Custom Outdoor Design — crew app

Sprinkler, landscape lighting and drainage work. The office puts the day's jobs
on the board; the crew open it on their phone, see where they are going and what
needs doing, clock on and off, and close the job out with what they used. The
office OKs the hours, puts announcements out, and runs payroll.

No dependencies to install — Node 22.5 or newer and nothing else. Everything
lives in one SQLite file you can copy or back up.

## Getting started

```bash
node --version      # 22.5 or newer
npm run setup       # make the office account
npm start           # http://localhost:3000
```

Sign in as the office, open **The crew**, and add everybody with a sign-in name
and a starting number. Hand each person the address, their name and their
number — they can change the number themselves.

To try it before putting anything real in:

```bash
npm run sample
```

That loads a sample crew, three jobs and a couple of announcements, and prints
the sign-ins. Delete `data/custom-outdoor.db` to wipe it and start again.

## What the crew see

Their own jobs for the day, and nothing else. Each job shows:

- the **type of work** as a colour chip — sprinkler, lighting or drainage — so
  they can tell at a glance what they are walking into
- the customer, the **address as a tap-to-open map link**, and the
  **phone number as a tap-to-call link**
- what needs doing, gate codes and the like
- roughly how long the office thinks it takes
- who else is on the job with them

Then: **Start this job**, and **I'm done** when they finish. The finish time is
filled in but they can change it, the break is typed in minutes with quick
buttons for the usual amounts, and they can say what they got done.

They can also:

- **Mark the job finished** with how it went and the parts used, which is what
  the office bills from
- **Start something not on the list** for a callback nobody wrote down
- **Put hours down by hand** if they forgot to hit start — that one stays open
  so three houses in a row go in one after another
- fix the start time, change times, or throw away a shift started by mistake
- read announcements, and the office can see who has

## What the office sees

- **Today** — how many are out on jobs, hours down, labour cost, and the board
  for the day: every job with its crew, whether it is started, being worked on
  or finished, and the notes and parts that came back from the field.
- **Hours** — everything sent in, waiting to be OK'd. *These look right*, or
  *Ask about it* with a question. The question shows in red on that person's
  phone; when they fix the times it comes straight back.
- **Give out work** — customer, address, phone, type of work, the day, roughly
  how long, what needs doing, and who is going. More than one person can be put
  on the same job. Existing jobs can be changed or moved to another crew.
- **Announcements** — put something out to everybody, mark it important so it
  sits at the top in colour, and see who has actually read it.
- **The crew** — add people, change rates, set a new sign-in number, take
  somebody off (their hours are kept, they just cannot sign in).
- **Payroll** — totals per person over any dates, with pay from their rate, and
  a CSV for whoever does the books.

## Things worth knowing

- **Hours work themselves out.** Finish minus start, minus the unpaid break.
  A finish earlier than the start is treated as work past midnight (21:00 to
  05:00 is eight hours). If that comes out over 16 hours it is refused as a
  typo, so nobody banks a 23-hour day by mistake.
- **Times are stored exactly as entered** — plain dates and clock times, no
  timezone conversion to go wrong. "Today" comes from the crew's own phone.
- **A job can have a crew of two or three.** Everybody on it sees it, and each
  person's hours are their own.
- **Starting work moves a job to "being worked on"** by itself, so the office
  can see what is live without ringing anybody.
- **Nobody sees anyone else's hours** except the office, and people can only log
  against jobs they are on, or something they type themselves.
- **Sign-in numbers are hashed** (scrypt), never stored as text. A new number
  signs that person out everywhere.
- **Weeks run Monday to Sunday.**

## Settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind to |
| `DB_FILE` | `data/custom-outdoor.db` | Where the database lives |
| `TZ` | system | Timezone the server calls "today" |

Not in dollars? Change `CASH` at the top of `public/js/common.js`.

The company name sits in the three page files (`public/index.html`,
`public/crew.html`, `public/office.html`) and in the two page scripts — search
for `Custom Outdoor Design`.

The pages ask Google Fonts for Bitter and Archivo. With no signal they fall back
to fonts already on the phone and everything still works.

## Putting it where the crew can reach it

It has to run somewhere their phones can get to — a cheap VPS, a box in the
office, anything that runs Node.

**Put it behind HTTPS.** Signing in sends their number, and the session cookie
is only marked `Secure` when the request arrives over HTTPS. Easiest is a
reverse proxy (Caddy or nginx) doing TLS in front of `localhost:3000` and
forwarding `X-Forwarded-Proto`. Do not put port 3000 straight on the internet.

Back up `data/custom-outdoor.db` — that one file is every hour anybody worked.

## Tests

```bash
npm test
```

29 tests covering the hours arithmetic (breaks, work past midnight, rounding),
a whole day from giving out a job through to payroll, two people on one job,
work that was never on a list, announcements and who read them, a job running
over two days, and the boundaries: the crew cannot reach the office side, cannot
log against somebody else's job, and cannot change hours already OK'd.

## Layout

```
server.js            HTTP server and router
src/db.js            SQLite schema
src/auth.js          sign-in numbers and sessions
src/time.js          date and time arithmetic
src/validate.js      checking what comes in
src/queries.js       shared job and shift queries
src/routes/          sign-in, crew and office endpoints
public/index.html    sign in
public/crew.html     the crew screen
public/office.html   the office screen
scripts/setup.js     makes the first office account
scripts/sample.js    loads sample data
test/                the tests
```
