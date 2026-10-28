// sw.js — Service Worker for PWA

const CACHE_NAME = 'investingview-v24-ticker-modal-resume';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/css/ui-consistency.css',
  '/css/ui-makeover.css',
  '/css/ui-components.css',
  '/css/chart-modal.css',
  '/css/market-ticker.css',
  '/js/components/market-ticker.js',
  '/js/components/market-ticker-settings.js',
  '/js/app.js',
  '/js/api.js',
  '/js/components/chart-modal.js',
  '/js/components/chart-search.js',
  '/js/components/chart-renderer.js',
  '/js/components/chart-utils.js',
  '/js/components/dominant-pattern.mjs',
  '/screens/chart-modal.html',
  '/js/components/volume-profile.js',
  '/manifest.json',
  '/assets/icons/apple-touch-icon.png',
  '/assets/icons/icon-192x192.png',
  '/assets/icons/icon-512x512.png',
  '/assets/icons/icon-maskable-512x512.png'
];

// Install event — cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate event — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch event — network first, fallback to cache
self.addEventListener('fetch', (event) => {
  // Skip API calls
  if (event.request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Clone the response
        const responseClone = response.clone();
        
        // Cache the response
        caches.open(CACHE_NAME)
          .then((cache) => cache.put(event.request, responseClone));
        
        return response;
      })
      .catch(() => {
        // Fallback to cache
        return caches.match(event.request);
      })
  );
});
