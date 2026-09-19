'use strict';

/* Shared by the crew screen and the office screen. */

var CASH = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });

/** JSON in, JSON out. Errors come back as an Error with a readable message. */
function api(path, opts) {
  opts = opts || {};
  var signInOnExpiry = opts.signInOnExpiry !== false;

  return fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }).then(function (res) {
    return res.text().then(function (text) {
      if (res.status === 401 && signInOnExpiry) {
        location.href = '/';
        throw new Error('Signed out');
      }
      var data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new Error(data.error || 'That did not work (' + res.status + ')');
      return data;
    });
  });
}

/* ------------------------------ time ------------------------------ */

function pad(n) { return String(n).padStart(2, '0'); }

/** Today on the crew's own phone, not the server's clock. */
function today() {
  var d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function timeNow() {
  var d = new Date();
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function mins(t) {
  var p = String(t || '').split(':');
  return (+p[0]) * 60 + (+p[1]);
}

/** A finish earlier than the start means the work carried past midnight. */
function gap(start, end) {
  var a = mins(start), b = mins(end);
  return b >= a ? b - a : b + 1440 - a;
}

function shiftDay(date, n) {
  var p = date.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mondayOf(date) {
  var p = date.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function fullDay(date) {
  var p = date.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
}

function briefDay(date) {
  var p = date.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC'
  });
}

function clockOf(t) {
  if (!t) return '';
  var p = t.split(':');
  return new Date(2000, 0, 1, +p[0], +p[1])
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function inWords(m) {
  var h = Math.floor(m / 60), r = m % 60, out = [];
  if (h) out.push(h + (h === 1 ? ' hour' : ' hours'));
  if (r || !h) out.push(r + (r === 1 ? ' minute' : ' minutes'));
  return out.join(' ');
}

var TIME_LOOKS_RIGHT = /^([01]\d|2[0-3]):[0-5]\d$/;

/* ----------------------------- building ---------------------------- */

/** Builds DOM without innerHTML, so a worker's notes can never inject markup. */
function make(tag, attrs) {
  var node = document.createElement(tag);
  var kids = Array.prototype.slice.call(arguments, 2);

  if (attrs) Object.keys(attrs).forEach(function (k) {
    var v = attrs[k];
    if (v == null || v === false) return;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  });

  kids.forEach(function put(kid) {
    if (Array.isArray(kid)) return kid.forEach(put);
    if (kid == null || kid === false) return;
    node.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
  });

  return node;
}

function empty(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function card(title, trailing, body, footer) {
  var head = make('div', { class: 'card-top' }, make('h2', { text: title }));
  (trailing || []).forEach(function (n) { head.appendChild(n); });
  var box = make('div', { class: 'card' }, head, body);
  if (footer) box.appendChild(footer);
  return box;
}

function strip(items) {
  var live = items.filter(Boolean);
  return make('div', { class: 'strip' + (live.length === 3 ? ' n3' : '') }, live.map(function (it) {
    return make('div', {}, make('b', { text: it.value }), make('span', { text: it.label }));
  }));
}

/** Quick-pick break buttons that drive a typed field. */
function breakPicker(read, onPick) {
  return make('div', { class: 'quickpicks' }, [0, 15, 30, 45, 60].map(function (m) {
    return make('button', {
      type: 'button',
      'aria-pressed': String(read() === m),
      onclick: function (e) {
        onPick(m);
        var row = e.target.parentNode.querySelectorAll('button');
        Array.prototype.forEach.call(row, function (b) {
          b.setAttribute('aria-pressed', String(b === e.target));
        });
      }
    }, m === 0 ? 'None' : m + 'm');
  }));
}

function say(node, message, kind) {
  node.className = 'notice ' + (kind || 'good');
  node.textContent = message || '';
  if (message && kind !== 'bad') {
    setTimeout(function () { if (node.textContent === message) node.textContent = ''; }, 6000);
  }
}

var SAYS = {
  open:      'On the clock',
  submitted: 'Sent to the office',
  approved:  "OK'd",
  rejected:  'Office has a question'
};

/** One line of hours, shared by both screens. */
function hourRow(entry, opts) {
  opts = opts || {};

  var span = clockOf(entry.start_time) + ' to ' +
    (entry.end_time ? clockOf(entry.end_time) : 'now') +
    (entry.break_minutes ? '  ·  ' + entry.break_minutes + ' min break' : '');

  var task = entry.job_title || entry.description || 'Other work';

  var middle = make('div', {},
    opts.withName && make('div', { class: 'name', text: entry.worker_name || '' }),
    make('div', { class: 'task' + (opts.withName ? ' sub' : ''), text: task }),
    entry.job_location && make('div', { class: 'span', text: entry.job_location }),
    make('div', { class: 'span', text: briefDay(entry.work_date) + '  ·  ' + span }),
    entry.job_title && entry.description &&
      make('div', { class: 'said', text: '“' + entry.description + '”' }),
    make('span', { class: 'mark-state ' + entry.status, text: SAYS[entry.status] || entry.status }),
    entry.status === 'rejected' && entry.review_note &&
      make('div', { class: 'asked', text: 'Office asks: ' + entry.review_note }));

  var right = make('div', { class: 'figure' },
    make('b', { text: entry.end_time ? entry.hours.toFixed(2) : '—' }),
    entry.end_time && make('small', { text: 'hours' }),
    opts.withPay && entry.end_time && entry.hourly_rate > 0 &&
      make('small', { text: CASH.format(entry.pay) }));

  var row = make('li', {}, make('div', { class: 'tick ' + entry.status }), middle, right);

  var acts = (opts.buttons || []).filter(Boolean);
  if (acts.length) middle.appendChild(make('div', { class: 'inarow foot-actions' }, acts));

  return row;
}

function signOutButton() {
  return make('button', {
    class: 'out',
    onclick: function () {
      api('/api/logout', { method: 'POST' })
        .catch(function () { /* going anyway */ })
        .then(function () { location.href = '/'; });
    }
  }, 'Sign out');
}
