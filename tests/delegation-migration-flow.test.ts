import { type SidePocket, delegationCommandSchema } from "../src/server/delegation-data";
import { TEST_TIMEOUT_MS, assignment, fixture, owner, state, tool } from "./fixtures/delegation-flow";
import { type NativeFlow, correction, transcript } from "./fixtures/delegation-native";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

/**
Restore the deployed queue-only table shape while retaining the fixture's original assignment rows.
@param directory - Explicit private fixture state, never a live database.
*/
function queueOnlySchema(directory: string) {
  const db = new Database(path.join(directory, "delegations.sqlite"));

  try {
    db.exec(`ALTER TABLE delegation_commands DROP COLUMN mode;
      ALTER TABLE delegation_commands DROP COLUMN targetId;
      ALTER TABLE delegation_commands DROP COLUMN turnId;
      ALTER TABLE delegation_commands DROP COLUMN supersedes;`);
  } finally {
    db.close();
  }
}

/**
Verify cancelled assignment corrections cannot restart while the retained native task runs.
@param native - Real offline worker, native replay and MCP ownership.
@param child - Child retained through the schema upgrade.
*/
async function verifyHistory(native: NativeFlow, child: SidePocket) {
  const history = await transcript(native, child);

  assert.equal(history.length, 1);
  assert.deepEqual(
    history[0].items.map((item) => item.text),
    ["retained task", "continue retained work"]
  );
}

/**
Verify the upgraded native worker executes unrelated retained work and accepts current-task steering.
@param flow - Private durable fixture after its queue-only database has been migrated by MCP.
@param client - Real parent MCP client owning the retained assignment.
@param child - Original managed identity from before schema adoption.
*/
async function runRetained(
  flow: Awaited<ReturnType<typeof fixture>>,
  client: Awaited<ReturnType<typeof flow.mcp>>,
  child: SidePocket
) {
  const worker = await flow.peer("native");
  const native = { flow, worker, client };

  await worker.until((events) =>
    events.some(
      (event) => event.event === "started" && event.childId === child.id && event.text === "ready:retained task"
    )
  );
  await correction(native, child, "continue retained work", "migrated-correction", "accepted");
  await verifyHistory(native, child);
}

/**
Withdraw a never-started obsolete assignment and its attached corrections while preserving separate work.
@param flow - Private migrated fixture.
@param client - Parent's real MCP client.
@param child - Managed child with no native turn yet.
*/
async function cancelObsolete(
  flow: Awaited<ReturnType<typeof fixture>>,
  client: Awaited<ReturnType<typeof flow.mcp>>,
  child: SidePocket
) {
  const initial = flow.store.queue.list(owner, child.id)[0];
  const pending = delegationCommandSchema.parse(
    await tool(client, "side_pocket_send", {
      id: child.id,
      message: "obsolete clarification",
      idempotencyKey: "old-correction",
    })
  );
  const later = delegationCommandSchema.parse(
    await tool(client, "side_pocket_send", {
      id: child.id,
      message: "retained task",
      idempotencyKey: "retained",
      mode: "queue",
    })
  );

  assert.equal(initial.mode, "queue");
  assert.equal(initial.body, "original deployed assignment");
  assert.equal(initial.status, "queued");
  assert.equal(pending.targetId, initial.id);
  await tool(client, "side_pocket_cancel", {
    id: child.id,
    commandIds: [initial.id],
    reason: "Obsolete assignment withdrawn",
  });
  await state(flow.store, () =>
    flow.store.queue
      .list(owner, child.id)
      .some((command) => command.id === pending.id && command.status === "cancelled")
  );
  assert.equal(flow.store.queue.list(owner, child.id).find((command) => command.id === later.id)?.status, "queued");
}

/**
Open a fresh MCP process to migrate the deployed schema before cancellation and native execution.
@param flow - Private fixture containing the deployed table shape.
@param child - Original recorded child, unchanged by migration.
*/
async function migrateAndRun(flow: Awaited<ReturnType<typeof fixture>>, child: SidePocket) {
  const client = await flow.mcp();

  await cancelObsolete(flow, client, child);
  await runRetained(flow, client, child);
}

await test(
  "queue-only database migration preserves assignments and cancellation retires only the selected task and its unsent corrections",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const flow = await fixture(t);
    const child = flow.store.create(owner, assignment("deployed-queue", "codex", "original deployed assignment"));

    queueOnlySchema(flow.directory);
    await migrateAndRun(flow, child);
  }
);
