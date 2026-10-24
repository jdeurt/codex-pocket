import { t as captureResult } from "try";
import { type Turn, object } from "../../src/lib/protocol";
import { notifyTurnComplete, saveSubscription } from "../../src/server/push";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { notificationDeviceId, notificationPresence } from "../../src/server/notification-presence";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import webpush from "web-push";
import { z } from "zod";

/**
Replay silent and hidden native completions through persistence without claiming a notification receipt.
@param sent - Captured outbound deliveries, which must remain empty throughout.
*/
async function replaySilentTurns(sent: { endpoint: string; body: unknown }[]) {
  const WHITESPACE_LENGTH = 3;
  const outputs = [
    [],
    [{ id: "blank", type: "agentMessage", phase: "final_answer", text: " ".repeat(WHITESPACE_LENGTH) }],
    [{ id: "commentary", type: "agentMessage", phase: "commentary", text: "Working" }],
    [{ id: "tool", type: "commandExecution", command: "true", status: "completed" }],
  ];

  for (const items of outputs) {
    await notifyTurnComplete("thread", { id: "turn", status: "completed", items });
    assert.deepEqual(sent, []);
  }
}

/**
Creates valid ephemeral Web Push subscription keys for the private delivery fixture.
@param endpoint - Private fixture endpoint receiving the encrypted push.
@returns Native subscription with valid P-256 and authentication key material.
*/
function subscription(endpoint: string) {
  const key = createECDH("prime256v1");
  const AUTH_BYTES = 16;

  key.generateKeys();

  return {
    endpoint,
    keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(AUTH_BYTES).toString("base64url") },
  };
}

/**
Replay foreground suppression, deduplication and background delivery with native subscriptions.
@param context - Native test context installing the outbound delivery spy.
@param sent - Captured outbound native payloads for the private replay.
@returns Completion of all device routing assertions.
*/
async function replayDelivery(context: TestContext, sent: { endpoint: string; body: unknown }[]) {
  const phone = subscription("https://push.example/foreground-phone");
  const tablet = subscription("https://push.example/background-tablet");
  const disconnect = notificationPresence.connect(notificationDeviceId(phone.endpoint), (challengeId) => {
    notificationPresence.acknowledge(notificationDeviceId(phone.endpoint), challengeId);
  });

  context.mock.method(
    webpush,
    "sendNotification",
    (...[device, payload]: Parameters<typeof webpush.sendNotification>) => {
      const encoded = z.string().parse(payload);
      const message = object(JSON.parse(encoded));

      sent.push({ endpoint: device.endpoint, body: message.body });

      return Promise.resolve({ statusCode: 201, body: "", headers: {} });
    }
  );

  context.after(disconnect);

  const turn: Turn = {
    id: "turn",
    status: "completed",
    items: [{ id: "reply", type: "agentMessage", text: "Done" }],
  };

  await saveSubscription(phone);
  await saveSubscription(tablet);

  await replaySilentTurns(sent);
  await notifyTurnComplete("thread", turn);
  await notifyTurnComplete("thread", turn);
  assert.deepEqual(sent, [{ endpoint: tablet.endpoint, body: "Done" }]);
  disconnect();
  await notifyTurnComplete("thread", { ...turn, id: "background" });
  assert.deepEqual(
    sent
      .slice(1)
      .map((entry) => entry.endpoint)
      .toSorted((a, b) => a.localeCompare(b)),
    [phone.endpoint, tablet.endpoint].toSorted((a, b) => a.localeCompare(b))
  );
}

await test("delivery skips only the acknowledged foreground device, keeps background delivery and deduplicates", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-push-delivery-"));
  const previousState = process.env.CODEX_POCKET_STATE_DIR;
  const previousThread = process.env.CODEX_THREAD_ID;
  const previousOrigins = process.env.CODEX_ALLOWED_ORIGINS;
  const sent: { endpoint: string; body: unknown }[] = [];

  process.env.CODEX_POCKET_STATE_DIR = directory;
  process.env.CODEX_THREAD_ID = "push-test";
  process.env.CODEX_ALLOWED_ORIGINS = "https://pocket.example";

  const completed = await captureResult(replayDelivery(t, sent));

  const previousEnvironment = {
    CODEX_POCKET_STATE_DIR: previousState,
    CODEX_THREAD_ID: previousThread,
    CODEX_ALLOWED_ORIGINS: previousOrigins,
  };

  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }

  await rm(directory, { recursive: true, force: true });

  if (!completed.ok) {
    throw completed.error;
  }
});
