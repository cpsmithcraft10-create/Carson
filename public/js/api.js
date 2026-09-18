'use strict';

/** Change this to your currency code (GBP, EUR, AUD, CAD ...). */
const CURRENCY = 'USD';

/** Thin wrapper over fetch: JSON in, JSON out, errors as Error with a readable message. */
async function api(path, { method = 'GET', body, signInOnExpiry = true } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && signInOnExpiry) {
    location.href = '/';
    throw new Error('Signed out');
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Today's date in the browser's timezone - the crew's own clock, not the server's. */
function todayLocal() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function nowLocal() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function startOfWeek(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

function formatDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

function formatTime(time) {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  const dt = new Date(2000, 0, 1, h, m);
  return dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function money(value) {
  return Number(value || 0).toLocaleString(undefined, { style: 'currency', currency: CURRENCY });
}

/** Builds DOM without innerHTML, so a worker's notes can never inject markup. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }

  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Replaces a node's contents, skipping the null/false that conditional children produce. */
function fill(node, ...children) {
  clear(node);
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function say(node, message, kind = 'error') {
  node.className = `msg ${kind}`;
  node.textContent = message || '';
  if (message && kind === 'ok') setTimeout(() => { if (node.textContent === message) node.textContent = ''; }, 4000);
}

function statusPill(status) {
  const labels = { open: 'Running', submitted: 'Sent in', approved: 'Approved', rejected: 'Needs a fix' };
  return el('span', { class: `pill ${status}`, text: labels[status] || status });
}

function hoursLabel(hours) {
  return `${Number(hours).toFixed(2)} h`;
}
