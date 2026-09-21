'use strict';

/* Shared by the sign-in, crew and office screens. */

/** Change this to your currency if you are not in dollars. */
var CASH = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });

var KIND_WORDS = {
  sprinkler: 'Sprinkler',
  lighting: 'Lighting',
  drainage: 'Drainage',
  other: 'Other',
};

var STATE_WORDS = {
  open: 'On the clock',
  sent: 'Sent to the office',
  ok: "OK'd",
  question: 'Office has a question',
};

var JOB_WORDS = {
  assigned: 'Not started',
  working: 'Being worked on',
  done: 'Finished',
};

var TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** JSON in, JSON out. Failures arrive as an Error with a readable message. */
function api(path, opts) {
  opts = opts || {};
  var bounceOnExpiry = opts.bounceOnExpiry !== false;

  return fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).catch(function () {
    /* Out of range, in a basement, or the office box is down. Whatever the
       browser calls that — "Failed to fetch", "Load failed" — is no use to
       somebody standing in a driveway. */
    throw new Error('No signal just now. Try again when you have a bar.');
  }).then(function (res) {
    return res.text().then(function (text) {
      if (res.status === 401 && bounceOnExpiry) {
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

function shiftDate(date, n) {
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

function longDate(date) {
  var p = date.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

function shortDate(date) {
  var p = date.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

function clockTime(t) {
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

function agoWords(iso) {
  if (!iso) return '';
  var then = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  var secs = Math.max(0, Math.round((Date.now() - then.getTime()) / 1000));
  if (secs < 90) return 'just now';
  if (secs < 3600) return Math.round(secs / 60) + ' minutes ago';
  if (secs < 86400) return Math.round(secs / 3600) + ' hours ago';
  var days = Math.round(secs / 86400);
  return days === 1 ? 'yesterday' : days + ' days ago';
}

/* ---------------------------- building ---------------------------- */

/** Builds DOM without innerHTML, so nothing anybody types can inject markup. */
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
    // `x && make(...)` hands back x itself when x is falsy, and SQLite gives
    // back 0 for a false flag - none of those should print.
    if (kid == null || kid === false || kid === 0 || kid === '') return;
    node.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
  });

  return node;
}

function emptyOut(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function panel(title, trailing, body, footer) {
  var head = make('div', { class: 'card-top' }, make('h2', { text: title }));
  (trailing || []).forEach(function (n) { head.appendChild(n); });
  var box = make('div', { class: 'card' }, head, body);
  if (footer) box.appendChild(footer);
  return box;
}

function figures(items) {
  var live = items.filter(Boolean);
  return make('div', { class: 'figures' + (live.length === 3 ? ' n3' : '') },
    live.map(function (it) {
      return make('div', {}, make('b', { text: it.value }), make('span', { text: it.label }));
    }));
}

/** Break buttons that drive a typed field, so either way works. */
function breakPicks(read, onPick) {
  return make('div', { class: 'picks' }, [0, 15, 30, 45, 60].map(function (m) {
    return make('button', {
      type: 'button',
      'aria-pressed': String(read() === m),
      onclick: function (e) {
        onPick(m);
        var all = e.target.parentNode.querySelectorAll('button');
        Array.prototype.forEach.call(all, function (b) {
          b.setAttribute('aria-pressed', String(b === e.target));
        });
      },
    }, m === 0 ? 'None' : m + 'm');
  }));
}

function flashInto(node, message, kind) {
  node.className = 'flash ' + (kind || 'good');
  node.textContent = message || '';
  if (message && kind !== 'bad') {
    setTimeout(function () { if (node.textContent === message) node.textContent = ''; }, 6000);
  }
}

function kindChip(kind) {
  return make('span', { class: 'kind ' + (kind || 'other'), text: KIND_WORDS[kind] || 'Other' });
}

/** Address that opens in whatever map app the phone uses. */
function addressLink(address) {
  if (!address) return null;
  return make('a', {
    class: 'linkout',
    href: 'https://maps.google.com/?q=' + encodeURIComponent(address),
    target: '_blank',
    rel: 'noopener',
  }, address);
}

function phoneLink(phone) {
  if (!phone) return null;
  return make('a', { class: 'linkout', href: 'tel:' + phone.replace(/[^\d+]/g, '') }, phone);
}

/** A small line icon, drawn rather than loaded so it works with no signal. */
function icon(name, size) {
  var paths = {
    pin: ['M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z', 'M12 12.4a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z'],
    phone: ['M6.3 3.8h3l1.5 3.8-1.9 1.4a11 11 0 0 0 5.1 5.1l1.4-1.9 3.8 1.5v3a1.7 1.7 0 0 1-1.9 1.7C10.2 17.7 6.3 13.8 4.6 5.7a1.7 1.7 0 0 1 1.7-1.9Z'],
  };

  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size || 21);
  svg.setAttribute('height', size || 21);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  (paths[name] || []).forEach(function (d) {
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.9');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  });

  return svg;
}

/** The two things somebody on site actually taps: the map and the phone. */
function siteActions(address, phone) {
  var bits = [];

  if (address) {
    bits.push(make('a', {
      class: 'bigaction',
      href: 'https://maps.google.com/?q=' + encodeURIComponent(address),
      target: '_blank', rel: 'noopener',
    }, icon('pin'), 'Open the map'));
  }

  if (phone) {
    bits.push(make('a', {
      class: 'bigaction',
      href: 'tel:' + phone.replace(/[^\d+]/g, ''),
    }, icon('phone'), 'Call the customer'));
  }

  if (!bits.length) return null;
  return make('div', { class: 'actionrow' + (bits.length === 2 ? ' two-up' : '') }, bits);
}

/** One line of hours, used on both screens. */
function hourRow(shift, opts) {
  opts = opts || {};

  var span = clockTime(shift.start_time) + ' to ' +
    (shift.end_time ? clockTime(shift.end_time) : 'now') +
    (shift.break_minutes ? '  ·  ' + shift.break_minutes + ' min break' : '');

  // Where the screen is already about one day, repeating the date on every
  // row is just something else to read past.
  var when = (opts.sameDay ? '' : shortDate(shift.work_date) + '  ·  ') + span;

  var middle = make('div', {},
    opts.withName && make('div', { class: 'headline' },
      make('div', { class: 'person', text: shift.employee_name }),
      make('span', { class: 'state ' + shift.status,
        text: STATE_WORDS[shift.status] || shift.status })),
    make('div', { class: 'what' + (opts.withName ? ' sub' : ''), text: shift.what }),
    shift.job_address && make('div', { class: 'clock', text: shift.job_address }),
    make('div', { class: 'clock', text: when }),
    shift.notes && make('div', { class: 'said', text: '“' + shift.notes + '”' }),
    !opts.withName && make('span', { class: 'state ' + shift.status,
      text: STATE_WORDS[shift.status] || shift.status }),
    shift.status === 'question' && shift.question &&
      make('div', { class: 'asked', text: 'Office asks: ' + shift.question }));

  var right = make('div', { class: 'num' },
    make('b', { text: shift.end_time ? shift.hours.toFixed(2) : '—' }),
    shift.end_time && make('small', { text: 'hours' }),
    opts.withPay && shift.end_time && shift.hourly_rate > 0 &&
      make('small', { text: CASH.format(shift.pay) }));

  var row = make('li', {}, make('div', { class: 'tick ' + shift.status }), middle, right);

  // The crew get buttons they can hit with a glove on; the office, whose
  // screen is mostly for reading, gets them quiet and out of the way.
  var acts = (opts.buttons || []).filter(Boolean);
  if (acts.length) {
    middle.appendChild(make('div', { class: (opts.quiet ? 'acts' : 'inline') + ' under' }, acts));
  }

  return row;
}

function signOutButton() {
  return make('button', {
    class: 'plain',
    onclick: function () {
      api('/api/signout', { method: 'POST' })
        .catch(function () { /* leaving anyway */ })
        .then(function () { location.href = '/'; });
    },
  }, 'Sign out');
}

/** The company mark, drawn rather than loaded so it works with no signal. */
function logoMark(size) {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');

  [
    ['M16 4c4.6 5.4 7.6 9.4 7.6 13a7.6 7.6 0 0 1-15.2 0C8.4 13.4 11.4 9.4 16 4Z', 'none'],
    ['M16 12.6v7.6', 'none'],
    ['M12.9 15.7 16 12.6l3.1 3.1', 'none'],
  ].forEach(function (pair) {
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pair[0]);
    path.setAttribute('fill', pair[1]);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  });

  return svg;
}

/* The tab bar is one row for the crew and two for the office. Measure it so
   the page ends above it instead of behind it. */
function watchBarHeight() {
  // On a phone the rail is the bar across the bottom; the sheet has to end
  // above it rather than behind it.
  var bar = document.querySelector('.rail');
  if (!bar) return;

  var settle = function () {
    var fixed = getComputedStyle(bar).position === 'fixed';
    document.documentElement.style.setProperty('--barh', fixed ? bar.offsetHeight + 'px' : '0px');
  };

  settle();
  window.addEventListener('resize', settle);
  if (window.ResizeObserver) new ResizeObserver(settle).observe(bar);
}

watchBarHeight();

/**
 * Which of the six people tints somebody gets. Picked from the name, so the
 * same person is the same colour on every screen and in every list.
 */
function tintFor(name) {
  var text = String(name || '');
  var sum = 0;
  for (var i = 0; i < text.length; i++) sum = (sum * 31 + text.charCodeAt(i)) >>> 0;
  return 'w' + ((sum % 6) + 1);
}

/** Two letters for the little round avatar in the corner. */
function initialsOf(name) {
  var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ------------------------- on the home screen ------------------------- */

/* Keeps the app's own files on the phone so the icon opens straight into the
   screen, with or without signal. Nothing the office typed is kept — see
   sw.js. A phone too old for this simply carries on fetching everything. */
var CAN_INSTALL = location.protocol === 'https:'
  || location.hostname === 'localhost'
  || location.hostname === '127.0.0.1';

if ('serviceWorker' in navigator && CAN_INSTALL) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {
      /* An old phone, or a private window. The app still works. */
    });
  });
}
