import { type RestartHost, restartFile } from "./restart-host";
import { type RestartSnapshots, appendRecovery, events } from "./restart-state";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";

/**
Confirms a failed resume leaves no notice and then requests a history-read failure.
@param host - Offline bridge process using the failure directory.
@param directory - Private state directory containing host-selected failure markers.
@returns Completion of the failed-resume checks and next failure setup.
*/
async function failedResume(host: RestartHost, directory: string) {
  const failed = await host.request();

  assert.match(failed.error ?? "", /Fixture resume failed/);
  await assert.rejects(readFile(restartFile(directory)), { code: "ENOENT" });
  await unlink(path.join(directory, "fail-resume"));
  await writeFile(path.join(directory, "fail-history"), "yes");
}

/**
Confirms incomplete history leaves no notice before allowing the next hydration attempt.
@param host - Offline bridge process using the failure directory.
@param directory - Private state directory containing the history failure marker.
@returns Completion of failed-history checks and marker removal.
*/
async function failedHistory(host: RestartHost, directory: string) {
  const incomplete = await host.request();

  assert.match(incomplete.error ?? "", /Fixture history failed/);
  await assert.rejects(readFile(restartFile(directory)), { code: "ENOENT" });
  await unlink(path.join(directory, "fail-history"));
}

/**
Confirms successful hydration creates one notice after the two failed native attempts.
@param host - Offline bridge host whose next request can hydrate successfully.
@param directory - Private native process log directory.
@returns Successfully hydrated snapshot pair for subsequent idempotency checks.
*/
async function successfulRetry(host: RestartHost, directory: string) {
  const successful = await host.snapshot();
  const processes = await readFile(path.join(directory, "fake-processes.jsonl"), "utf8");
  const failedAttempts = 2;

  assert.equal(events(successful.visible).length, 1);
  assert.equal(processes.trim().split("\n").length, failedAttempts + 1);

  return { successful, processes };
}

/**
Proves another request neither repeats a notice nor opens another native process.
@param host - Successfully hydrated offline bridge host.
@param directory - Private native process log directory.
@param successful - Earlier successful canonical and phone snapshots.
@param processes - Exact process log captured after successful hydration.
@returns Completion of retry idempotency checks and confirmed host shutdown.
*/
async function stableRetry(host: RestartHost, directory: string, successful: RestartSnapshots, processes: string) {
  const retried = await host.snapshot();

  assert.deepEqual(events(retried.visible), events(successful.visible));
  assert.equal(await readFile(path.join(directory, "fake-processes.jsonl"), "utf8"), processes);
  await host.stop();
}

/**
Compares a repeated pending-recovery snapshot with its first observed notice set.
@param host - Offline bridge after pending recovery delivery.
@param pending - Snapshot captured after the queued recovery settled.
@returns Completion of notice idempotency checks.
*/
async function stablePending(host: RestartHost, pending: RestartSnapshots) {
  const retriedPending = await host.snapshot();

  assert.deepEqual(events(retriedPending.visible), events(pending.visible));
}

/**
Checks that an already queued recovery is delivered once while restart notices remain idempotent.
@param host - Restarted offline bridge host with a persisted queued recovery receipt.
@param successful - Snapshot before the queued recovery restart.
@returns Completion of pending recovery and retry checks.
*/
async function pendingRecovery(host: RestartHost, successful: RestartSnapshots) {
  const pending = await host.snapshot();
  const inputs = pending.raw.turns
    .flatMap((turn) => turn.items)
    .filter((item) => String(item.clientId).startsWith("pocket-recovery:"));

  assert.equal(events(pending.visible).length, events(successful.visible).length + 1);
  assert.equal(inputs.length, 2);
  assert.equal(inputs.filter((item) => item.clientId === "pocket-recovery:already-queued").length, 1);
  await stablePending(host, pending);
}

/**
Coordinates successful retry and persisted pending recovery after the failure markers are cleared.
@param host - Owned offline bridge host whose next hydration can succeed.
@param directory - Private failure scenario directory.
@returns Completion of successful and pending retry checks.
*/
async function checkRetries(host: RestartHost, directory: string) {
  const { successful, processes } = await successfulRetry(host, directory);

  await stableRetry(host, directory, successful, processes);
  await appendRecovery(directory, "pocket-recovery:already-queued", "queued");
  host.start(directory);
  await pendingRecovery(host, successful);
}

/**
Executes native resume failure, incomplete history, successful retry and queued recovery as one flow.
@param host - Owned offline bridge host, stopped before failure state is prepared.
@param directory - Private parent directory for this integration invocation.
@returns Completion of all failure and pending-recovery scenarios.
*/
export async function failedAndPendingChecks(host: RestartHost, directory: string) {
  const failureDirectory = path.join(directory, "failed-resume");

  await host.stop();
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
  host.start(failureDirectory);
  await failedResume(host, failureDirectory);
  await failedHistory(host, failureDirectory);
  await checkRetries(host, failureDirectory);
}
