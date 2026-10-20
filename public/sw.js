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

globalThis.addEventListener("push", (event) => {
  let payload = {};

  try {
    payload = event.data?.json() ?? {};
  } catch {
    // A visible fallback also covers empty or malformed pushes.
  }

  event.waitUntil(
    globalThis.registration.showNotification(payload.title || "Pocket", {
      body: payload.body || "Pocket finished. Open Pocket to continue.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: payload.tag || "pocket-turn-complete",
      data: { url: "/" },
    })
  );
});

globalThis.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await globalThis.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((client) => client.url.startsWith(globalThis.location.origin + "/"));

      if (existing) {
        await existing.focus();
      } else {
        await globalThis.clients.openWindow("/");
      }
    })()
  );
});
