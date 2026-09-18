'use strict';

const msg = document.getElementById('msg');

const state = {
  date: todayLocal(),
  jobsFrom: todayLocal(),
  jobsTo: addDays(todayLocal(), 6),
  reportFrom: startOfWeek(todayLocal()),
  reportTo: addDays(startOfWeek(todayLocal()), 6),
  workers: [],
};

/* ------------------------------------------------------------------ tabs */

const TABS = {
  today: loadToday,
  approve: loadPending,
  jobs: loadJobs,
  crew: loadCrew,
  report: loadReport,
};

function showTab(name) {
  for (const tab of Object.keys(TABS)) {
    document.getElementById(`tab-${tab}`).setAttribute('aria-selected', String(tab === name));
    document.getElementById(`panel-${tab}`).hidden = tab !== name;
  }
  TABS[name]().catch((err) => say(msg, err.message));
}

for (const tab of Object.keys(TABS)) {
  document.getElementById(`tab-${tab}`).addEventListener('click', () => showTab(tab));
}

document.getElementById('signout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
});

/* -------------------------------------------------------------- rendering */

function entryCard(entry, { actions = true } = {}) {
  const times = `${formatTime(entry.start_time)} - ${entry.end_time ? formatTime(entry.end_time) : 'running'}`;

  const item = el('li', {},
    el('div', { class: 'entry-head' },
      el('div', { class: 'grow' },
        el('strong', { text: entry.worker_name }),
        el('div', { class: 'tiny', text: entry.job_title || 'General work' }),
        el('div', { class: 'muted tiny', text: `${formatDate(entry.work_date)} · ${times}` +
          (entry.break_minutes ? ` · ${entry.break_minutes} min break` : '') }),
      ),
      el('div', { style: 'text-align:right' },
        el('div', { class: 'entry-hours', text: entry.end_time ? hoursLabel(entry.hours) : '--' }),
        entry.hourly_rate > 0 && el('div', { class: 'muted tiny', text: money(entry.pay) }),
      ),
    ),
    el('div', { class: 'row', style: 'margin-top:6px' }, statusPill(entry.status)),
    entry.description && el('p', { class: 'tiny', style: 'margin:6px 0 0', text: entry.description }),
    entry.review_note && el('p', { class: 'muted tiny', style: 'margin:6px 0 0', text: `Your note: ${entry.review_note}` }),
  );

  if (!actions || entry.status === 'open') return item;

  const buttons = el('div', { class: 'row', style: 'margin-top:8px' });

  if (entry.status !== 'approved') {
    buttons.append(el('button', {
      class: 'primary small', type: 'button', onclick: () => reviewEntry(entry.id, 'approve'),
    }, 'Approve'));
  }
  if (entry.status !== 'rejected') {
    buttons.append(el('button', {
      class: 'small', type: 'button', onclick: () => reviewEntry(entry.id, 'reject'),
    }, 'Send back'));
  }
  if (entry.status === 'approved') {
    buttons.append(el('button', {
      class: 'small', type: 'button', onclick: () => reviewEntry(entry.id, 'reopen'),
    }, 'Reopen'));
  }

  buttons.append(el('button', { class: 'small', type: 'button', onclick: () => editEntry(entry) }, 'Edit'));
  buttons.append(el('button', { class: 'small danger', type: 'button', onclick: () => deleteEntry(entry) }, 'Delete'));

  item.append(buttons);
  return item;
}

function renderEntries(host, entries, options) {
  clear(host);
  if (entries.length === 0) {
    host.append(el('p', { class: 'empty', text: 'Nothing here.' }));
    return;
  }
  const list = el('ul', { class: 'list' });
  for (const entry of entries) list.append(entryCard(entry, options));
  host.append(list);
}

async function reviewEntry(id, action) {
  let note = null;
  if (action === 'reject') {
    note = prompt('Tell them what needs fixing:', '');
    if (note === null) return;
  }

  try {
    await api(`/api/admin/entries/${id}/${action}`, { method: 'POST', body: { note } });
    say(msg, action === 'approve' ? 'Approved.' : 'Updated.', 'ok');
    await refreshVisible();
  } catch (err) {
    say(msg, err.message);
  }
}

async function editEntry(entry) {
  const start = prompt('Start time (HH:MM)', entry.start_time);
  if (start === null) return;
  const end = prompt('Finish time (HH:MM)', entry.end_time || '');
  if (end === null) return;
  const breakMinutes = prompt('Unpaid break in minutes', String(entry.break_minutes));
  if (breakMinutes === null) return;

  try {
    await api(`/api/admin/entries/${entry.id}`, {
      method: 'PATCH',
      body: { start_time: start.trim(), end_time: end.trim(), break_minutes: Number(breakMinutes) || 0 },
    });
    say(msg, 'Entry updated.', 'ok');
    await refreshVisible();
  } catch (err) {
    say(msg, err.message);
  }
}

async function deleteEntry(entry) {
  if (!confirm(`Delete ${entry.worker_name}'s hours for ${entry.work_date}?`)) return;
  try {
    await api(`/api/admin/entries/${entry.id}`, { method: 'DELETE' });
    say(msg, 'Deleted.', 'ok');
    await refreshVisible();
  } catch (err) {
    say(msg, err.message);
  }
}

function refreshVisible() {
  const open = Object.keys(TABS).find((tab) => !document.getElementById(`panel-${tab}`).hidden);
  return Promise.all([TABS[open](), loadPendingCount()]);
}

/* ----------------------------------------------------------------- today */

async function loadToday() {
  const data = await api(`/api/admin/overview?date=${state.date}`);

  fill(document.getElementById('day-totals'),
    el('div', { class: 'stat' }, el('b', { text: hoursLabel(data.totals.hours) }), el('span', { text: 'Hours today' })),
    el('div', { class: 'stat' }, el('b', { text: String(data.running) }), el('span', { text: 'On the clock' })),
    el('div', { class: 'stat' }, el('b', { text: String(data.pending_all_time) }), el('span', { text: 'To approve' })),
    el('div', { class: 'stat' }, el('b', { text: money(data.totals.pay) }), el('span', { text: 'Labour cost' })),
  );

  const jobsHost = clear(document.getElementById('day-jobs'));
  if (data.jobs.length === 0) {
    jobsHost.append(el('p', { class: 'empty', text: 'No work given out for this day yet.' }));
  } else {
    const list = el('ul', { class: 'list' });
    for (const job of data.jobs) {
      list.append(el('li', {},
        el('div', { class: 'row between' },
          el('div', { class: 'grow' },
            el('strong', { text: job.title }),
            el('div', { class: 'muted tiny', text: job.worker_name + (job.location ? ` · ${job.location}` : '') }),
            job.notes && el('div', { class: 'tiny', text: job.notes }),
          ),
          el('span', { class: `pill ${job.entry_count ? 'approved' : 'submitted'}`,
            text: job.entry_count ? 'Logged' : 'Not logged' }),
        ),
      ));
    }
    jobsHost.append(list);
  }

  renderEntries(document.getElementById('day-entries'), data.entries);
}

/* ---------------------------------------------------------- approvals */

async function loadPending() {
  const data = await api('/api/admin/pending');
  renderEntries(document.getElementById('pending'), data.entries);
}

async function loadPendingCount() {
  const { entries } = await api('/api/admin/pending');
  const badge = document.getElementById('pending-count');
  badge.textContent = entries.length ? `(${entries.length})` : '';
}

/* ---------------------------------------------------------------- jobs */

async function loadJobs() {
  await ensureWorkers();

  const picker = clear(document.getElementById('j-workers'));
  for (const worker of state.workers.filter((w) => w.active)) {
    const id = `pick-${worker.id}`;
    picker.append(el('label', { for: id, style: 'display:flex;gap:8px;align-items:center;font-weight:500' },
      el('input', { type: 'checkbox', id, value: String(worker.id), style: 'width:auto;min-height:auto' }),
      worker.name,
    ));
  }

  const data = await api(`/api/admin/jobs?from=${state.jobsFrom}&to=${state.jobsTo}`);
  const host = clear(document.getElementById('job-list'));

  if (data.jobs.length === 0) {
    host.append(el('p', { class: 'empty', text: 'No work assigned in these days.' }));
    return;
  }

  const list = el('ul', { class: 'list' });
  for (const job of data.jobs) {
    list.append(el('li', {},
      el('div', { class: 'row between' },
        el('div', { class: 'grow' },
          el('strong', { text: job.title }),
          el('div', { class: 'muted tiny',
            text: `${formatDate(job.work_date)} · ${job.worker_name}${job.location ? ` · ${job.location}` : ''}` }),
          job.notes && el('div', { class: 'tiny', text: job.notes }),
        ),
        el('button', { class: 'small danger', type: 'button', onclick: () => deleteJob(job) }, 'Remove'),
      ),
    ));
  }
  host.append(list);
}

async function deleteJob(job) {
  const warning = job.entry_count
    ? 'Hours have already been logged against this job. They will be kept but lose the job name. Remove it?'
    : `Remove "${job.title}" from ${job.worker_name}?`;
  if (!confirm(warning)) return;

  try {
    await api(`/api/admin/jobs/${job.id}`, { method: 'DELETE' });
    say(msg, 'Job removed.', 'ok');
    await loadJobs();
  } catch (err) {
    say(msg, err.message);
  }
}

document.getElementById('job-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const workerIds = [...document.querySelectorAll('#j-workers input:checked')].map((i) => Number(i.value));
  if (workerIds.length === 0) {
    say(msg, 'Pick at least one worker for this job.');
    return;
  }

  try {
    const hours = document.getElementById('j-hours').value;
    await api('/api/admin/jobs', {
      method: 'POST',
      body: {
        title: document.getElementById('j-title').value,
        work_date: document.getElementById('j-date').value,
        location: document.getElementById('j-location').value,
        notes: document.getElementById('j-notes').value,
        scheduled_hours: hours === '' ? null : Number(hours),
        worker_ids: workerIds,
      },
    });

    document.getElementById('j-title').value = '';
    document.getElementById('j-notes').value = '';
    say(msg, `Job sent to ${workerIds.length} worker${workerIds.length > 1 ? 's' : ''}.`, 'ok');
    await loadJobs();
  } catch (err) {
    say(msg, err.message);
  }
});

/* ---------------------------------------------------------------- crew */

async function ensureWorkers() {
  const { workers } = await api('/api/admin/workers?include_inactive=1');
  state.workers = workers;
  return workers;
}

async function loadCrew() {
  await ensureWorkers();
  const host = clear(document.getElementById('crew'));
  const list = el('ul', { class: 'list' });

  for (const worker of state.workers) {
    list.append(el('li', {},
      el('div', { class: 'row between' },
        el('div', { class: 'grow' },
          el('strong', { text: worker.name }),
          el('div', { class: 'muted tiny',
            text: `${worker.username} · ${worker.role === 'admin' ? 'Manager' : 'Worker'}` +
              (worker.hourly_rate ? ` · ${money(worker.hourly_rate)}/h` : '') +
              (worker.phone ? ` · ${worker.phone}` : '') }),
        ),
        !worker.active && el('span', { class: 'pill rejected', text: 'Inactive' }),
      ),
      el('div', { class: 'row', style: 'margin-top:8px' },
        el('button', { class: 'small', type: 'button', onclick: () => editWorker(worker) }, 'Edit'),
        el('button', { class: 'small', type: 'button', onclick: () => resetPin(worker) }, 'New PIN'),
        el('button', {
          class: worker.active ? 'small danger' : 'small',
          type: 'button',
          onclick: () => setActive(worker, !worker.active),
        }, worker.active ? 'Deactivate' : 'Reactivate'),
      ),
    ));
  }

  host.append(list);
}

async function editWorker(worker) {
  const name = prompt('Name', worker.name);
  if (name === null) return;
  const rate = prompt('Hourly rate', String(worker.hourly_rate));
  if (rate === null) return;
  const phone = prompt('Phone', worker.phone || '');
  if (phone === null) return;

  try {
    await api(`/api/admin/workers/${worker.id}`, {
      method: 'PATCH',
      body: { name, hourly_rate: Number(rate) || 0, phone },
    });
    say(msg, 'Saved.', 'ok');
    await loadCrew();
  } catch (err) {
    say(msg, err.message);
  }
}

async function resetPin(worker) {
  const pin = prompt(`New PIN for ${worker.name} (4-10 digits)`, '');
  if (pin === null) return;

  try {
    await api(`/api/admin/workers/${worker.id}/pin`, { method: 'POST', body: { pin: pin.trim() } });
    say(msg, `${worker.name} can now sign in with that PIN.`, 'ok');
  } catch (err) {
    say(msg, err.message);
  }
}

async function setActive(worker, active) {
  if (!active && !confirm(`${worker.name} will not be able to sign in. Continue?`)) return;

  try {
    await api(`/api/admin/workers/${worker.id}`, { method: 'PATCH', body: { active } });
    say(msg, active ? 'Reactivated.' : 'Deactivated.', 'ok');
    await loadCrew();
  } catch (err) {
    say(msg, err.message);
  }
}

document.getElementById('worker-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    await api('/api/admin/workers', {
      method: 'POST',
      body: {
        name: document.getElementById('w-name').value,
        username: document.getElementById('w-username').value,
        pin: document.getElementById('w-pin').value,
        hourly_rate: Number(document.getElementById('w-rate').value || 0),
        role: document.getElementById('w-role').value,
        phone: document.getElementById('w-phone').value,
      },
    });

    event.target.reset();
    document.getElementById('w-rate').value = '0';
    say(msg, 'Worker added. Give them their username and PIN.', 'ok');
    await loadCrew();
  } catch (err) {
    say(msg, err.message);
  }
});

/* -------------------------------------------------------------- reports */

async function loadReport() {
  await ensureWorkers();

  const select = document.getElementById('r-worker');
  const chosen = select.value;
  clear(select).append(el('option', { value: '' }, 'Everyone'));
  for (const worker of state.workers) {
    select.append(el('option', { value: String(worker.id) }, worker.name));
  }
  select.value = chosen;

  document.getElementById('r-from').value = state.reportFrom;
  document.getElementById('r-to').value = state.reportTo;

  const query = new URLSearchParams({ from: state.reportFrom, to: state.reportTo });
  if (select.value) query.set('worker_id', select.value);

  const data = await api(`/api/admin/report?${query}`);
  document.getElementById('r-csv').href = `/api/admin/report.csv?${query}`;

  const host = clear(document.getElementById('report-rows'));
  if (data.rows.length === 0) {
    host.append(el('p', { class: 'empty', text: 'No hours logged in this period.' }));
  } else {
    const table = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { text: 'Worker' }),
        el('th', { class: 'num', text: 'Shifts' }),
        el('th', { class: 'num', text: 'Approved' }),
        el('th', { class: 'num', text: 'Waiting' }),
        el('th', { class: 'num', text: 'Total h' }),
        el('th', { class: 'num', text: 'Pay' }),
      )),
    );

    const body = el('tbody');
    for (const row of data.rows) {
      body.append(el('tr', {},
        el('td', { text: row.worker_name }),
        el('td', { class: 'num', text: String(row.entries) }),
        el('td', { class: 'num', text: row.approved_hours.toFixed(2) }),
        el('td', { class: 'num', text: row.pending_hours.toFixed(2) }),
        el('td', { class: 'num', text: row.hours.toFixed(2) }),
        el('td', { class: 'num', text: money(row.pay) }),
      ));
    }

    body.append(el('tr', {},
      el('td', {}, el('strong', { text: 'Total' })),
      el('td', {}), el('td', { class: 'num', text: data.totals.approved_hours.toFixed(2) }),
      el('td', {}),
      el('td', { class: 'num' }, el('strong', { text: data.totals.hours.toFixed(2) })),
      el('td', { class: 'num' }, el('strong', { text: money(data.totals.pay) })),
    ));

    table.append(body);
    host.append(table);
  }

  renderEntries(document.getElementById('report-entries'), data.entries);
}

document.getElementById('r-run').addEventListener('click', () => {
  state.reportFrom = document.getElementById('r-from').value || state.reportFrom;
  state.reportTo = document.getElementById('r-to').value || state.reportTo;
  loadReport().catch((err) => say(msg, err.message));
});

document.getElementById('r-week').addEventListener('click', () => {
  state.reportFrom = startOfWeek(todayLocal());
  state.reportTo = addDays(state.reportFrom, 6);
  loadReport().catch((err) => say(msg, err.message));
});

document.getElementById('r-last').addEventListener('click', () => {
  state.reportFrom = addDays(startOfWeek(todayLocal()), -7);
  state.reportTo = addDays(state.reportFrom, 6);
  loadReport().catch((err) => say(msg, err.message));
});

document.getElementById('r-worker').addEventListener('change', () => {
  loadReport().catch((err) => say(msg, err.message));
});

/* ---------------------------------------------------------- date inputs */

const dayInput = document.getElementById('day-date');

function goToDay(date) {
  state.date = date;
  dayInput.value = date;
  loadToday().catch((err) => say(msg, err.message));
}

dayInput.addEventListener('change', () => dayInput.value && goToDay(dayInput.value));
document.getElementById('day-prev').addEventListener('click', () => goToDay(addDays(state.date, -1)));
document.getElementById('day-next').addEventListener('click', () => goToDay(addDays(state.date, 1)));

for (const [id, key] of [['jobs-from', 'jobsFrom'], ['jobs-to', 'jobsTo']]) {
  document.getElementById(id).addEventListener('change', (event) => {
    if (!event.target.value) return;
    state[key] = event.target.value;
    loadJobs().catch((err) => say(msg, err.message));
  });
}

/* ------------------------------------------------------------------ start */

(async function start() {
  try {
    const { user } = await api('/api/me');
    if (user.role !== 'admin') {
      location.replace('/app.html');
      return;
    }

    document.getElementById('who').textContent = user.name;
    dayInput.value = state.date;
    document.getElementById('j-date').value = state.date;
    document.getElementById('jobs-from').value = state.jobsFrom;
    document.getElementById('jobs-to').value = state.jobsTo;

    await loadToday();
    await loadPendingCount();
  } catch (err) {
    say(msg, err.message);
  }
}());
