'use strict';

/* What has to be true for the app to land on a phone's home screen: the
   manifest is served as a manifest, the icons it names are really there, and
   the service worker never quietly caches the office's own work. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { open } = require('../src/db');
const { createServer } = require('../server');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

async function startApp() {
  const db = open(':memory:');
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

test('the manifest is served as one, and every icon it names exists', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const res = await fetch(`${app.base}/app.webmanifest`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/manifest\+json/);

  const manifest = JSON.parse(await res.text());
  assert.strictEqual(manifest.display, 'standalone');
  assert.strictEqual(manifest.start_url, '/');

  // Android will not offer to install without a 192 and a 512.
  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes('192x192'), 'needs a 192');
  assert.ok(sizes.includes('512x512'), 'needs a 512');
  assert.ok(
    manifest.icons.some((icon) => icon.purpose === 'maskable'),
    'needs one the phone can crop to its own shape',
  );

  for (const icon of manifest.icons) {
    const got = await fetch(app.base + icon.src);
    assert.strictEqual(got.status, 200, `${icon.src} is missing`);
    assert.strictEqual(got.headers.get('content-type'), 'image/png');
  }
});

test('iOS gets a square icon of its own', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const res = await fetch(`${app.base}/icons/apple-touch-icon-180.png`);
  assert.strictEqual(res.status, 200);

  const head = Buffer.from(await res.arrayBuffer()).subarray(0, 8);
  assert.deepStrictEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('every screen points a phone at the manifest and the icon', () => {
  for (const page of ['index.html', 'crew.html', 'office.html', 'install.html']) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
    assert.match(html, /rel="manifest" href="\/app\.webmanifest"/, `${page} has no manifest`);
    assert.match(html, /rel="apple-touch-icon"/, `${page} has no iOS icon`);
    assert.match(html, /name="theme-color"/, `${page} has no theme colour`);
  }
});

test('the service worker keeps the screens but never the work', () => {
  const sw = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');

  // Anything under /api/ is handed straight back to the network.
  assert.match(sw, /\/api\//, 'the API has to be named, to be excluded');

  const shell = sw.slice(sw.indexOf('var SHELL'), sw.indexOf('self.addEventListener'));
  assert.ok(!shell.includes('/api/'), 'no API call belongs in the cached shell');

  for (const file of ['/css/app.css', '/js/common.js', '/crew.html']) {
    assert.ok(shell.includes(`'${file}'`), `${file} should be kept on the phone`);
  }

  // Every file it promises to cache has to exist, or installing it fails
  // outright and the app never goes offline at all.
  const listed = shell.match(/'\/[^']*'/g).map((quoted) => quoted.slice(1, -1));
  for (const file of listed) {
    if (file === '/') continue;
    assert.ok(
      fs.existsSync(path.join(PUBLIC_DIR, file.replace(/^\//, ''))),
      `sw.js caches ${file}, which is not in public/`,
    );
  }
});
