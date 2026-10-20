const cacheName = "codex-pocket-static-v1";
const realm = globalThis;

/**
Cache the existing static fallback without caching conversation or API responses.
@returns {Promise<void>} Completion of the offline page's cache write.
*/
async function installOfflinePage() {
  const cache = await globalThis.caches.open(cacheName);

  await cache.addAll(["/offline.html"]);
}

/**
Fetch a navigation normally and use only the static offline page on network failure.
@param {Request} request - Native navigation request intercepted by this worker.
@returns {Promise<Response>} Network response or the existing offline fallback.
*/
async function navigate(request) {
  try {
    return await globalThis.fetch(request);
  } catch {
    return (await globalThis.caches.match("/offline.html")) ?? Response.error();
  }
}

/**
Remove obsolete Pocket static caches before taking control of existing clients.
@param {ServiceWorkerGlobalScope} worker - Actual native service-worker realm.
@returns {Promise<void>} Completion of cache cleanup and client claiming.
*/
async function activate(worker) {
  const keys = await globalThis.caches.keys();

  for (const key of keys) {
    if (key !== cacheName && key.startsWith("codex-pocket-static-")) {
      await globalThis.caches.delete(key);
    }
  }

  await worker.clients.claim();
}

/**
Validate one string field from the shared completion notification protocol.
@param {unknown} value - Field decoded from a push's JSON body.
@param {string} fallback - Existing visible fallback for a missing, empty or invalid field.
@returns {string} Text passed to the browser's notification API.
*/
function notificationText(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
Decode native push JSON without letting an empty or malformed body hide the visible fallback.
@param {PushMessageData | null} data - Browser-provided push body.
@returns {unknown} Untrusted JSON value, or undefined when no valid JSON is present.
*/
function readPushData(data) {
  if (!data) {
    return;
  }

  try {
    return data.json();
  } catch {
    return;
  }
}

/**
Validate the push JSON boundary once and retain the existing visible fallbacks.
@param {PushMessageData | null} data - Native push data, which may be empty or malformed.
@returns {import("../src/lib/notification-payload").NotificationPayload} Normalized completion notification.
*/
function notificationPayload(data) {
  const value = readPushData(data);
  const fields = typeof value === "object" && value !== null ? value : {};

  return {
    title: notificationText("title" in fields ? fields.title : undefined, "Pocket"),
    body: notificationText("body" in fields ? fields.body : undefined, "Pocket finished. Open Pocket to continue."),
    tag: notificationText("tag" in fields ? fields.tag : undefined, "pocket-turn-complete"),
    url: "/",
  };
}

/**
Focus an existing Pocket window or open its root after a notification click.
@param {ServiceWorkerGlobalScope} worker - Native worker whose clients belong to this origin.
@returns {Promise<void>} Completion of the existing focus-or-open operation.
*/
async function openPocket(worker) {
  const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows.find((client) => client.url.startsWith(worker.location.origin + "/"));

  if (existing) {
    await existing.focus();
  } else {
    await worker.clients.openWindow("/");
  }
}

/**
Register the native lifecycle, navigation and notification handlers for this classic worker.
@param {ServiceWorkerGlobalScope} worker - Realm verified at the script entry point.
*/
function registerWorker(worker) {
  worker.addEventListener("install", (event) => {
    event.waitUntil(installOfflinePage());
    void worker.skipWaiting();
  });
  worker.addEventListener("activate", (event) => {
    event.waitUntil(activate(worker));
  });
  worker.addEventListener("fetch", (event) => {
    // Messages, prompts and API requests always go to the computer. Never replay them offline.
    if (event.request.mode === "navigate") {
      event.respondWith(navigate(event.request));
    }
  });
  worker.addEventListener("push", (event) => {
    const payload = notificationPayload(event.data);

    event.waitUntil(
      worker.registration.showNotification(payload.title, {
        body: payload.body,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: payload.tag,
        data: { url: payload.url },
      })
    );
  });
  worker.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(openPocket(worker));
  });
}

if (realm instanceof ServiceWorkerGlobalScope) {
  registerWorker(realm);
}
