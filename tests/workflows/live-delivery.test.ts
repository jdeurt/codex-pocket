import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { type Data, type Turn, initialSnapshot } from "../../src/lib/protocol";
import { nativeText } from "../../src/state/harness-transcript";
import { visibleSnapshot } from "../../src/state/visible-snapshot";
import { piChatMessage } from "../../src/state/pi-chat";
import { voiceWorkerResult } from "../../src/state/voice-context";
import { groupedVoiceSegments } from "../../src/state/voice";
import { voiceTimeline } from "../../src/lib/voice-timeline";
import { type DelegationStore, delegations } from "../../src/server/delegations";
import { ParentReports } from "../../src/server/delegation-reports";
import { piWorkflow } from "../fixtures/pi-workflow";
import { voiceWorkflow, TEST_SDP } from "../fixtures/voice-workflow";
import { eventually } from "../fixtures/workflow";
import assert from "node:assert/strict";
import test from "node:test";

const LAST = -1;
const STEP_MS = 2000;
const REPORT = "## Transport report\n\n[Open the logs](https://example.com/logs)\n\nExact findings ✓";
const SUMMARY = "The report and link are in the chat.";
const CHAT_CALL = "send-report";
const PRIVATE_REPORT = "Private raw child report; never forward this directly to speech.";
const CAPTIONS = [
  ["user", "[clear throat"],
  ["user", "] [breath"],
  ["assistant", " Here you go: these links open the logs directly."],
  ["user", "]"],
  ["user", "Okay"],
  ["assistant", " Sure."],
  ["user", ". All right, I will report the bugs."],
  ["assistant", " Sounds good. I can collect"],
  ["user", "[clear throat]"],
  ["assistant", " the right details."],
];

type Flow = Awaited<ReturnType<typeof voiceWorkflow>>;

/** Read canonical turn items.
@param turn - Public parent turn.
@returns Its items.
*/
function turnItems(turn: Turn) {
  return turn.items;
}

/** Select public turn items through the canonical visibility boundary.
@param turns - Actual Pi history.
@returns Visible items without worker replies or private tool results.
*/
function publicItems(turns: Turn[]) {
  const visible = visibleSnapshot({ ...initialSnapshot, turns });

  return visible.turns.flatMap(turnItems.bind(undefined));
}

/** Identify native tool output without promoting it to assistant text.
@param message - Provider context item.
@returns Whether this is tool output.
*/
function isToolResult(message: { role: string }) {
  return message.role === "toolResult";
}

/** Verify the model receives confirmed delivery before its final voice summary.
@param context - Actual Pi provider context after native tool execution.
@returns Short backend response instead of reading the report aloud.
*/
const deliveredResponse: FauxResponseFactory = (context) => {
  const result = context.messages.findLast(isToolResult.bind(undefined));

  assert.ok(result);
  assert.match(nativeText(result.content), /"status":"delivered"/);
  assert.ok(nativeText(result.content).includes("example.com/logs"));

  return fauxAssistantMessage(SUMMARY);
};

/** Select accepted backend commentary.
@param event - Actual native sideband command.
@returns Whether it carries a verified result.
*/
function isCommentary(event: Data) {
  return event.type === "session.commentary.append";
}

/** Wait until a main turn and its voice update are complete.
@param count - Expected number of result commands.
@param flow - Running voice workflow.
@returns Whether all requested results arrived.
*/
function hasResults(count: number, flow: Flow) {
  return !flow.bridge.snapshot.activeTurnId && flow.frames.filter(isCommentary.bind(undefined)).length === count;
}

/** Release the canonical mailbox allocated by this workflow.
@param store - Exact owned store.
*/
function closeMailbox(store: DelegationStore) {
  store.close();
  Reflect.deleteProperty(globalThis, "codexPocketDelegations");
}

/** Read displayed or saved text.
@param caption - Caption or group.
@returns Its original text field.
*/
function captionText(caption: { text: string }) {
  return caption.text;
}

/** Read expected exact provider text.
@param entry - Role/text fixture pair.
@returns Native fragment text.
*/
function expectedText(entry: string[]) {
  return entry[1];
}

/** Simulate legacy pause-generated group boundaries without altering original text.
@param segment - Persisted native fragment.
@returns An old-format grouping hint per fragment.
*/
function legacyGroup(segment: Awaited<ReturnType<Flow["voice"]["transcripts"]>>[number]) {
  return { ...segment, groupId: segment.id };
}

await test("Pi sends reports directly to chat during voice work and preserves one delivery after reload", async (t) => {
  const flow = await piWorkflow(t, 2);

  flow.provider.setResponses([
    fauxAssistantMessage(fauxToolCall("pocket_send_to_chat", { message: REPORT }, { id: CHAT_CALL }), {
      stopReason: "toolUse",
    }),
    deliveredResponse,
  ]);
  await flow.send("realtime-tool:session:request", "Deliver the report and its links to chat.");
  const turns = await flow.history();
  const visible = publicItems(turns);

  assert.equal(visible.length, 1);
  assert.equal(visible[0].text, REPORT);
  assert.equal(visible[0].delivery, "chat");
  assert.equal(voiceWorkerResult({ ...initialSnapshot, turns }, turns[0])?.text, SUMMARY);
  assert.equal(piChatMessage(turns[0], flow.parent.id, CHAT_CALL, REPORT), undefined);
  assert.throws(
    piChatMessage.bind(undefined, turns[0], flow.parent.id, CHAT_CALL, "Changed report"),
    /another message/
  );
  await flow.main.close();
  const resumed = flow.create();

  await resumed.request("thread/resume", {});
  assert.deepEqual(publicItems(await flow.history(resumed)), visible);
});

await test("Live receives the main reply after a later Side Pocket report without another user request", async (t) => {
  const flow = await voiceWorkflow(t);
  const started = await flow.voice.start(TEST_SDP);

  flow.speech("request", "Investigate the audio problem.");
  flow.delegation("investigate");
  await eventually(hasResults.bind(undefined, 1, flow), "The original worker turn must return");
  const store = delegations();

  flow.cleanup(closeMailbox.bind(undefined, store));
  store.saveParent(flow.parent.id, { cwd: flow.directory, policy: { sandbox: "read-only", approval: "never" } });
  const child = store.create(flow.parent.id, { title: "Audio lookup", body: "Investigate.", idempotencyKey: "audio" });
  const command = store.queue.claim(flow.parent.id, child.id);

  assert.ok(command);
  store.mail.message(child.id, command.id, { message: PRIVATE_REPORT });
  store.queue.finish(command, "completed", JSON.stringify({ status: "completed" }));
  const reports = new ParentReports(store, flow.bridge, flow.config);

  reports.queue();
  await reports.settled();
  await eventually(hasResults.bind(undefined, 2, flow), "The follow-up parent turn must reach Live automatically");
  const results = flow.frames.filter(isCommentary.bind(undefined));

  assert.equal(results[0].delegation_id, "investigate");
  assert.equal(results[1].delegation_id, null);
  assert.match(String(results[1].content), /Voice repair completed/);
  assert.ok(!JSON.stringify(results).includes(PRIVATE_REPORT));
  flow.voice.completed(flow.bridge.snapshot.turns.at(LAST));
  assert.equal(flow.frames.filter(isCommentary.bind(undefined)).length, 2);
  await flow.voice.stop(started.token);
});

await test("Live keeps brackets and punctuation together across pauses and noise without changing saved fragments", async (t) => {
  const flow = await voiceWorkflow(t);
  const started = await flow.voice.start(TEST_SDP);

  for (const [index, [role, text]] of CAPTIONS.entries()) {
    flow.speech(`fragment-${String(index)}`, text, role, index * STEP_MS);
  }

  await flow.voice.stop(started.token);
  const raw = await flow.voice.transcripts();
  const groups = groupedVoiceSegments(raw);
  const text = Array.from(groups, captionText.bind(undefined));

  assert.deepEqual(Array.from(raw, captionText.bind(undefined)), Array.from(CAPTIONS, expectedText.bind(undefined)));
  assert.deepEqual(text, [
    "[clear throat] [breath]",
    "Here you go: these links open the logs directly.",
    "Okay.",
    "Sure.",
    "All right, I will report the bugs.",
    "Sounds good. I can collect the right details.",
    "[clear throat]",
  ]);
  const split = raw.map(legacyGroup.bind(undefined));
  const merged = groupedVoiceSegments(split);
  const previousId = split.at(LAST)?.groupId;

  assert.ok(previousId);
  const restart = { id: "restart", type: "pocketRestart", afterItemId: previousId };
  const timeline = voiceTimeline([{ id: "restart", entries: [{ kind: "message", item: restart }] }], split, []);

  assert.deepEqual(Array.from(merged, captionText.bind(undefined)), text);
  assert.equal(timeline.at(LAST)?.id, "restart");
});
