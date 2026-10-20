import { type Item, type Turn } from "../src/lib/protocol";
import assert from "node:assert/strict";
import test from "node:test";
import { turnMessages } from "../src/lib/turn-messages";

const LAST_ITEM_INDEX = -1;
const items: Item[] = [
  { id: "user", type: "userMessage" },
  { id: "first", type: "agentMessage", phase: "commentary", text: "First update" },
  { id: "private", type: "reasoning", content: ["Not visible"] },
  { id: "steering", type: "userMessage" },
  { id: "second", type: "agentMessage", phase: "commentary", text: "Second update" },
  { id: "image", type: "imageOutput", images: [] },
  { id: "final", type: "agentMessage", phase: "final_answer", text: "Final reply" },
];
const turn: Turn = { id: "turn", status: "completed", items };

await test("a running turn keeps visible messages in order without an expander", () => {
  const entries = turnMessages(turn, true);
  assert.equal(
    entries.every((entry) => entry.kind === "message"),
    true
  );
  assert.deepEqual(
    entries.map((entry) => entry.kind === "message" && entry.item.id),
    items.filter((item) => item.type !== "reasoning").map((item) => item.id)
  );
});

await test("steering preserves earlier updates while subsequent activity collapses beside the final reply", () => {
  const entries = turnMessages(turn, false);
  const activity = entries.find((entry) => entry.kind === "activity");
  assert.ok(activity?.kind === "activity");
  assert.deepEqual(
    activity.items.map((item) => item.id),
    ["second"]
  );
  assert.deepEqual(
    entries.flatMap((entry) => (entry.kind === "message" ? entry.item.id : [])),
    ["user", "first", "steering", "image", "final"]
  );
  assert.deepEqual(turnMessages(structuredClone(turn), false), entries);
  assert.notEqual(
    turnMessages({ ...turn, id: "another" }, false).find((entry) => entry.kind === "activity")?.id,
    activity.id
  );
});

await test("legacy phase-less history keeps its last reply, and commentary-only interrupted turns remain visible", () => {
  const legacy = {
    ...turn,
    items: items.filter((item) => item.type === "agentMessage").map((item) => ({ ...item, phase: null })),
  };
  const entries = turnMessages(legacy, false);
  assert.equal(entries.at(LAST_ITEM_INDEX)?.kind, "message");
  assert.equal(
    entries.some((entry) => entry.kind === "message" && entry.item.id === "final"),
    true
  );
  const final = items.at(LAST_ITEM_INDEX);
  assert.ok(final);
  const onlyFinal = turnMessages({ ...turn, items: [final] }, false);
  assert.equal(
    onlyFinal.some((entry) => entry.kind === "activity"),
    false
  );
  const interrupted = turnMessages({ ...turn, status: "interrupted", items: [items[1]] }, false);
  assert.equal(interrupted[0].kind, "message");
});

await test("uninterrupted activity still collapses with the final answer outside", () => {
  const ordinary = { ...turn, items: items.filter((item) => item.id !== "steering") };
  const entries = turnMessages(ordinary, false);
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["message", "activity", "message", "message"]
  );
  const activity = entries[1];
  assert.ok(activity.kind === "activity");
  assert.deepEqual(
    activity.items.map((item) => item.id),
    ["first", "second"]
  );
  assert.equal(entries.at(LAST_ITEM_INDEX)?.kind, "message");
});

await test("each repeated interruption fixes all preceding updates in their chronological positions", () => {
  const final = items.at(LAST_ITEM_INDEX);
  assert.ok(final);
  const repeated: Turn = {
    ...turn,
    items: [
      ...items.slice(0, LAST_ITEM_INDEX),
      { id: "steering-again", type: "userMessage" },
      { id: "third", type: "agentMessage", phase: "commentary", text: "Third update" },
      final,
    ],
  };
  const entries = turnMessages(repeated, false);
  assert.deepEqual(
    entries.flatMap((entry) => (entry.kind === "message" ? entry.item.id : [])),
    ["user", "first", "steering", "second", "image", "steering-again", "final"]
  );
  assert.deepEqual(turnMessages(structuredClone(repeated), false), entries);
  assert.equal(entries.filter((entry) => entry.kind === "activity").length, 1);
});
