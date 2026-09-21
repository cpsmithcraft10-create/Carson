'use strict';

/* The office screen. Hand out work, keep an eye on the day, OK hours, post
   announcements, run payroll. */

var TABS = ['today', 'hours', 'jobs', 'notices', 'crew', 'pay'];

var view = {
  me: null,
  tab: 'today',
  day: today(),
  jobsTo: null,
  payFrom: mondayOf(today()),
  payTo: shiftDate(mondayOf(today()), 6),
  payWho: '',
  people: [],
  data: {},
  flash: null,
  editingJob: null,
};

/* ----------------------------- loading ---------------------------- */

function loadPeople() {
  return api('/api/office/people?include_past=1').then(function (r) { view.people = r.people; });
}

function fetchTab() {
  if (view.tab === 'today') return api('/api/office/day?date=' + view.day);
  if (view.tab === 'hours') return api('/api/office/waiting');
  if (view.tab === 'jobs') {
    var to = view.jobsTo || shiftDate(view.day, 13);
    return api('/api/office/jobs?from=' + view.day + '&to=' + to);
  }
  if (view.tab === 'notices') return api('/api/office/notices');
  if (view.tab === 'crew') return loadPeople().then(function () { return {}; });

  var q = '?from=' + view.payFrom + '&to=' + view.payTo +
    (view.payWho ? '&employee_id=' + view.payWho : '');
  return api('/api/office/payroll' + q);
}

function load() {
  return Promise.all([fetchTab(), api('/api/office/waiting')])
    .then(function (both) {
      view.data = both[0];
      var pip = document.getElementById('hours-pip');
      pip.textContent = both[1].shifts.length ? '(' + both[1].shifts.length + ')' : '';
      paint();
    })
    .catch(function (err) { say(err.message, 'bad'); });
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
  TABS.forEach(function (t) {
    document.getElementById('tab-' + t).setAttribute('aria-selected', String(t === tab));
  });
  load();
}

/* ----------------------------- painting --------------------------- */

function paint() {
  var sheet = emptyOut(document.getElementById('sheet'));

  if (view.tab === 'today' || view.tab === 'jobs') {
    sheet.appendChild(make('div', { class: 'daybar' },
      make('button', { class: 'slim', 'aria-label': 'Day before',
        onclick: function () { view.day = shiftDate(view.day, -1); load(); } }, '‹'),
      make('h1', {}, longDate(view.day), view.day !== today() && make('em', { text: 'not today' })),
      make('button', { class: 'slim', 'aria-label': 'Day after',
        onclick: function () { view.day = shiftDate(view.day, 1); load(); } }, '›')));
  }

  if (view.flash) {
    sheet.appendChild(make('div', { class: 'flash ' + view.flash.kind, text: view.flash.message }));
  }

  ({
    today: paintToday,
    hours: paintHours,
    jobs: paintJobs,
    notices: paintNotices,
    crew: paintCrew,
    pay: paintPay,
  })[view.tab](sheet);
}

/* ------------------------------ today ----------------------------- */

function paintToday(sheet) {
  var d = view.data;

  sheet.appendChild(panel('How the day looks', [], figures([
    { value: String(d.jobs.length), label: 'Jobs today' },
    { value: String(d.on_the_clock.length), label: 'Out on jobs now' },
    { value: d.totals.hours.toFixed(2), label: 'Hours down' },
    { value: String(d.waiting), label: 'Hours to OK' },
    { value: CASH.format(d.totals.pay), label: 'Labour today' },
  ])));

  if (d.on_the_clock.length) {
    sheet.appendChild(panel('Out on jobs right now',
      [make('span', { class: 'pip', text: String(d.on_the_clock.length) })],
      make('ul', { class: 'rows' }, d.on_the_clock.map(function (s) {
        return hourRow(s, { withName: true });
      }))));
  }

  sheet.appendChild(panel('The board · ' + shortDate(view.day), [
    make('span', { class: 'dim', style: 'font-size:15px',
      text: d.job_counts.assigned + ' not started · ' + d.job_counts.working +
            ' going · ' + d.job_counts.done + ' finished' }),
  ],
    d.jobs.length
      ? make('ul', { class: 'jobs' }, d.jobs.map(officeJobItem))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'No work on the board for this day.' }))));

  sheet.appendChild(panel('Hours put down for ' + shortDate(view.day), [],
    d.shifts.length
      ? make('ul', { class: 'rows' }, d.shifts.map(function (s) {
          return hourRow(s, { withName: true, withPay: true, buttons: shiftButtons(s) });
        }))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'Nothing down for this day.' }))));
}

function officeJobItem(job) {
  return make('li', {}, make('div', { class: 'bar ' + job.status }), make('div', {},
    make('div', { class: 'jobline' },
      kindChip(job.kind),
      make('span', { class: 'progress ' + job.status, text: JOB_WORDS[job.status] })),
    make('h3', { text: job.customer }),
    job.address && make('p', { class: 'jobmeta' }, addressLink(job.address)),
    make('p', { class: 'mates',
      text: 'On it: ' + (job.crew.map(function (c) { return c.name; }).join(', ') || 'nobody') }),
    job.details && make('p', { class: 'jobdetail', text: job.details }),
    job.status === 'done' && job.wrap_notes &&
      make('p', { class: 'jobdetail', text: 'Wrapped up: ' + job.wrap_notes }),
    job.status === 'done' && job.materials &&
      make('p', { class: 'mates', text: 'Parts used: ' + job.materials }),
    job.finished_by_name &&
      make('p', { class: 'mates', text: 'Finished by ' + job.finished_by_name }),
    make('div', { class: 'inline' },
      make('button', { class: 'slim', style: 'margin:0',
        onclick: function () { view.editingJob = job.id; goTab('jobs'); } }, 'Change it'),
      make('button', { class: 'slim', style: 'margin:0',
        onclick: function () { removeJob(job); } }, 'Take it off'))));
}

function shiftButtons(s) {
  return [
    s.status === 'sent' && make('button', { class: 'slim go', style: 'margin:0',
      onclick: function () { okThese(s); } }, 'These look right'),
    s.status === 'sent' && make('button', { class: 'slim', style: 'margin:0',
      onclick: function () { askAbout(s); } }, 'Ask about it'),
    s.status === 'ok' && make('button', { class: 'slim', style: 'margin:0',
      onclick: function () {
        then(api('/api/office/shifts/' + s.id + '/reopen', { method: 'POST' }), 'Put back.');
      } }, 'Put it back'),
    s.status !== 'open' && make('button', { class: 'slim', style: 'margin:0',
      onclick: function () { changeTimes(s); } }, 'Change times'),
    s.status !== 'open' && make('button', { class: 'slim', style: 'margin:0',
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
          return hourRow(s, { withName: true, withPay: true, buttons: shiftButtons(s) });
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
  var customer = make('input', { id: 'job-customer', maxlength: '120',
    placeholder: 'Weaver residence', value: job ? job.customer : '' });
  var address = make('input', { id: 'job-address', maxlength: '200',
    placeholder: '1420 Oak Hollow Dr', value: job && job.address ? job.address : '' });
  var phone = make('input', { id: 'job-phone', maxlength: '40',
    placeholder: '555-0142', value: job && job.phone ? job.phone : '' });
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
    make('div', { class: 'field' }, make('label', { for: 'job-customer', text: 'Customer' }), customer),
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

        if (!customer.value.trim()) { say('Put the customer name in.', 'bad'); return; }
        if (!ids.length) { say('Tick who is going.', 'bad'); return; }

        var payload = {
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
            make('th', { class: 'r', text: 'Pay' }))),
          make('tbody', {}, rows.map(function (r) {
            return make('tr', {},
              make('td', { text: r.name }),
              make('td', { class: 'r', text: CASH.format(r.hourly_rate) }),
              make('td', { class: 'r', text: String(r.shifts) }),
              make('td', { class: 'r', text: r.ok_hours.toFixed(2) }),
              make('td', { class: 'r', text: r.waiting_hours.toFixed(2) }),
              make('td', { class: 'r', text: r.hours.toFixed(2) }),
              make('td', { class: 'r', text: CASH.format(r.pay) }));
          })),
          make('tfoot', {}, make('tr', {},
            make('td', { text: 'Total' }),
            make('td', {}), make('td', {}),
            make('td', { class: 'r', text: view.data.totals.ok_hours.toFixed(2) }),
            make('td', {}),
            make('td', { class: 'r', text: view.data.totals.hours.toFixed(2) }),
            make('td', { class: 'r', text: CASH.format(view.data.totals.pay) })))))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'No hours over those dates.' }))));

  var shifts = view.data.shifts || [];

  sheet.appendChild(panel('Every shift over those dates', [],
    shifts.length
      ? make('ul', { class: 'rows' }, shifts.map(function (s) {
          return hourRow(s, { withName: true, withPay: true, buttons: shiftButtons(s) });
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

document.getElementById('signout').appendChild(signOutButton());

api('/api/me').then(function (r) {
  if (r.user.role !== 'office') { location.replace('/crew.html'); return; }
  view.me = r.user;
  document.getElementById('me').textContent = r.user.name;
  return loadPeople().then(load);
}).catch(function (err) {
  document.getElementById('sheet').textContent = err.message;
});
