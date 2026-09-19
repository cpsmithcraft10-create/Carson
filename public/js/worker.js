'use strict';

/* The crew screen. One person, one day at a time. */

var view = {
  me: null,
  day: today(),
  jobs: [],
  entries: [],
  running: null,
  week: null,
  closing: false,
  byHand: false,
  offList: false,
  pin: false,
  notice: null
};

/* ------------------------------ loading ---------------------------- */

function load() {
  return Promise.all([
    api('/api/my/day?date=' + view.day),
    api('/api/my/entries?from=' + mondayOf(view.day) + '&to=' + shiftDay(mondayOf(view.day), 6))
  ]).then(function (both) {
    view.jobs = both[0].jobs;
    view.entries = both[0].entries;
    view.running = both[0].running;
    view.dayTotals = both[0].totals;
    view.week = both[1];
    paint();
  }).catch(function (err) {
    flash(err.message, 'bad');
  });
}

function flash(message, kind) {
  view.notice = message ? { message: message, kind: kind || 'good' } : null;
  paint();
}

function after(promise, message) {
  return promise.then(function () {
    view.notice = message ? { message: message, kind: 'good' } : null;
    return load();
  }).catch(function (err) {
    flash(err.message, 'bad');
  });
}

/* ------------------------------ painting --------------------------- */

function paint() {
  var sheet = empty(document.getElementById('sheet'));

  sheet.appendChild(make('div', { class: 'daybar' },
    make('button', { class: 'line', 'aria-label': 'Day before',
      onclick: function () { goDay(shiftDay(view.day, -1)); } }, '‹'),
    make('h1', {}, fullDay(view.day),
      view.day !== today() && make('em', { text: 'not today — tap the arrow to come back' })),
    make('button', { class: 'line', 'aria-label': 'Day after',
      onclick: function () { goDay(shiftDay(view.day, 1)); } }, '›')));

  if (view.notice) {
    sheet.appendChild(make('div', { class: 'notice ' + view.notice.kind, text: view.notice.message }));
  }

  if (view.running) sheet.appendChild(liveCard(view.running));

  sheet.appendChild(jobsCard());
  sheet.appendChild(myDayCard());
  sheet.appendChild(byHandCard());
  sheet.appendChild(weekCard());
  sheet.appendChild(pinCard());
}

function goDay(d) {
  view.day = d;
  view.notice = null;
  view.closing = false;
  view.byHand = false;
  view.offList = false;
  load();
}

function liveCard(entry) {
  var box = make('div', { class: 'live' },
    make('span', { class: 'flag' }, make('span', { class: 'blip' }), 'On the clock'),
    make('h3', { text: entry.job_title || entry.description || 'Work in progress' }),
    entry.job_location && make('p', { class: 'addr', text: entry.job_location }),
    make('p', { class: 'ticker', id: 'ticker', text: inWords(gap(entry.start_time, timeNow())) }),
    make('p', { class: 'since' },
      'Started at ' + clockOf(entry.start_time),
      make('button', { class: 'link', onclick: function () { fixStart(entry); } }, 'change')));

  if (!view.closing) {
    box.appendChild(make('button', {
      class: 'stop', onclick: function () { view.closing = true; paint(); }
    }, "I'm done"));
    box.appendChild(make('button', {
      class: 'line', style: 'width:100%',
      onclick: function () {
        if (!confirm('Throw this away? No hours get counted.')) return;
        after(api('/api/my/entries/' + entry.id, { method: 'DELETE' }),
          'Thrown away. Nothing was counted.');
      }
    }, 'I started the wrong job'));
    return box;
  }

  var finish = make('input', { type: 'time', id: 'finish-at', value: timeNow() });
  var brk = make('input', { type: 'number', id: 'finish-break', min: '0', max: '600', step: '5', value: '30' });
  var said = make('textarea', { id: 'finish-note', maxlength: '600',
    placeholder: 'Zone 3 valve replaced, tested all six zones.' },
    entry.job_title ? (entry.description || '') : '');

  box.appendChild(make('div', { class: 'pair', style: 'margin:16px 0 14px' },
    make('div', {}, make('label', { for: 'finish-at', text: 'What time did you finish?' }), finish),
    make('div', {},
      make('label', { for: 'finish-break', text: 'Break, in minutes' }), brk,
      make('div', { style: 'margin-top:9px' },
        breakPicker(function () { return +brk.value || 0; },
          function (m) { brk.value = String(m); })))));

  box.appendChild(make('div', { class: 'field' },
    make('label', { for: 'finish-note', text: 'What did you get done? (can be left empty)' }), said));

  box.appendChild(make('button', {
    class: 'stop',
    onclick: function () {
      after(api('/api/my/entries/' + entry.id + '/clock-out', {
        method: 'POST',
        body: {
          end_time: finish.value,
          break_minutes: +brk.value || 0,
          description: said.value.trim() || (entry.job_title ? null : entry.description)
        }
      }), 'Sent to the office.').then(function () { view.closing = false; paint(); });
    }
  }, 'Send my hours in'));

  box.appendChild(make('button', {
    class: 'line', style: 'width:100%',
    onclick: function () { view.closing = false; paint(); }
  }, 'Go back — still working'));

  return box;
}

function fixStart(entry) {
  var asked = prompt('What time did you actually start? Use 24 hour time, like 07:30', entry.start_time);
  if (asked === null) return;
  asked = asked.trim();

  if (!TIME_LOOKS_RIGHT.test(asked)) { flash('Times go in like 07:30 or 14:05.', 'bad'); return; }

  after(api('/api/my/entries/' + entry.id, { method: 'PATCH', body: { start_time: asked } }),
    'Start time changed to ' + clockOf(asked) + '.');
}

function jobsCard() {
  var body;

  if (!view.jobs.length) {
    body = make('div', { class: 'pad' },
      make('p', { class: 'none', text: 'Nothing on your list for this day.' }));
  } else {
    body = make('ul', { class: 'rows' }, view.jobs.map(function (job) {
      var already = view.entries
        .filter(function (e) { return e.job_id === job.id && e.status !== 'rejected'; })
        .reduce(function (t, e) { return t + e.hours; }, 0);

      return make('li', { style: 'grid-template-columns:4px 1fr' },
        make('div', { class: 'tick ' + (already > 0 ? 'approved' : '') }),
        make('div', {},
          make('h3', { text: job.title }),
          job.location && make('p', { class: 'addr', text: job.location }),
          job.notes && make('p', { class: 'brief', text: job.notes }),
          job.scheduled_hours &&
            make('p', { class: 'span', text: 'Office figured about ' + job.scheduled_hours + ' hours' }),
          already > 0 &&
            make('p', { class: 'span', text: 'You have put down ' + already.toFixed(2) + ' hours on this' }),
          make('button', {
            class: view.running ? '' : 'go',
            disabled: !!view.running,
            onclick: function () { clockOn(job.id, null); }
          }, view.running ? 'Finish what you are on first' : 'Start this job')));
    }));
  }

  var box = card('Your work · ' + briefDay(view.day), [], body);
  var tail = make('div', { class: 'pad', style: 'border-top:1px solid var(--line)' });

  if (!view.offList) {
    tail.appendChild(make('button', {
      disabled: !!view.running,
      onclick: function () { view.offList = true; paint(); }
    }, view.running ? 'Finish what you are on first' : 'Start something that is not on the list'));
  } else {
    var what = make('input', { id: 'off-what', maxlength: '120',
      placeholder: 'Emergency call — broken head at the Weaver place' });
    tail.appendChild(make('div', { class: 'field' },
      make('label', { for: 'off-what', text: 'What are you working on?' }), what));
    tail.appendChild(make('div', { class: 'inarow' },
      make('button', { class: 'go', onclick: function () {
        if (!what.value.trim()) { flash('Say what the job is first.', 'bad'); return; }
        clockOn(null, what.value.trim());
      } }, 'Start it'),
      make('button', { onclick: function () { view.offList = false; paint(); } }, 'Never mind')));
  }

  box.appendChild(tail);
  return box;
}

function clockOn(jobId, describe) {
  view.offList = false;
  after(api('/api/my/clock-in', {
    method: 'POST',
    body: { job_id: jobId, work_date: view.day, start_time: timeNow(), description: describe }
  }), 'Clocked in at ' + clockOf(timeNow()) + '. Hit "I\'m done" when you finish.');
}

function myDayCard() {
  var list = make('ul', { class: 'rows' }, view.entries.map(function (e) {
    return hourRow(e, {
      buttons: [
        e.status !== 'approved' && e.end_time && make('button', {
          class: 'line', style: 'margin:0', onclick: function () { editTimes(e); }
        }, 'Change times'),
        e.status !== 'approved' && make('button', {
          class: 'line', style: 'margin:0',
          onclick: function () {
            if (!confirm('Take these hours off?')) return;
            after(api('/api/my/entries/' + e.id, { method: 'DELETE' }), 'Taken off.');
          }
        }, 'Take it off')
      ]
    });
  }));

  return card('What you put down · ' + briefDay(view.day), [],
    view.entries.length
      ? list
      : make('div', { class: 'pad' }, make('p', { class: 'none', text: 'Nothing down for this day yet.' })),
    strip([
      { value: view.dayTotals.hours.toFixed(2), label: 'Hours this day' },
      { value: String(view.dayTotals.pending), label: 'Waiting on the office' }
    ]));
}

function editTimes(entry) {
  var from = prompt('What time did you start? Like 07:30', entry.start_time);
  if (from === null) return;
  var to = prompt('What time did you finish? Like 16:00', entry.end_time || '');
  if (to === null) return;
  var brk = prompt('How many minutes was your break?', String(entry.break_minutes || 0));
  if (brk === null) return;

  from = from.trim();
  to = to.trim();

  if (!TIME_LOOKS_RIGHT.test(from) || !TIME_LOOKS_RIGHT.test(to)) {
    flash('Times go in like 07:30 or 16:00.', 'bad');
    return;
  }

  after(api('/api/my/entries/' + entry.id, {
    method: 'PATCH',
    body: { start_time: from, end_time: to, break_minutes: +brk || 0 }
  }), 'Times changed and sent back to the office.');
}

function byHandCard() {
  if (!view.byHand) {
    return card('Forgot to hit start?', [], make('div', { class: 'pad' },
      make('p', { class: 'none',
        text: 'Put the hours down by hand instead. You can add as many as you need.' }),
      make('button', { onclick: function () { view.byHand = true; paint(); } },
        'Put hours down by hand')));
  }

  // Their own jobs first, so the common case needs no typing.
  var jobPick = make('select', { id: 'hand-job' },
    view.jobs.map(function (j) { return make('option', { value: String(j.id) }, j.title); }),
    make('option', { value: '' }, 'Something else — I will type it'));

  var otherWhat = make('input', { id: 'hand-other', maxlength: '120',
    placeholder: 'Reset the timer at the Kline house' });
  var otherBox = make('div', { class: 'field' },
    make('label', { for: 'hand-other', text: 'What was the job?' }), otherWhat);

  jobPick.addEventListener('change', function () { otherBox.hidden = !!jobPick.value; });
  otherBox.hidden = !!jobPick.value;

  var from = make('input', { type: 'time', id: 'hand-from', value: '07:30' });
  var to = make('input', { type: 'time', id: 'hand-to', value: '16:00' });
  var brk = make('input', { type: 'number', id: 'hand-break', min: '0', max: '600', step: '5', value: '30' });
  var said = make('textarea', { id: 'hand-note', maxlength: '600', placeholder: 'What you did' });

  return card('Put hours down by hand', [], make('div', { class: 'pad' },
    make('div', { class: 'field' }, make('label', { for: 'hand-job', text: 'Which job?' }), jobPick),
    otherBox,
    make('div', { class: 'pair', style: 'margin-bottom:14px' },
      make('div', {}, make('label', { for: 'hand-from', text: 'Started' }), from),
      make('div', {}, make('label', { for: 'hand-to', text: 'Finished' }), to)),
    make('div', { class: 'field' },
      make('label', { for: 'hand-break', text: 'Break, in minutes' }), brk,
      make('div', { style: 'margin-top:9px' },
        breakPicker(function () { return +brk.value || 0; }, function (m) { brk.value = String(m); }))),
    make('div', { class: 'field' },
      make('label', { for: 'hand-note', text: 'What did you get done?' }), said),
    make('button', {
      class: 'go',
      onclick: function () {
        if (!jobPick.value && !otherWhat.value.trim()) {
          flash('Pick a job or type what you were doing.', 'bad');
          return;
        }
        api('/api/my/entries', {
          method: 'POST',
          body: {
            job_id: jobPick.value ? Number(jobPick.value) : null,
            work_date: view.day,
            start_time: from.value,
            end_time: to.value,
            break_minutes: +brk.value || 0,
            description: jobPick.value ? said.value.trim() : otherWhat.value.trim()
          }
        }).then(function () {
          // Stay open so a second and third job can go straight in.
          view.notice = { message: 'Sent to the office. Add another if you need to.', kind: 'good' };
          said.value = '';
          from.value = to.value;
          to.value = timeNow();
          return load();
        }).catch(function (err) { flash(err.message, 'bad'); });
      }
    }, 'Send these hours in'),
    make('button', {
      class: 'line', style: 'width:100%',
      onclick: function () { view.byHand = false; paint(); }
    }, 'Done adding')));
}

function weekCard() {
  var from = view.week.from, to = view.week.to;
  var rows = view.week.entries;

  var body = rows.length
    ? make('div', { class: 'sideways' }, make('table', {},
        make('thead', {}, make('tr', {},
          make('th', { text: 'Day' }),
          make('th', { text: 'Job' }),
          make('th', { class: 'n', text: 'Hours' }),
          make('th', { text: 'Where it is at' }))),
        make('tbody', {}, rows.map(function (e) {
          return make('tr', {},
            make('td', { text: briefDay(e.work_date) }),
            make('td', { text: e.job_title || e.description || 'Other work' }),
            make('td', { class: 'n', text: e.end_time ? e.hours.toFixed(2) : '—' }),
            make('td', {}, make('span', { class: 'mark-state ' + e.status,
              text: SAYS[e.status] || e.status })));
        }))))
    : make('div', { class: 'pad' }, make('p', { class: 'none', text: 'Nothing down this week.' }));

  return card('Your week · ' + briefDay(from) + ' to ' + briefDay(to), [], body,
    strip([
      { value: view.week.totals.hours.toFixed(2), label: 'Hours this week' },
      { value: view.week.totals.approved_hours.toFixed(2), label: "OK'd so far" },
      { value: CASH.format(view.week.totals.pay), label: 'Roughly' }
    ]));
}

function pinCard() {
  if (!view.pin) {
    return card('Your sign-in', [], make('div', { class: 'pad' },
      make('p', { class: 'none', text: 'Change the number you use to sign in.' }),
      make('button', { onclick: function () { view.pin = true; paint(); } }, 'Change my number')));
  }

  var oldOne = make('input', { id: 'pin-old', type: 'password', inputmode: 'numeric', maxlength: '10' });
  var newOne = make('input', { id: 'pin-new', type: 'password', inputmode: 'numeric', maxlength: '10' });

  return card('Your sign-in', [], make('div', { class: 'pad' },
    make('div', { class: 'field' },
      make('label', { for: 'pin-old', text: 'The number you use now' }), oldOne),
    make('div', { class: 'field' },
      make('label', { for: 'pin-new', text: 'New number (4 to 10 digits)' }), newOne),
    make('button', {
      class: 'go',
      onclick: function () {
        api('/api/me/pin', {
          method: 'POST',
          body: { current_pin: oldOne.value, new_pin: newOne.value }
        }).then(function () {
          view.pin = false;
          flash('Your number is changed. Other phones have been signed out.', 'good');
        }).catch(function (err) { flash(err.message, 'bad'); });
      }
    }, 'Save the new number'),
    make('button', {
      class: 'line', style: 'width:100%',
      onclick: function () { view.pin = false; paint(); }
    }, 'Never mind')));
}

/* ------------------------------- start ----------------------------- */

document.getElementById('signout').appendChild(signOutButton());

// Keep the ticker honest without redrawing under the user's thumb.
setInterval(function () {
  var line = document.getElementById('ticker');
  if (view.running && line) {
    line.textContent = inWords(gap(view.running.start_time, timeNow()));
  }
}, 30000);

api('/api/me').then(function (r) {
  view.me = r.user;
  document.getElementById('me').textContent = r.user.name;
  return load();
}).catch(function (err) {
  document.getElementById('sheet').textContent = err.message;
});
