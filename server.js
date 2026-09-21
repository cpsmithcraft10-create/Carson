'use strict';

const http = require('node:http');
const { open } = require('./src/db');
const auth = require('./src/auth');
const {
  HttpError, sendJson, sendText, readBody, readCookies, serveFile,
} = require('./src/http');

const ROUTES = [
  ...require('./src/routes/auth'),
  ...require('./src/routes/site'),
  ...require('./src/routes/crew'),
  ...require('./src/routes/office'),
].map((route) => ({
  ...route,
  parts: route.path.split('/').filter(Boolean),
  officeOnly: route.path.startsWith('/api/office'),
}));

/** Matches '/api/crew/shifts/7' against '/api/crew/shifts/:id'. */
function match(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);

  for (const route of ROUTES) {
    if (route.method !== method || route.parts.length !== parts.length) continue;

    const params = {};
    let ok = true;

    for (let i = 0; i < parts.length; i += 1) {
      const part = route.parts[i];
      if (part.startsWith(':')) params[part.slice(1)] = parts[i];
      else if (part !== parts[i]) { ok = false; break; }
    }

    if (ok) return { route, params };
  }
  return null;
}

function createApp(db) {
  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method not allowed');
        return;
      }
      serveFile(req, res, url.pathname);
      return;
    }

    const found = match(req.method, url.pathname);
    if (!found) {
      sendJson(res, 404, { error: 'No such endpoint' });
      return;
    }

    try {
      const token = readCookies(req.headers.cookie)[auth.COOKIE];
      const user = auth.whoIs(db, token);

      if (!found.route.open && !user) throw new HttpError(401, 'Please sign in again');
      if (found.route.officeOnly && (!user || user.role !== 'office')) {
        throw new HttpError(403, 'That part is for the office');
      }

      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);

      const result = await found.route.handler({
        req, res, db, user, token,
        params: found.params,
        query: Object.fromEntries(url.searchParams),
        body,
      });

      // A handler that wrote its own response (the CSV) returns nothing.
      if (result !== undefined) sendJson(res, 200, result);
      else if (!res.writableEnded) res.writeHead(204).end();
    } catch (err) {
      if (res.writableEnded) return;
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      console.error(`${req.method} ${url.pathname} failed:`, err);
      sendJson(res, 500, { error: 'Something went wrong on our end' });
    }
  };
}

function createServer(db) {
  return http.createServer(createApp(db));
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const db = open();

  const server = createServer(db);
  server.listen(port, host, () => {
    const offices = db.prepare("SELECT COUNT(*) AS n FROM employees WHERE role = 'office'").get().n;
    console.log(`Custom Outdoor Design running on http://localhost:${port}`);
    if (offices === 0) console.log('No office account yet — run "npm run setup" to make one.');
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  }
}

module.exports = { createServer, createApp, match };
