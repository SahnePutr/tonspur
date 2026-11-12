'use strict';

// ============================================================================
// Service Worker: läuft im Hintergrund und macht die App offline-fähig.
// Er legt die Dateien der App (HTML, CSS, JavaScript, Symbole) in einen
// Zwischenspeicher ("Cache"). Die Musik liegt nicht hier, sondern in der
// Datenbank (siehe speicher.js).
//
// Regel: Erst das Internet fragen, damit Updates sofort ankommen.
//        Ohne Internet die gespeicherte Fassung nehmen.
// ============================================================================

const CACHE = 'tonspur-app-v1';
const APP_DATEIEN = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'speicher.js',
  'id3.js',
  'manifest.webmanifest',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// Beim Installieren: alle App-Dateien einmal herunterladen und ablegen.
self.addEventListener('install', ereignis => {
  ereignis.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_DATEIEN)));
  self.skipWaiting();
});

// Beim Aktivieren: alte Zwischenspeicher früherer Versionen aufräumen.
self.addEventListener('activate', ereignis => {
  ereignis.waitUntil(
    caches.keys()
      .then(namen => Promise.all(namen.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Bei jeder Anfrage der App nach einer ihrer Dateien:
self.addEventListener('fetch', ereignis => {
  const anfrage = ereignis.request;
  if (anfrage.method !== 'GET' || new URL(anfrage.url).origin !== self.location.origin) return;

  ereignis.respondWith(
    fetch(anfrage)
      .then(antwort => {
        // Frische Fassung für das nächste Mal ohne Internet aufheben
        const kopie = antwort.clone();
        caches.open(CACHE).then(cache => cache.put(anfrage, kopie));
        return antwort;
      })
      .catch(() => caches.match(anfrage, { ignoreSearch: true }).then(treffer => treffer || caches.match('index.html')))
  );
});
