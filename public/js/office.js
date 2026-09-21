'use strict';

/* The office screen. Hand out work, keep an eye on the day, OK hours, post
   announcements, run payroll. */

var TABS = ['today', 'week', 'hours', 'jobs', 'customers', 'notices', 'crew', 'pay'];

var view = {
  me: null,
  tab: 'today',
  day: today(),
  weekFrom: mondayOf(today()),
  payFrom: mondayOf(today()),
  payTo: shiftDate(mondayOf(today()), 6),
  payWho: '',
  people: [],
  customers: [],
  openCustomer: null,
  bringingIn: false,  // the customer-list import panel is open
  bringText: '',      // kept here so a repaint does not lose the paste
  bringFill: 'skip',  // and so the preview and the run agree about matches
  looked: null,       // what a look-first run said would happen
  copying: null,
  hunting: null,      // a search term, which takes over the sheet
  data: {},
  flash: null,
  editingJob: null,
};

/* ----------------------------- loading ---------------------------- */

function fetchTab() {
  if (view.hunting) return api('/api/office/search?q=' + encodeURIComponent(view.hunting));

  if (view.tab === 'today') return api('/api/office/day?date=' + view.day);
  if (view.tab === 'week') return api('/api/office/week?from=' + view.weekFrom);
  if (view.tab === 'hours') return api('/api/office/waiting');
  if (view.tab === 'jobs') {
    return api('/api/office/jobs?from=' + view.day + '&to=' + shiftDate(view.day, 13));
  }
  if (view.tab === 'customers') {
    return view.openCustomer
      ? api('/api/office/customers/' + view.openCustomer)
      : api('/api/office/customers');
  }
  if (view.tab === 'notices') return api('/api/office/notices');
  if (view.tab === 'crew') return api('/api/office/people?include_past=1');

  var q = '?from=' + view.payFrom + '&to=' + view.payTo +
    (view.payWho ? '&employee_id=' + view.payWho : '');
  return api('/api/office/payroll' + q);
}

/* One request per screen. The tab-bar counts ride home on every response, and
   the crew list is only re-read by the screens that actually show it. */
function load() {
  // The job form needs the crew and the customer list; both are cached after
  // the first read, so a steady state is still one request per screen.
  var also = [];
  if (view.tab === 'jobs') also.push(ensurePeople(), ensureCustomers());
  if (view.tab === 'pay') also.push(ensurePeople());

  return Promise.all([fetchTab()].concat(also)).then(function (all) {
    var data = all[0];
    view.data = data;
    if (data.people) view.people = data.people;
    if (data.customers && !view.openCustomer) view.customers = data.customers;
    paintCounts(data.counts);
    paint();
  }).catch(function (err) { say(err.message, 'bad'); });
}

function paintCounts(counts) {
  if (!counts) return;

  var pip = document.getElementById('pip-hours');
  pip.className = counts.waiting ? 'pipdot' : '';
  pip.textContent = counts.waiting ? String(counts.waiting) : '';
}

/* The job form and the payroll picker need the crew even on screens that do
   not list them, so fetch it once and keep it. */
function ensurePeople() {
  if (view.people.length) return Promise.resolve();
  return api('/api/office/people?include_past=1').then(function (r) { view.people = r.people; });
}

function ensureCustomers() {
  if (view.customers.length) return Promise.resolve();
  return api('/api/office/customers').then(function (r) { view.customers = r.customers; });
}

function say(message, kind) {
  view.flash = message ? { message: message, kind: kind || 'good' } : null;
  paint();
}

function then(promise, message) {
  return promise.then(function () {
    view.flash = message ? { message: message, kind: 'good' } : null;
    return load();
  }).catch(function (err) { say(err.message, 'bad'); });
}

function goTab(tab) {
  view.tab = tab;
  view.flash = null;
  view.editingJob = null;
  view.openCustomer = null;
  view.bringingIn = false;
  view.bringText = '';
  view.bringFill = 'skip';
  view.looked = null;
  view.copying = null;
  view.hunting = null;

  var box = document.getElementById('search');
  if (box) box.value = '';

  markTab();
  load();
}

function markTab() {
  TABS.forEach(function (t) {
    document.getElementById('tab-' + t)
      .setAttribute('aria-selected', String(!view.hunting && t === view.tab));
  });
}

/* ----------------------------- painting --------------------------- */

function paint() {
  var sheet = emptyOut(document.getElementById('sheet'));

  if (view.tab === 'today' || view.tab === 'jobs') {
    sheet.appendChild(make('div', { class: 'daybar' },
      make('h1', {}, longDate(view.day), view.day !== today() && make('em', { text: 'not today' })),
      view.day !== today() && make('button', {
        onclick: function () { view.day = today(); load(); } }, 'Today'),
      make('button', { class: 'step', 'aria-label': 'Day before',
        onclick: function () { view.day = shiftDate(view.day, -1); load(); } }, '‹'),
      make('button', { class: 'step', 'aria-label': 'Day after',
        onclick: function () { view.day = shiftDate(view.day, 1); load(); } }, '›')));
  }

  if (view.flash) {
    sheet.appendChild(make('div', { class: 'flash ' + view.flash.kind, text: view.flash.message }));
  }

  if (view.hunting) { paintSearch(sheet); return; }

  ({
    today: paintToday,
    week: paintWeek,
    hours: paintHours,
    jobs: paintJobs,
    customers: paintCustomers,
    notices: paintNotices,
    crew: paintCrew,
    pay: paintPay,
  })[view.tab](sheet);
}

/* ------------------------------ the week -------------------------------- */

function paintWeek(sheet) {
  var w = view.data;

  sheet.appendChild(make('div', { class: 'daybar' },
    make('h1', {}, shortDate(w.from) + ' to ' + shortDate(w.to),
      w.from !== mondayOf(today()) && make('em', { text: 'not this week' })),
    w.from !== mondayOf(today()) && make('button', {
      onclick: function () { view.weekFrom = mondayOf(today()); load(); } }, 'This week'),
    make('button', { class: 'step', 'aria-label': 'Week before',
      onclick: function () { view.weekFrom = shiftDate(view.weekFrom, -7); load(); } }, '\u2039'),
    make('button', { class: 'step', 'aria-label': 'Week after',
      onclick: function () { view.weekFrom = shiftDate(view.weekFrom, 7); load(); } }, '\u203a')));

  var grid = make('div', { class: 'weekgrid' }, w.days.map(function (d) {
    var weekend = [0, 6].indexOf(new Date(d.date + 'T00:00:00Z').getUTCDay()) >= 0;

    return make('div', {
      class: 'weekday' + (d.date === today() ? ' is-today' : '') + (weekend ? ' weekend' : ''),
    },
      make('h4', {},
        shortDate(d.date).split(', ')[0],
        make('span', { text: shortDate(d.date).split(', ')[1] })),
      d.jobs.map(function (job) {
        return make('button', {
          class: 'weekjob ' + job.status,
          onclick: function () { view.day = job.job_date; goTab('today'); },
        }, job.customer,
           make('em', { text: job.crew.map(function (c) { return c.name.split(' ')[0]; }).join(', ') || 'nobody' }));
      }),
      d.jobs.length === 0 && make('p', { class: 'weekfoot', text: '—' }),
      d.hours > 0 && make('p', { class: 'weekfoot', text: d.hours.toFixed(2) + ' h logged' }));
  }));

  sheet.appendChild(panel('The board, seven days at a time', [
    make('span', { class: 'dim', style: 'font-size:15px',
      text: w.totals.jobs + ' jobs · ' + w.totals.hours.toFixed(2) + ' hours · ' +
            CASH.format(w.totals.pay) }),
  ], make('div', { class: 'scroller' }, grid)));

  sheet.appendChild(panel('Who is spoken for', [], make('div', { class: 'scroller' }, make('table', {},
    make('thead', {}, make('tr', {},
      make('th', { text: 'Name' }),
      w.days.map(function (d) {
        return make('th', { class: 'r', text: shortDate(d.date).split(', ')[0] });
      }))),
    make('tbody', {}, w.people.map(function (p) {
      return make('tr', {},
        make('td', { text: p.name }),
        w.days.map(function (d) {
          var n = d.jobs.filter(function (j) {
            return j.crew.some(function (c) { return c.id === p.id; });
          }).length;
          return make('td', { class: 'r', style: n ? '' : 'color:var(--ink-soft)',
            text: n ? String(n) : '·' });
        }));
    }))))));
}

/* ----------------------------- customers -------------------------------- */

function paintCustomers(sheet) {
  if (view.openCustomer) { paintOneCustomer(sheet); return; }

  var list = view.data.customers || [];

  sheet.appendChild(newCustomerForm());
  sheet.appendChild(bringInForm());

  sheet.appendChild(panel('Customers',
    list.length ? [make('span', { class: 'pip', text: String(list.length) })] : [],
    list.length
      ? make('div', { class: 'scroller' }, make('table', {},
          make('thead', {}, make('tr', {},
            make('th', { text: 'Name' }),
            make('th', { text: 'Where' }),
            make('th', { text: 'Phone' }),
            make('th', { class: 'r', text: 'Jobs' }),
            make('th', { text: 'Last seen' }),
            make('th', { text: '' }))),
          make('tbody', {}, list.map(function (c) {
            return make('tr', {},
              make('td', { text: c.name }),
              make('td', { text: c.address || '—' }),
              make('td', { text: c.phone || '—' }),
              make('td', { class: 'r', text: String(c.job_count) }),
              make('td', { text: c.last_job ? shortDate(c.last_job) : 'never' }),
              make('td', {}, make('button', {
                class: 'slim', style: 'margin:0',
                onclick: function () { view.openCustomer = c.id; load(); },
              }, 'Open')));
          }))))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'Nobody on the books yet.' }))));
}

function newCustomerForm() {
  var name = make('input', { id: 'cust-name', maxlength: '120', placeholder: 'Weaver residence' });
  var address = make('input', { id: 'cust-address', maxlength: '200', placeholder: '1420 Oak Hollow Dr' });
  var phone = make('input', { id: 'cust-phone', maxlength: '40', placeholder: '555-0142' });
  var notes = make('textarea', { id: 'cust-notes', maxlength: '2000',
    placeholder: 'Gate code 4471. Dog is friendly but loud. Bills quarterly.' });

  return panel('Put somebody on the books', [], make('div', { class: 'pad' },
    make('div', { class: 'two', style: 'margin-bottom:13px' },
      make('div', {}, make('label', { for: 'cust-name', text: 'Their name' }), name),
      make('div', {}, make('label', { for: 'cust-phone', text: 'Phone' }), phone)),
    make('div', { class: 'field' },
      make('label', { for: 'cust-address', text: 'Address' }), address),
    make('div', { class: 'field' },
      make('label', { for: 'cust-notes', text: 'Anything worth remembering' }), notes),
    make('button', {
      class: 'go',
      onclick: function () {
        if (!name.value.trim()) { say('Put their name in.', 'bad'); return; }
        view.customers = [];
        then(api('/api/office/customers', {
          method: 'POST',
          body: {
            name: name.value.trim(),
            address: address.value.trim(),
            phone: phone.value.trim(),
            notes: notes.value.trim(),
          },
        }), 'On the books. You can book them a job now.');
      },
    }, 'Add them')));
}

/**
 * Bringing a list in from wherever the customers live now. Everything that
 * holds them — the accounts, a spreadsheet, the contacts on a phone — will
 * save a CSV, and a spreadsheet pasted straight in arrives as tab-separated
 * text. Both go in the same box.
 */
function bringInForm() {
  if (!view.bringingIn) {
    return panel('Already have a customer list?', [], make('div', { class: 'pad' },
      make('p', { class: 'none', style: 'margin-bottom:4px',
        text: 'Bring it in from the accounts, a spreadsheet or the phone instead of '
          + 'typing it all out again.' }),
      make('button', { class: 'slim', style: 'width:auto',
        onclick: function () { view.bringingIn = true; view.looked = null; paint(); } },
        'Bring a list in')));
  }

  var box = make('textarea', {
    id: 'bring-text',
    style: 'min-height:150px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px',
    placeholder: 'Name,Address,Phone,Notes\nWeaver residence,1420 Oak Hollow Dr,555-0142,Gate code 4471',
    oninput: function (e) { view.bringText = e.target.value; view.looked = null; },
  });

  box.value = view.bringText;

  var file = make('input', {
    type: 'file', id: 'bring-file', accept: '.csv,.tsv,.txt,text/csv,text/plain',
    style: 'padding:9px 12px',
    onchange: function (e) {
      var picked = e.target.files && e.target.files[0];
      if (!picked) return;

      var reader = new FileReader();
      reader.onload = function () {
        view.bringText = String(reader.result || '');
        box.value = view.bringText;
        view.looked = null;
        say('Read ' + picked.name + '. Have a look at what it found, then bring it in.');
      };
      reader.onerror = function () { say('That file could not be read.', 'bad'); };
      reader.readAsText(picked);
    },
  });

  var fill = make('select', {
    id: 'bring-fill',
    onchange: function (e) { view.bringFill = e.target.value; view.looked = null; paint(); },
  },
    make('option', { value: 'skip' }, 'Leave anybody already on the books alone'),
    make('option', { value: 'update' }, 'Fill in blanks on anybody already on the books'));

  fill.value = view.bringFill;

  var send = function (lookFirst) {
    var text = (view.bringText || '').trim();
    if (!text) { say('Paste the list in, or pick a file.', 'bad'); return; }

    api('/api/office/customers/import', {
      method: 'POST',
      body: { text: text, on_match: view.bringFill, look_first: lookFirst },
    }).then(function (out) {
      if (lookFirst) {
        view.looked = out;
        view.flash = null;
        paint();
        return null;
      }

      view.bringingIn = false;
      view.bringText = '';
      view.bringFill = 'skip';
      view.looked = null;
      view.customers = [];
      view.flash = { kind: 'good', message: broughtInWords(out) };
      return load();
    }).catch(function (err) { say(err.message, 'bad'); });
  };

  var body = make('div', { class: 'pad' },
    make('p', { class: 'none', style: 'margin-bottom:12px' },
      'Export from the accounts as CSV and pick the file, or open the spreadsheet, '
      + 'select the customers and paste them straight in. The first row can be '
      + 'headings — Name, Address, Phone, Notes — or not.'),
    make('div', { class: 'field' },
      make('label', { for: 'bring-file', text: 'Pick a file you exported' }), file),
    make('div', { class: 'field' },
      make('label', { for: 'bring-text', text: 'Or paste the list here' }), box),
    make('div', { class: 'field' },
      make('label', { for: 'bring-fill', text: 'Anybody already on the books' }), fill),
    make('div', { class: 'inline' },
      make('button', { class: 'go', style: 'flex:1 1 200px',
        onclick: function () { send(true); } }, 'Have a look first'),
      make('button', { class: 'slim', style: 'flex:0 0 auto',
        onclick: function () {
          view.bringingIn = false;
          view.bringText = '';
          view.bringFill = 'skip';
          view.looked = null;
          paint();
        } }, 'Never mind')));

  if (view.looked) body.appendChild(lookedAt(view.looked, send));

  return panel('Bring a customer list in', [], body);
}

function broughtInWords(out) {
  var bits = [];
  if (out.add) bits.push(out.add + (out.add === 1 ? ' customer added' : ' customers added'));
  if (out.update) bits.push(out.update + ' filled in');
  if (out.already) bits.push(out.already + ' already on the books');
  return bits.length ? bits.join(', ') + '.' : 'Nothing new to bring in.';
}

/** What the look-first run found, before anything is written. */
function lookedAt(out, send) {
  var trouble = (out.problems || []).length + out.doubled;

  var lines = make('div', { style: 'margin-top:18px' },
    figures([
      { value: String(out.add), label: out.add === 1 ? 'To add' : 'To add' },
      out.update > 0 && { value: String(out.update), label: 'To fill in' },
      out.already > 0 && { value: String(out.already), label: 'Already on' },
      trouble > 0 && { value: String(trouble), label: 'Skipped' },
    ]));

  if (!out.headed) {
    lines.appendChild(make('p', { class: 'asked', style: 'margin-top:12px',
      text: 'No heading row found, so the columns were read in order: name, address, '
        + 'phone, then notes. Check the rows below landed the right way round.' }));
  }

  if (out.look.length) {
    lines.appendChild(make('div', { class: 'scroller', style: 'margin-top:12px' },
      make('table', {},
        make('thead', {}, make('tr', {},
          make('th', { text: 'Name' }),
          make('th', { text: 'Where' }),
          make('th', { text: 'Phone' }),
          make('th', { text: 'Notes' }))),
        make('tbody', {}, out.look.map(function (one) {
          return make('tr', {},
            make('td', { text: one.name }),
            make('td', { text: one.address || '—' }),
            make('td', { text: one.phone || '—' }),
            make('td', { text: one.notes || '—' }));
        })))));

    var rest = (out.add + out.update) - out.look.length;
    if (rest > 0) {
      lines.appendChild(make('p', { class: 'none', style: 'margin-top:8px',
        text: 'The first few of ' + (out.add + out.update) + '. ' + rest + ' more after these.' }));
    }
  }

  (out.problems || []).slice(0, 6).forEach(function (bad) {
    lines.appendChild(make('p', { class: 'none', style: 'margin-top:6px',
      text: 'Row ' + bad.line + ' skipped — ' + bad.why.toLowerCase() + '.' }));
  });

  if (out.doubled > 0) {
    lines.appendChild(make('p', { class: 'none', style: 'margin-top:6px',
      text: out.doubled + (out.doubled === 1 ? ' row was' : ' rows were')
        + ' the same name as an earlier one, so only the first went in.' }));
  }

  lines.appendChild(make('button', {
    class: 'go',
    disabled: (out.add + out.update) === 0,
    onclick: function () { send(false); },
  }, (out.add + out.update) === 0
    ? 'Nothing new to bring in'
    : 'Bring in ' + (out.add + out.update)
      + ((out.add + out.update) === 1 ? ' customer' : ' customers')));

  return lines;
}

function paintOneCustomer(sheet) {
  var c = view.data.customer;
  var jobs = view.data.jobs || [];
  var totals = view.data.totals || { hours: 0, pay: 0 };

  sheet.appendChild(make('div', { class: 'backrow' },
    make('button', { onclick: function () { view.openCustomer = null; load(); } },
      '\u2039 Back to customers')));

  sheet.appendChild(panel(c.name, [], make('div', { class: 'pad' },
    c.address && make('p', { class: 'jobmeta' }, addressLink(c.address)),
    c.phone && make('p', { class: 'jobmeta' }, 'Call: ', phoneLink(c.phone)),
    c.notes && make('p', { class: 'needdoing', style: 'margin-top:14px', text: c.notes }),
    make('div', { class: 'inline' },
      make('button', { class: 'slim', style: 'margin:0',
        onclick: function () { editCustomer(c); } }, 'Change their details'),
      make('button', { class: 'slim', style: 'margin:0',
        onclick: function () {
          view.openCustomer = null;
          view.editingJob = null;
          view.bookFor = c;
          goTab('jobs');
        } }, 'Book them a job'))),
    figures([
      { value: String(c.job_count), label: 'Jobs done' },
      { value: totals.hours.toFixed(2), label: 'Hours on site' },
      { value: CASH.format(totals.pay), label: 'Labour spent' },
    ])));

  sheet.appendChild(panel('Everything done for them', [],
    jobs.length
      ? make('ul', { class: 'jobs' }, jobs.map(officeJobItem))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'No jobs on record yet.' }))));
}

function editCustomer(c) {
  var name = prompt('Their name', c.name);
  if (name === null) return;
  var address = prompt('Address', c.address || '');
  if (address === null) return;
  var phone = prompt('Phone', c.phone || '');
  if (phone === null) return;
  var notes = prompt('Anything worth remembering', c.notes || '');
  if (notes === null) return;

  view.customers = [];
  then(api('/api/office/customers/' + c.id, {
    method: 'PATCH',
    body: { name: name.trim(), address: address.trim(), phone: phone.trim(), notes: notes.trim() },
  }), 'Their details are updated. Old jobs keep what was true at the time.');
}

/* ------------------------------- search --------------------------------- */

function paintSearch(sheet) {
  var d = view.data;

  sheet.appendChild(make('div', { class: 'backrow' },
    make('button', { onclick: function () { goTab(view.tab); } }, '\u2039 Back')));

  sheet.appendChild(panel('Customers matching "' + d.term + '"',
    [make('span', { class: 'pip', text: String(d.customers.length) })],
    d.customers.length
      ? make('div', { class: 'scroller' }, make('table', {},
          make('tbody', {}, d.customers.map(function (c) {
            return make('tr', {},
              make('td', { text: c.name }),
              make('td', { text: c.address || '—' }),
              make('td', { class: 'r', text: c.job_count + ' jobs' }),
              make('td', {}, make('button', {
                class: 'slim', style: 'margin:0',
                onclick: function () {
                  view.hunting = null;
                  view.tab = 'customers';
                  view.openCustomer = c.id;
                  markTab();
                  load();
                },
              }, 'Open')));
          }))))
      : make('div', { class: 'pad' }, make('p', { class: 'none', text: 'Nobody by that name.' }))));

  sheet.appendChild(panel('Jobs matching "' + d.term + '"',
    [make('span', { class: 'pip', text: String(d.jobs.length) })],
    d.jobs.length
      ? make('ul', { class: 'jobs' }, d.jobs.map(officeJobItem))
      : make('div', { class: 'pad' }, make('p', { class: 'none', text: 'No jobs match that.' }))));
}

/* ------------------------------ today ----------------------------- */

function paintToday(sheet) {
  var d = view.data;

  // Whatever is actually waiting on the office goes first. Everything else
  // on this screen is something to look at, not something to do.
  if (d.waiting > 0) {
    sheet.appendChild(make('div', { class: 'needsyou' },
      make('b', { text: d.waiting === 1
        ? 'One set of hours is waiting on you'
        : d.waiting + ' sets of hours are waiting on you' }),
      make('button', { class: 'go', onclick: function () { goTab('hours'); } },
        'Go through them')));
  }

  sheet.appendChild(make('div', { class: 'card' }, figures([
    { value: String(d.jobs.length), label: d.jobs.length === 1 ? 'Job on' : 'Jobs on' },
    { value: String(d.on_the_clock.length), label: 'Out there now' },
    { value: d.totals.hours.toFixed(2), label: 'Hours down' },
    { value: CASH.format(d.totals.pay), label: 'Labour' },
  ])));

  if (d.on_the_clock.length) {
    sheet.appendChild(panel('On the clock right now',
      [make('span', { class: 'pip', text: String(d.on_the_clock.length) })],
      make('ul', { class: 'rows' }, d.on_the_clock.map(function (s) {
        return hourRow(s, { withName: true, sameDay: s.work_date === view.day });
      }))));
  }

  sheet.appendChild(panel('The work', [
    make('span', { class: 'dim', style: 'font-size:15px',
      text: d.job_counts.assigned + ' not started · ' + d.job_counts.working +
            ' going · ' + d.job_counts.done + ' finished' }),
  ],
    d.jobs.length
      ? make('ul', { class: 'jobs tight' }, d.jobs.map(officeJobItem))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'No work on the board for this day.' }))));

  sheet.appendChild(panel('Hours put down', d.shifts.length
    ? [make('span', { class: 'dim', style: 'font-size:15px',
        text: d.totals.hours.toFixed(2) + ' hours · ' + CASH.format(d.totals.pay) })]
    : [],
    d.shifts.length
      ? make('ul', { class: 'rows' }, d.shifts.map(function (s) {
          return hourRow(s, {
            withName: true, withPay: true, quiet: true, sameDay: true,
            buttons: shiftButtons(s),
          });
        }))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'Nothing down for this day.' }))));
}

/** A job as the office reads it: who it is for first, then the reference
 *  bits on one line, then what needs doing. The buttons come last and stay
 *  out of the way — this is a screen for looking at, mostly. */
function officeJobItem(job) {
  var crew = job.crew.map(function (c) { return c.name; }).join(', ');

  var meta = make('p', { class: 'metaline' }, kindChip(job.kind));
  var add = function (bit) {
    if (!bit) return;
    if (meta.childNodes.length) meta.appendChild(make('span', { class: 'gap', text: '\u00b7' }));
    meta.appendChild(bit);
  };

  add(job.address && addressLink(job.address));
  add(make('span', { text: crew || 'nobody on it' }));
  if (job.est_hours) add(make('span', { text: job.est_hours + 'h' }));

  return make('li', {}, make('div', { class: 'bar ' + job.status }), make('div', {},
    make('div', { class: 'headline' },
      make('h3', { text: job.customer }),
      make('span', { class: 'progress ' + job.status, text: JOB_WORDS[job.status] })),
    meta,
    job.details && make('p', { class: 'jobdetail', text: job.details }),
    job.status === 'done' && job.wrap_notes &&
      make('p', { class: 'jobdetail', text: '\u201c' + job.wrap_notes + '\u201d' }),
    job.status === 'done' && job.materials &&
      make('p', { class: 'mates', text: 'Parts used: ' + job.materials }),
    job.finished_by_name &&
      make('p', { class: 'mates', text: 'Finished by ' + job.finished_by_name }),
    make('div', { class: 'acts' },
      make('button', {
        onclick: function () { view.editingJob = job.id; goTab('jobs'); } }, 'Change'),
      make('button', { onclick: function () { repeatJob(job); } }, 'Put it out again'),
      make('button', { class: 'risky', onclick: function () { removeJob(job); } },
        'Take it off'))));
}

/* Seasonal work is the same call round again: blowouts, startups, lamp checks. */
function repeatJob(job) {
  var asked = prompt(
    'Put "' + job.customer + '" out again.\n\n' +
    'How many weeks running? (same day each week)\n' +
    'Or type a date like 2026-10-14 for one more only.', '4');

  if (asked === null) return;
  asked = asked.trim();
  if (!asked) return;

  var body = /^\d{4}-\d{2}-\d{2}$/.test(asked)
    ? { dates: [asked] }
    : { every_weeks_for: Number(asked) };

  if (!body.dates && !(body.every_weeks_for > 0)) {
    say('Put in a number of weeks, or a date like 2026-10-14.', 'bad');
    return;
  }

  then(api('/api/office/jobs/' + job.id + '/copy', { method: 'POST', body: body }),
    'Booked again. Check The week to see where it landed.');
}

function shiftButtons(s) {
  return [
    s.status === 'sent' && make('button', { class: 'lead',
      onclick: function () { okThese(s); } }, 'These look right'),
    s.status === 'sent' && make('button', {
      onclick: function () { askAbout(s); } }, 'Ask about it'),
    s.status === 'ok' && make('button', {
      onclick: function () {
        then(api('/api/office/shifts/' + s.id + '/reopen', { method: 'POST' }), 'Put back.');
      } }, 'Put it back'),
    s.status !== 'open' && make('button', {
      onclick: function () { changeTimes(s); } }, 'Change times'),
    s.status !== 'open' && make('button', { class: 'risky',
      onclick: function () {
        if (!confirm("Take " + s.employee_name + "'s hours off for " + shortDate(s.work_date) + '?')) return;
        then(api('/api/office/shifts/' + s.id, { method: 'DELETE' }), 'Taken off.');
      } }, 'Take it off'),
  ];
}

function okThese(s) {
  then(api('/api/office/shifts/' + s.id + '/ok', { method: 'POST', body: {} }),
    "OK'd — " + s.hours.toFixed(2) + ' hours for ' + s.employee_name + '.');
}

function askAbout(s) {
  var q = prompt('What do you want to ask ' + s.employee_name + '?', '');
  if (q === null) return;
  then(api('/api/office/shifts/' + s.id + '/question', {
    method: 'POST', body: { question: q.trim() },
  }), 'Sent back to ' + s.employee_name + '.');
}

function changeTimes(s) {
  var from = prompt('What time did they start? Like 07:30', s.start_time);
  if (from === null) return;
  var to = prompt('What time did they finish? Like 16:00', s.end_time || '');
  if (to === null) return;
  var brk = prompt('How many minutes was the break?', String(s.break_minutes || 0));
  if (brk === null) return;

  from = from.trim();
  to = to.trim();

  if (!TIME_SHAPE.test(from) || !TIME_SHAPE.test(to)) {
    say('Times go in like 07:30 or 16:00.', 'bad');
    return;
  }

  then(api('/api/office/shifts/' + s.id, {
    method: 'PATCH', body: { start_time: from, end_time: to, break_minutes: +brk || 0 },
  }), 'Times changed.');
}

function removeJob(job) {
  var warn = job.status === 'assigned'
    ? 'Take "' + job.customer + '" off the board?'
    : 'Hours may already be against this job. They stay, but lose the customer name. Take it off?';
  if (!confirm(warn)) return;
  then(api('/api/office/jobs/' + job.id, { method: 'DELETE' }), 'Taken off the board.');
}

/* ------------------------------ hours ----------------------------- */

function paintHours(sheet) {
  var list = view.data.shifts;

  sheet.appendChild(panel('Hours waiting on you',
    list.length ? [make('span', { class: 'pip', text: String(list.length) })] : [],
    list.length
      ? make('ul', { class: 'rows' }, list.map(function (s) {
          return hourRow(s, { withName: true, withPay: true, quiet: true, buttons: shiftButtons(s) });
        }))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'Nothing waiting. All caught up.' })),
    list.length ? figures([
      { value: view.data.totals.hours.toFixed(2), label: 'Hours waiting' },
      { value: CASH.format(view.data.totals.pay), label: 'Worth' },
    ]) : null));
}

/* ---------------------------- giving work ------------------------- */

function paintJobs(sheet) {
  var editing = view.editingJob
    ? (view.data.jobs || []).filter(function (j) { return j.id === view.editingJob; })[0]
    : null;

  sheet.appendChild(jobForm(editing));

  var jobs = view.data.jobs || [];

  sheet.appendChild(panel('On the board · ' + shortDate(view.data.from) + ' to ' +
      shortDate(view.data.to), [],
    jobs.length
      ? make('ul', { class: 'jobs' }, jobs.map(function (job) {
          return make('li', {}, make('div', { class: 'bar ' + job.status }), make('div', {},
            make('div', { class: 'jobline' }, kindChip(job.kind),
              make('span', { class: 'dim', style: 'font-size:15px', text: shortDate(job.job_date) })),
            make('h3', { text: job.customer }),
            job.address && make('p', { class: 'jobmeta' }, addressLink(job.address)),
            make('p', { class: 'mates',
              text: 'On it: ' + (job.crew.map(function (c) { return c.name; }).join(', ') || 'nobody') }),
            job.details && make('p', { class: 'jobdetail', text: job.details }),
            make('div', { class: 'inline' },
              make('button', { class: 'slim', style: 'margin:0',
                onclick: function () { view.editingJob = job.id; paint(); window.scrollTo(0, 0); } },
                'Change it'),
              make('button', { class: 'slim', style: 'margin:0',
                onclick: function () { removeJob(job); } }, 'Take it off'))));
        }))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'Nothing on the board over these days.' }))));
}

function jobForm(job) {
  var booking = view.bookFor;
  view.bookFor = null;

  var known = make('select', { id: 'job-known' },
    make('option', { value: '' }, 'Somebody new — I will type it'),
    view.customers.map(function (c) { return make('option', { value: String(c.id) }, c.name); }));

  if (job && job.customer_id) known.value = String(job.customer_id);
  else if (booking) known.value = String(booking.id);

  var customer = make('input', { id: 'job-customer', maxlength: '120',
    placeholder: 'Weaver residence',
    value: job ? job.customer : (booking ? booking.name : '') });
  var address = make('input', { id: 'job-address', maxlength: '200',
    placeholder: '1420 Oak Hollow Dr',
    value: job && job.address ? job.address : (booking && booking.address ? booking.address : '') });
  var phone = make('input', { id: 'job-phone', maxlength: '40', placeholder: '555-0142',
    value: job && job.phone ? job.phone : (booking && booking.phone ? booking.phone : '') });

  // Picking somebody off the books fills their details in for you.
  var typed = make('div', { class: 'field' },
    make('label', { for: 'job-customer', text: 'Customer name' }), customer);

  known.addEventListener('change', function () {
    var pick = view.customers.filter(function (c) { return String(c.id) === known.value; })[0];
    typed.hidden = !!pick;
    if (!pick) return;
    customer.value = pick.name;
    address.value = pick.address || '';
    phone.value = pick.phone || '';
  });

  typed.hidden = !!known.value;
  var when = make('input', { type: 'date', id: 'job-day', value: job ? job.job_date : view.day });
  var est = make('input', { type: 'number', id: 'job-est', min: '0', max: '24', step: '.5',
    placeholder: '4', value: job && job.est_hours != null ? String(job.est_hours) : '' });
  var details = make('textarea', { id: 'job-details', maxlength: '2000',
    placeholder: 'Zone 3 not coming on. Gate code 4471, valve box is by the driveway.' },
    job && job.details ? job.details : '');

  var kind = make('select', { id: 'job-kind' },
    ['sprinkler', 'lighting', 'drainage', 'other'].map(function (k) {
      return make('option', { value: k }, KIND_WORDS[k]);
    }));
  kind.value = job ? job.kind : 'sprinkler';

  var onJob = job ? job.crew.map(function (c) { return c.id; }) : [];
  var crew = view.people.filter(function (p) { return p.active && p.role === 'crew'; });

  var ticks = crew.length
    ? make('div', { style: 'display:flex;flex-wrap:wrap;gap:10px 20px' },
        crew.map(function (p, i) {
          var id = 'on-' + p.id;
          return make('label', {
            for: id,
            style: 'display:flex;align-items:center;gap:8px;font-weight:600;margin:0',
          }, make('input', {
            type: 'checkbox', id: id, value: String(p.id),
            checked: job ? onJob.indexOf(p.id) >= 0 : i === 0,
            style: 'width:auto;min-height:auto;margin:0',
          }), p.name);
        }))
    : make('p', { class: 'none', text: 'Add somebody to the crew first.' });

  var body = make('div', { class: 'pad' },
    make('div', { class: 'field' },
      make('label', { for: 'job-known', text: 'Who is it for?' }), known),
    typed,
    make('div', { class: 'field' }, make('label', { for: 'job-address', text: 'Address' }), address),
    make('div', { class: 'two', style: 'margin-bottom:13px' },
      make('div', {}, make('label', { for: 'job-phone', text: 'Their phone' }), phone),
      make('div', {}, make('label', { for: 'job-kind', text: 'Type of work' }), kind)),
    make('div', { class: 'two', style: 'margin-bottom:13px' },
      make('div', {}, make('label', { for: 'job-day', text: 'What day?' }), when),
      make('div', {}, make('label', { for: 'job-est', text: 'About how many hours?' }), est)),
    make('div', { class: 'field' },
      make('label', { for: 'job-details', text: 'What needs doing' }), details),
    make('div', { class: 'field' }, make('label', { text: 'Who is going?' }), ticks),
    make('button', {
      class: 'go',
      onclick: function () {
        var ids = Array.prototype.slice.call(body.querySelectorAll('input[type=checkbox]:checked'))
          .map(function (i) { return Number(i.value); });

        if (!known.value && !customer.value.trim()) {
          say('Pick a customer or type a name.', 'bad');
          return;
        }
        if (!ids.length) { say('Tick who is going.', 'bad'); return; }

        var payload = {
          customer_id: known.value ? Number(known.value) : null,
          customer: customer.value.trim(),
          address: address.value.trim(),
          phone: phone.value.trim(),
          kind: kind.value,
          job_date: when.value || view.day,
          est_hours: est.value === '' ? null : Number(est.value),
          details: details.value.trim(),
          crew_ids: ids,
        };

        view.editingJob = null;

        then(job
          ? api('/api/office/jobs/' + job.id, { method: 'PATCH', body: payload })
          : api('/api/office/jobs', { method: 'POST', body: payload }),
          job ? 'Job updated.' : 'On the board for ' + ids.length +
            (ids.length === 1 ? ' person.' : ' people.'));
      },
    }, job ? 'Save the changes' : 'Put it on the board'));

  if (job) {
    body.appendChild(make('button', {
      class: 'slim', style: 'width:100%',
      onclick: function () { view.editingJob = null; paint(); },
    }, 'Never mind'));
  }

  return panel(job ? 'Change this job' : 'Give out a job', [], body);
}

/* --------------------------- announcements ------------------------ */

function paintNotices(sheet) {
  var title = make('input', { id: 'note-title', maxlength: '120',
    placeholder: 'Freeze warning Thursday night' });
  var body = make('textarea', { id: 'note-body', maxlength: '3000', style: 'min-height:120px',
    placeholder: 'Blowouts move up a week. If you are on a sprinkler call before then, '
      + 'talk the customer through shutting the backflow off.' });
  var urgent = make('input', { type: 'checkbox', id: 'note-urgent',
    style: 'width:auto;min-height:auto;margin:0' });

  sheet.appendChild(panel('Put something out to the crew', [], make('div', { class: 'pad' },
    make('div', { class: 'field' }, make('label', { for: 'note-title', text: 'Heading' }), title),
    make('div', { class: 'field' }, make('label', { for: 'note-body', text: 'What you want to say' }), body),
    make('label', { for: 'note-urgent',
      style: 'display:flex;align-items:center;gap:9px;margin-bottom:13px' },
      urgent, 'Mark it important — it goes to the top and sits in colour'),
    make('button', {
      class: 'go',
      onclick: function () {
        if (!title.value.trim() || !body.value.trim()) {
          say('It needs a heading and something to say.', 'bad');
          return;
        }
        then(api('/api/office/notices', {
          method: 'POST',
          body: { title: title.value.trim(), body: body.value.trim(), urgent: urgent.checked },
        }), 'Put out to the crew.');
      },
    }, 'Send it out'))));

  var list = view.data.notices || [];

  sheet.appendChild(panel('What you have put out', [],
    list.length
      ? make('div', { class: 'pad' }, list.map(function (n) {
          var seen = n.seen_by || [];
          return make('div', { class: 'notice-card' + (n.urgent ? ' urgent' : '') },
            make('h4', {}, n.title, !!n.urgent && make('span', { class: 'urgent-tag', text: 'Important' })),
            make('p', { text: n.body }),
            make('div', { class: 'when',
              text: agoWords(n.posted_at) + ' · read by ' + seen.length + ' of ' + n.crew_count +
                (seen.length ? ' (' + seen.join(', ') + ')' : '') }),
            make('button', {
              class: 'slim', style: 'margin-top:10px',
              onclick: function () {
                if (!confirm('Take "' + n.title + '" down?')) return;
                then(api('/api/office/notices/' + n.id, { method: 'DELETE' }), 'Taken down.');
              },
            }, 'Take it down'));
        }))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'Nothing put out yet.' }))));
}

/* ------------------------------ the crew -------------------------- */

function paintCrew(sheet) {
  sheet.appendChild(addPersonForm());

  sheet.appendChild(panel('Everybody', [], make('div', { class: 'scroller' }, make('table', {},
    make('thead', {}, make('tr', {},
      make('th', { text: 'Name' }),
      make('th', { text: 'Signs in as' }),
      make('th', { class: 'r', text: 'Rate' }),
      make('th', { text: '' }))),
    make('tbody', {}, view.people.map(function (p) {
      return make('tr', { style: p.active ? '' : 'opacity:.55' },
        make('td', {}, p.name + (p.role === 'office' ? ' (office)' : ''),
          !p.active && make('span', { class: 'state question', text: 'Not working here' })),
        make('td', { text: p.username }),
        make('td', { class: 'r', text: CASH.format(p.hourly_rate) }),
        make('td', {}, make('div', { class: 'inline', style: 'margin:0' },
          make('button', { class: 'slim', style: 'margin:0',
            onclick: function () { changeRate(p); } }, 'Rate'),
          make('button', { class: 'slim', style: 'margin:0',
            onclick: function () { newNumber(p); } }, 'New number'),
          make('button', { class: 'slim', style: 'margin:0',
            onclick: function () { setWorking(p, !p.active); } },
            p.active ? 'Take off' : 'Put back'))));
    }))))));
}

function addPersonForm() {
  var name = make('input', { id: 'add-name', maxlength: '80', placeholder: 'Ray Delgado' });
  var username = make('input', { id: 'add-user', maxlength: '32', autocapitalize: 'none',
    spellcheck: 'false', placeholder: 'ray' });
  var pin = make('input', { id: 'add-pin', inputmode: 'numeric', maxlength: '10',
    placeholder: '4 to 10 digits' });
  var rate = make('input', { type: 'number', id: 'add-rate', min: '0', step: '.25', value: '0' });
  var phone = make('input', { id: 'add-phone', maxlength: '40', placeholder: '(optional)' });
  var role = make('select', { id: 'add-role' },
    make('option', { value: 'crew' }, 'Out on jobs'),
    make('option', { value: 'office' }, 'In the office'));

  return panel('Add somebody', [], make('div', { class: 'pad' },
    make('div', { class: 'two', style: 'margin-bottom:13px' },
      make('div', {}, make('label', { for: 'add-name', text: 'Their name' }), name),
      make('div', {}, make('label', { for: 'add-user', text: 'What they type to sign in' }), username)),
    make('div', { class: 'two', style: 'margin-bottom:13px' },
      make('div', {}, make('label', { for: 'add-pin', text: 'Starting number' }), pin),
      make('div', {}, make('label', { for: 'add-rate', text: 'Hourly rate' }), rate)),
    make('div', { class: 'two', style: 'margin-bottom:13px' },
      make('div', {}, make('label', { for: 'add-phone', text: 'Phone' }), phone),
      make('div', {}, make('label', { for: 'add-role', text: 'Where they work' }), role)),
    make('button', {
      class: 'go',
      onclick: function () {
        then(api('/api/office/people', {
          method: 'POST',
          body: {
            name: name.value,
            username: username.value,
            pin: pin.value,
            hourly_rate: Number(rate.value || 0),
            role: role.value,
            phone: phone.value,
          },
        }), 'Added. Give them their sign-in name and number.');
      },
    }, 'Add them')));
}

function changeRate(p) {
  var asked = prompt('Hourly rate for ' + p.name, String(p.hourly_rate));
  if (asked === null) return;
  var n = Number(asked);
  if (!isFinite(n) || n < 0) { say('That rate is not a number.', 'bad'); return; }
  then(api('/api/office/people/' + p.id, { method: 'PATCH', body: { hourly_rate: n } }),
    p.name + ' is now ' + CASH.format(n) + ' an hour.');
}

function newNumber(p) {
  var pin = prompt('New sign-in number for ' + p.name + ' (4 to 10 digits)', '');
  if (pin === null) return;
  then(api('/api/office/people/' + p.id + '/pin', { method: 'POST', body: { pin: pin.trim() } }),
    p.name + ' can sign in with that now. They have been signed out everywhere.');
}

function setWorking(p, active) {
  if (!active && !confirm(p.name + ' will not be able to sign in. Their hours are kept. Go ahead?')) return;
  then(api('/api/office/people/' + p.id, { method: 'PATCH', body: { active: active } }),
    active ? p.name + ' can sign in again.' : p.name + ' can no longer sign in.');
}

/* ------------------------------ payroll --------------------------- */

function paintPay(sheet) {
  var from = make('input', { type: 'date', id: 'pay-from', value: view.payFrom });
  var to = make('input', { type: 'date', id: 'pay-to', value: view.payTo });

  var pick = make('select', { id: 'pay-who' },
    make('option', { value: '' }, 'Everybody'),
    view.people.map(function (p) { return make('option', { value: String(p.id) }, p.name); }));
  pick.value = view.payWho;

  var csv = '/api/office/payroll.csv?from=' + view.payFrom + '&to=' + view.payTo +
    (view.payWho ? '&employee_id=' + view.payWho : '');

  sheet.appendChild(panel('Pick the dates', [], make('div', { class: 'pad' },
    make('div', { class: 'two', style: 'margin-bottom:13px' },
      make('div', {}, make('label', { for: 'pay-from', text: 'From' }), from),
      make('div', {}, make('label', { for: 'pay-to', text: 'To' }), to)),
    make('div', { class: 'field' }, make('label', { for: 'pay-who', text: 'Who?' }), pick),
    make('div', { class: 'inline' },
      make('button', { class: 'go', onclick: function () {
        view.payFrom = from.value || view.payFrom;
        view.payTo = to.value || view.payTo;
        view.payWho = pick.value;
        load();
      } }, 'Show it'),
      make('button', { onclick: function () {
        view.payFrom = mondayOf(today());
        view.payTo = shiftDate(view.payFrom, 6);
        load();
      } }, 'This week'),
      make('button', { onclick: function () {
        view.payFrom = shiftDate(mondayOf(today()), -7);
        view.payTo = shiftDate(view.payFrom, 6);
        load();
      } }, 'Last week'),
      make('a', { class: 'linkout', href: csv,
        style: 'align-self:center;padding:10px 4px' }, 'Download CSV')))));

  var rows = view.data.rows || [];

  sheet.appendChild(panel('What each person is owed', [],
    rows.length
      ? make('div', { class: 'scroller' }, make('table', {},
          make('thead', {}, make('tr', {},
            make('th', { text: 'Name' }),
            make('th', { class: 'r', text: 'Rate' }),
            make('th', { class: 'r', text: 'Jobs' }),
            make('th', { class: 'r', text: "OK'd" }),
            make('th', { class: 'r', text: 'Waiting' }),
            make('th', { class: 'r', text: 'Hours' }),
            make('th', { class: 'r', text: 'Over 40' }),
            make('th', { class: 'r', text: 'Pay' }))),
          make('tbody', {}, rows.map(function (r) {
            return make('tr', {},
              make('td', { text: r.name }),
              make('td', { class: 'r', text: CASH.format(r.hourly_rate) }),
              make('td', { class: 'r', text: String(r.shifts) }),
              make('td', { class: 'r', text: r.ok_hours.toFixed(2) }),
              make('td', { class: 'r', text: r.waiting_hours.toFixed(2) }),
              make('td', { class: 'r', text: r.hours.toFixed(2) }),
              make('td', { class: 'r', style: r.over_40 > 0 ? 'color:var(--ask-ink);font-weight:700' : 'color:var(--ink-soft)',
                text: r.over_40 > 0 ? r.over_40.toFixed(2) : '—' }),
              make('td', { class: 'r', text: CASH.format(r.pay) }));
          })),
          make('tfoot', {}, make('tr', {},
            make('td', { text: 'Total' }),
            make('td', {}), make('td', {}),
            make('td', { class: 'r', text: view.data.totals.ok_hours.toFixed(2) }),
            make('td', {}),
            make('td', { class: 'r', text: view.data.totals.hours.toFixed(2) }),
            make('td', { class: 'r', text: view.data.totals.over_40 > 0
              ? view.data.totals.over_40.toFixed(2) : '—' }),
            make('td', { class: 'r', text: CASH.format(view.data.totals.pay) })))))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'No hours over those dates.' }))));

  if (view.data.days === 7 && view.data.totals.over_40 > 0) {
    sheet.appendChild(make('div', { class: 'flash bad' },
      view.data.totals.over_40.toFixed(2) + ' hours past forty this week. Check before you run it.'));
  }

  var parts = view.data.parts || [];

  sheet.appendChild(panel('Parts used over those dates',
    parts.length ? [make('span', { class: 'pip', text: String(parts.length) + ' jobs' })] : [],
    parts.length
      ? make('div', { class: 'scroller' }, make('table', {},
          make('thead', {}, make('tr', {},
            make('th', { text: 'Day' }),
            make('th', { text: 'Customer' }),
            make('th', { text: 'Work' }),
            make('th', { text: 'What went in' }))),
          make('tbody', {}, parts.map(function (row) {
            return make('tr', {},
              make('td', { text: shortDate(row.job_date) }),
              make('td', { text: row.customer }),
              make('td', {}, kindChip(row.kind)),
              make('td', { style: 'white-space:normal', text: row.materials }));
          }))))
      : make('div', { class: 'pad' },
          make('p', { class: 'none',
            text: 'Nothing recorded. The crew add parts when they mark a job finished.' }))));

  var shifts = view.data.shifts || [];

  sheet.appendChild(panel('Every shift over those dates', [],
    shifts.length
      ? make('ul', { class: 'rows' }, shifts.map(function (s) {
          return hourRow(s, { withName: true, withPay: true, quiet: true, buttons: shiftButtons(s) });
        }))
      : make('div', { class: 'pad' }, make('p', { class: 'none', text: 'Nothing to show.' }))));
}

/* ------------------------------- start ---------------------------- */

document.getElementById('badge').append(
  logoMark(30),
  make('span', {},
    make('b', { text: 'Custom Outdoor Design' }),
    make('i', { text: 'Office' })));

TABS.forEach(function (t) {
  document.getElementById('tab-' + t).addEventListener('click', function () { goTab(t); });
});

var hunt = document.getElementById('search');
var huntTimer = null;

hunt.addEventListener('input', function () {
  clearTimeout(huntTimer);
  var term = hunt.value.trim();

  // Wait for them to stop typing rather than asking on every keystroke.
  huntTimer = setTimeout(function () {
    if (term.length < 2) {
      if (view.hunting) { view.hunting = null; markTab(); load(); }
      return;
    }
    view.hunting = term;
    view.openCustomer = null;
    markTab();
    load();
  }, 250);
});

document.getElementById('signout').appendChild(signOutButton());

api('/api/me').then(function (r) {
  if (r.user.role !== 'office') { location.replace('/crew.html'); return; }
  view.me = r.user;
  document.getElementById('me').textContent = r.user.name;
  return load();
}).catch(function (err) {
  document.getElementById('sheet').textContent = err.message;
});
