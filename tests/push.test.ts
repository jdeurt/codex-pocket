import { completionNotification, pushPublicKey, saveSubscription, subscriptionSchema } from "../src/server/push";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import assert from "node:assert/strict";
import { object } from "../src/lib/protocol";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

function subscription(endpoint: string) {
  const key = createECDH("prime256v1");
  key.generateKeys();
  const AUTH_BYTES = 16;

  return {
    endpoint,
    keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(AUTH_BYTES).toString("base64url") },
  };
}

test("push keys stay stable and concurrent subscription saves preserve both devices with private storage", async () => {
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

test("subscriptions require HTTPS and browser encryption keys", () => {
  const valid = subscription("https://push.example/device");
  assert.deepEqual(subscriptionSchema.parse(valid), valid);
  assert.throws(() => subscriptionSchema.parse({ ...valid, endpoint: "http://push.example/device" }));
  assert.throws(() => subscriptionSchema.parse({ ...valid, keys: { auth: "bad", p256dh: "bad" } }));
});

test("completion notifications distinguish turns without putting conversation text on the lock screen", () => {
  const turn = {
    id: "turn",
    status: "completed",
    items: [{ id: "reply", type: "agentMessage", text: "Private response" }],
  };
  const notification = completionNotification("thread", turn);
  assert.equal(notification.url, "/");
  assert.equal(notification.tag, "thread:turn");
  assert.ok(!notification.body.includes("Private response"));
  assert.notEqual(completionNotification("thread", { ...turn, id: "next" }).tag, notification.tag);
  assert.match(completionNotification("thread", { ...turn, status: "failed" }).body, /stopped/);
});
