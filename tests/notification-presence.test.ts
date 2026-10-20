import { NotificationPresence, notificationDeviceId } from "../src/server/notification-presence";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

const PHONE = "https://push.example/phone";
const TABLET = "https://push.example/tablet";
const PROBE_EXPIRY_MS = 1501;

await test("only a fresh acknowledgement from the receiving device suppresses delivery", async () => {
  const presence = new NotificationPresence();
  const phoneId = notificationDeviceId(PHONE);

  assert.equal(await presence.isForeground(PHONE), false);
  const disconnect = presence.connect(phoneId, (challengeId) => {
    assert.equal(presence.acknowledge(notificationDeviceId(TABLET), challengeId), false);
    assert.equal(presence.acknowledge(phoneId, challengeId), true);
    assert.equal(presence.acknowledge(phoneId, challengeId), false);
  });

  assert.equal(await presence.isForeground(PHONE), true);
  assert.equal(await presence.isForeground(TABLET), false);
  disconnect();
  assert.equal(await presence.isForeground(PHONE), false);
});

await test("suspended connections and late acknowledgements fail open, and reconnects restore suppression", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const presence = new NotificationPresence();
  const phoneId = notificationDeviceId(PHONE);

  let pendingChallenge = "";

  const disconnect = presence.connect(phoneId, (challengeId) => {
    pendingChallenge = challengeId;
  });
  const pending = presence.isForeground(PHONE);

  t.mock.timers.tick(PROBE_EXPIRY_MS);
  assert.equal(await pending, false);
  assert.equal(presence.acknowledge(phoneId, pendingChallenge), false);
  disconnect();
  const restored = presence.connect(phoneId, (challengeId) => {
    presence.acknowledge(phoneId, challengeId);
  });

  assert.equal(await presence.isForeground(PHONE), true);
  restored();
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
  const { notificationPresence } = await import("../src/server/notification-presence");
  const previousThread = process.env.CODEX_THREAD_ID;
  const previousOrigins = process.env.CODEX_ALLOWED_ORIGINS;

  process.env.CODEX_THREAD_ID = "presence-route-test";
  process.env.CODEX_ALLOWED_ORIGINS = "http://127.0.0.1:3000";
  const deviceId = notificationDeviceId(PHONE);
  const abort = new AbortController();

  try {
    const response = await GET(
      new Request(`http://127.0.0.1:3000/api/notifications/presence?device=${deviceId}`, {
        headers: { host: "127.0.0.1:3000" },
        signal: abort.signal,
      })
    );
    const HTTP_OK = 200;

    assert.equal(response.status, HTTP_OK);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body?.getReader();

    assert.ok(reader);
    await reader.read();
    const pending = notificationPresence.isForeground(PHONE);
    const probeMessage = await reader.read();
    const probe = new TextDecoder().decode(probeMessage.value);
    const data = probe.split("data: ", 2)[1].trim();
    const { challengeId } = z.object({ challengeId: z.string() }).parse(JSON.parse(data));
    const acknowledge = await POST(
      new Request("http://127.0.0.1:3000/api/notifications/presence", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
        body: JSON.stringify({ deviceId, challengeId }),
      })
    );

    assert.deepEqual(await acknowledge.json(), { acknowledged: true });
    assert.equal(await pending, true);
    abort.abort();
    assert.equal(await notificationPresence.isForeground(PHONE), false);
    await reader.cancel();
    const rejected = await POST(
      new Request("http://127.0.0.1:3000/api/notifications/presence", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", origin: "https://untrusted.example", "content-type": "application/json" },
        body: JSON.stringify({ deviceId, challengeId }),
      })
    );
    const HTTP_FORBIDDEN = 403;

    assert.equal(rejected.status, HTTP_FORBIDDEN);
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
