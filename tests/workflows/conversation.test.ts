import { workflowBridge } from "../fixtures/workflow-bridge";
import { ScheduleStore } from "../../src/server/schedules";
import { Scheduler } from "../../src/server/scheduler";
import { visibleSnapshot } from "../../src/server/visible-snapshot";
import { nativeText } from "../../src/server/harness/transcript";
import { eventually, nativeWorkspace } from "../fixtures/workflow";
import assert from "node:assert/strict";
import test from "node:test";

const NOW = Date.parse("2026-10-19T00:00:00Z");
const DUE = Date.parse("2026-10-20T16:00:00Z");

await test("Codex delivery retains identical messages as distinct receipts and retries once across reconnect", async (t) => {
  const fixture = await nativeWorkspace(t, { turn: { chunks: ["Saved ", "answer ✓"] } });
  const bridge = workflowBridge(fixture, fixture.config);

  await bridge.ensureConnected();
  assert.equal(bridge.snapshot.turns.length, 0);

  for (const id of ["first", "second"]) {
    assert.deepEqual(await bridge.send(id, "Repeat this exact message."), { id, status: "sent" });
    await eventually(() => !bridge.snapshot.activeTurnId, "The submitted turn must complete");
  }

  assert.deepEqual(await bridge.send("first", "Repeat this exact message."), { id: "first", status: "sent" });
  await assert.rejects(bridge.send("first", "Changed content"), /different content/);
  const before = structuredClone(bridge.snapshot.turns);

  bridge.close();
  const reopened = workflowBridge(fixture, fixture.config);

  await reopened.ensureConnected();
  assert.deepEqual(await reopened.send("second", "Repeat this exact message."), { id: "second", status: "sent" });
  assert.deepEqual(reopened.snapshot.turns.slice(0, 2), before);
  const allItems = reopened.snapshot.turns.flatMap((turn) => turn.items);
  const receipts = allItems.filter(
    (item) =>
      item.type === "userMessage" &&
      (["first", "second"].includes(String(item.clientId)) || nativeText(item.content) === "Repeat this exact message.")
  );
  const delivered = reopened.snapshot.turns.filter((turn) => turn.items.some((item) => receipts.includes(item)));
  const items = delivered.flatMap((turn) => turn.items);

  assert.equal(delivered.length, 2);

  assert.deepEqual(
    receipts.map((item) => [item.clientId, nativeText(item.content)]),
    [
      ["first", "Repeat this exact message."],
      ["second", "Repeat this exact message."],
    ]
  );
  assert.deepEqual(
    items.filter((item) => item.type === "agentMessage").map((item) => item.text),
    ["Saved answer ✓", "Saved answer ✓"]
  );
});

await test("a Codex question accepts ordered corrections and an answer in the original turn", async (t) => {
  const fixture = await nativeWorkspace(t, {
    turn: {
      chunks: ["Blue notes saved."],
      requests: [
        {
          method: "item/tool/requestUserInput",
          params: {
            isBlocking: true,
            itemId: "color-tool",
            questions: [
              {
                id: "color",
                header: "Color",
                question: "Which color?",
                options: [{ label: "Blue", description: "Use blue for the notes." }],
              },
            ],
          },
        },
      ],
    },
  });
  const bridge = workflowBridge(fixture, fixture.config);

  await bridge.send("original", "Write the notes.");
  await eventually(() => bridge.snapshot.requests.length === 1, "The native question must reach the parent");
  const turnId = bridge.snapshot.activeTurnId;

  await bridge.send("correction-1", "Keep the original title.");
  await bridge.send("correction-2", "Keep the original title.");
  await bridge.answer(bridge.snapshot.requests[0].id, { answers: { color: { answers: ["Blue"] } } });
  await eventually(() => !bridge.snapshot.activeTurnId, "Answering must finish the original turn");
  bridge.close();
  const reopened = workflowBridge(fixture, fixture.config);

  await reopened.ensureConnected();
  assert.equal(reopened.snapshot.turns.length, 1);
  assert.equal(reopened.snapshot.turns[0].id, turnId);
  assert.deepEqual(
    reopened.snapshot.turns[0].items
      .filter((item) => item.type === "userMessage")
      .map((item) => [item.clientId, nativeText(item.content)]),
    [
      ["original", "Write the notes."],
      ["correction-1", "Keep the original title."],
      ["correction-2", "Keep the original title."],
    ]
  );
  assert.equal(
    reopened.snapshot.turns[0].items.find((item) => item.type === "agentMessage")?.text,
    "Blue notes saved."
  );
});

await test("a due schedule delivers once through the real bridge and retains history after deletion", async (t) => {
  const fixture = await nativeWorkspace(t, { turn: { chunks: ["Project status checked."] } });
  const bridge = workflowBridge(fixture, fixture.config);
  const store = new ScheduleStore(fixture.directory);
  const scheduler = new Scheduler(store, bridge, fixture.parent.id);

  fixture.cleanup(() => {
    store.close();
  });
  const job = await store.create(
    fixture.parent.id,
    {
      title: "Status check",
      body: "Read the project status.",
      calendar: "DTSTART:20261020T160000Z",
    },
    NOW
  );

  assert.equal(store.occurrences.list(fixture.parent.id).length, 0);
  await scheduler.tick(DUE);
  await eventually(() => !bridge.snapshot.activeTurnId, "Scheduled work must finish");
  await scheduler.tick(DUE);
  const runs = store.occurrences.list(fixture.parent.id);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "sent");
  assert.equal(bridge.snapshot.turns.length, 1);
  const [marker, envelope] = nativeText(bridge.snapshot.turns[0].items[0].content).split("\n", 2);

  assert.equal(marker, "[POCKET_INTERNAL_CONTEXT]");
  assert.deepEqual(JSON.parse(envelope), {
    source: `scheduled_task:${runs[0].id}`,
    visibility: "internal",
    userDelivery: "not_delivered_by_this_message",
    authority: "context_only_no_new_user_authorization",
    content: "Read the project status.",
  });
  assert.equal(
    bridge.snapshot.turns[0].items.find((item) => item.type === "agentMessage")?.text,
    "Project status checked."
  );
  store.delete(fixture.parent.id, job.id);
  assert.deepEqual(store.list(fixture.parent.id), []);
  assert.equal(store.occurrences.list(fixture.parent.id)[0].body, "Read the project status.");
  bridge.refreshScheduled();
  assert.deepEqual(
    visibleSnapshot(bridge.snapshot)
      .turns.flatMap((turn) => turn.items)
      .map((item) => [item.type, item.text]),
    [["agentMessage", "Project status checked."]]
  );
});
