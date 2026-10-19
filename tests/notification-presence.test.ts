import { NotificationPresence, notificationDeviceId } from "../src/server/notification-presence";
import assert from "node:assert/strict";
import test from "node:test";

const PHONE = "https://push.example/phone";
const TABLET = "https://push.example/tablet";
const PROBE_EXPIRY_MS = 1501;

test("only a fresh acknowledgement from the receiving device suppresses delivery", async () => {
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

test("suspended connections and late acknowledgements fail open, and reconnects restore suppression", async (t) => {
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

test("disconnect resolves an in-flight probe without muting the device", async () => {
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
