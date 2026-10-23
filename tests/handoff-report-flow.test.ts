import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { updatePocketSettings } from "../src/server/pocket-settings";
import { Bridge } from "../src/server/bridge-session";
import { DelegationStore } from "../src/server/delegations";
import { configSchema } from "../src/server/config";
import { nativeText } from "../src/server/harness/transcript";
import { readLocal } from "../src/server/local-state";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** Exercise active voice handoff, exact text delivery and durable same-ID retries across host restarts.
@param root - Private fixture directory.
*/
async function handoffFlow(root: string) {
  const config = configSchema.parse({
    threadId: "realtime-fixture-parent",
    cwd: root,
    codexBinary: process.execPath,
    serverArgs: [
      "--import",
      path.resolve("node_modules/tsx/dist/loader.mjs"),
      path.resolve("tests/fixtures/realtime-rpc.ts"),
    ],
  });
  const bridge = new Bridge(config);
  const resumed = new Bridge(config);
  const input = {
    id: "voice-receipt",
    transcript: "  Exact finalized speech.\nKeep punctuation! ✓  ",
    source: { type: "realtime" as const, sessionId: "voice-session", itemId: "finalized-item" },
  };

  await mkdir(path.join(root, ".local/realtime-fixture"), { recursive: true });
  const provider = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const previousEndpoint = process.env.POCKET_REALTIME_TEST_URL;

  provider.on("connection", (peer) => {
    peer.once("message", () => {
      peer.send(JSON.stringify({ type: "session.updated" }));
    });
  });
  await once(provider, "listening");
  const address = provider.address();

  assert.ok(address && typeof address === "object");
  process.env.POCKET_REALTIME_TEST_URL = `ws://127.0.0.1:${String(address.port)}/v1/realtime`;
  await updatePocketSettings({ openaiApiKey: "dummy-local-handoff-key" });

  try {
    await bridge.ensureConnected();
    await bridge.realtime.start();
    assert.notEqual(bridge.realtime.status().type, "idle");
    assert.deepEqual(await bridge.handoff(input), { id: input.id, status: "sent" });
    await new Promise<void>((resolve) => {
      const observe = () => {
        const item = bridge.snapshot.turns.flatMap((turn) => turn.items).find((entry) => entry.type === "userMessage");

        if (!(item && nativeText(item.content) === input.transcript)) {
          return;
        }

        bridge.snapshots.removeEventListener("snapshot", observe);
        resolve();
      };

      bridge.snapshots.addEventListener("snapshot", observe);
      observe();
    });
    await assert.rejects(bridge.handoff({ ...input, transcript: "Changed" }), /different content/);
    await assert.rejects(
      bridge.handoff({ ...input, source: { ...input.source, itemId: "another-item" } }),
      /provenance/
    );
    bridge.close();
    await resumed.ensureConnected();
    assert.deepEqual(await resumed.handoff(input), { id: input.id, status: "sent" });
    const saved = await readLocal("outbox.json", null);

    assert.match(JSON.stringify(saved), /finalized-item/);
    assert.equal(resumed.snapshot.turns.length, 0);
  } finally {
    bridge.close();
    resumed.close();

    for (const client of provider.clients) {
      client.terminate();
    }

    await new Promise<void>((resolve) => {
      provider.close(() => {
        resolve();
      });
    });

    if (previousEndpoint === undefined) {
      delete process.env.POCKET_REALTIME_TEST_URL;
    } else {
      process.env.POCKET_REALTIME_TEST_URL = previousEndpoint;
    }
  }
}

/** Follow explicit reports through native completion, subsequent assignments and a reopened durable store.
@param root - Private fixture database directory.
*/
function reportFlow(root: string) {
  const store = new DelegationStore(root);
  const owner = "report-parent";

  store.saveParent(owner, { cwd: root, policy: { sandbox: "danger-full-access", approval: "never" } });
  const child = store.create(owner, { title: "Worker", body: "Complete work", idempotencyKey: "first" });
  const command = store.queue.claim(owner, child.id);

  assert.ok(command);
  store.mail.message(child.id, command.id, { message: "Progress" });
  store.mail.message(child.id, command.id, { message: "Original final report" });
  assert.ok(store.reports.list(owner).every((report) => !report.final));
  store.queue.recordResult(command, "completed", JSON.stringify({ status: "completed", text: "native result" }));
  assert.equal(store.reports.list(owner).filter((report) => report.final).length, 1);
  const final = store.reports.list(owner).find((report) => report.final);

  assert.ok(final);
  assert.equal(final.text, "Original final report");
  assert.deepEqual(final.final, { commandId: command.id, outcome: "completed" });
  store.queue.send(owner, child.id, "follow-up", "More work", "queue", []);
  const next = store.queue.claim(owner, child.id);

  assert.ok(next);
  store.mail.message(child.id, next.id, { message: "Follow-up progress" });
  store.queue.recordResult(next, "completed", JSON.stringify({ status: "interrupted", text: "Interrupted" }));
  const legacy = store.create(owner, {
    title: "Legacy worker",
    body: "Saved legacy work",
    idempotencyKey: "legacy",
  });
  const legacyCommand = store.queue.claim(owner, legacy.id);

  assert.ok(legacyCommand);
  store.mail.message(legacy.id, legacyCommand.id, { message: "Legacy original report" });
  store.queue.finish(legacyCommand, "completed", "offline fixture");
  assert.equal(store.reports.list(owner).filter((report) => report.final).length, 1);
  store.close();
  const restored = new DelegationStore(root);

  assert.deepEqual(restored.reports.list(owner).find((report) => report.final)?.final, final.final);
  assert.deepEqual(restored.reports.list("another-parent"), []);
  restored.close();
}

await test("voice handoff preserves finalized speech and successful delegate completion has durable provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pocket-handoff-flow-"));
  const previous = process.env.CODEX_POCKET_STATE_DIR;

  process.env.CODEX_POCKET_STATE_DIR = root;

  try {
    await handoffFlow(root);
    reportFlow(root);
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_POCKET_STATE_DIR;
    } else {
      process.env.CODEX_POCKET_STATE_DIR = previous;
    }

    await rm(root, { recursive: true, force: true });
  }
});
