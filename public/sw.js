/* global caches, fetch, Response */
const cacheName = "codex-pocket-static-v1";

async function installOfflinePage() {
  const cache = await caches.open(cacheName);
  await cache.addAll(["/offline.html"]);
}

async function navigate(request) {
  try {
    return await fetch(request);
  } catch {
    return (await caches.match("/offline.html")) ?? Response.error();
  }
}

globalThis.addEventListener("install", (event) => {
  event.waitUntil(installOfflinePage());
  globalThis.skipWaiting();
});
globalThis.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("codex-pocket-static-") && key !== cacheName) {
          await caches.delete(key);
        }
      }

      await globalThis.clients.claim();
    })()
  );
});
globalThis.addEventListener("fetch", (event) => {
  // Messages, prompts and API requests always go to the computer. Never replay them offline.
  if (event.request.mode === "navigate") {
    event.respondWith(navigate(event.request));
  }
});
