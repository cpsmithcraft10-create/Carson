'use strict';

const http = require('node:http');
const { open } = require('./src/db');
const auth = require('./src/auth');
const {
  HttpError, sendJson, sendText, readBody, parseCookies, serveStatic,
} = require('./src/http');

const ROUTES = [
  ...require('./src/routes/auth'),
  ...require('./src/routes/worker'),
  ...require('./src/routes/admin'),
].map((route) => ({
  ...route,
  segments: route.path.split('/').filter(Boolean),
  adminOnly: route.path.startsWith('/api/admin'),
}));

/** Matches '/api/my/entries/7' against '/api/my/entries/:id'. */
function match(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);

  for (const route of ROUTES) {
    if (route.method !== method || route.segments.length !== parts.length) continue;

    const params = {};
    let ok = true;

    for (let i = 0; i < parts.length; i += 1) {
      const segment = route.segments[i];
      if (segment.startsWith(':')) params[segment.slice(1)] = parts[i];
      else if (segment !== parts[i]) { ok = false; break; }
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
      serveStatic(req, res, url.pathname);
      return;
    }

    const found = match(req.method, url.pathname);
    if (!found) {
      sendJson(res, 404, { error: 'No such endpoint' });
      return;
    }

    try {
      const token = parseCookies(req.headers.cookie)[auth.COOKIE];
      const user = auth.sessionWorker(db, token);

      if (!found.route.public && !user) {
        throw new HttpError(401, 'Please sign in again');
      }
      if (found.route.adminOnly && (!user || user.role !== 'admin')) {
        throw new HttpError(403, 'Managers only');
      }

      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);

      const result = await found.route.handler({
        req,
        res,
        db,
        user,
        token,
        params: found.params,
        query: Object.fromEntries(url.searchParams),
        body,
      });

      // A handler that wrote its own response (a file download) returns nothing.
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
    const admins = db.prepare("SELECT COUNT(*) AS n FROM workers WHERE role = 'admin'").get().n;
    console.log(`Crew hours running on http://localhost:${port}`);
    if (admins === 0) {
      console.log('No office account yet - run "npm run setup" to make one.');
    }
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
