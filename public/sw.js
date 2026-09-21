'use strict';

/* What makes this an app on a phone rather than a page they have to go and
   find. The screen, its stylesheet and its scripts are kept on the handset, so
   tapping the icon opens the app at once — in a basement, in a truck on a bad
   stretch of road, or with one bar at the back of a property.

   The work itself is never cached. Hours, jobs and announcements always come
   from the office; a stale job list is worse than no job list. When the phone
   has nothing to fetch with, the screen says so in plain words instead of
   showing yesterday's work as if it were today's.

   Bump CACHE when any of the files below change, or the old ones stay put. */

var CACHE = 'cod-shell-v1';

var SHELL = [
  '/',
  '/index.html',
  '/crew.html',
  '/office.html',
  '/install.html',
  '/css/app.css',
  '/js/common.js',
  '/js/signin.js',
  '/js/crew.js',
  '/js/office.js',
  '/favicon.svg',
  '/app.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon-180.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.map(function (name) {
          return name === CACHE ? null : caches.delete(name);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Anything the office typed in is asked for fresh, every time.
  if (url.pathname.indexOf('/api/') === 0) return;

  /* The screens themselves: try the office first so an update lands the next
     time there is signal, and fall back to the copy on the phone. */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
          return response;
        })
        .catch(function () {
          return caches.match(request).then(function (hit) {
            return hit || caches.match('/index.html');
          });
        })
    );
    return;
  }

  // Stylesheet, scripts, icons: whatever is on the phone, then top it up.
  event.respondWith(
    caches.match(request).then(function (hit) {
      var fresh = fetch(request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      });

      return hit || fresh;
    }).catch(function () {
      return fetch(request);
    })
  );
});
