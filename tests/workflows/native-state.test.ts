import { PiMessages } from "../../src/server/pi-projection";
import { t } from "try";
import assert from "node:assert/strict";
import test from "node:test";
import { observedCodexAgents, type CodexAgentState } from "../../src/state/codex-agents";
import { waitingClaudeAgent, type ClaudeAgentState } from "../../src/state/claude-agents";
import { changedSettings, savedSettingsSchema } from "../../src/state/pocket-settings";
import { TextStream } from "../../src/server/text-stream";

/**
Verify a later native event cannot rewrite metadata held by an earlier subscriber.
*/
function nativeMetadata() {
  const codex: CodexAgentState = Object.freeze({
    child: Object.freeze({ parentId: "parent", name: "worker", status: "running" }),
  });
  const next = observedCodexAgents(
    codex,
    {
      method: "thread/status/changed",
      params: { threadId: "child", status: { type: "idle" } },
    },
    "parent"
  );

  assert.equal(codex.child.status, "running");
  assert.equal(next?.child.status, "idle");
  const claude: ClaudeAgentState = Object.freeze({ child: Object.freeze({ name: "worker", status: "running" }) });

  assert.equal(waitingClaudeAgent(claude, "child", true)?.child.status, "waiting");
  assert.equal(claude.child.status, "running");
  assert.equal(waitingClaudeAgent(claude, "unknown", true), undefined);
}

/**
Verify omitted fields and explicit removals retain their distinct persisted meanings.
*/
function partialSettings() {
  const saved = Object.freeze(savedSettingsSchema.parse({ showToolCalls: true, realtimeVoice: "marin" }));
  const next = changedSettings(saved, { showToolCalls: undefined, realtimeVoice: null });

  assert.equal(next.showToolCalls, true);
  assert.equal(next.realtimeVoice, null);
  assert.equal(saved.realtimeVoice, "marin");
}

/** Count release of the exact producer connected by the fixture.
@param probe - Explicit resource accounting.
*/
function disconnected(probe: { stops: number }) {
  probe.stops++;
}

/** Abort synchronously during producer setup, before its teardown can be returned.
@param controller - Request cancellation owner.
@param probe - Native resource accounting.
@param stream - Transport currently executing producer setup.
@returns Exact producer release callback.
*/
function abortedSetup(controller: AbortController, probe: { stops: number }, stream: TextStream) {
  stream.send("ready");
  controller.abort();

  return disconnected.bind(undefined, probe);
}

/**
Verify cancellation during setup releases the eventual producer exactly once.
*/
async function setupCancellation() {
  const controller = new AbortController();
  const probe = { stops: 0 };
  const stream = new ReadableStream(new TextStream(controller.signal, abortedSetup.bind(undefined, controller, probe)));
  const reader = stream.getReader();

  await reader.read();
  const ending = await reader.read();

  assert.equal(ending.done, true);
  assert.equal(probe.stops, 1);
  await reader.cancel();
  assert.equal(probe.stops, 1);
}

await test("native metadata updates preserve earlier published state", nativeMetadata);
await test("partial settings preserve omitted values and explicit removal", partialSettings);
await test("stream abort during producer setup releases its eventual subscription", setupCancellation);

/** Reject one native correction before it is queued.
@returns Original rejected native outcome.
*/
function rejectedSteering(): Promise<"queued"> {
  return Promise.reject(new Error("native rejection"));
}

/** Acknowledge a native queued correction.
@returns Original native disposition.
*/
function acceptedSteering(): Promise<"queued"> {
  return Promise.resolve("queued");
}

/**
Verify a failed native correction cannot claim the next accepted message's receipt.
*/
async function failedReceipt() {
  const messages = new PiMessages();
  const rejected = await t(messages.steer.bind(messages), { steer: rejectedSteering }, "rejected", "first");

  assert.equal(rejected.ok, false);
  await messages.steer({ steer: acceptedSteering }, "accepted", "second");
  const turn = { id: "active", status: "inProgress", items: [] };
  const projected = messages.project({ role: "user", content: "second", timestamp: 1 }, turn, [turn], "parent");

  assert.equal(projected.turn.items[0].clientId, "accepted");
  assert.equal(turn.items.length, 0);
}

await test("rejected Pi steering cannot consume a later message receipt", failedReceipt);
