import { type FauxProviderHandle, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { type RpcEvent, type Snapshot, initialSnapshot, object, threadSchema } from "../../src/lib/protocol";
import { type PiMain } from "../../src/server/pi-main";
import assert from "node:assert/strict";
import { delegations } from "../../src/server/delegations";
import { reconcileDeliveries } from "../../src/lib/deliveries";
import { recoveryReceipt } from "../../src/server/recovery";
import { recordRestart } from "../../src/server/restart-events";
import { reduceEvent } from "../../src/server/reducer";
import { setTimeout as delay } from "node:timers/promises";
import { visibleSnapshot } from "../../src/server/visible-snapshot";
import { readPiState, savePiState } from "../../src/server/pi-store";

const POLL_MS = 10;
const TIMEOUT_MS = 5000;
const LAST_EVENT = -1;

interface ChatFlow {
  main: PiMain;
  events: RpcEvent[];
  faux: FauxProviderHandle;
  parentId: string;
  root: string;
  create: () => PiMain;
}

/** Await an observed provider/bridge boundary with a bounded failure, never a blind delay.
@param isReady - Observation of real session state.
*/
async function waitFor(isReady: () => boolean) {
  const until = Date.now() + TIMEOUT_MS;

  while (!isReady()) {
    assert.ok(Date.now() < until, "Pi did not reach the expected lifecycle boundary");
    await delay(POLL_MS);
  }
}

/** Read the production parent projection, retaining canonical transport validation.
@param flow - Actual Pi session and parent identity.
@returns Canonical readable snapshot.
*/
async function snapshot(flow: ChatFlow): Promise<Snapshot> {
  const result = await flow.main.request("thread/read", { threadId: flow.parentId });
  const thread = threadSchema.parse(object(result).thread);

  return { ...structuredClone(initialSnapshot), threadId: flow.parentId, turns: thread.turns };
}

/** Submit real Pi input and wait for the completion belonging to that submission.
@param flow - Actual Pi session and captured canonical events.
@param id - Durable receipt identity.
@param text - Exact submitted text.
@returns Canonical terminal turn.
*/
async function send(flow: ChatFlow, id: string, text: string) {
  const start = flow.events.length;

  await flow.main.request("turn/start", { input: [{ type: "text", text }], clientUserMessageId: id });
  await waitFor(() => flow.events.slice(start).some((event) => event.method === "turn/completed"));
  const turn = flow.events.slice(start).find((event) => event.method === "turn/completed")?.params.turn;

  assert.ok(turn);

  return turn;
}

/** Exercise identical human sends and identity-based restart/report attribution through the real SDK and store.
@param flow - Actual session, provider and private delegation database scope.
*/
async function checkMessages(flow: ChatFlow) {
  const text = "hello brother";

  for (const id of ["repeat-1", "repeat-2"]) {
    flow.faux.setResponses([fauxAssistantMessage("Hello again.")]);
    await send(flow, id, text);
  }

  const state = await snapshot(flow);
  const pending = ["repeat-1", "repeat-2"].map((id) => ({ id, text, status: "sent" as const }));
  const delivered = reconcileDeliveries(visibleSnapshot(state), pending);

  assert.equal(delivered.state.queue.length, 0, "Confirmed Pi sends must not remain at the transcript tail");
  assert.equal(
    delivered.state.turns.flatMap((turn) => turn.items).filter((item) => pending.some((entry) => entry.id === item.id))
      .length,
    pending.length,
    "Legitimate identical human sends must remain separate"
  );
  const recovery = recoveryReceipt(state.turns, []);

  assert.ok(recovery);
  state.restartEvents = await recordRestart(state);
  flow.faux.setResponses([fauxAssistantMessage("Resumed.")]);
  await send(flow, recovery.id, recovery.text);
  const store = delegations();

  store.saveParent(flow.parentId, {
    cwd: flow.root,
    policy: { sandbox: "workspace-write", approval: "never", model: "fixture", effort: "high" },
  });
  const child = store.create(flow.parentId, {
    title: "Short story",
    body: "Write a short story.",
    idempotencyKey: "pi-chat-story",
  });
  const command = store.queue.claim(flow.parentId, child.id);

  assert.ok(command);
  store.setStatus(flow.parentId, child.id, "running");
  const report = store.mail.message(child.id, command.id, { message: "Once upon a time." });

  store.queue.finish(command, "completed", JSON.stringify({ status: "completed" }));
  flow.faux.setResponses([fauxAssistantMessage("The story is ready.")]);
  await send(flow, report.id, "Report from the short-story delegate.");
  const visible = visibleSnapshot(
    { ...(await snapshot(flow)), restartEvents: state.restartEvents },
    {
      reports: store.reports.list(flow.parentId),
    }
  );
  const items = visible.turns.flatMap((turn) => turn.items);

  assert.equal(items.filter((item) => item.type === "pocketRestart").length, 1);
  assert.equal(items.filter((item) => item.id === recovery.id).length, 0);
  assert.deepEqual(
    items.filter((item) => item.id === report.id).map((item) => item.type),
    ["delegateReport"]
  );
  assert.ok(items.find((item) => item.id === report.id)?.delegateReport?.final);
}

/** Deliver steering during an actual native tool wait, then complete it without changing receipt order.
@param flow - Session with the real structured-question tool.
*/
async function checkSteering(flow: ChatFlow) {
  const start = flow.events.length;

  flow.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("request_user_input", {
        questions: [{ id: "file", question: "Continue?", options: [{ label: "Yes" }] }],
      }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage([fauxThinking("Considering the follow-ups."), { type: "text", text: "Both received." }]),
  ]);
  const response = object(
    await flow.main.request("turn/start", {
      input: [{ type: "text", text: "Wait for my follow-ups." }],
      clientUserMessageId: "steer-start",
    })
  );

  await waitFor(() => flow.events.slice(start).some((event) => event.id !== undefined));
  const question = flow.events.slice(start).find((event) => event.id !== undefined);

  assert.ok(question?.id);

  for (const id of ["steer-1", "steer-2"]) {
    await flow.main.request("turn/steer", {
      expectedTurnId: object(response.turn).id,
      input: [{ type: "text", text: "same follow-up" }],
      clientUserMessageId: id,
    });
  }

  flow.main.respond(question.id, { answers: { file: { answers: ["Yes"] } } });
  await waitFor(() => flow.events.slice(start).some((event) => event.method === "turn/completed"));
  const state = await snapshot(flow);
  const users = state.turns.flatMap((turn) => turn.items).filter((item) => item.type === "userMessage");

  assert.deepEqual(
    users.filter((item) => item.id.startsWith("steer-")).map((item) => item.clientId),
    ["steer-start", "steer-1", "steer-2"]
  );
}

/** Cancel actual Pi work at a native question boundary and check fatal provider errors clear activity.
@param flow - Actual session and provider, with no native Codex turn running.
*/
async function checkCancellation(flow: ChatFlow) {
  const start = flow.events.length;

  flow.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("request_user_input", {
        questions: [{ id: "file", question: "Wait here?", options: [{ label: "Yes" }] }],
      }),
      { stopReason: "toolUse" }
    ),
  ]);
  const response = object(
    await flow.main.request("turn/start", {
      input: [{ type: "text", text: "Wait until interrupted." }],
      clientUserMessageId: "cancel-start",
    })
  );

  await waitFor(() => flow.events.slice(start).some((event) => event.id !== undefined));

  for (const id of ["cancel-queued-1", "cancel-queued-2"]) {
    await flow.main.request("turn/steer", {
      expectedTurnId: object(response.turn).id,
      input: [{ type: "text", text: "Keep this queued correction." }],
      clientUserMessageId: id,
    });
  }

  await flow.main.request("turn/interrupt", { threadId: flow.parentId, turnId: object(response.turn).id });
  await waitFor(() => flow.events.slice(start).some((event) => event.method === "turn/completed"));
  assert.equal(flow.events.at(LAST_EVENT)?.params.turn?.status, "interrupted");
  assert.ok(flow.events.slice(start).some((event) => event.method === "serverRequest/resolved"));
  flow.faux.setResponses([fauxAssistantMessage("Continuing."), fauxAssistantMessage("Correction received.")]);
  await send(flow, "after-cancel", "A new request after cancellation.");
  const delivered = await snapshot(flow);

  assert.deepEqual(
    delivered.turns
      .flatMap((turn) => turn.items)
      .filter((item) => item.id === "after-cancel" || item.id.startsWith("cancel-queued-"))
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({
        id: item.clientId,
        content: item.content,
      })),
    [
      { id: "after-cancel", content: [{ type: "text", text: "A new request after cancellation." }] },
      { id: "cancel-queued-1", content: [{ type: "text", text: "Keep this queued correction." }] },
      { id: "cancel-queued-2", content: [{ type: "text", text: "Keep this queued correction." }] },
    ]
  );
  flow.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid fixture request" })]);
  const failed = await send(flow, "failed-provider", "Fail this request.");

  assert.equal(failed.status, "failed");
  const state = { ...structuredClone(initialSnapshot), threadId: flow.parentId };

  for (const event of flow.events) {
    reduceEvent(state, structuredClone(event));
  }

  assert.equal(state.activeTurnId, undefined);
  assert.equal(visibleSnapshot(state).activity, undefined);
  assert.ok(state.error);
}

/** Restore deployed Pi history with receipt IDs stored only in item.id and verify display attribution after reconnect.
@param flow - Completed real session and reconnect factory.
*/
async function checkLegacyHistory(flow: ChatFlow) {
  await flow.main.close();
  const saved = await readPiState(flow.parentId);

  assert.ok(saved);

  for (const turn of saved.turns) {
    for (const item of turn.items) {
      if (item.source === "pi" && item.type === "userMessage") {
        delete item.clientId;
      }
    }
  }

  await savePiState(flow.parentId, saved);
  const resumed = flow.create();

  await resumed.request("thread/resume", {});
  const state = visibleSnapshot(await snapshot({ ...flow, main: resumed }), {
    reports: delegations().reports.list(flow.parentId),
  });
  const pending = [{ id: "repeat-1", text: "hello brother", status: "sent" as const }];
  const delivered = reconcileDeliveries(state, pending);
  const items = delivered.state.turns.flatMap((turn) => turn.items);

  assert.equal(delivered.state.queue.length, 0);
  assert.equal(items.filter((item) => item.type === "delegateReport").length, 1);
  assert.equal(items.filter((item) => item.type === "userMessage" && item.id.startsWith("pocket-")).length, 0);
  await resumed.close();
}

/** Verify integrated Pi regressions using native SDK prompts, tools, persistence and production projections.
@param flow - Real session and isolated provider controls.
*/
export async function checkPiChat(flow: ChatFlow) {
  await checkMessages(flow);
  await checkSteering(flow);
  const start = flow.events.length;

  await flow.main.request("thread/settings/update", { model: "pocket-offline/calendar-model", effort: "high" });
  assert.equal(flow.events.length, start, "A UI settings mutation must not invent an agent tool call");
  flow.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("mcp__pocket__pocket_session_settings", {
        model: "pocket-offline/second-model",
        effort: "high",
      }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("Next turn uses the second model."),
  ]);
  const switched = await send(flow, "switch-model", "Switch the model using your settings tool.");
  const tool = switched.items.find((item) => item.tool === "mcp__pocket__pocket_session_settings");

  assert.equal(tool?.status, "completed");
  assert.match(String(tool.text), /applied/);
  const settings = object(await flow.main.request("thread/read", { threadId: flow.parentId }));

  assert.equal(object(settings.thread).model, "pocket-offline/second-model");
  assert.ok(flow.events.slice(start).some((event) => event.params.activity === "Updating session"));
  flow.faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" }),
    fauxAssistantMessage("Recovered after retry."),
  ]);
  const retried = await send(flow, "provider-retry", "Retry the transient provider failure.");

  assert.equal(retried.status, "completed");
  assert.ok(flow.events.some((event) => event.params.activity === "Retrying request"));
  await checkCancellation(flow);
  await checkLegacyHistory(flow);
}
