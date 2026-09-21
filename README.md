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

That loads a sample crew, four customers, their jobs and a couple of
announcements, and prints the sign-ins. Delete `data/custom-outdoor.db` to wipe
it and start again.

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
- **The week** — Monday to Sunday at a glance, every day in a column with its
  jobs, so the week can be filled in without clicking through a day at a time.
  Days that are empty stand out, which is the point.
- **Hours** — everything sent in, waiting to be OK'd. *These look right*, or
  *Ask about it* with a question. The question shows in red on that person's
  phone; when they fix the times it comes straight back. The tab carries a
  count so nothing sits waiting unnoticed.
- **Give out work** — pick a customer already on file and the address and phone
  fill themselves in, or type a new one. Type of work, the day, roughly how
  long, what needs doing, and who is going. More than one person can be put on
  the same job. Existing jobs can be changed or moved to another crew, and
  **put out again** — same crew, same notes — either on days you name or every
  week for as many weeks as the season runs.
- **Customers** — everybody worked for, with their address, phone, notes for
  next time (gate code, dog, where the controller is), how many jobs they have
  had and when the last one was. Open one for its whole history. A list you
  already have **comes in whole** — see below.
- **Search** — one box across customers and jobs: a name, a street, a part
  fitted, anything written in the notes.
- **Announcements** — put something out to everybody, mark it important so it
  sits at the top in colour, and see who has actually read it.
- **The crew** — add people, change rates, set a new sign-in number, take
  somebody off (their hours are kept, they just cannot sign in).
- **Billing** — every finished job, what it comes to, and whether it is in
  QuickBooks yet. See below.
- **Payroll** — totals per person over any dates, with pay from their rate,
  **anything over 40 hours flagged**, a day-by-day breakdown, a roll-up of
  every part used over the period for billing, and a CSV for whoever does the
  books.

## Bringing the customers you already have

Nobody is retyping four hundred customers. Whatever holds them now will hand
over a CSV: QuickBooks, Jobber, ServiceTitan, Excel, Google Sheets, the
contacts on a phone. On **Customers**, hit *Bring a list in* and either pick
the file you exported or paste the rows straight out of the spreadsheet.

- **Headings are worked out for you.** Name, Customer, Client, Company and
  Display Name all mean the name; Address, Street, Service Address and Bill To
  Street all mean where. A file with no heading row at all is read in the
  order anyone would write it: name, address, phone, notes — and it says so,
  so you can check it landed the right way round.
- **An address split over columns is put back together.** The accounts keep
  street, city, state and zip apart; a job sheet wants one line.
- **You see what will happen before it happens.** How many will be added, how
  many are already on the books, which rows were skipped and why — then you
  decide. Nothing is written until you do.
- **Running the same list twice is safe.** Matching is by name, ignoring case
  and extra spaces, so a second run adds nobody twice. The same name twice in
  one file goes in once.
- **Blanks get filled, notes never get overwritten.** Ask it to fill blanks and
  it fills only what is empty. A gate code somebody wrote after standing at the
  gate is not replaced by whatever the export had in that column.
- It goes in all at once or not at all, so a list never ends up half in.

Straight after, those customers are in the drop-down on **Give out work** —
pick one and the address and phone fill themselves in.

## Billing into QuickBooks

When the crew mark a job finished it goes to **Billing**, and from there into
QuickBooks Online as an invoice against that customer.

- **It goes by itself.** *Send a job to QuickBooks as soon as the crew finish
  it* is on by default. Turn it off and everything queues for you instead.
- **A job gets one invoice, ever.** The send is claimed in the database before
  anything leaves the building, so a double click, a retry and the automatic
  send all racing at once still produce exactly one invoice. A customer being
  billed twice for the same day is the thing this feature is built around
  never doing.
- **It never guesses.** No customer on the job, no hourly rate set, parts used
  with no price on them, hours nobody has OK'd yet — each one holds the job in
  *Needs a look* and says which it was. Hours that are still waiting for you to
  approve are never billed.
- **Prices.** Labour is the OK'd hours times the rate you set. A job with a
  quoted price is billed at the quote whatever the hours came to. Parts are
  billed at what you charge, which is not what they cost — the crew write down
  what they used, you put the price on. Any job can be marked *no charge*.
- **Customers are matched by name**, and remembered after the first time. If
  QuickBooks has never heard of them, they get added.

### Setting it up

1. Make an app at `developer.intuit.com` and copy the **Client ID** and
   **Client secret**.
2. Add `https://your-address/office.html` there as a **Redirect URI**.
3. In **Billing → QuickBooks keys**, paste both in, then **Connect to
   QuickBooks** and say yes. The company ID fills itself in.
4. Set the **hourly rate you charge**, and make sure the two product names —
   *Labour* and *Materials* by default — match real products or services in
   your QuickBooks. An invoice line has to point at one, and it will say so if
   they are missing.
5. **Leave it on the test company until you have watched a few go through.**
   That is what the *Which QuickBooks company* setting is for. Invoices on the
   real file are seen by customers.

The keys and tokens live in the `settings` table on your own server and are
never sent back out to the browser.

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
- **A job keeps the address it was done at.** Picking a customer copies their
  name, address and phone onto the job there and then, so when somebody moves
  the old paperwork still says where the work actually happened.
- **The office screen asks for one thing at a time.** Each tab is a single
  request, and the counts on the tabs ride along with it, so switching about on
  a phone in the truck stays quick.

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

There are no web fonts and nothing else loaded from the internet — an office
on a bad connection gets the real thing, not a fallback. Colour, type and
spacing all come from the tokens at the top of `public/css/app.css`; change
`--accent` there and the whole app follows.

## Two screens, one design

The office runs on a desk all day, so it gets the layout that suits that: a
rail down the left that is always there, dense tables with the figures
aligned, small type, hairline rules, and row actions that stay quiet until
you reach for them.

The crew run on a phone, outdoors, often with gloves on, and some of them are
reading it through bifocals. Same palette, same components, same everything —
set a size larger, spaced further apart, with a bar across the bottom your
thumb reaches and buttons you cannot miss. It is not a different product, it
is this one turned up.

Their side is built for somebody who has never used an app before:

- **The first thing on the screen is whether you are on the clock**, in the
  same place every time, with the one button that does the next thing. Off the
  clock it names the next job and says *Open this job*. On the clock it counts
  the hours up and says *I'm done*.
- **Nothing is smaller than 13.5px**, body text is 17px and the buttons you
  press most are 62px tall.
- **Rows say "Open"** rather than leaving a chevron to explain itself.
- **Plain words.** Tabs read *My jobs*, *My hours*, *Messages*, *My details*.
  Not "Take it off" but *Delete these hours*; not "Put hours down by hand" but
  *Add hours myself*.
- **The jobs screen is always today.** No date to get lost on — the office
  hands work out a day at a time anyway. Going back to check or fix an earlier
  day happens under **My hours**, with buttons that say *Day before* and
  *Back to today*.
- **It adds the hours up while you type.** Before you send anything it says
  "That comes to 8 hours 26 minutes", and if the break does not fit inside the
  shift it says exactly that instead of refusing when you press the button.
- **It says a mistake is fixable**, because that is the thing people are
  actually worried about: *the office checks it, and if anything looks off
  they will ask you.*

## Putting it where the crew can reach it

It has to run somewhere their phones can get to — a cheap VPS, a box in the
office, anything that runs Node.

**Put it behind HTTPS.** Signing in sends their number, and the session cookie
is only marked `Secure` when the request arrives over HTTPS. Easiest is a
reverse proxy (Caddy or nginx) doing TLS in front of `localhost:3000` and
forwarding `X-Forwarded-Proto`. Do not put port 3000 straight on the internet.

Back up `data/custom-outdoor.db` — that one file is every hour anybody worked.

## Getting it onto their phones

There is no app store to go through. Once it is running behind HTTPS, the
crew's phones treat it as an app: an icon on the home screen, no browser bar,
and it opens straight into their day.

Send everybody one link — `https://your-address/install.html` — and that page
works out which phone they are holding and gives them the three taps:

- **iPhone**, in Safari: share button, **Add to Home Screen**, **Add**.
- **Android**, in Chrome: the three dots, **Install app**. That page offers a
  single button instead when the phone lets it, so most of them never read the
  steps.

Then they sign in once with their name and number. The session lasts a month,
so from the next morning on it is tap the icon and the jobs are there.

Two things make that work, both of them in `public/`:

- `app.webmanifest` — the name, the icons and `display: standalone`, which is
  what drops the browser bar. The icons are drawn by `npm run icons` from the
  same mark as the favicon; run it if the mark changes.
- `sw.js` — keeps the screen, the stylesheet and the scripts on the handset,
  so the icon opens at once in a basement or down a driveway with one bar. It
  never caches anything under `/api/`: jobs, hours and announcements always
  come from the office, because a stale job list is worse than none.

**It has to be HTTPS.** Neither the home-screen install nor the offline part
happens over plain HTTP — phones refuse both. `http://localhost` is the one
exception, which is how you try it on the machine you are developing on.

## The website

`site/` is the public side: what the work looks like, who does it, and the
form that brings a job in. Plain HTML and CSS, no build step — open
`site/index.html` in a browser and that is the site.

Estimate requests from that form post to `/api/estimate` and land in the
office screen under **Estimates**, with a count on the tab until somebody has
rung back and a button to put them straight on the customer list.

Everything still to be filled in — phone, town, licence number, photographs —
is listed across the top of the page until you turn the draft flag off.
`site/README.md` has the checklist and how to put it online.

## Tests

```bash
npm test
```

99 tests covering the hours arithmetic (breaks, work past midnight, rounding),
a whole day from giving out a job through to payroll, two people on one job,
work that was never on a list, announcements and who read them, a job running
over two days, customers and their history, putting a job out again week after
week, searching, over-40 flagging and the parts roll-up, reading a customer
list out of a messy export (quoted commas, tabs, a split address, no heading
row, a byte-order mark) and bringing it in twice without doubling anybody up
or writing over a note somebody left, and the boundaries: the crew cannot
reach the office side, cannot log against somebody else's job, cannot bring a
customer list in, cannot reach billing or the QuickBooks keys, and cannot
change hours already OK'd. Four more check what a phone needs before it will
put this on a home screen: the manifest, the icons it names, the tags on every
screen, and that the service worker caches no part of the office's own work.
Six more follow a request off the website all the way through: a stranger
sends the form, it reaches the office and nobody else, they ring back and it
becomes a customer, and the things that should not get in — no callback
number, a bot filling every field, the same number sent over and over — do
not.

The billing half of that runs the whole send-an-invoice path against a
QuickBooks that lives in a variable: the invoice body Intuit is handed, the
token refresh, a customer being created, a missing product, a refusal, and two
sends racing each other over the same job.

## Layout

```
server.js            HTTP server and router
src/db.js            SQLite schema
src/auth.js          sign-in numbers and sessions
src/time.js          date and time arithmetic
src/validate.js      checking what comes in
src/queries.js       shared job and shift queries
src/import.js        reading a customer list out of a CSV or a paste
src/settings.js      office settings, including the QuickBooks connection
src/billing.js       working out what a finished job should bill
src/quickbooks.js    every URL and body shape QuickBooks Online expects
src/invoicing.js     a finished job, all the way to an invoice
src/routes/          sign-in, website, crew and office endpoints
public/index.html    sign in
public/crew.html     the crew screen
public/office.html   the office screen
public/install.html  the page the crew are sent to put it on their phone
public/app.webmanifest  what makes it an app on a phone
public/sw.js         keeps the screens on the handset; never the work
public/icons/        the home-screen icons
site/                the public website — see site/README.md
scripts/setup.js     makes the first office account
scripts/sample.js    loads sample data
scripts/icons.js     draws the home-screen icons from the house mark
test/                the tests
```
