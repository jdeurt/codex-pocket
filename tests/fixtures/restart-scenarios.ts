import { type RestartHost, restartFile } from "./restart-host";
import { type RestartSnapshots, appendRecovery, events } from "./restart-state";
import { type Snapshot, type Turn, initialSnapshot, object, string } from "../../src/lib/protocol";
import { readFile, writeFile } from "node:fs/promises";
import { RECOVERY_PROMPT } from "../../src/server/recovery";
import assert from "node:assert/strict";
import { failedAndPendingChecks } from "./restart-failures";
import path from "node:path";
import { turnMessages } from "../../src/lib/turn-messages";
import { visibleSnapshot } from "../../src/server/visible-snapshot";
import { readInternalContext } from "./internal-context";

const RECONNECTS = 8;
const LAST_ITEM = -1;

/**
Checks the first restart notice's placement and hides only the reserved recovery instruction.
@param restarted - First successful restart snapshots.
@param lastItem - Last native item before the process restart.
*/
function verifyFirstRestart(restarted: RestartSnapshots, lastItem: string | undefined) {
  const flattened = restarted.visible.turns.flatMap((turn) => turn.items);
  const index = flattened.findIndex((item) => item.type === "pocketRestart");
  const recovery = restarted.raw.turns
    .flatMap((turn) => turn.items)
    .find((item) => String(item.clientId).startsWith("pocket-recovery:"));

  assert.equal(events(restarted.visible).length, 1);
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
  assert.ok(Array.isArray(recovery?.content));
  const envelope = readInternalContext(string(object(recovery.content[0]).text));

  assert.equal(envelope.content, RECOVERY_PROMPT);
  assert.equal(envelope.source, `restart_recovery:${String(recovery.clientId)}`);
}

/**
Proves repeated hydration neither starts another native process nor changes persisted restart events.
@param host - Offline bridge after the first successful restart.
@param directory - Private bridge and native process state root.
@param restarted - First restart snapshots used as the stable reference.
@returns Completion of repeated reconnect and durable-file checks.
*/
async function stableReconnects(host: RestartHost, directory: string, restarted: RestartSnapshots) {
  const persisted = await readFile(restartFile(directory), "utf8");
  const processes = await readFile(path.join(directory, "fake-processes.jsonl"), "utf8");

  assert.equal(processes.trim().split("\n").length, 2);

  for (let retry = 0; retry < RECONNECTS; retry += 1) {
    const reconnected = await host.snapshot();

    assert.deepEqual(events(reconnected.visible), events(restarted.visible));
  }

  assert.equal(await readFile(restartFile(directory), "utf8"), persisted);
  assert.equal(await readFile(path.join(directory, "fake-processes.jsonl"), "utf8"), processes);
  await writeFile(path.join(directory, "snapshot.json"), JSON.stringify(restarted.visible));
}

/**
Confirms the first native restart and its subsequent reconnects against saved state.
@param host - Newly restarted offline bridge.
@param directory - Private state directory.
@param lastItem - Last native item before process exit.
@returns First restart snapshots after all reconnect checks pass.
*/
async function firstRestart(host: RestartHost, directory: string, lastItem: string | undefined) {
  const restarted = await host.snapshot();

  verifyFirstRestart(restarted, lastItem);
  await stableReconnects(host, directory, restarted);

  return restarted;
}

/**
Sends an ordinary user message and restarts only the owned bridge process.
@param host - Empty offline bridge host.
@param directory - Private state directory.
@returns First successfully restarted native and phone snapshots.
*/
async function originalMessage(host: RestartHost, directory: string) {
  const original = await host.snapshot("Original user content must remain unchanged.");
  const lastItem = original.raw.turns.at(LAST_ITEM)?.items.at(LAST_ITEM)?.id;

  assert.equal(events(original.visible).length, 0);
  await host.stop();
  host.start();

  return await firstRestart(host, directory, lastItem);
}

/**
Checks a new process creates a distinct notice without replacing the earlier notice identity.
@param host - Restarted offline bridge after an ordinary matching-text message.
@param restarted - First restart snapshots.
@returns Second restart snapshots with both stable notice identities.
*/
async function secondRestart(host: RestartHost, restarted: RestartSnapshots) {
  const second = await host.snapshot();

  assert.equal(events(second.visible).length, 2);
  assert.equal(events(second.visible)[0].id, events(restarted.visible)[0].id);
  assert.equal(new Set(events(second.visible).map((item) => item.id)).size, 2);

  return second;
}

/**
Preserves ordinary user text even when it exactly matches the reserved recovery prompt.
@param host - Offline bridge after the first restart and stable reconnects.
@param restarted - First restart snapshots.
@returns Second restart snapshots after the ordinary user-message check.
*/
async function matchingUserText(host: RestartHost, restarted: RestartSnapshots) {
  const ordinaryMatching = await host.snapshot(RECOVERY_PROMPT);

  assert.equal(
    ordinaryMatching.visible.turns
      .flatMap((turn) => turn.items)
      .filter((item) => JSON.stringify(item.content ?? []).includes(RECOVERY_PROMPT)).length,
    1
  );
  await host.stop();
  host.start();

  return await secondRestart(host, restarted);
}

/**
Checks restart messages remain outside the interrupted turn's collapsed activity.
@param interruptedTurn - Canonical visible turn found after native steering completes.
*/
function verifySteeredProjection(interruptedTurn: Turn) {
  const entries = turnMessages(interruptedTurn, false);
  const noticeIndex = entries.findIndex((entry) => entry.kind === "message" && entry.item.type === "pocketRestart");

  assert.ok(noticeIndex > 0);
  assert.equal(entries[noticeIndex - 1].kind, "activity");
  assert.equal(entries[noticeIndex + 1].kind, "message");
}

/**
Confirms recovery steers the saved interrupted turn and persists its visible transcript.
@param host - Offline bridge reopened with interrupted native history.
@param directory - Private state directory.
@param second - Snapshot before the interrupted restart.
@param interruptedId - Native interrupted turn identity.
@returns Snapshot after successful in-place recovery and projection checks.
*/
async function confirmedSteer(host: RestartHost, directory: string, second: RestartSnapshots, interruptedId: string) {
  const steered = await host.snapshot();
  const interruptedTurn = steered.visible.turns.find((turn) => turn.id === interruptedId);

  assert.equal(events(steered.visible).length, events(second.visible).length + 1);
  assert.ok(interruptedTurn);
  verifySteeredProjection(interruptedTurn);
  await writeFile(path.join(directory, "steered-snapshot.json"), JSON.stringify(steered.visible));

  return steered;
}

/**
Reopens a persisted in-progress turn containing both original commentary and native activity.
@param host - Owned offline bridge process.
@param directory - Private history directory.
@param second - Snapshot whose canonical history precedes the interrupted turn.
@returns Snapshot after native recovery steers the interrupted turn in place.
*/
async function interruptedRecovery(host: RestartHost, directory: string, second: RestartSnapshots) {
  const interrupted: Turn = {
    id: "interrupted-work",
    status: "inProgress",
    items: [
      { id: "unfinished-user", type: "userMessage", content: [{ type: "text", text: "Continue the original task" }] },
      { id: "before-restart", type: "agentMessage", phase: "commentary", text: "Work before restart" },
      { id: "old-command", type: "commandExecution", command: "fixture-only" },
    ],
  };

  await host.stop();
  await writeFile(path.join(directory, "fake-history.json"), JSON.stringify([...second.raw.turns, interrupted]));
  host.start();

  return await confirmedSteer(host, directory, second, interrupted.id);
}

/**
Checks uncertain delivery is not replayed merely to display a new restart notice.
@param host - Offline bridge reopened with an uncertain recovery receipt.
@param steered - Canonical state before the uncertain restart.
@returns Completion of unknown-delivery and hidden-queue checks.
*/
async function confirmedUncertainty(host: RestartHost, steered: RestartSnapshots) {
  const uncertain = await host.snapshot();

  assert.equal(events(uncertain.visible).length, events(steered.visible).length + 1);
  assert.deepEqual(uncertain.raw.turns, steered.raw.turns);
  assert.equal(uncertain.raw.queue.find((item) => item.id === "pocket-recovery:unknown")?.status, "unknown");
  assert.equal(uncertain.visible.queue.length, 0);
}

/**
Loads the actual component projection only after registering the test-only CSS loader.
@returns Real restart projection verifier with inert CSS evaluation for native SSR.
*/
async function loadProjection() {
  await import("./restart-css-loader.mjs");

  return await import("./restart-projection");
}

/**
Checks actual writable/read-only component projection and silent rows around restart notices.
@param restarted - First restart snapshot with exactly one notice.
@param second - Later raw snapshot used to verify thread-scope isolation.
@returns Completion of canonical and rendered transcript checks.
*/
async function componentProjection(restarted: RestartSnapshots, second: RestartSnapshots) {
  const { verifyRestartProjection } = await loadProjection();
  const mismatched = visibleSnapshot({ ...second.raw, threadId: "other-thread" });
  const legacy: Turn = {
    id: "legacy",
    status: "completed",
    items: [
      { id: "old-recovery", type: "userMessage", clientId: "pocket-recovery:historical" },
      { id: "old-answer", type: "agentMessage", text: "An old recovery reply" },
    ],
  };
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

  verifyRestartProjection(restarted.visible);
  assert.equal(events(mismatched).length, 0);
  assert.equal(events(visibleSnapshot({ ...initialSnapshot, turns: [legacy] })).length, 0);
  verifyRestartProjection(emptyAroundEvent);
  assert.deepEqual(
    emptyAroundEvent.turns
      .flatMap((turn) => turnMessages(turn, false))
      .filter((entry) => entry.kind === "message" && entry.item.type === "pocketRestart"),
    [{ kind: "message", item: events(restarted.visible)[0] }]
  );
}

/**
Coordinates snapshot handoffs between ordinary, interrupted and uncertain recovery phases.
@param host - Owned offline bridge host after its empty-state assertions.
@param directory - Fresh private state directory.
@returns Completion of all persisted restart scenarios.
*/
async function persistedRecovery(host: RestartHost, directory: string) {
  const restarted = await originalMessage(host, directory);
  const second = await matchingUserText(host, restarted);
  const steered = await interruptedRecovery(host, directory, second);

  await host.stop();
  await appendRecovery(directory, "pocket-recovery:unknown", "unknown");
  host.start();
  await confirmedUncertainty(host, steered);
  await componentProjection(restarted, second);
  await failedAndPendingChecks(host, directory);
  console.info(`Restart integration passed. Artifacts: ${directory}`);
}

/**
Runs the full existing offline native restart and durable recovery workflow.
@param host - Owned fake bridge process, closed by the caller after this flow.
@param directory - Fresh private native and bridge state directory.
@returns Completion of restart, recovery, component projection and failure scenarios.
*/
export async function restartScenarios(host: RestartHost, directory: string) {
  const empty = await host.snapshot();

  assert.equal(events(empty.visible).length, 0);
  assert.equal(empty.raw.turns.length, 0);
  await persistedRecovery(host, directory);
}
