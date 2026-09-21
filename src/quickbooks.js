'use strict';

/**
 * Talking to QuickBooks Online.
 *
 * Every URL, header and body shape Intuit expects is in this one file, so
 * when they change something there is exactly one place to fix, and so the
 * rest of the app never has to know what an OAuth refresh is.
 *
 * `fetch` is injected rather than reached for, which is what lets the tests
 * run the whole send-an-invoice path against a fake without a network.
 *
 * Worth knowing before this goes near a real company file:
 *   - Access tokens last an hour; refresh tokens about a hundred days and
 *     are rotated on nearly every refresh, so the new one must be saved.
 *   - A line needs an ItemRef pointing at a real product/service in the
 *     company file. "Labour" and "Materials" are only defaults; whatever is
 *     set has to exist in QuickBooks or the invoice is rejected.
 *   - Test against the sandbox company first. Invoices are seen by customers.
 */

const AUTHORIZE = 'https://appcenter.intuit.com/connect/oauth2';
const TOKENS = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

const BASES = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
};

// Pinned so a later Intuit default cannot quietly change what comes back.
const MINOR_VERSION = '75';
const SCOPE = 'com.intuit.quickbooks.accounting';

class QuickBooksError extends Error {
  constructor(message, { status = 0, detail = null, retryable = false } = {}) {
    super(message);
    this.name = 'QuickBooksError';
    this.status = status;
    this.detail = detail;
    this.retryable = retryable;
  }
}

/** Where to send somebody to say yes to the connection. */
function consentUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTHORIZE}?${q.toString()}`;
}

/** A single quote inside a query string has to be doubled, or the query breaks. */
function quote(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

/** Pull something readable out of whatever shape the failure arrived in. */
function readFault(body, status) {
  if (body && body.Fault && Array.isArray(body.Fault.Error) && body.Fault.Error.length) {
    const first = body.Fault.Error[0];
    const bits = [first.Message, first.Detail].filter(Boolean);
    return bits.join(' — ') || 'QuickBooks refused that';
  }
  if (body && body.error_description) return body.error_description;
  if (body && body.error) return String(body.error);
  return `QuickBooks answered ${status}`;
}

function makeClient({ fetchImpl, settings, saveTokens, now = () => Date.now() }) {
  const http = fetchImpl || globalThis.fetch;
  if (typeof http !== 'function') throw new Error('No fetch available for QuickBooks');

  const base = BASES[settings.qbo_env] || BASES.sandbox;

  function basicAuth() {
    const raw = `${settings.qbo_client_id}:${settings.qbo_client_secret}`;
    return 'Basic ' + Buffer.from(raw, 'utf8').toString('base64');
  }

  async function readJson(res) {
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  /** Swap an authorization code, or a refresh token, for fresh tokens. */
  async function getTokens(form) {
    const res = await http(TOKENS, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
    });

    const body = await readJson(res);
    if (!res.ok) {
      throw new QuickBooksError(readFault(body, res.status), {
        status: res.status,
        // A refused refresh token will not start working on a retry: the
        // office has to reconnect.
        retryable: res.status >= 500,
      });
    }

    const tokens = {
      access_token: body.access_token,
      refresh_token: body.refresh_token || settings.qbo_refresh_token,
      // A minute of slack, so a token never expires mid-request.
      expires_at: now() + Math.max(0, (Number(body.expires_in) || 3600) - 60) * 1000,
    };

    settings.qbo_access_token = tokens.access_token;
    settings.qbo_refresh_token = tokens.refresh_token;
    settings.qbo_access_expires = String(tokens.expires_at);
    if (saveTokens) saveTokens(tokens);

    return tokens;
  }

  function exchangeCode({ code, redirectUri }) {
    return getTokens({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
  }

  function refresh() {
    if (!settings.qbo_refresh_token) {
      throw new QuickBooksError('QuickBooks is not connected yet', { status: 401 });
    }
    return getTokens({
      grant_type: 'refresh_token',
      refresh_token: settings.qbo_refresh_token,
    });
  }

  async function accessToken() {
    const expires = Number(settings.qbo_access_expires) || 0;
    if (settings.qbo_access_token && expires > now()) return settings.qbo_access_token;
    const fresh = await refresh();
    return fresh.access_token;
  }

  /**
   * One call against the company file. Retries once on a 401, because that
   * usually means the access token went stale between the check and the call.
   */
  async function call(path, { method = 'GET', body = null, retried = false } = {}) {
    const token = await accessToken();
    const join = path.includes('?') ? '&' : '?';
    const url = `${base}/v3/company/${settings.qbo_realm_id}${path}${join}minorversion=${MINOR_VERSION}`;

    const res = await http(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && !retried) {
      settings.qbo_access_expires = '0';
      return call(path, { method, body, retried: true });
    }

    const out = await readJson(res);

    if (!res.ok) {
      throw new QuickBooksError(readFault(out, res.status), {
        status: res.status,
        detail: out,
        // 429 and the 5xx family are worth another go; a 400 means the
        // invoice itself is wrong and will be wrong next time too.
        retryable: res.status === 429 || res.status >= 500,
      });
    }

    return out;
  }

  function query(sql) {
    return call(`/query?query=${encodeURIComponent(sql)}`);
  }

  /** Find a customer in QuickBooks by the name the office knows them by. */
  async function findCustomer(name) {
    const out = await query(`SELECT * FROM Customer WHERE DisplayName = '${quote(name)}'`);
    const found = out && out.QueryResponse && out.QueryResponse.Customer;
    return found && found.length ? found[0] : null;
  }

  async function findCustomerById(id) {
    const out = await call(`/customer/${encodeURIComponent(id)}`);
    return (out && out.Customer) || null;
  }

  async function createCustomer({ name, address, phone }) {
    const body = { DisplayName: name };
    if (address) body.BillAddr = { Line1: address };
    if (phone) body.PrimaryPhone = { FreeFormNumber: phone };

    const out = await call('/customer', { method: 'POST', body });
    return (out && out.Customer) || null;
  }

  /** The product/service an invoice line has to point at. */
  async function findItem(name) {
    const out = await query(`SELECT * FROM Item WHERE Name = '${quote(name)}'`);
    const found = out && out.QueryResponse && out.QueryResponse.Item;
    return found && found.length ? found[0] : null;
  }

  async function createInvoice(invoice) {
    const out = await call('/invoice', { method: 'POST', body: invoice });
    return (out && out.Invoice) || null;
  }

  async function getInvoice(id) {
    const out = await call(`/invoice/${encodeURIComponent(id)}`);
    return (out && out.Invoice) || null;
  }

  async function revoke() {
    if (!settings.qbo_refresh_token) return;
    await http(REVOKE, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ token: settings.qbo_refresh_token }),
    });
  }

  return {
    base,
    exchangeCode,
    refresh,
    accessToken,
    query,
    findCustomer,
    findCustomerById,
    createCustomer,
    findItem,
    createInvoice,
    getInvoice,
    revoke,
  };
}

module.exports = {
  AUTHORIZE, TOKENS, REVOKE, BASES, MINOR_VERSION, SCOPE,
  QuickBooksError, consentUrl, quote, readFault, makeClient,
};
