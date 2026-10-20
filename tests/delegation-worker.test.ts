import {
  LAST_INDEX,
  LOST_NOTIFICATION_RECOVERY_MS,
  type Peer,
  TEST_TIMEOUT_MS,
  THREE_MORE_STARTS,
  assignment,
  fixture,
  owner,
  state,
  tool,
} from "./fixtures/delegation-flow";
import { type Client } from "@modelcontextprotocol/client";
import { type SidePocket } from "../src/server/delegation-data";
import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

type Flow = Awaited<ReturnType<typeof fixture>>;

/**
Reads a private process signal file while treating only missing files as not-yet-signaled.
@param filename - Private fixture signal path.
@returns Signal text, or an empty value while the file does not exist.
*/
async function readSignal(filename: string) {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }

    return "missing";
  }
}

/**
Connects the real child stdio client only after the native assignment starts.
@param flow - Private durable fixture owning every child and MCP lifetime.
@param worker - Native simulator dispatching the assignment.
@param child - Canonical created child from the MCP boundary.
@returns Scoped real child MCP client bound to the recorded command.
*/
async function connectQuestionChild(flow: Flow, worker: Peer, child: SidePocket) {
  await worker.until(() => worker.starts().length === 1);

  return flow.mcp("scripts/side-pocket-mcp.ts", {
    POCKET_CHILD_ID: child.id,
    POCKET_COMMAND_ID: flow.store.queue.list(owner, child.id)[0].id,
  });
}

/**
Persists a real child report and opens its native question before reading the durable request.
@param flow - Private durable fixture and its native mailbox.
@param worker - Native simulator dispatching question events.
@param child - Canonical managed child.
@param childMcp - Real stdio client bound to that child's active command.
@returns Canonical pending native request from the durable mailbox.
*/
async function readChildQuestion(flow: Flow, worker: Peer, child: SidePocket, childMcp: Client) {
  await tool(childMcp, "message_parent", { message: "Cross-process report" });
  await worker.until((events) =>
    events.some((entry) => entry.event === "mail" && entry.text.includes("Cross-process report"))
  );
  await worker.call("ask", { childId: child.id });
  await worker.until((events) => events.some((entry) => entry.event === "mail" && entry.text.includes("request")));

  return flow.store.mail.requests(owner, child.id)[0];
}

/**
Answers the first native question before queuing and cancelling the child's next work.
@param flow - Private fixture owning the persisted mailbox and queue.
@param worker - Native simulator emitting answer and cancellation events.
@param client - Parent's connected real MCP client.
@param child - Canonical managed child.
@param requestId - Original persisted request identity.
@returns Canonical confirmed-close result from the real parent tool.
*/
async function answerAndCloseChild(flow: Flow, worker: Peer, client: Client, child: SidePocket, requestId: string) {
  await tool(client, "side_pocket_answer", {
    id: child.id,
    requestId,
    answer: { answers: { color: "Blue" } },
  });
  await worker.until((events) => events.some((entry) => entry.event === "answer"));
  assert.equal(flow.store.get(owner, child.id).status, "running");
  await worker.call("ask", { childId: child.id });
  await state(flow.store, () => flow.store.mail.requests(owner, child.id).length === 2);
  await tool(client, "side_pocket_send", { id: child.id, message: "cancel queued", idempotencyKey: "cancel" });

  return await tool(client, "side_pocket_close", { id: child.id });
}

/**
Requires confirmed cancellation before resuming the saved session and opening a final question.
@param flow - Private fixture owning native process creation and durable state.
@param worker - Existing simulator retaining the same managed child session.
@param client - Parent's connected real MCP client.
@param child - Original managed child identity.
@param closed - Canonical confirmed-close result whose status is checked before reuse.
@returns Native writer used by the final answer/close race.
*/
async function resumeQuestionChild(flow: Flow, worker: Peer, client: Client, child: SidePocket, closed: SidePocket) {
  assert.equal(closed.status, "closed");
  await worker.until((events) => events.some((entry) => entry.event === "cancelled"));
  assert.deepEqual(
    flow.store.queue.list(owner, child.id).map((entry) => entry.status),
    ["cancelled", "cancelled"]
  );
  assert.equal(flow.store.mail.requests(owner, child.id)[1].status, "cancelled");
  await tool(client, "side_pocket_resume", { id: child.id });
  await tool(client, "side_pocket_send", { id: child.id, message: "resumed", idempotencyKey: "resumed" });
  await worker.until(() => worker.starts().length === 2);
  assert.equal(flow.store.get(owner, child.id).sessionId, `saved:${child.id}`);
  await worker.call("ask", { childId: child.id });
  await state(flow.store, () => flow.store.mail.requests(owner, child.id).length === THREE_MORE_STARTS);

  return flow.peer("writer");
}

await test(
  "cross-process child mail, requests, answers, cancellation and confirmed close wake without polling",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const flow = await fixture(t);
    const { store, peer, mcp } = flow;
    const worker = await peer();
    const client = await mcp();
    const child = await tool(client, "side_pocket_create", assignment("question-flow"));

    const childMcp = await connectQuestionChild(flow, worker, child);
    const request = await readChildQuestion(flow, worker, child, childMcp);
    const closed = await answerAndCloseChild(flow, worker, client, child, request.id);
    const writer = await resumeQuestionChild(flow, worker, client, child, closed);

    await writer.call("answerAndClose", {
      childId: child.id,
      requestId: store.mail.requests(owner, child.id).at(LAST_INDEX)?.id,
      answer: { answers: { color: "Blue" } },
    });
    await state(store, () => store.get(owner, child.id).status === "closed");
    assert.equal(store.queue.list(owner, child.id).at(LAST_INDEX)?.status, "cancelled");
  }
);

/**
Records a held parent report before opening the crash scenario's native question.
@param flow - Private durable fixture owning parent mail.
@param worker - Native simulator whose delivery is deliberately held.
@param writer - Separate native writer committing the parent report.
@param child - Canonical persisted child assignment.
@returns Persisted report whose identity must survive the later native crash.
*/
async function heldParentReport(flow: Flow, worker: Peer, writer: Peer, child: SidePocket) {
  await worker.until(() => worker.starts().length === 1);
  await worker.call("holdDelivery");
  await writer.call("message", {
    childId: child.id,
    commandId: worker.starts()[0].id,
    message: "Durable before crash",
  });
  await worker.until((events) => events.some((entry) => entry.event === "mail"));

  return flow.store.mail.pending(owner).find((mail) => mail.kind === "message");
}

/**
Kills this owned simulator only after subscribing to its native exit.
@param worker - Native simulator intentionally terminated by the recovery workflow.
*/
async function crashPeer(worker: Peer) {
  const exited = once(worker.child, "exit");

  worker.child.kill("SIGKILL");
  await exited;
}

/**
Requires durable mail, opens the native question, then queues new work only after confirmed crash exit.
@param flow - Private durable fixture and mailbox.
@param worker - Existing simulator whose native exit is joined.
@param writer - Separate native writer committing work during downtime.
@param child - Original persisted child whose in-flight work becomes uncertain.
@returns Persisted report and the child committed while no worker was running.
*/
async function crashReportedChild(flow: Flow, worker: Peer, writer: Peer, child: SidePocket) {
  const pendingMail = await heldParentReport(flow, worker, writer, child);

  assert.ok(pendingMail);
  await worker.call("ask", { childId: child.id });
  await state(flow.store, () => flow.store.mail.requests(owner, child.id).length === 1);
  await crashPeer(worker);

  return { pendingMail, queued: await writer.call("create", assignment("queued-during-downtime")) };
}

/**
Checks persisted uncertain work and new dispatch before reading the single recovery report.
@param flow - Private durable fixture owning commands and mail.
@param restarted - Replacement native simulator.
@param child - Original child whose uncertain command must not replay.
@param queued - Child committed during downtime and expected to dispatch first.
@returns Persisted recovery report required by the subsequent delivery assertions.
*/
async function recoveredParentReport(flow: Flow, restarted: Peer, child: SidePocket, queued: SidePocket) {
  await restarted.until(() => restarted.starts().length === 1);
  assert.equal(restarted.starts()[0].childId, queued.id);
  assert.equal(flow.store.queue.list(owner, child.id)[0].status, "unknown");
  assert.equal(flow.store.get(owner, child.id).status, "unknown");
  assert.equal(flow.store.mail.requests(owner, child.id)[0].status, "cancelled");

  return flow.store.mail.history(owner, child.id).find((mail) => mail.kind === "recovery");
}

await test(
  "worker crash marks in-flight work unknown, retains mail IDs, and never automatically replays it",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const flow = await fixture(t);
    const { store, peer } = flow;
    const writer = await peer("writer");
    const child = await writer.call("create", assignment("crash"));
    const worker = await peer();

    const { pendingMail, queued } = await crashReportedChild(flow, worker, writer, child);
    const restarted = await peer();
    const recovery = await recoveredParentReport(flow, restarted, child, queued);

    assert.ok(recovery);
    await restarted.until((events) => events.some((entry) => entry.event === "mail" && entry.id === recovery.id));
    await restarted.until((events) => events.some((entry) => entry.event === "mail" && entry.id === pendingMail.id));
    await writer.call("resume", { childId: child.id });
    await writer.call("send", { childId: child.id, key: "continue", body: "Continue after inspection" });
    await restarted.until(() => restarted.starts().length === 2);
    assert.equal(restarted.starts()[1].text, "Continue after inspection");
    assert.equal(store.mail.history(owner, child.id).filter((mail) => mail.kind === "recovery").length, 1);
  }
);

await test(
  "bounded reconciliation recovers a commit whose writer exits before publishing its notification",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { store, directory, peer } = await fixture(t);
    // A short recovery interval belongs only to this simulator; production is 30s.
    const worker = await peer("worker", LOST_NOTIFICATION_RECOVERY_MS);
    const writer = await peer("writer");
    const signal = path.join(directory, "delegations.notify");
    const before = await readSignal(signal);
    const exited = once(writer.child, "exit");
    const child = await writer.call("createAndCrash", assignment("lost-notification"));

    await exited;
    assert.equal(await readSignal(signal), before);
    await worker.until(() => worker.starts().length === 1);
    assert.equal(worker.starts()[0].childId, child.id);
    assert.equal(store.queue.list(owner, child.id)[0].status, "running");
  }
);

/**
Holds real parent delivery before creating work that can emit its first report.
@param worker - Native simulator whose delivery lease is held.
@param writer - Separate native writer committing the child assignment.
@returns Canonical persisted child while delivery remains blocked.
*/
async function childWithHeldDelivery(worker: Peer, writer: Peer) {
  await worker.call("holdDelivery");

  return await writer.call("create", assignment("slow-mail"));
}

/**
Requires a held native report before committing the independent assignment that must still dispatch.
@param worker - Native simulator retaining the held delivery.
@param writer - Separate native writer committing the report and next child.
@param child - Original canonical child with its active command.
@returns Canonical second child committed while the first report is blocked.
*/
async function queueDuringHeldDelivery(worker: Peer, writer: Peer, child: SidePocket) {
  await worker.until(() => worker.starts().length === 1);
  await writer.call("message", { childId: child.id, commandId: worker.starts()[0].id, message: "Blocked delivery" });
  await worker.until((events) => events.some((event) => event.event === "mail"));

  return await writer.call("create", assignment("dispatch-while-mail-waits"));
}

/**
Answers the second child while delivery is held, then persists the first report's uncertain delivery outcome.
@param flow - Private durable fixture owning requests and report history.
@param worker - Native simulator holding parent delivery.
@param writer - Separate native writer answering the recorded question.
@param child - Original child whose report must not be retried.
@param next - Independent child whose native question must remain serviceable.
@returns Durable report identity used to assert no duplicate native delivery.
*/
async function releaseUnknownDelivery(flow: Flow, worker: Peer, writer: Peer, child: SidePocket, next: SidePocket) {
  await worker.until(() => worker.starts().length === 2);
  await worker.call("ask", { childId: next.id });
  await state(flow.store, () => flow.store.mail.requests(owner, next.id).length === 1);
  await writer.call("answer", {
    childId: next.id,
    requestId: flow.store.mail.requests(owner, next.id)[0].id,
    answer: { answers: { color: "Blue" } },
  });
  await worker.until((events) => events.some((event) => event.event === "answer"));
  await worker.call("deliveryStatus", { status: "unknown" });
  await worker.call("releaseDelivery");
  await state(flow.store, () => flow.store.mail.history(owner, child.id)[0].delivery === "unknown");

  return flow.store.mail.history(owner, child.id)[0].id;
}

await test(
  "slow parent delivery permits dispatch and answers, and unknown delivery is not retried",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const flow = await fixture(t);
    const { store, peer } = flow;
    const worker = await peer();
    const writer = await peer("writer");

    const child = await childWithHeldDelivery(worker, writer);
    const next = await queueDuringHeldDelivery(worker, writer, child);
    const mailId = await releaseUnknownDelivery(flow, worker, writer, child, next);

    await worker.call("barrier");
    assert.equal(worker.events.filter((event) => event.event === "mail" && event.id === mailId).length, 1);
    await worker.call("fail", { childId: child.id });
    await state(store, () => store.get(owner, child.id).status === "unknown");
    assert.equal(store.queue.list(owner, child.id)[0].status, "unknown");
  }
);
