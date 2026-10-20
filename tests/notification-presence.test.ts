import { type GET, type POST } from "../src/app/api/notifications/presence/route";
import { NotificationPresence, notificationDeviceId, notificationPresence } from "../src/server/notification-presence";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

const PHONE = "https://push.example/phone";
const TABLET = "https://push.example/tablet";
const PROBE_EXPIRY_MS = 1501;
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;

/**
Check device-specific acknowledgements after the disconnected baseline.
@param presence - Isolated native probe coordinator.
@param phoneId - Identity of the receiving fixture device.
@returns Completion of acknowledgement and disconnect assertions.
*/
async function assertConnected(presence: NotificationPresence, phoneId: string) {
  const disconnect = presence.connect(phoneId, (challengeId) => {
    assert.equal(presence.acknowledge(notificationDeviceId(TABLET), challengeId), false);
    assert.equal(presence.acknowledge(phoneId, challengeId), true);
    assert.equal(presence.acknowledge(phoneId, challengeId), false);
  });

  assert.equal(await presence.isForeground(PHONE), true);
  assert.equal(await presence.isForeground(TABLET), false);
  disconnect();
  assert.equal(await presence.isForeground(PHONE), false);
}

/**
Restore acknowledgements after a suspended connection has expired and disconnected.
@param presence - Probe coordinator retaining no active connection.
@param phoneId - Identity of the receiving fixture device.
@returns Completion of the restored suppression assertion.
*/
async function assertReconnected(presence: NotificationPresence, phoneId: string) {
  const restored = presence.connect(phoneId, (challengeId) => {
    presence.acknowledge(phoneId, challengeId);
  });

  assert.equal(await presence.isForeground(PHONE), true);
  restored();
}

/**
Enable the native test clock before opening a suspended connection.
@param context - Native test context controlling probe expiry.
@param presence - Isolated native coordinator.
@param phoneId - Identity of the fixture device.
@param receive - Suspended page callback retaining its unanswered challenge.
@returns Disconnect operation for this connection.
*/
function connectSuspended(
  context: TestContext,
  presence: NotificationPresence,
  phoneId: string,
  receive: (challengeId: string) => void
) {
  context.mock.timers.enable({ apis: ["setTimeout"] });

  return presence.connect(phoneId, receive);
}

/**
Validate the SSE response and consume its initial frame before issuing a probe.
@param get - Native presence GET handler.
@param deviceId - Receiving fixture device identity.
@param abort - Lifetime of the private event stream.
@returns The response reader after its initial frame.
*/
async function openPresenceStream(get: typeof GET, deviceId: string, abort: AbortController) {
  const response = await get(
    new Request(`http://127.0.0.1:3000/api/notifications/presence?device=${deviceId}`, {
      headers: { host: "127.0.0.1:3000" },
      signal: abort.signal,
    })
  );
  const reader = response.body?.getReader();

  assert.equal(response.status, HTTP_OK);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.ok(reader);
  await reader.read();

  return reader;
}

/**
Decode one native probe and acknowledge it through the same-origin POST route.
@param reader - Connected SSE reader after the initial frame.
@param post - Native acknowledgement handler.
@param deviceId - Receiving fixture device identity.
@returns Challenge identity after successful foreground confirmation.
*/
async function acknowledgeProbe(reader: ReadableStreamDefaultReader<Uint8Array>, post: typeof POST, deviceId: string) {
  const pending = notificationPresence.isForeground(PHONE);
  const probeMessage = await reader.read();
  const probe = new TextDecoder().decode(probeMessage.value);
  const data = probe.split("data: ", 2)[1].trim();
  const { challengeId } = z.object({ challengeId: z.string() }).parse(JSON.parse(data));
  const acknowledge = await post(
    new Request("http://127.0.0.1:3000/api/notifications/presence", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ deviceId, challengeId }),
    })
  );

  assert.deepEqual(await acknowledge.json(), { acknowledged: true });
  assert.equal(await pending, true);

  return challengeId;
}

/**
Require the actual route to reject acknowledgements from a foreign origin.
@param post - Native acknowledgement handler.
@param deviceId - Receiving fixture device identity.
@param challengeId - Previously acknowledged native challenge.
@returns Completion of the forbidden-response assertion.
*/
async function assertForeignOriginRejected(post: typeof POST, deviceId: string, challengeId: string) {
  const rejected = await post(
    new Request("http://127.0.0.1:3000/api/notifications/presence", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "https://untrusted.example", "content-type": "application/json" },
      body: JSON.stringify({ deviceId, challengeId }),
    })
  );

  assert.equal(rejected.status, HTTP_FORBIDDEN);
}

/**
Replay acknowledgement and abort through the real route handlers.
@param get - Native presence GET handler.
@param post - Native same-origin acknowledgement handler.
@param deviceId - Receiving fixture device identity.
@param abort - Lifetime of the private event stream.
@returns Completion of foreground, abort and foreign-origin rejection assertions.
*/
async function replayPresenceRoute(get: typeof GET, post: typeof POST, deviceId: string, abort: AbortController) {
  const reader = await openPresenceStream(get, deviceId, abort);
  const challengeId = await acknowledgeProbe(reader, post, deviceId);

  abort.abort();
  assert.equal(await notificationPresence.isForeground(PHONE), false);
  await reader.cancel();
  await assertForeignOriginRejected(post, deviceId, challengeId);
}

await test("only a fresh acknowledgement from the receiving device suppresses delivery", async () => {
  const presence = new NotificationPresence();
  const phoneId = notificationDeviceId(PHONE);

  assert.equal(await presence.isForeground(PHONE), false);
  await assertConnected(presence, phoneId);
});

await test("suspended connections and late acknowledgements fail open, and reconnects restore suppression", async (t) => {
  let pendingChallenge = "";

  const presence = new NotificationPresence();
  const phoneId = notificationDeviceId(PHONE);

  const disconnect = connectSuspended(t, presence, phoneId, (challengeId) => {
    pendingChallenge = challengeId;
  });
  const pending = presence.isForeground(PHONE);

  t.mock.timers.tick(PROBE_EXPIRY_MS);
  assert.equal(await pending, false);
  assert.equal(presence.acknowledge(phoneId, pendingChallenge), false);
  disconnect();
  await assertReconnected(presence, phoneId);
});

await test("disconnect resolves an in-flight probe without muting the device", async () => {
  const presence = new NotificationPresence();
  const disconnect = presence.connect(notificationDeviceId(PHONE), () => {
    /*
    Simulate a suspended page that cannot acknowledge.
    */
  });
  const pending = presence.isForeground(PHONE);

  disconnect();
  assert.equal(await pending, false);
});

await test("the live presence route carries probes, accepts same-origin acknowledgements and releases aborted streams", async () => {
  const { GET, POST } = await import("../src/app/api/notifications/presence/route");
  const previousThread = process.env.CODEX_THREAD_ID;
  const previousOrigins = process.env.CODEX_ALLOWED_ORIGINS;

  const deviceId = notificationDeviceId(PHONE);
  const abort = new AbortController();

  process.env.CODEX_THREAD_ID = "presence-route-test";
  process.env.CODEX_ALLOWED_ORIGINS = "http://127.0.0.1:3000";

  try {
    await replayPresenceRoute(GET, POST, deviceId, abort);
  } finally {
    abort.abort();

    if (previousThread === undefined) {
      delete process.env.CODEX_THREAD_ID;
    } else {
      process.env.CODEX_THREAD_ID = previousThread;
    }

    if (previousOrigins === undefined) {
      delete process.env.CODEX_ALLOWED_ORIGINS;
    } else {
      process.env.CODEX_ALLOWED_ORIGINS = previousOrigins;
    }
  }
});
