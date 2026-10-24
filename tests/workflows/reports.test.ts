import { initialSnapshot, snapshotSchema, type Snapshot } from "../../src/lib/protocol";
import { type DelegationStore, delegations } from "../../src/server/delegations";
import { piWorkflow } from "../fixtures/pi-workflow";
import { checkReportProjection, forwardReport } from "../fixtures/pi-report-checks";
import { visibleSnapshot } from "../../src/state/visible-snapshot";
import { SnapshotStream } from "../../src/server/snapshot-stream";
import { type Bridge } from "../../src/server/bridge-session";
import { nativeWorkspace, eventually } from "../fixtures/workflow";
import { workflowBridge } from "../fixtures/workflow-bridge";
import { conversationTurns } from "../../src/state/conversation";
import { t as captureResult } from "try";
import test from "node:test";
import assert from "node:assert/strict";

const FRAME_PREFIX = "data: ";
const PUBLIC_REPLY = "The main Pocket’s own answer.";
const INTERNAL_PROGRESS = "INTERNAL_SIDE_POCKET_PROGRESS";
const INTERNAL_RESULT = "INTERNAL_SIDE_POCKET_FINAL";

/** Release this test’s mailbox without sharing a stale process-global store.
@param store - Exact mailbox owner allocated inside this workflow.
*/
function closeMailbox(store: DelegationStore) {
  store.close();

  if (globalThis.codexPocketDelegations === store) {
    Reflect.deleteProperty(globalThis, "codexPocketDelegations");
  }
}

/** Read one real SSE frame and release both cancellation owners unconditionally.
@param bridge - Connected canonical main conversation.
@returns Validated public snapshot after the actual streaming projection.
*/
async function publicFrame(bridge: Bridge) {
  const abort = new AbortController();
  const request = new Request("http://127.0.0.1:3000/api/events", { signal: abort.signal });
  const response = new SnapshotStream(request, bridge).response();

  assert.ok(response.body);
  const reader = response.body.getReader();
  const received = await captureResult(reader.read.bind(reader));

  abort.abort();
  const cancelled = await captureResult(reader.cancel.bind(reader));

  if (!received.ok) {
    throw received.error;
  }

  if (!cancelled.ok) {
    throw cancelled.error;
  }

  assert.equal(received.value.done, false);
  const text = new TextDecoder().decode(received.value.value);

  assert.ok(text.startsWith(FRAME_PREFIX));

  return snapshotSchema.parse(JSON.parse(text.slice(FRAME_PREFIX.length).trim()));
}

/** Observe completed public work before seeding independent mailbox reports.
@param bridge - Actual native bridge.
@returns Whether the parent’s response is complete.
*/
function isMainIdle(bridge: Bridge) {
  return !bridge.snapshot.activeTurnId;
}

/** Assert the main view retains its own response without auto-rendered child text.
@param state - Actual streamed or reloaded display state.
*/
function checkOwnTranscript(state: Snapshot) {
  const encoded = JSON.stringify(conversationTurns(state, false, true));

  assert.ok(encoded.includes(PUBLIC_REPLY));
  assert.ok(!encoded.includes(INTERNAL_PROGRESS));
  assert.ok(!encoded.includes(INTERNAL_RESULT));
  assert.ok(!encoded.includes("delegateReport"));
}

await test("a Side Pocket report stays internal while the parent delivers its result once after reload", async (t) => {
  const flow = await piWorkflow(t, 2);
  const store = delegations();

  flow.cleanup(closeMailbox.bind(undefined, store));

  store.saveParent(flow.parent.id, { cwd: flow.directory, policy: { sandbox: "read-only", approval: "never" } });
  const child = store.create(flow.parent.id, {
    title: "Short story",
    body: "Write a short story.",
    idempotencyKey: "story",
  });
  const command = store.queue.claim(flow.parent.id, child.id);

  assert.ok(command);
  const story =
    "Ground Clearance\n\nThe dragon arrived carrying the learner car.\n\n“Keep the wheels down.”\n\nThe end. ✓";
  const report = store.mail.message(child.id, command.id, { message: story });

  store.queue.finish(command, "completed", JSON.stringify({ status: "completed" }));
  const state = { ...structuredClone(initialSnapshot), threadId: flow.parent.id };

  await forwardReport(
    {
      parentId: flow.parent.id,
      root: flow.directory,
      faux: flow.provider,
      send: (id, body) => flow.send(id, body),
    },
    state,
    report.id,
    story
  );
  const turns = await flow.history();
  const visible = visibleSnapshot({ ...state, turns });

  checkReportProjection(visible, report.id, story);
  assert.equal(turns.length, 1);
  assert.equal(store.mail.pending(flow.parent.id).length, 0);
  const saved = store.mail.history(flow.parent.id, child.id);

  assert.equal(saved.length, 1);
  assert.equal(saved[0].childId, child.id);
  assert.equal(saved[0].payload, JSON.stringify({ message: story }));
  await flow.main.close();
  const resumed = flow.create();

  await resumed.request("thread/resume", {});
  const restored = await flow.history(resumed);

  checkReportProjection(visibleSnapshot({ ...state, turns: restored }), report.id, story);
});

await test("main SSE ignores interim and completed Side Pocket reports and filters legacy report rows", async (t) => {
  const fixture = await nativeWorkspace(t, { turn: { chunks: [PUBLIC_REPLY] } });
  const store = delegations();

  fixture.cleanup(closeMailbox.bind(undefined, store));
  const bridge = workflowBridge(fixture, fixture.config);

  await bridge.send("main-request", "Show me the result.");
  await eventually(isMainIdle.bind(undefined, bridge), "The main reply must complete");
  store.saveParent(fixture.parent.id, { cwd: fixture.directory, policy: { sandbox: "read-only", approval: "never" } });
  const child = store.create(fixture.parent.id, {
    title: "Private lookup",
    body: "Find the requested result.",
    idempotencyKey: "private-lookup",
  });
  const command = store.queue.claim(fixture.parent.id, child.id);

  assert.ok(command);
  const progress = store.mail.message(child.id, command.id, { message: INTERNAL_PROGRESS });

  store.mail.message(child.id, command.id, { message: INTERNAL_RESULT });
  store.queue.finish(command, "completed", JSON.stringify({ status: "completed" }));
  checkOwnTranscript(await publicFrame(bridge));
  checkOwnTranscript(await publicFrame(bridge));
  const historical: Snapshot = {
    ...bridge.snapshot,
    turns: [
      ...bridge.snapshot.turns,
      {
        id: "legacy-report-turn",
        status: "completed",
        items: [
          { id: progress.id, type: "userMessage", content: [{ type: "text", text: INTERNAL_PROGRESS }] },
          { id: "legacy-report-row", type: "delegateReport", delegateReport: { text: INTERNAL_RESULT } },
        ],
      },
    ],
  };
  const stored = JSON.stringify(historical);
  const restored = snapshotSchema.parse(JSON.parse(stored));

  checkOwnTranscript(visibleSnapshot(restored, { tools: true }));
  assert.equal(store.mail.history(fixture.parent.id, child.id).length, 2);
});
