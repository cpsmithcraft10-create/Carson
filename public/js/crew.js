'use strict';

/* The crew screen. Jobs first — that is what somebody opens this for on the
   way out of the yard. Hours and the rest sit behind their own tabs. */

var TABS = ['jobs', 'hours', 'notices', 'me'];

var view = {
  me: null,
  tab: 'jobs',
  openJob: null,      // a job id: the jobs tab shows that one job in full
  day: today(),
  jobs: [],
  shifts: [],
  running: null,
  totals: null,
  week: null,
  notices: [],
  unread: 0,
  closing: false,
  byHand: false,
  offList: false,
  wrapping: false,
  fixing: false,
  flash: null,
};

/* ----------------------------- loading ---------------------------- */

function load() {
  var weekFrom = mondayOf(view.day);

  return Promise.all([
    api('/api/crew/day?date=' + view.day),
    api('/api/crew/week?from=' + weekFrom + '&to=' + shiftDate(weekFrom, 6)),
    api('/api/crew/notices'),
  ]).then(function (all) {
    view.jobs = all[0].jobs;
    view.shifts = all[0].shifts;
    view.running = all[0].running;
    view.totals = all[0].totals;
    view.week = all[1];
    view.notices = all[2].notices;
    view.unread = all[2].unread;

    // A job that came off the list while it was open should not strand them.
    if (view.openJob && !jobById(view.openJob)) view.openJob = null;

    paint();
  }).catch(function (err) {
    say(err.message, 'bad');
  });
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

function jobById(id) {
  for (var i = 0; i < view.jobs.length; i++) if (view.jobs[i].id === id) return view.jobs[i];
  return null;
}

function goTab(tab) {
  view.tab = tab;
  view.openJob = null;
  view.flash = null;
  view.closing = false;
  view.fixing = false;
  view.byHand = false;
  view.offList = false;
  view.wrapping = false;
  paint();
}

function openJob(id) {
  view.openJob = id;
  view.flash = null;
  view.wrapping = false;
  paint();
  window.scrollTo(0, 0);
}

/* ----------------------------- painting --------------------------- */

var SCREENS = { jobs: 'My day', hours: 'My hours', notices: 'From the office', me: 'Me' };

function paint() {
  TABS.forEach(function (t) {
    document.getElementById('tab-' + t).setAttribute('aria-selected', String(t === view.tab));
  });

  document.getElementById('screen').textContent = SCREENS[view.tab] || 'My day';

  var pip = document.getElementById('unread-pip');
  pip.className = view.unread ? 'pipdot' : '';
  pip.textContent = view.unread ? String(view.unread) : '';

  var sheet = emptyOut(document.getElementById('sheet'));

  // The open job carries its own day, so the arrows only clutter it there.
  var wantsDayBar = (view.tab === 'jobs' && !view.openJob) || view.tab === 'hours';
  if (wantsDayBar) sheet.appendChild(dayBar());

  if (view.flash) {
    sheet.appendChild(make('div', { class: 'flash ' + view.flash.kind, text: view.flash.message }));
  }

  if (view.tab === 'jobs') {
    if (view.openJob) paintOneJob(sheet, jobById(view.openJob));
    else paintJobList(sheet);
  } else if (view.tab === 'hours') {
    paintHours(sheet);
  } else if (view.tab === 'notices') {
    paintNotices(sheet);
  } else {
    paintMe(sheet);
  }
}

function dayBar() {
  return make('div', { class: 'daybar' },
    make('button', { class: 'slim', 'aria-label': 'Day before',
      onclick: function () { goDay(shiftDate(view.day, -1)); } }, '‹'),
    make('h1', {}, longDate(view.day),
      view.day !== today() && make('em', { text: 'not today — tap the arrow to come back' })),
    make('button', { class: 'slim', 'aria-label': 'Day after',
      onclick: function () { goDay(shiftDate(view.day, 1)); } }, '›'));
}

function goDay(d) {
  view.day = d;
  view.openJob = null;
  view.flash = null;
  view.closing = false;
  view.fixing = false;
  view.byHand = false;
  view.offList = false;
  view.wrapping = false;
  load();
}

/* ------------------------- the list of jobs ----------------------- */

function paintJobList(sheet) {
  if (view.unread > 0) sheet.appendChild(unreadBanner());
  if (view.running) sheet.appendChild(onClockCard(view.running, { compact: true }));

  var body = view.jobs.length
    ? make('ul', { class: 'picklist' }, view.jobs.map(jobRow))
    : make('div', { class: 'pad' },
        make('p', { class: 'none', text: 'Nothing on your list for this day.' }));

  var card = panel('Your jobs · ' + shortDate(view.day),
    view.jobs.length ? [make('span', { class: 'pip', text: String(view.jobs.length) })] : [],
    body);

  card.appendChild(offListBit());
  sheet.appendChild(card);
}

function jobRow(job) {
  return make('li', {}, make('button', {
    class: 'jobpick',
    onclick: function () { openJob(job.id); },
  },
    make('span', { class: 'bar ' + job.status, style: 'align-self:stretch' }),
    make('span', {},
      make('span', { class: 'jobline' }, kindChip(job.kind)),
      make('h3', { text: job.customer }),
      job.address && make('span', { class: 'jobmeta', style: 'display:block', text: job.address }),
      make('span', { class: 'progress ' + job.status, style: 'margin-top:6px',
        text: JOB_WORDS[job.status] })),
    make('span', { class: 'chev', 'aria-hidden': 'true' }, '\u203a')));
}

function offListBit() {
  var tail = make('div', { class: 'pad', style: 'border-top:1px solid var(--line)' });

  if (!view.offList) {
    tail.appendChild(make('button', {
      disabled: !!view.running,
      onclick: function () { view.offList = true; paint(); },
    }, view.running ? 'Finish what you are on first' : 'Start something not on the list'));
    return tail;
  }

  var what = make('input', { id: 'off-what', maxlength: '160',
    placeholder: 'Callback — broken head at the Weaver place' });

  tail.appendChild(make('div', { class: 'field' },
    make('label', { for: 'off-what', text: 'What are you working on?' }), what));
  tail.appendChild(make('div', { class: 'inline' },
    make('button', { class: 'go', onclick: function () {
      if (!what.value.trim()) { say('Say what the job is first.', 'bad'); return; }
      clockOn(null, what.value.trim());
    } }, 'Start it'),
    make('button', { onclick: function () { view.offList = false; paint(); } }, 'Never mind')));

  return tail;
}

/* --------------------------- one job, in full --------------------- */

function paintOneJob(sheet, job) {
  if (!job) { view.openJob = null; paintJobList(sheet); return; }

  var mates = job.crew.filter(function (c) { return c.id !== view.me.id; });
  var mine = view.shifts.filter(function (s) {
    return s.job_id === job.id && s.status !== 'question';
  });
  var myHours = mine.reduce(function (t, s) { return t + s.hours; }, 0);
  var runningHere = view.running && view.running.job_id === job.id;

  sheet.appendChild(make('div', { class: 'backrow' },
    make('button', { onclick: function () { view.openJob = null; view.flash = null; paint(); } },
      '\u2039 Back to jobs')));

  if (runningHere) sheet.appendChild(onClockCard(view.running, {}));

  // Everything that is not the job itself goes in one quiet list underneath.
  var facts = [];

  if (job.est_hours > 0) {
    facts.push(['Should take', 'About ' + job.est_hours + ' hours']);
  }
  if (mates.length > 0) {
    facts.push(['With you', mates.map(function (c) { return c.name; }).join(', ')]);
  }
  if (myHours > 0) {
    facts.push(['Your hours on it', myHours.toFixed(2) + ' so far']);
  }
  if (job.job_date !== today()) {
    facts.push(['Day', longDate(job.job_date)]);
  }
  if (job.status === 'done') {
    if (job.wrap_notes) facts.push(['Wrapped up', job.wrap_notes]);
    if (job.materials) facts.push(['Parts used', job.materials]);
    if (job.finished_by_name) facts.push(['Finished by', job.finished_by_name]);
  }

  sheet.appendChild(panel('The job', [], make('div', { class: 'pad' },
    make('div', { class: 'jobline' },
      kindChip(job.kind),
      make('span', { class: 'progress ' + job.status, text: JOB_WORDS[job.status] })),
    make('h3', { style: 'font-size:var(--t-title);margin:10px 0 2px', text: job.customer }),
    job.address && make('p', { class: 'jobmeta', text: job.address }),
    make('p', { class: 'needdoing', style: 'margin-top:14px',
      text: job.details || 'The office did not leave any notes on this one.' }),
    siteActions(job.address, job.phone),
    facts.length > 0 && make('ul', { class: 'facts', style: 'margin-top:16px' },
      facts.map(function (row) {
        return make('li', {},
          make('span', { class: 'tag', text: row[0] }),
          make('span', { text: row[1] }));
      })))));

  sheet.appendChild(jobActions(job, runningHere));

  if (mine.length > 0) {
    sheet.appendChild(panel('Hours you put on this job', [],
      make('ul', { class: 'rows' }, mine.map(function (s) { return hourRow(s, {}); }))));
  }
}

function jobActions(job, runningHere) {
  var body = make('div', { class: 'pad' });

  if (view.wrapping) {
    body.appendChild(wrapUpForm(job));
    return panel('Finish this job', [], body);
  }

  if (job.status === 'done') {
    body.appendChild(make('p', { class: 'none',
      text: 'This one is marked finished. If that was wrong, put it back on the list.' }));
    body.appendChild(make('button', {
      onclick: function () {
        then(api('/api/crew/jobs/' + job.id + '/reopen', { method: 'POST' }), 'Put back on the list.');
      },
    }, 'Not finished after all'));
    return panel('What now?', [], body);
  }

  if (runningHere) {
    body.appendChild(make('p', { class: 'none',
      text: 'You are on the clock here. Use the panel above when you are done.' }));
  } else {
    body.appendChild(make('button', {
      class: view.running ? '' : 'go',
      disabled: !!view.running,
      onclick: function () { clockOn(job.id, null); },
    }, view.running ? 'Finish what you are on first' : 'Start this job'));
  }

  body.appendChild(make('button', {
    class: 'slim', style: 'width:100%',
    onclick: function () { view.wrapping = true; paint(); },
  }, 'Mark this job finished'));

  return panel('What now?', [], body);
}

function wrapUpForm(job) {
  var how = make('textarea', { id: 'wrap-how', maxlength: '900',
    placeholder: 'New valve in zone 3, all six zones tested and running.' }, job.wrap_notes || '');
  var parts = make('textarea', { id: 'wrap-parts', maxlength: '900',
    placeholder: '1 in valve, 3 spray heads, 20ft of poly' }, job.materials || '');

  return make('div', {},
    make('div', { class: 'field' },
      make('label', { for: 'wrap-how', text: 'How did it go?' }), how),
    make('div', { class: 'field' },
      make('label', { for: 'wrap-parts', text: 'Parts used (so the office can bill it)' }), parts),
    make('button', {
      class: 'go',
      onclick: function () {
        view.wrapping = false;
        then(api('/api/crew/jobs/' + job.id + '/finish', {
          method: 'POST',
          body: { wrap_notes: how.value.trim(), materials: parts.value.trim() },
        }), 'Marked finished. The office can see it.');
      },
    }, 'Mark it finished'),
    make('button', {
      class: 'slim', style: 'width:100%',
      onclick: function () { view.wrapping = false; paint(); },
    }, 'Never mind'));
}

/* --------------------------- on the clock ------------------------- */

function onClockCard(shift, opts) {
  opts = opts || {};

  var box = make('div', { class: 'onclock' },
    make('span', { class: 'flag' }, make('span', { class: 'dot' }), 'On the clock'),
    make('h3', { text: shift.what }),
    shift.job_address && make('p', { class: 'jobmeta', text: shift.job_address }),
    make('p', { class: 'ticker elapsed', id: 'elapsed',
      text: inWords(gap(shift.start_time, timeNow())) }),
    make('p', { class: 'startedat', text: 'Started at ' + clockTime(shift.start_time) }));

  if (!view.closing) {
    box.appendChild(make('button', {
      class: 'stop', onclick: function () { view.closing = true; paint(); },
    }, "I'm done"));

    // Only one button at rest. The fiddly bits hide behind a quiet line.
    var tuck = make('div', { class: 'tuck' });

    if (!view.fixing) {
      tuck.appendChild(make('button', {
        class: 'more', onclick: function () { view.fixing = true; paint(); },
      }, 'Something not right?'));
    } else {
      if (opts.compact && shift.job_id) {
        tuck.appendChild(make('button', {
          class: 'slim', style: 'width:100%',
          onclick: function () { openJob(shift.job_id); },
        }, 'See what this job needs'));
      }
      tuck.appendChild(make('button', {
        class: 'slim', style: 'width:100%',
        onclick: function () { fixStart(shift); },
      }, 'I started earlier than it says'));
      tuck.appendChild(make('button', {
        class: 'slim', style: 'width:100%',
        onclick: function () {
          if (!confirm('Throw this away? No hours get counted.')) return;
          then(api('/api/crew/shifts/' + shift.id, { method: 'DELETE' }),
            'Thrown away. Nothing was counted.');
        },
      }, 'I started the wrong job'));
      tuck.appendChild(make('button', {
        class: 'more', onclick: function () { view.fixing = false; paint(); },
      }, 'Never mind'));
    }

    box.appendChild(tuck);
    return box;
  }

  var finish = make('input', { type: 'time', id: 'finish-at', value: timeNow() });
  var brk = make('input', { type: 'number', id: 'finish-break', min: '0', max: '600', step: '5', value: '30' });
  var said = make('textarea', { id: 'finish-note', maxlength: '600',
    placeholder: 'New valve in zone 3, tested all six zones.' }, shift.notes || '');

  box.appendChild(make('div', { class: 'two', style: 'margin:16px 0 13px' },
    make('div', {}, make('label', { for: 'finish-at', text: 'What time did you finish?' }), finish),
    make('div', {},
      make('label', { for: 'finish-break', text: 'Break, in minutes' }), brk,
      make('div', { style: 'margin-top:9px' },
        breakPicks(function () { return +brk.value || 0; },
          function (m) { brk.value = String(m); })))));

  box.appendChild(make('div', { class: 'field' },
    make('label', { for: 'finish-note', text: 'What did you get done? (can be left empty)' }), said));

  box.appendChild(make('button', {
    class: 'stop',
    onclick: function () {
      then(api('/api/crew/shifts/' + shift.id + '/clock-out', {
        method: 'POST',
        body: {
          end_time: finish.value,
          break_minutes: +brk.value || 0,
          notes: said.value.trim(),
        },
      }), 'Sent to the office.').then(function () { view.closing = false; paint(); });
    },
  }, 'Send my hours in'));

  box.appendChild(make('button', {
    class: 'slim', style: 'width:100%',
    onclick: function () { view.closing = false; paint(); },
  }, 'Go back — still working'));

  return box;
}

function fixStart(shift) {
  var asked = prompt('What time did you actually start? Use 24 hour time, like 07:30', shift.start_time);
  if (asked === null) return;
  asked = asked.trim();

  if (!TIME_SHAPE.test(asked)) { say('Times go in like 07:30 or 14:05.', 'bad'); return; }

  then(api('/api/crew/shifts/' + shift.id, { method: 'PATCH', body: { start_time: asked } }),
    'Start time changed to ' + clockTime(asked) + '.');
}

function clockOn(jobId, describe) {
  view.offList = false;
  then(api('/api/crew/clock-in', {
    method: 'POST',
    body: { job_id: jobId, work_date: view.day, start_time: timeNow(), other_work: describe },
  }), 'Clocked in at ' + clockTime(timeNow()) + '. Hit "I\'m done" when you finish.');
}

/* ------------------------------ my hours -------------------------- */

function paintHours(sheet) {
  if (view.running) sheet.appendChild(onClockCard(view.running, { compact: true }));

  var list = make('ul', { class: 'rows' }, view.shifts.map(function (s) {
    return hourRow(s, {
      buttons: [
        s.status !== 'ok' && s.end_time && make('button', {
          class: 'slim', style: 'margin:0', onclick: function () { changeTimes(s); },
        }, 'Change times'),
        s.status !== 'ok' && make('button', {
          class: 'slim', style: 'margin:0',
          onclick: function () {
            if (!confirm('Take these hours off?')) return;
            then(api('/api/crew/shifts/' + s.id, { method: 'DELETE' }), 'Taken off.');
          },
        }, 'Take it off'),
      ],
    });
  }));

  sheet.appendChild(panel('What you put down · ' + shortDate(view.day), [],
    view.shifts.length
      ? list
      : make('div', { class: 'pad' }, make('p', { class: 'none', text: 'Nothing down for this day yet.' })),
    figures([
      { value: view.totals.hours.toFixed(2), label: 'Hours this day' },
      { value: String(view.totals.waiting), label: 'Waiting on the office' },
    ])));

  sheet.appendChild(byHandCard());
  sheet.appendChild(weekCard());
}

function changeTimes(shift) {
  var from = prompt('What time did you start? Like 07:30', shift.start_time);
  if (from === null) return;
  var to = prompt('What time did you finish? Like 16:00', shift.end_time || '');
  if (to === null) return;
  var brk = prompt('How many minutes was your break?', String(shift.break_minutes || 0));
  if (brk === null) return;

  from = from.trim();
  to = to.trim();

  if (!TIME_SHAPE.test(from) || !TIME_SHAPE.test(to)) {
    say('Times go in like 07:30 or 16:00.', 'bad');
    return;
  }

  then(api('/api/crew/shifts/' + shift.id, {
    method: 'PATCH',
    body: { start_time: from, end_time: to, break_minutes: +brk || 0 },
  }), 'Times changed and sent back to the office.');
}

function byHandCard() {
  if (!view.byHand) {
    return panel('Forgot to hit start?', [], make('div', { class: 'pad' },
      make('p', { class: 'none',
        text: 'Put the hours down by hand instead. You can add as many as you need.' }),
      make('button', { onclick: function () { view.byHand = true; paint(); } },
        'Put hours down by hand')));
  }

  // Their own jobs first, so the usual case needs no typing.
  var jobPick = make('select', { id: 'hand-job' },
    view.jobs.map(function (j) { return make('option', { value: String(j.id) }, j.customer); }),
    make('option', { value: '' }, 'Something else — I will type it'));

  var otherWhat = make('input', { id: 'hand-other', maxlength: '160',
    placeholder: 'Reset the timer at the Kline house' });
  var otherBox = make('div', { class: 'field' },
    make('label', { for: 'hand-other', text: 'What was the job?' }), otherWhat);

  jobPick.addEventListener('change', function () { otherBox.hidden = !!jobPick.value; });
  otherBox.hidden = !!jobPick.value;

  var from = make('input', { type: 'time', id: 'hand-from', value: '07:30' });
  var to = make('input', { type: 'time', id: 'hand-to', value: '16:00' });
  var brk = make('input', { type: 'number', id: 'hand-break', min: '0', max: '600', step: '5', value: '30' });
  var said = make('textarea', { id: 'hand-note', maxlength: '900', placeholder: 'What you got done' });

  return panel('Put hours down by hand', [], make('div', { class: 'pad' },
    make('div', { class: 'field' }, make('label', { for: 'hand-job', text: 'Which job?' }), jobPick),
    otherBox,
    make('div', { class: 'two', style: 'margin-bottom:13px' },
      make('div', {}, make('label', { for: 'hand-from', text: 'Started' }), from),
      make('div', {}, make('label', { for: 'hand-to', text: 'Finished' }), to)),
    make('div', { class: 'field' },
      make('label', { for: 'hand-break', text: 'Break, in minutes' }), brk,
      make('div', { style: 'margin-top:9px' },
        breakPicks(function () { return +brk.value || 0; }, function (m) { brk.value = String(m); }))),
    make('div', { class: 'field' },
      make('label', { for: 'hand-note', text: 'What did you get done?' }), said),
    make('button', {
      class: 'go',
      onclick: function () {
        if (!jobPick.value && !otherWhat.value.trim()) {
          say('Pick a job or type what you were doing.', 'bad');
          return;
        }
        api('/api/crew/shifts', {
          method: 'POST',
          body: {
            job_id: jobPick.value ? Number(jobPick.value) : null,
            other_work: jobPick.value ? null : otherWhat.value.trim(),
            work_date: view.day,
            start_time: from.value,
            end_time: to.value,
            break_minutes: +brk.value || 0,
            notes: said.value.trim(),
          },
        }).then(function () {
          // Stay open, so three houses in a row go in without reopening it.
          view.flash = { message: 'Sent to the office. Add another if you need to.', kind: 'good' };
          said.value = '';
          from.value = to.value;
          to.value = timeNow();
          return load();
        }).catch(function (err) { say(err.message, 'bad'); });
      },
    }, 'Send these hours in'),
    make('button', {
      class: 'slim', style: 'width:100%',
      onclick: function () { view.byHand = false; paint(); },
    }, 'Done adding')));
}

function weekCard() {
  var w = view.week;

  var body = w.shifts.length
    ? make('div', { class: 'scroller' }, make('table', {},
        make('thead', {}, make('tr', {},
          make('th', { text: 'Day' }),
          make('th', { text: 'Job' }),
          make('th', { class: 'r', text: 'Hours' }))),
        make('tbody', {}, w.shifts.map(function (s) {
          return make('tr', {},
            make('td', { text: shortDate(s.work_date) }),
            make('td', { text: s.what }),
            make('td', { class: 'r', text: s.end_time ? s.hours.toFixed(2) : '—' }));
        }))))
    : make('div', { class: 'pad' }, make('p', { class: 'none', text: 'Nothing down this week.' }));

  return panel('Your week · ' + shortDate(w.from) + ' to ' + shortDate(w.to), [], body,
    figures([
      { value: w.totals.hours.toFixed(2), label: 'Hours this week' },
      { value: w.totals.ok_hours.toFixed(2), label: "OK'd so far" },
      { value: CASH.format(w.totals.pay), label: 'Roughly' },
    ]));
}

/* ----------------------------- notices ---------------------------- */

function unreadBanner() {
  return make('div', { class: 'card', style: 'border-color:var(--brass);border-width:2px' },
    make('div', { class: 'pad' },
      make('h3', { text: view.unread === 1
        ? 'There is a new announcement from the office'
        : 'There are ' + view.unread + ' new announcements from the office' }),
      make('p', { class: 'dim', text: 'Have a read before you head out.' }),
      make('button', { onclick: function () { goTab('notices'); } }, 'Read them')));
}

function paintNotices(sheet) {
  var body = view.notices.length
    ? make('div', { class: 'pad' }, view.notices.map(function (n) {
        return make('div', {
          class: 'notice-card' + (n.urgent ? ' urgent' : '') + (!n.seen ? ' unread' : ''),
        },
          make('h4', {}, n.title, !!n.urgent && make('span', { class: 'urgent-tag', text: 'Important' })),
          make('p', { text: n.body }),
          make('div', { class: 'when',
            text: (n.posted_by_name || 'The office') + ' · ' + agoWords(n.posted_at) }),
          !n.seen && make('button', {
            class: 'slim', style: 'margin-top:10px',
            onclick: function () {
              then(api('/api/crew/notices/' + n.id + '/seen', { method: 'POST' }), null);
            },
          }, 'Got it'));
      }))
    : make('div', { class: 'pad' },
        make('p', { class: 'none', text: 'Nothing from the office right now.' }));

  sheet.appendChild(panel('From the office',
    view.unread ? [make('span', { class: 'pip', text: String(view.unread) + ' new' })] : [],
    body));
}

/* ---------------------------- my sign-in -------------------------- */

function paintMe(sheet) {
  var oldOne = make('input', { id: 'pin-old', type: 'password', inputmode: 'numeric', maxlength: '10' });
  var newOne = make('input', { id: 'pin-new', type: 'password', inputmode: 'numeric', maxlength: '10' });

  sheet.appendChild(panel('Change the number you sign in with', [], make('div', { class: 'pad' },
    make('div', { class: 'field' },
      make('label', { for: 'pin-old', text: 'The number you use now' }), oldOne),
    make('div', { class: 'field' },
      make('label', { for: 'pin-new', text: 'New number (4 to 10 digits)' }), newOne),
    make('button', {
      class: 'go',
      onclick: function () {
        api('/api/me/pin', {
          method: 'POST',
          body: { current_pin: oldOne.value, new_pin: newOne.value },
        }).then(function () {
          oldOne.value = '';
          newOne.value = '';
          say('Your number is changed. Other phones have been signed out.', 'good');
        }).catch(function (err) { say(err.message, 'bad'); });
      },
    }, 'Save the new number'))));

  sheet.appendChild(panel('Signed in as', [], make('div', { class: 'pad' },
    make('h3', { text: view.me.name }),
    make('p', { class: 'none', text: 'You type "' + view.me.username + '" to sign in.' }),
    make('button', {
      style: 'margin-top:16px',
      onclick: function () {
        api('/api/signout', { method: 'POST' })
          .catch(function () { /* leaving anyway */ })
          .then(function () { location.href = '/'; });
      },
    }, 'Sign out'))));
}

/* ------------------------------- start ---------------------------- */

document.getElementById('badge').append(
  make('b', { text: 'Custom Outdoor Design' }),
  make('i', { text: 'Sprinkler · Lighting · Drainage' }));

TABS.forEach(function (t) {
  document.getElementById('tab-' + t).addEventListener('click', function () { goTab(t); });
});

// Keep the elapsed line honest without redrawing under somebody's thumb.
setInterval(function () {
  var line = document.getElementById('elapsed');
  if (view.running && line) {
    line.textContent = inWords(gap(view.running.start_time, timeNow()));
  }
}, 30000);

api('/api/me').then(function (r) {
  if (r.user.role === 'office') { location.replace('/office.html'); return; }
  view.me = r.user;
  document.getElementById('me').append(
    make('span', { class: 'avatar', text: initialsOf(r.user.name) }),
    make('span', { style: 'min-width:0' }, make('b', { text: r.user.name })));
  return load();
}).catch(function (err) {
  document.getElementById('sheet').textContent = err.message;
});
