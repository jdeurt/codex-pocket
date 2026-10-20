import { type Turn, object } from "../src/lib/protocol";
import {
  completionNotification,
  completionPayload,
  notifyTurnComplete,
  pushPublicKey,
  saveSubscription,
  subscriptionSchema,
} from "../src/server/push";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { notificationDeviceId, notificationPresence } from "../src/server/notification-presence";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import webpush from "web-push";

function subscription(endpoint: string) {
  const key = createECDH("prime256v1");

  key.generateKeys();
  const AUTH_BYTES = 16;

  return {
    endpoint,
    keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(AUTH_BYTES).toString("base64url") },
  };
}

await test("push keys stay stable and concurrent subscription saves preserve both devices with private storage", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-push-"));
  const previous = process.env.CODEX_POCKET_STATE_DIR;

  process.env.CODEX_POCKET_STATE_DIR = directory;

  try {
    const keys = await Promise.all([pushPublicKey(), pushPublicKey()]);

    assert.equal(keys[0], keys[1]);
    const phone = subscription("https://push.example/phone");
    const tablet = subscription("https://push.example/tablet");

    await Promise.all([saveSubscription(phone), saveSubscription(tablet)]);
    await saveSubscription(phone);
    const file = path.join(directory, "push.json");
    const state = object(JSON.parse(await readFile(file, "utf8")));

    assert.deepEqual(state.subscriptions, [tablet, phone]);
    assert.equal(object(state.keys).publicKey, keys[0]);
    const PERMISSION_MASK = 0o777;
    const PRIVATE_FILE_MODE = 0o600;
    const info = await stat(file);

    assert.equal(info.mode & PERMISSION_MASK, PRIVATE_FILE_MODE);
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_POCKET_STATE_DIR;
    } else {
      process.env.CODEX_POCKET_STATE_DIR = previous;
    }

    await rm(directory, { recursive: true, force: true });
  }
});

await test("subscriptions require HTTPS and browser encryption keys", () => {
  const valid = subscription("https://push.example/device");

  assert.deepEqual(subscriptionSchema.parse(valid), valid);
  assert.throws(() => subscriptionSchema.parse({ ...valid, endpoint: "http://push.example/device" }));
  assert.throws(() => subscriptionSchema.parse({ ...valid, keys: { auth: "bad", p256dh: "bad" } }));
});

await test("completion notifications contain the final reply, keep tap routing and use fallbacks without final text", () => {
  const turn: Turn = {
    id: "turn",
    status: "completed",
    items: [
      { id: "progress", type: "agentMessage", phase: "commentary", text: "Still working" },
      { id: "reply", type: "agentMessage", phase: "final_answer", text: "A full response 👋" },
    ],
  };
  const notification = completionNotification("thread", turn);

  assert.equal(notification.title, "Pocket");
  assert.equal(notification.body, "A full response 👋");
  assert.equal(notification.url, "/");
  assert.equal(notification.tag, "thread:turn");
  assert.notEqual(completionNotification("thread", { ...turn, id: "next" }).tag, notification.tag);
  assert.match(completionNotification("thread", { ...turn, items: [turn.items[0]] }).body, /finished/);
  assert.match(completionNotification("thread", { ...turn, status: "failed", items: [] }).body, /stopped/);
  assert.equal(
    completionNotification("thread", {
      ...turn,
      items: [{ id: "legacy", type: "agentMessage", text: "Older Codex reply" }],
    }).body,
    "Older Codex reply"
  );
});

await test("payloads retain full replies that fit and limit actual encrypted bytes without splitting Unicode", () => {
  const device = subscription("https://push.example/size-check");
  const MAX_ENCRYPTED_BYTES = 4096;
  const LONG_REPETITIONS = 5000;
  const SHORT_REPETITIONS = 20;
  const texts = ["All of this reply is included. ".repeat(SHORT_REPETITIONS), '👩🏽‍💻漢字\n\t"\\'.repeat(LONG_REPETITIONS)];

  for (const text of texts) {
    const turn: Turn = { id: "turn", status: "completed", items: [{ id: "reply", type: "agentMessage", text }] };
    const payload = completionPayload("thread", turn);
    const body = object(JSON.parse(payload)).body;

    assert.equal(typeof body, "string");
    assert.ok(text.startsWith(String(body)));
    assert.ok(!String(body).endsWith("…"));
    assert.ok(!String(body).includes("�"));
    const encrypted = webpush.generateRequestDetails(device, payload);

    assert.ok(Buffer.byteLength(encrypted.body) <= MAX_ENCRYPTED_BYTES);

    if (text === texts[0]) {
      assert.equal(body, text.trim());
    } else {
      assert.ok(String(body).length < text.length);
    }
  }
});

await test("delivery skips only the acknowledged foreground device, keeps background delivery and deduplicates", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-push-delivery-"));
  const previousState = process.env.CODEX_POCKET_STATE_DIR;
  const previousThread = process.env.CODEX_THREAD_ID;
  const previousOrigins = process.env.CODEX_ALLOWED_ORIGINS;

  process.env.CODEX_POCKET_STATE_DIR = directory;
  process.env.CODEX_THREAD_ID = "push-test";
  process.env.CODEX_ALLOWED_ORIGINS = "https://pocket.example";
  const phone = subscription("https://push.example/foreground-phone");
  const tablet = subscription("https://push.example/background-tablet");
  const disconnect = notificationPresence.connect(notificationDeviceId(phone.endpoint), (challengeId) => {
    notificationPresence.acknowledge(notificationDeviceId(phone.endpoint), challengeId);
  });
  const sent: { endpoint: string; body: unknown }[] = [];

  t.mock.method(webpush, "sendNotification", (...[device, payload]: Parameters<typeof webpush.sendNotification>) => {
    sent.push({ endpoint: device.endpoint, body: object(JSON.parse(String(payload))).body });

    return Promise.resolve({ statusCode: 201, body: "", headers: {} });
  });

  try {
    await saveSubscription(phone);
    await saveSubscription(tablet);
    const turn: Turn = {
      id: "turn",
      status: "completed",
      items: [{ id: "reply", type: "agentMessage", text: "Done" }],
    };

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
  } finally {
    disconnect();

    for (const [name, value] of Object.entries({
      CODEX_POCKET_STATE_DIR: previousState,
      CODEX_THREAD_ID: previousThread,
      CODEX_ALLOWED_ORIGINS: previousOrigins,
    })) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }

    await rm(directory, { recursive: true, force: true });
  }
});
