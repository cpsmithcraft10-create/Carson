'use strict';

const msg = document.getElementById('msg');
const state = { date: todayLocal(), weekStart: startOfWeek(todayLocal()), day: null };

/* ------------------------------------------------------------------ tabs */

const TABS = ['today', 'week', 'pin'];

function showTab(name) {
  for (const tab of TABS) {
    document.getElementById(`tab-${tab}`).setAttribute('aria-selected', String(tab === name));
    document.getElementById(`panel-${tab}`).hidden = tab !== name;
  }
  if (name === 'week') loadWeek();
}

for (const tab of TABS) {
  document.getElementById(`tab-${tab}`).addEventListener('click', () => showTab(tab));
}

document.getElementById('signout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
});

/* ------------------------------------------------------- the running shift */

function renderRunning(entry) {
  const host = clear(document.getElementById('running'));
  if (!entry) return;

  const card = el('div', { class: 'card' },
    el('div', { class: 'row between' },
      el('div', { class: 'grow' },
        el('h3', { text: entry.job_title || 'Shift in progress' }),
        el('p', { class: 'muted tiny', text: `Started ${formatTime(entry.start_time)} on ${formatDate(entry.work_date)}` }),
      ),
      statusPill('open'),
    ),
    el('div', { class: 'fields two', style: 'margin:12px 0' },
      el('div', {},
        el('label', { for: 'stop-break', text: 'Unpaid break (minutes)' }),
        el('input', { type: 'number', id: 'stop-break', min: '0', max: '1440', step: '5', value: '0' }),
      ),
      el('div', {},
        el('label', { for: 'stop-time', text: 'Finish time' }),
        el('input', { type: 'time', id: 'stop-time', value: nowLocal() }),
      ),
    ),
    el('div', {},
      el('label', { for: 'stop-notes', text: 'What did you get done?' }),
      el('textarea', { id: 'stop-notes', maxlength: '1000' }, entry.description || ''),
    ),
    el('button', {
      class: 'primary big-action',
      style: 'margin-top:12px',
      type: 'button',
      onclick: () => clockOut(entry.id),
    }, 'Finish shift'),
  );

  host.append(card);
}

async function clockOut(entryId) {
  try {
    await api(`/api/my/entries/${entryId}/clock-out`, {
      method: 'POST',
      body: {
        end_time: document.getElementById('stop-time').value,
        break_minutes: Number(document.getElementById('stop-break').value || 0),
        description: document.getElementById('stop-notes').value,
      },
    });
    say(msg, 'Shift saved and sent to your manager.', 'ok');
    await loadDay();
  } catch (err) {
    say(msg, err.message);
  }
}

async function clockIn(jobId) {
  try {
    await api('/api/my/clock-in', {
      method: 'POST',
      body: { job_id: jobId, work_date: state.date, start_time: nowLocal() },
    });
    say(msg, 'Clocked in. Tap "Finish shift" when you are done.', 'ok');
    await loadDay();
  } catch (err) {
    say(msg, err.message);
  }
}

/* --------------------------------------------------------- jobs of the day */

function renderJobs(jobs, running) {
  const host = clear(document.getElementById('jobs'));

  if (jobs.length === 0) {
    host.append(el('p', { class: 'empty', text: 'Nothing assigned for this day. You can still add hours by hand below.' }));
    return;
  }

  const list = el('ul', { class: 'list' });

  for (const job of jobs) {
    list.append(el('li', {},
      el('h3', { text: job.title }),
      job.location && el('p', { class: 'muted tiny', text: job.location }),
      job.notes && el('p', { class: 'tiny', text: job.notes }),
      job.scheduled_hours && el('p', { class: 'muted tiny', text: `Planned: ${job.scheduled_hours} h` }),
      el('button', {
        class: 'primary small',
        type: 'button',
        style: 'margin-top:8px',
        disabled: !!running,
        onclick: () => clockIn(job.id),
      }, running ? 'Finish your current shift first' : 'Start now'),
    ));
  }

  host.append(list);
}

/* ------------------------------------------------------------- my entries */

function entryLine(entry, { editable }) {
  const detail = [
    formatTime(entry.start_time),
    entry.end_time ? formatTime(entry.end_time) : 'running',
  ].join(' - ');

  const parts = el('li', {},
    el('div', { class: 'entry-head' },
      el('div', { class: 'grow' },
        el('strong', { text: entry.job_title || 'General work' }),
        el('div', { class: 'muted tiny', text: `${formatDate(entry.work_date)} · ${detail}` +
          (entry.break_minutes ? ` · ${entry.break_minutes} min break` : '') }),
      ),
      el('span', { class: 'entry-hours', text: entry.end_time ? hoursLabel(entry.hours) : '' }),
    ),
    el('div', { class: 'row', style: 'margin-top:6px' }, statusPill(entry.status)),
    entry.description && el('p', { class: 'tiny', style: 'margin:6px 0 0', text: entry.description }),
    entry.status === 'rejected' && entry.review_note
      && el('p', { class: 'msg error', style: 'margin:8px 0 0', text: `Manager: ${entry.review_note}` }),
  );

  if (editable && entry.status !== 'approved' && entry.end_time) {
    parts.append(el('div', { class: 'row', style: 'margin-top:8px' },
      el('button', { class: 'small', type: 'button', onclick: () => editEntry(entry) }, 'Edit'),
      el('button', { class: 'small danger', type: 'button', onclick: () => removeEntry(entry) }, 'Delete'),
    ));
  }

  return parts;
}

async function editEntry(entry) {
  const start = prompt('Start time (HH:MM)', entry.start_time);
  if (start === null) return;
  const end = prompt('Finish time (HH:MM)', entry.end_time || '');
  if (end === null) return;
  const breakMinutes = prompt('Unpaid break in minutes', String(entry.break_minutes));
  if (breakMinutes === null) return;
  const description = prompt('Notes', entry.description || '');
  if (description === null) return;

  try {
    await api(`/api/my/entries/${entry.id}`, {
      method: 'PATCH',
      body: {
        start_time: start.trim(),
        end_time: end.trim(),
        break_minutes: Number(breakMinutes) || 0,
        description,
      },
    });
    say(msg, 'Updated and sent back to your manager.', 'ok');
    await refresh();
  } catch (err) {
    say(msg, err.message);
  }
}

async function removeEntry(entry) {
  if (!confirm('Delete these hours?')) return;
  try {
    await api(`/api/my/entries/${entry.id}`, { method: 'DELETE' });
    say(msg, 'Deleted.', 'ok');
    await refresh();
  } catch (err) {
    say(msg, err.message);
  }
}

function renderTotals(host, totals, { showPay = false } = {}) {
  fill(host,
    el('div', { class: 'stat' }, el('b', { text: hoursLabel(totals.hours) }), el('span', { text: 'Hours' })),
    el('div', { class: 'stat' }, el('b', { text: hoursLabel(totals.approved_hours) }), el('span', { text: 'Approved' })),
    el('div', { class: 'stat' }, el('b', { text: String(totals.pending) }), el('span', { text: 'Waiting' })),
    showPay && el('div', { class: 'stat' }, el('b', { text: money(totals.pay) }), el('span', { text: 'Est. pay' })),
  );
}

/* ---------------------------------------------------------------- loading */

async function loadDay() {
  const data = await api(`/api/my/day?date=${state.date}`);
  state.day = data;

  renderRunning(data.running);
  renderJobs(data.jobs, data.running);

  const host = clear(document.getElementById('day-entries'));
  if (data.entries.length === 0) {
    host.append(el('p', { class: 'empty', text: 'No hours logged for this day yet.' }));
  } else {
    const list = el('ul', { class: 'list' });
    for (const entry of data.entries) list.append(entryLine(entry, { editable: true }));
    host.append(list);
  }

  renderTotals(document.getElementById('day-totals'), data.totals);

  const select = clear(document.getElementById('m-job'));
  select.append(el('option', { value: '' }, 'General work (no job)'));
  for (const job of data.jobs) select.append(el('option', { value: String(job.id) }, job.title));
}

async function loadWeek() {
  const end = addDays(state.weekStart, 6);
  const data = await api(`/api/my/entries?from=${state.weekStart}&to=${end}`);

  document.getElementById('week-label').textContent =
    `${formatDate(state.weekStart)} - ${formatDate(end)}`;
  renderTotals(document.getElementById('week-totals'), data.totals, { showPay: true });

  const host = clear(document.getElementById('week-entries'));
  if (data.entries.length === 0) {
    host.append(el('p', { class: 'empty', text: 'Nothing logged in this week.' }));
    return;
  }

  const list = el('ul', { class: 'list' });
  for (const entry of data.entries) list.append(entryLine(entry, { editable: true }));
  host.append(list);
}

async function refresh() {
  await loadDay();
  if (!document.getElementById('panel-week').hidden) await loadWeek();
}

/* ----------------------------------------------------------------- inputs */

const dayInput = document.getElementById('day-date');

dayInput.addEventListener('change', () => {
  if (!dayInput.value) return;
  state.date = dayInput.value;
  loadDay().catch((err) => say(msg, err.message));
});

document.getElementById('day-prev').addEventListener('click', () => {
  state.date = addDays(state.date, -1);
  dayInput.value = state.date;
  loadDay().catch((err) => say(msg, err.message));
});

document.getElementById('day-next').addEventListener('click', () => {
  state.date = addDays(state.date, 1);
  dayInput.value = state.date;
  loadDay().catch((err) => say(msg, err.message));
});

document.getElementById('week-prev').addEventListener('click', () => {
  state.weekStart = addDays(state.weekStart, -7);
  loadWeek().catch((err) => say(msg, err.message));
});

document.getElementById('week-next').addEventListener('click', () => {
  state.weekStart = addDays(state.weekStart, 7);
  loadWeek().catch((err) => say(msg, err.message));
});

document.getElementById('toggle-manual').addEventListener('click', (event) => {
  const form = document.getElementById('manual');
  form.hidden = !form.hidden;
  event.target.textContent = form.hidden ? 'Show' : 'Hide';
  if (!form.hidden && !document.getElementById('m-start').value) {
    document.getElementById('m-start').value = '08:00';
    document.getElementById('m-end').value = nowLocal();
  }
});

document.getElementById('manual').addEventListener('submit', async (event) => {
  event.preventDefault();
  const jobId = document.getElementById('m-job').value;

  try {
    await api('/api/my/entries', {
      method: 'POST',
      body: {
        job_id: jobId ? Number(jobId) : null,
        work_date: state.date,
        start_time: document.getElementById('m-start').value,
        end_time: document.getElementById('m-end').value,
        break_minutes: Number(document.getElementById('m-break').value || 0),
        description: document.getElementById('m-notes').value,
      },
    });

    document.getElementById('m-notes').value = '';
    say(msg, 'Hours saved and sent to your manager.', 'ok');
    await refresh();
  } catch (err) {
    say(msg, err.message);
  }
});

document.getElementById('pin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/me/pin', {
      method: 'POST',
      body: {
        current_pin: document.getElementById('p-current').value,
        new_pin: document.getElementById('p-new').value,
      },
    });
    event.target.reset();
    say(msg, 'PIN changed.', 'ok');
  } catch (err) {
    say(msg, err.message);
  }
});

/* ------------------------------------------------------------------ start */

(async function start() {
  try {
    const { user } = await api('/api/me');
    document.getElementById('who').textContent = user.name;
    dayInput.value = state.date;
    await loadDay();
  } catch (err) {
    say(msg, err.message);
  }
}());
