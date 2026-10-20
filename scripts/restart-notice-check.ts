import { type Snapshot, type Turn, initialSnapshot, object, snapshotSchema, string } from "../src/lib/protocol";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { once } from "node:events";
import { outboxSchema } from "../src/server/outbox";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";

const replySchema = z.union([
  z.object({ raw: snapshotSchema, visible: snapshotSchema, error: z.undefined().optional() }),
  z.object({ error: z.string() }),
]);

const script = fileURLToPath(import.meta.url);
const fixture = path.resolve("tests/fixtures/restart-rpc.mjs");
const SETTLE_ATTEMPTS = 200;
const SETTLE_INTERVAL_MS = 10;
const PROCESS_TIMEOUT_MS = 15_000;
const RECONNECTS = 8;
const LAST_ITEM = -1;
const events = (state: Snapshot) =>
  state.turns.flatMap((turn) => turn.items).filter((item) => item.type === "pocketRestart");

async function worker() {
  const { Bridge } = await import("../src/server/bridge");
  const { visibleSnapshot } = await import("../src/server/visible-snapshot");
  const bridge = new Bridge();

  process.on("message", (command: { id: string; text?: string }) => {
    void (async () => {
      await bridge.ensureConnected();

      if (command.text) {
        await bridge.send(command.id, command.text);
      }

      for (let retry = 0; retry < SETTLE_ATTEMPTS; retry += 1) {
        if (
          !bridge.snapshot.activeTurnId &&
          bridge.snapshot.queue.every((entry) => entry.status !== "queued" && entry.status !== "sending")
        ) {
          process.send?.({ raw: bridge.snapshot, visible: visibleSnapshot(bridge.snapshot) });

          return;
        }

        await pause(SETTLE_INTERVAL_MS);
      }

      throw new Error("The isolated bridge did not settle.");
    })().catch((error: unknown) => process.send?.({ error: String(error) }));
  });
  process.once("SIGTERM", () => {
    bridge.close();
    process.disconnect();
  });
}

async function check() {
  const { RECOVERY_PROMPT } = await import("../src/server/recovery");
  const directory = path.resolve(".local", "restart-notice-check", crypto.randomUUID());

  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "fake-history.json"), "[]");
  const env = {
    ...process.env,
    CODEX_THREAD_ID: "isolated-restart-check",
    CODEX_CWD: directory,
    CODEX_POCKET_STATE_DIR: directory,
    CODEX_BINARY: process.execPath,
    CODEX_SERVER_ARGS: JSON.stringify([fixture]),
  };

  function start(stateDirectory = directory) {
    const target = fork(script, ["worker"], {
      env: { ...env, CODEX_CWD: stateDirectory, CODEX_POCKET_STATE_DIR: stateDirectory },
      execArgv: ["--import", "tsx"],
      silent: true,
    });

    target.stdout?.resume();
    target.stderr?.pipe(process.stderr);

    return target;
  }

  let child = start();

  async function request(text?: string) {
    const reply = once(child, "message", { signal: AbortSignal.timeout(PROCESS_TIMEOUT_MS) });

    child.send({ id: crypto.randomUUID(), text });
    const replies: unknown[] = await reply;
    const result = replies[0];

    return replySchema.parse(result);
  }

  async function snapshot(text?: string) {
    const result = await request(text);

    assert.equal(result.error, undefined);
    assert.ok("raw" in result && "visible" in result);

    return result;
  }

  async function stop() {
    const exited = once(child, "exit", { signal: AbortSignal.timeout(PROCESS_TIMEOUT_MS) });

    child.kill("SIGTERM");
    await exited;
  }

  async function failedAndPendingChecks() {
    await stop();
    const failureDirectory = path.join(directory, "failed-resume");

    await mkdir(failureDirectory);
    await writeFile(
      path.join(failureDirectory, "fake-history.json"),
      JSON.stringify([
        {
          id: "existing-turn",
          status: "completed",
          items: [{ id: "existing-answer", type: "agentMessage", text: "Existing conversation" }],
        },
      ])
    );
    await writeFile(path.join(failureDirectory, "fail-resume"), "yes");
    child = start(failureDirectory);
    const failed = await request();

    assert.match(failed.error ?? "", /Fixture resume failed/);
    await assert.rejects(readFile(path.join(failureDirectory, "restart-events.json")), { code: "ENOENT" });
    await unlink(path.join(failureDirectory, "fail-resume"));
    await writeFile(path.join(failureDirectory, "fail-history"), "yes");
    const incomplete = await request();

    assert.match(incomplete.error ?? "", /Fixture history failed/);
    await assert.rejects(readFile(path.join(failureDirectory, "restart-events.json")), { code: "ENOENT" });
    await unlink(path.join(failureDirectory, "fail-history"));
    const successful = await snapshot();

    assert.equal(events(successful.visible).length, 1);
    const processes = await readFile(path.join(failureDirectory, "fake-processes.jsonl"), "utf8");
    const failedAttempts = 2;

    assert.equal(processes.trim().split("\n").length, failedAttempts + 1);
    const retried = await snapshot();

    assert.deepEqual(events(retried.visible), events(successful.visible));
    assert.equal(await readFile(path.join(failureDirectory, "fake-processes.jsonl"), "utf8"), processes);
    await stop();
    const outboxFile = path.join(failureDirectory, "outbox.json");
    const outbox = outboxSchema.parse(JSON.parse(await readFile(outboxFile, "utf8")));

    outbox.receipts.push({ id: "pocket-recovery:already-queued", text: RECOVERY_PROMPT, status: "queued" });
    await writeFile(outboxFile, JSON.stringify(outbox));
    child = start(failureDirectory);
    const pending = await snapshot();

    assert.equal(events(pending.visible).length, events(successful.visible).length + 1);
    const inputs = pending.raw.turns
      .flatMap((turn) => turn.items)
      .filter((item) => String(item.clientId).startsWith("pocket-recovery:"));

    assert.equal(inputs.length, 2);
    assert.equal(inputs.filter((item) => item.clientId === "pocket-recovery:already-queued").length, 1);
    const retriedPending = await snapshot();

    assert.deepEqual(events(retriedPending.visible), events(pending.visible));
  }

  async function scenarios() {
    const empty = await snapshot();

    assert.equal(events(empty.visible).length, 0);
    assert.equal(empty.raw.turns.length, 0);
    const original = await snapshot("Original user content must remain unchanged.");

    assert.equal(events(original.visible).length, 0);
    const lastItem = original.raw.turns.at(LAST_ITEM)?.items.at(LAST_ITEM)?.id;

    await stop();
    child = start();
    const restarted = await snapshot();

    assert.equal(events(restarted.visible).length, 1);
    const flattened = restarted.visible.turns.flatMap((turn) => turn.items);
    const index = flattened.findIndex((item) => item.type === "pocketRestart");

    assert.equal(flattened[index - 1].id, lastItem);
    assert.equal(flattened[index + 1].type, "agentMessage");
    assert.equal(
      restarted.raw.turns
        .flatMap((turn) => turn.items)
        .filter((item) => String(item.clientId).startsWith("pocket-recovery:")).length,
      1
    );
    assert.equal(
      flattened.some((item) => String(item.clientId).startsWith("pocket-recovery:")),
      false
    );
    assert.match(JSON.stringify(flattened), /Original user content must remain unchanged/);
    const recovery = restarted.raw.turns
      .flatMap((turn) => turn.items)
      .find((item) => String(item.clientId).startsWith("pocket-recovery:"));

    assert.ok(Array.isArray(recovery?.content));
    assert.equal(string(object(recovery.content[0]).text), RECOVERY_PROMPT);
    const persisted = await readFile(path.join(directory, "restart-events.json"), "utf8");
    const processes = await readFile(path.join(directory, "fake-processes.jsonl"), "utf8");

    assert.equal(processes.trim().split("\n").length, 2);

    for (let retry = 0; retry < RECONNECTS; retry += 1) {
      const reconnected = await snapshot();

      assert.deepEqual(events(reconnected.visible), events(restarted.visible));
    }

    assert.equal(await readFile(path.join(directory, "restart-events.json"), "utf8"), persisted);
    assert.equal(await readFile(path.join(directory, "fake-processes.jsonl"), "utf8"), processes);
    await writeFile(path.join(directory, "snapshot.json"), JSON.stringify(restarted.visible));
    const ordinaryMatching = await snapshot(RECOVERY_PROMPT);

    assert.equal(
      ordinaryMatching.visible.turns
        .flatMap((turn) => turn.items)
        .filter((item) => JSON.stringify(item.content ?? []).includes(RECOVERY_PROMPT)).length,
      1
    );
    await stop();
    child = start();
    const second = await snapshot();

    assert.equal(events(second.visible).length, 2);
    assert.equal(events(second.visible)[0].id, events(restarted.visible)[0].id);
    assert.equal(new Set(events(second.visible).map((item) => item.id)).size, 2);

    // An interrupted turn can resume in place. The event must remain outside collapsed activity.
    await stop();
    const interrupted: Turn = {
      id: "interrupted-work",
      status: "inProgress",
      items: [
        { id: "unfinished-user", type: "userMessage", content: [{ type: "text", text: "Continue the original task" }] },
        { id: "before-restart", type: "agentMessage", phase: "commentary", text: "Work before restart" },
        { id: "old-command", type: "commandExecution", command: "fixture-only" },
      ],
    };

    await writeFile(path.join(directory, "fake-history.json"), JSON.stringify([...second.raw.turns, interrupted]));
    child = start();
    const steered = await snapshot();

    assert.equal(events(steered.visible).length, events(second.visible).length + 1);
    const { turnMessages } = await import("../src/lib/turn-messages");
    const interruptedTurn = steered.visible.turns.find((turn) => turn.id === interrupted.id);

    assert.ok(interruptedTurn);
    const entries = turnMessages(interruptedTurn, false);
    const noticeIndex = entries.findIndex((entry) => entry.kind === "message" && entry.item.type === "pocketRestart");

    assert.ok(noticeIndex > 0);
    assert.equal(entries[noticeIndex - 1].kind, "activity");
    assert.equal(entries[noticeIndex + 1].kind, "message");
    await writeFile(path.join(directory, "steered-snapshot.json"), JSON.stringify(steered.visible));

    // An uncertain recovery instruction must not be replayed just to display a restart.
    await stop();
    const outboxFile = path.join(directory, "outbox.json");
    const outbox = outboxSchema.parse(JSON.parse(await readFile(outboxFile, "utf8")));

    outbox.receipts.push({ id: "pocket-recovery:unknown", text: RECOVERY_PROMPT, status: "unknown" });
    await writeFile(outboxFile, JSON.stringify(outbox));
    child = start();
    const uncertain = await snapshot();

    assert.equal(events(uncertain.visible).length, events(steered.visible).length + 1);
    assert.deepEqual(uncertain.raw.turns, steered.raw.turns);
    assert.equal(uncertain.raw.queue.find((item) => item.id === "pocket-recovery:unknown")?.status, "unknown");
    assert.equal(uncertain.visible.queue.length, 0);

    const { visibleSnapshot } = await import("../src/server/visible-snapshot");

    await import("../tests/fixtures/restart-css-loader.mjs");
    const { verifyRestartProjection } = await import("../tests/fixtures/restart-projection");

    verifyRestartProjection(restarted.visible);
    const mismatched = visibleSnapshot({ ...second.raw, threadId: "other-thread" });

    assert.equal(events(mismatched).length, 0);
    const legacy: Turn = {
      id: "legacy",
      status: "completed",
      items: [
        { id: "old-recovery", type: "userMessage", clientId: "pocket-recovery:historical" },
        { id: "old-answer", type: "agentMessage", text: "An old recovery reply" },
      ],
    };

    assert.equal(events(visibleSnapshot({ ...initialSnapshot, turns: [legacy] })).length, 0);
    const emptyAroundEvent: Snapshot = {
      ...restarted.visible,
      turns: restarted.visible.turns.map((turn) => ({
        ...turn,
        items: [
          { id: `empty-${turn.id}`, type: "agentMessage", text: "  " },
          ...turn.items,
          { id: `empty-user-${turn.id}`, type: "userMessage", content: [] },
        ],
      })),
    };

    verifyRestartProjection(emptyAroundEvent);
    assert.deepEqual(
      emptyAroundEvent.turns
        .flatMap((turn) => turnMessages(turn, false))
        .filter((entry) => entry.kind === "message" && entry.item.type === "pocketRestart"),
      [{ kind: "message", item: events(restarted.visible)[0] }]
    );
    await failedAndPendingChecks();
    console.info(`Restart integration passed. Artifacts: ${directory}`);
  }

  try {
    await scenarios();
  } finally {
    if (child.exitCode === null) {
      await stop();
    }
  }
}

if (process.argv.includes("worker")) {
  await worker();
} else {
  await check();
}
