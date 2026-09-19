'use strict';

/* The office screen. Approve hours, hand out work, run payroll. */

var TABS = ['day', 'waiting', 'work', 'crew', 'pay'];

var view = {
  me: null,
  tab: 'day',
  day: today(),
  payFrom: mondayOf(today()),
  payTo: shiftDay(mondayOf(today()), 6),
  payWho: '',
  crew: [],
  notice: null,
  data: {}
};

/* ------------------------------ loading ---------------------------- */

function loadCrew() {
  return api('/api/admin/workers?include_inactive=1').then(function (r) {
    view.crew = r.workers;
  });
}

function load() {
  var jobs = {
    day: function () { return api('/api/admin/overview?date=' + view.day); },
    waiting: function () { return api('/api/admin/pending'); },
    work: function () {
      return api('/api/admin/jobs?from=' + view.day + '&to=' + shiftDay(view.day, 13));
    },
    crew: function () { return loadCrew().then(function () { return {}; }); },
    pay: function () {
      var q = '?from=' + view.payFrom + '&to=' + view.payTo +
        (view.payWho ? '&worker_id=' + view.payWho : '');
      return api('/api/admin/report' + q);
    }
  };

  return Promise.all([jobs[view.tab](), api('/api/admin/pending')])
    .then(function (both) {
      view.data = both[0];
      var badge = document.getElementById('waiting-count');
      badge.textContent = both[1].entries.length ? '(' + both[1].entries.length + ')' : '';
      paint();
    })
    .catch(function (err) { flash(err.message, 'bad'); });
}

function flash(message, kind) {
  view.notice = message ? { message: message, kind: kind || 'good' } : null;
  paint();
}

function after(promise, message) {
  return promise.then(function () {
    view.notice = message ? { message: message, kind: 'good' } : null;
    return load();
  }).catch(function (err) { flash(err.message, 'bad'); });
}

function goTab(tab) {
  view.tab = tab;
  view.notice = null;
  TABS.forEach(function (t) {
    document.getElementById('tab-' + t).setAttribute('aria-selected', String(t === tab));
  });
  load();
}

/* ------------------------------ painting --------------------------- */

function paint() {
  var sheet = empty(document.getElementById('sheet'));

  if (view.tab === 'day' || view.tab === 'waiting' || view.tab === 'work') {
    sheet.appendChild(make('div', { class: 'daybar' },
      make('button', { class: 'line', 'aria-label': 'Day before',
        onclick: function () { view.day = shiftDay(view.day, -1); load(); } }, '‹'),
      make('h1', {}, fullDay(view.day),
        view.day !== today() && make('em', { text: 'not today' })),
      make('button', { class: 'line', 'aria-label': 'Day after',
        onclick: function () { view.day = shiftDay(view.day, 1); load(); } }, '›')));
  }

  if (view.notice) {
    sheet.appendChild(make('div', { class: 'notice ' + view.notice.kind, text: view.notice.message }));
  }

  if (view.tab === 'day') paintDay(sheet);
  else if (view.tab === 'waiting') paintWaiting(sheet);
  else if (view.tab === 'work') paintWork(sheet);
  else if (view.tab === 'crew') paintCrew(sheet);
  else paintPay(sheet);
}

/* ------------------------------- the day --------------------------- */

function paintDay(sheet) {
  var d = view.data;

  sheet.appendChild(card('How the day looks', [], strip([
    { value: d.totals.hours.toFixed(2), label: 'Hours this day' },
    { value: String(d.running), label: 'Out on jobs now' },
    { value: String(d.pending_all_time), label: 'Waiting on you' },
    { value: CASH.format(d.totals.pay), label: 'Labour this day' }
  ])));

  sheet.appendChild(card('Work given out for ' + briefDay(view.day), [],
    d.jobs.length
      ? make('ul', { class: 'rows' }, d.jobs.map(function (job) {
          return make('li', { style: 'grid-template-columns:4px 1fr auto' },
            make('div', { class: 'tick ' + (job.entry_count ? 'approved' : '') }),
            make('div', {},
              make('div', { class: 'task', text: job.title }),
              make('div', { class: 'span', text: job.worker_name +
                (job.location ? '  ·  ' + job.location : '') }),
              job.notes && make('div', { class: 'said', text: job.notes })),
            make('div', { class: 'figure' },
              make('small', { text: job.entry_count ? 'hours in' : 'nothing yet' })));
        }))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'No work given out for this day.' }))));

  sheet.appendChild(card('Everything down for ' + briefDay(view.day), [],
    d.entries.length
      ? make('ul', { class: 'rows' }, d.entries.map(function (e) {
          return hourRow(e, { withName: true, withPay: true, buttons: entryButtons(e) });
        }))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'Nothing down for this day.' }))));
}

function entryButtons(e) {
  return [
    e.status === 'submitted' && make('button', {
      class: 'line go', style: 'margin:0', onclick: function () { okThese(e); }
    }, 'These look right'),
    e.status === 'submitted' && make('button', {
      class: 'line', style: 'margin:0', onclick: function () { askAbout(e); }
    }, 'Ask about it'),
    e.status === 'approved' && make('button', {
      class: 'line', style: 'margin:0',
      onclick: function () {
        after(api('/api/admin/entries/' + e.id + '/reopen', { method: 'POST' }),
          'Put back in the waiting pile.');
      }
    }, 'Put it back'),
    e.status !== 'open' && make('button', {
      class: 'line', style: 'margin:0', onclick: function () { editTimes(e); }
    }, 'Change times'),
    e.status !== 'open' && make('button', {
      class: 'line', style: 'margin:0',
      onclick: function () {
        if (!confirm('Take ' + e.worker_name + "'s hours off for " + briefDay(e.work_date) + '?')) return;
        after(api('/api/admin/entries/' + e.id, { method: 'DELETE' }), 'Taken off.');
      }
    }, 'Take it off')
  ];
}

function okThese(e) {
  after(api('/api/admin/entries/' + e.id + '/approve', { method: 'POST', body: {} }),
    "OK'd — " + e.hours.toFixed(2) + ' hours for ' + e.worker_name + '.');
}

function askAbout(e) {
  var q = prompt('What do you want to ask ' + e.worker_name + '?', '');
  if (q === null) return;
  after(api('/api/admin/entries/' + e.id + '/reject', {
    method: 'POST',
    body: { note: q.trim() || 'Please check these times.' }
  }), 'Sent back to ' + e.worker_name + '.');
}

function editTimes(e) {
  var from = prompt('What time did they start? Like 07:30', e.start_time);
  if (from === null) return;
  var to = prompt('What time did they finish? Like 16:00', e.end_time || '');
  if (to === null) return;
  var brk = prompt('How many minutes was the break?', String(e.break_minutes || 0));
  if (brk === null) return;

  from = from.trim();
  to = to.trim();

  if (!TIME_LOOKS_RIGHT.test(from) || !TIME_LOOKS_RIGHT.test(to)) {
    flash('Times go in like 07:30 or 16:00.', 'bad');
    return;
  }

  after(api('/api/admin/entries/' + e.id, {
    method: 'PATCH',
    body: { start_time: from, end_time: to, break_minutes: +brk || 0 }
  }), 'Times changed.');
}

/* ----------------------------- waiting ----------------------------- */

function paintWaiting(sheet) {
  var list = view.data.entries;

  sheet.appendChild(card('Hours waiting on you',
    list.length ? [make('span', { class: 'count', text: String(list.length) })] : [],
    list.length
      ? make('ul', { class: 'rows' }, list.map(function (e) {
          return hourRow(e, { withName: true, withPay: true, buttons: entryButtons(e) });
        }))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'Nothing waiting. All caught up.' })),
    list.length ? strip([
      { value: view.data.totals.hours.toFixed(2), label: 'Hours waiting' },
      { value: CASH.format(view.data.totals.pay), label: 'Worth' }
    ]) : null));
}

/* ---------------------------- giving work -------------------------- */

function paintWork(sheet) {
  sheet.appendChild(giveOutCard());

  var jobs = view.data.jobs || [];

  sheet.appendChild(card('On the books · next two weeks', [],
    jobs.length
      ? make('ul', { class: 'rows' }, jobs.map(function (job) {
          return make('li', { style: 'grid-template-columns:4px 1fr auto' },
            make('div', { class: 'tick ' + (job.entry_count ? 'approved' : '') }),
            make('div', {},
              make('div', { class: 'task', text: job.title }),
              make('div', { class: 'span', text: briefDay(job.work_date) + '  ·  ' + job.worker_name +
                (job.location ? '  ·  ' + job.location : '') }),
              job.notes && make('div', { class: 'said', text: job.notes })),
            make('div', {}, make('button', {
              class: 'line', style: 'margin:0',
              onclick: function () {
                var warn = job.entry_count
                  ? 'Hours are already down against this job. They stay, but lose the job name. Take it off the list?'
                  : 'Take "' + job.title + '" off ' + job.worker_name + "'s list?";
                if (!confirm(warn)) return;
                after(api('/api/admin/jobs/' + job.id, { method: 'DELETE' }), 'Taken off the list.');
              }
            }, 'Take off')));
        }))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'Nothing on the books for the next two weeks.' }))));
}

function giveOutCard() {
  var what = make('input', { id: 'give-what', maxlength: '120',
    placeholder: 'Sprinkler zone 3 not coming on' });
  var place = make('input', { id: 'give-where', maxlength: '200',
    placeholder: '1420 Oak Hollow Dr' });
  var planned = make('input', { type: 'number', id: 'give-hours', min: '0', max: '24',
    step: '.5', placeholder: '4' });
  var dayOn = make('input', { type: 'date', id: 'give-day', value: view.day });
  var extra = make('textarea', { id: 'give-notes', maxlength: '1000',
    placeholder: 'Gate code 4471. Check the valve box by the driveway.' });

  var live = view.crew.filter(function (c) { return c.active && c.role !== 'admin'; });

  var ticks = make('div', { style: 'display:flex;flex-wrap:wrap;gap:10px 20px' },
    live.map(function (c, i) {
      var id = 'give-' + c.id;
      return make('label', {
        for: id,
        style: 'display:flex;align-items:center;gap:8px;font-weight:600;margin:0'
      }, make('input', {
        type: 'checkbox', id: id, value: String(c.id), checked: i === 0,
        style: 'width:auto;min-height:auto;margin:0'
      }), c.name);
    }));

  if (!live.length) {
    ticks = make('p', { class: 'none', text: 'Add somebody to the crew first.' });
  }

  return card('Give somebody a job', [], make('div', { class: 'pad' },
    make('div', { class: 'field' }, make('label', { for: 'give-what', text: 'What is the job?' }), what),
    make('div', { class: 'field' }, make('label', { for: 'give-where', text: 'Where is it?' }), place),
    make('div', { class: 'pair', style: 'margin-bottom:14px' },
      make('div', {}, make('label', { for: 'give-day', text: 'What day?' }), dayOn),
      make('div', {}, make('label', { for: 'give-hours', text: 'About how many hours?' }), planned)),
    make('div', { class: 'field' },
      make('label', { for: 'give-notes', text: 'Anything they should know?' }), extra),
    make('div', { class: 'field' }, make('label', { text: 'Who is doing it?' }), ticks),
    make('button', {
      class: 'go',
      onclick: function () {
        var ids = Array.prototype.slice.call(ticks.querySelectorAll('input:checked'))
          .map(function (i) { return Number(i.value); });

        if (!what.value.trim()) { flash('Say what the job is.', 'bad'); return; }
        if (!ids.length) { flash('Tick who is doing it.', 'bad'); return; }

        after(api('/api/admin/jobs', {
          method: 'POST',
          body: {
            title: what.value.trim(),
            work_date: dayOn.value || view.day,
            location: place.value.trim(),
            notes: extra.value.trim(),
            scheduled_hours: planned.value === '' ? null : Number(planned.value),
            worker_ids: ids
          }
        }), 'On the list for ' + ids.length + (ids.length === 1 ? ' person.' : ' people.'));
      }
    }, 'Put it on their list')));
}

/* ------------------------------ the crew --------------------------- */

function paintCrew(sheet) {
  sheet.appendChild(addPersonCard());

  sheet.appendChild(card('The crew', [], make('div', { class: 'sideways' }, make('table', {},
    make('thead', {}, make('tr', {},
      make('th', { text: 'Name' }),
      make('th', { text: 'Signs in as' }),
      make('th', { class: 'n', text: 'Rate' }),
      make('th', { text: '' }))),
    make('tbody', {}, view.crew.map(function (c) {
      return make('tr', { style: c.active ? '' : 'opacity:.55' },
        make('td', {}, c.name + (c.role === 'admin' ? ' (office)' : ''),
          !c.active && make('span', { class: 'mark-state rejected', text: 'Not working here' })),
        make('td', { text: c.username }),
        make('td', { class: 'n', text: CASH.format(c.hourly_rate) }),
        make('td', {}, make('div', { class: 'inarow', style: 'margin:0' },
          make('button', { class: 'line', style: 'margin:0',
            onclick: function () { changeRate(c); } }, 'Rate'),
          make('button', { class: 'line', style: 'margin:0',
            onclick: function () { newNumber(c); } }, 'New number'),
          make('button', { class: 'line', style: 'margin:0',
            onclick: function () { setWorking(c, !c.active); } },
            c.active ? 'Take off' : 'Put back'))));
    }))))));
}

function addPersonCard() {
  var name = make('input', { id: 'add-name', maxlength: '80', placeholder: 'Ray Delgado' });
  var username = make('input', { id: 'add-user', maxlength: '32', autocapitalize: 'none',
    spellcheck: 'false', placeholder: 'ray' });
  var pin = make('input', { id: 'add-pin', inputmode: 'numeric', maxlength: '10', placeholder: '4 to 10 digits' });
  var rate = make('input', { type: 'number', id: 'add-rate', min: '0', step: '.25', value: '0' });
  var phone = make('input', { id: 'add-phone', maxlength: '40', placeholder: '(optional)' });
  var role = make('select', { id: 'add-role' },
    make('option', { value: 'worker' }, 'Out on jobs'),
    make('option', { value: 'admin' }, 'In the office'));

  return card('Add somebody', [], make('div', { class: 'pad' },
    make('div', { class: 'pair', style: 'margin-bottom:14px' },
      make('div', {}, make('label', { for: 'add-name', text: 'Their name' }), name),
      make('div', {}, make('label', { for: 'add-user', text: 'What they type to sign in' }), username)),
    make('div', { class: 'pair', style: 'margin-bottom:14px' },
      make('div', {}, make('label', { for: 'add-pin', text: 'Starting number' }), pin),
      make('div', {}, make('label', { for: 'add-rate', text: 'Hourly rate' }), rate)),
    make('div', { class: 'pair', style: 'margin-bottom:14px' },
      make('div', {}, make('label', { for: 'add-phone', text: 'Phone' }), phone),
      make('div', {}, make('label', { for: 'add-role', text: 'Where they work' }), role)),
    make('button', {
      class: 'go',
      onclick: function () {
        after(api('/api/admin/workers', {
          method: 'POST',
          body: {
            name: name.value,
            username: username.value,
            pin: pin.value,
            hourly_rate: Number(rate.value || 0),
            role: role.value,
            phone: phone.value
          }
        }), 'Added. Give them their sign-in name and number.');
      }
    }, 'Add them')));
}

function changeRate(c) {
  var asked = prompt('Hourly rate for ' + c.name, String(c.hourly_rate));
  if (asked === null) return;
  var n = Number(asked);
  if (!isFinite(n) || n < 0) { flash('That rate is not a number.', 'bad'); return; }
  after(api('/api/admin/workers/' + c.id, { method: 'PATCH', body: { hourly_rate: n } }),
    c.name + ' is now ' + CASH.format(n) + ' an hour.');
}

function newNumber(c) {
  var pin = prompt('New sign-in number for ' + c.name + ' (4 to 10 digits)', '');
  if (pin === null) return;
  after(api('/api/admin/workers/' + c.id + '/pin', { method: 'POST', body: { pin: pin.trim() } }),
    c.name + ' can sign in with that number now. They have been signed out everywhere.');
}

function setWorking(c, active) {
  if (!active && !confirm(c.name + ' will not be able to sign in. Their old hours are kept. Go ahead?')) return;
  after(api('/api/admin/workers/' + c.id, { method: 'PATCH', body: { active: active } }),
    active ? c.name + ' can sign in again.' : c.name + ' can no longer sign in.');
}

/* ------------------------------ payroll ---------------------------- */

function paintPay(sheet) {
  var from = make('input', { type: 'date', id: 'pay-from', value: view.payFrom });
  var to = make('input', { type: 'date', id: 'pay-to', value: view.payTo });

  var pick = make('select', { id: 'pay-who' },
    make('option', { value: '' }, 'Everybody'),
    view.crew.map(function (c) { return make('option', { value: String(c.id) }, c.name); }));
  pick.value = view.payWho;

  var csv = '/api/admin/report.csv?from=' + view.payFrom + '&to=' + view.payTo +
    (view.payWho ? '&worker_id=' + view.payWho : '');

  sheet.appendChild(card('Pick the dates', [], make('div', { class: 'pad' },
    make('div', { class: 'pair', style: 'margin-bottom:14px' },
      make('div', {}, make('label', { for: 'pay-from', text: 'From' }), from),
      make('div', {}, make('label', { for: 'pay-to', text: 'To' }), to)),
    make('div', { class: 'field' }, make('label', { for: 'pay-who', text: 'Who?' }), pick),
    make('div', { class: 'inarow' },
      make('button', { class: 'go', onclick: function () {
        view.payFrom = from.value || view.payFrom;
        view.payTo = to.value || view.payTo;
        view.payWho = pick.value;
        load();
      } }, 'Show it'),
      make('button', { onclick: function () {
        view.payFrom = mondayOf(today());
        view.payTo = shiftDay(view.payFrom, 6);
        load();
      } }, 'This week'),
      make('button', { onclick: function () {
        view.payFrom = shiftDay(mondayOf(today()), -7);
        view.payTo = shiftDay(view.payFrom, 6);
        load();
      } }, 'Last week'),
      make('a', { class: 'button line', href: csv, style: 'margin:0;display:inline-flex;align-items:center' },
        'Download CSV')))));

  var rows = view.data.rows || [];

  sheet.appendChild(card('What each person is owed', [],
    rows.length
      ? make('div', { class: 'sideways' }, make('table', {},
          make('thead', {}, make('tr', {},
            make('th', { text: 'Name' }),
            make('th', { class: 'n', text: 'Rate' }),
            make('th', { class: 'n', text: 'Jobs' }),
            make('th', { class: 'n', text: "OK'd" }),
            make('th', { class: 'n', text: 'Waiting' }),
            make('th', { class: 'n', text: 'Hours' }),
            make('th', { class: 'n', text: 'Pay' }))),
          make('tbody', {}, rows.map(function (r) {
            return make('tr', {},
              make('td', { text: r.worker_name }),
              make('td', { class: 'n', text: CASH.format(r.hourly_rate) }),
              make('td', { class: 'n', text: String(r.entries) }),
              make('td', { class: 'n', text: r.approved_hours.toFixed(2) }),
              make('td', { class: 'n', text: r.pending_hours.toFixed(2) }),
              make('td', { class: 'n', text: r.hours.toFixed(2) }),
              make('td', { class: 'n', text: CASH.format(r.pay) }));
          })),
          make('tfoot', {}, make('tr', {},
            make('td', { text: 'Total' }),
            make('td', {}), make('td', {}),
            make('td', { class: 'n', text: view.data.totals.approved_hours.toFixed(2) }),
            make('td', {}),
            make('td', { class: 'n', text: view.data.totals.hours.toFixed(2) }),
            make('td', { class: 'n', text: CASH.format(view.data.totals.pay) })))))
      : make('div', { class: 'pad' },
          make('p', { class: 'none', text: 'No hours in over those dates.' }))));

  var entries = view.data.entries || [];

  sheet.appendChild(card('Every job over those dates', [],
    entries.length
      ? make('ul', { class: 'rows' }, entries.map(function (e) {
          return hourRow(e, { withName: true, withPay: true, buttons: entryButtons(e) });
        }))
      : make('div', { class: 'pad' }, make('p', { class: 'none', text: 'Nothing to show.' }))));
}

/* ------------------------------- start ----------------------------- */

TABS.forEach(function (t) {
  document.getElementById('tab-' + t).addEventListener('click', function () { goTab(t); });
});

document.getElementById('signout').appendChild(signOutButton());

api('/api/me').then(function (r) {
  if (r.user.role !== 'admin') { location.replace('/app.html'); return; }
  view.me = r.user;
  document.getElementById('me').textContent = r.user.name;
  return loadCrew().then(load);
}).catch(function (err) {
  document.getElementById('sheet').textContent = err.message;
});
