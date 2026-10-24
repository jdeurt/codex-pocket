import assert from "node:assert/strict";
import test from "node:test";
import { initialSnapshot, type RpcEvent, type Snapshot } from "../../src/lib/protocol";
import { receivedThread, stagedMessage, threadState } from "../../src/state/thread";
import { reconcileCaptions } from "../../src/state/voice";
import { finalizedCaptions } from "../../src/state/saved-voice";
import { type VoiceSegment } from "../../src/lib/voice-history";
import { reduceEvent } from "../../src/state/reducer";
import { currentActivity } from "../../src/state/native-activity";
import { visibleSnapshot } from "../../src/state/visible-snapshot";

/** Freeze test inputs recursively so accidental input mutation fails at the offending write.
@param value - Test data owned by this fixture.
@returns Frozen input with its existing static type.
*/
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      freeze(entry);
    }

    Object.freeze(value);
  }

  return value;
}

/** Construct an independent connected parent snapshot.
@param threadId - Explicit conversation identity.
@returns Snapshot with an active turn and assistant text.
*/
function connected(threadId: string): Snapshot {
  return {
    ...structuredClone(initialSnapshot),
    connection: "connected",
    threadId,
    activeTurnId: "turn",
    turns: [{ id: "turn", status: "inProgress", items: [{ id: "reply", type: "agentMessage", text: "Hello" }] }],
  };
}

/**
Exercise deterministic reveal IDs and atomic optimistic/canonical reconciliation.
*/
function conversationTransitions() {
  const original = freeze(threadState(connected("one")));
  const staged = freeze(stagedMessage(original, "receipt", "Question"));
  const incoming = freeze({
    ...connected("one"),
    turns: [
      {
        id: "turn",
        status: "inProgress",
        items: [
          { id: "reply", type: "agentMessage", text: "Hello world" },
          { id: "user", type: "userMessage", clientId: "receipt", content: [{ type: "text", text: "Question" }] },
        ],
      },
    ],
  });
  const next = receivedThread(staged, incoming, true);

  assert.deepEqual(next, receivedThread(staged, incoming, true));
  assert.equal(original.pending.length, 0);
  assert.equal(staged.pending.length, 1);
  assert.equal(next.pending.length, 0);
  assert.equal(next.state.queue.length, 0);
  assert.equal(next.state.turns[0].items[0].revealId, `reply:${String(next.revision)}`);
  assert.equal(incoming.turns[0].items[0].text, "Hello world");
  assert.equal(Object.hasOwn(incoming.turns[0].items[0], "revealId"), false);
}

/**
Verify late captions cannot replace final speech and finalized text cannot be rewritten.
*/
function captionTransitions() {
  const caption: VoiceSegment = freeze({
    id: "voice:one",
    itemId: "one",
    nativeSessionId: "call",
    role: "assistant",
    text: "Done.",
    done: true,
  });
  const entries = freeze([caption]);
  const partial = freeze([{ ...caption, done: false, text: "Do" }]);

  assert.deepEqual(reconcileCaptions(entries, partial), entries);
  assert.deepEqual(finalizedCaptions(entries, { ...caption, handoff: "sent" }), [{ ...caption, handoff: "sent" }]);
  const conflict = { ...caption, text: "Different" };

  assert.throws(finalizedCaptions.bind(undefined, entries, conflict), /Finalized caption changed/);
  assert.deepEqual(entries, [caption]);
}

/**
Verify native deltas leave both saved state and transport payloads unchanged.
*/
function nativeTransitions() {
  const previous = freeze(connected("one"));
  const event: RpcEvent = freeze({
    method: "item/agentMessage/delta",
    params: { threadId: "one", turnId: "turn", itemId: "reply", delta: "!" },
  });
  const next = reduceEvent(previous, event);

  assert.equal(previous.turns[0].items[0].text, "Hello");
  assert.equal(next.turns[0].items[0].text, "Hello!");
  assert.deepEqual(next, reduceEvent(previous, event));
  assert.equal(reduceEvent(previous, { ...event, params: { ...event.params, threadId: "other" } }), previous);
}

/**
Verify activity is explicit, isolated, serializable and excluded from public snapshots.
*/
function activityTransitions() {
  const first = freeze(connected("first"));
  const second = freeze(connected("second"));
  const started: RpcEvent = freeze({
    method: "item/started",
    params: {
      threadId: "first",
      turnId: "turn",
      item: { id: "tool", type: "commandExecution", status: "inProgress" },
    },
  });
  const active = freeze(reduceEvent(first, started));

  assert.equal(currentActivity(active), "Running commands");
  assert.equal(currentActivity(structuredClone(active)), "Running commands");
  assert.equal(currentActivity(second), "");
  assert.equal(Object.hasOwn(visibleSnapshot(active), "activityState"), false);
  const completed = reduceEvent(active, {
    method: "item/completed",
    params: {
      threadId: "first",
      turnId: "turn",
      item: { id: "tool", type: "commandExecution", status: "completed" },
    },
  });

  assert.equal(currentActivity(completed), "");
  assert.equal(currentActivity(active), "Running commands");
  assert.deepEqual(active, reduceEvent(first, started));
}

await test("pure conversation transitions are deterministic and do not mutate frozen inputs", conversationTransitions);
await test("pure caption transitions preserve final speech and reject conflicting text", captionTransitions);
await test("pure native reducers preserve frozen snapshots and reject foreign events", nativeTransitions);
await test("pure activity survives cloning and isolates identical turn IDs across conversations", activityTransitions);
