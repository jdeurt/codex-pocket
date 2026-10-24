import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { nativeText } from "../../src/state/harness-transcript";
import { object } from "../../src/lib/protocol";
import { piWorkflow } from "../fixtures/pi-workflow";
import { eventually } from "../fixtures/workflow";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const LAST_TURN = -1;

await test("Pi executes requested file work and preserves exact repeated messages and tool results after reopen", async (t) => {
  const flow = await piWorkflow(t, 2);

  flow.provider.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "notes.txt", content: "Original notes ✓\n" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("edit", { path: "notes.txt", oldText: "Original", newText: "Reviewed" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Reviewed notes saved."),
    fauxAssistantMessage("I received the repeated request."),
  ]);
  const initial = await flow.history();

  assert.equal(initial.length, 0);
  const completed = await flow.send("first", "Write the notes.");

  assert.equal(completed.status, "completed");
  assert.equal(await readFile(path.join(flow.directory, "notes.txt"), "utf8"), "Reviewed notes ✓\n");
  const repeated = await flow.send("second", "Write the notes.");

  assert.equal(repeated.status, "completed");
  await flow.main.close();
  const restored = flow.create();

  await restored.request("thread/resume", {});
  const saved = await flow.history(restored);
  const items = saved.flatMap((turn) => turn.items);

  assert.deepEqual(
    items.filter((item) => item.type === "userMessage").map((item) => [item.clientId, nativeText(item.content)]),
    [
      ["first", "Write the notes."],
      ["second", "Write the notes."],
    ]
  );
  assert.deepEqual(
    items.filter((item) => item.type === "agentMessage").map((item) => item.text),
    ["Reviewed notes saved.", "I received the repeated request."]
  );
  assert.deepEqual(
    items.filter((item) => item.type === "toolTrace").map((item) => [item.tool, item.status]),
    [
      ["write", "completed"],
      ["edit", "completed"],
    ]
  );
  assert.equal(flow.provider.getPendingResponseCount(), 0);
});

await test("Pi questions retain ordered steering and interrupt safely before successful new work", async (t) => {
  const flow = await piWorkflow(t);

  flow.provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("request_user_input", {
        questions: [{ id: "color", question: "Which color?", options: [{ label: "Blue" }] }],
      }),
      { stopReason: "toolUse" }
    ),
    (context) => {
      const result = context.messages.findLast((message) => message.role === "toolResult");

      assert.match(nativeText(result?.content ?? ""), /Blue/);

      return fauxAssistantMessage("Blue selected; preparing notes.");
    },
    (context) => {
      const corrections = context.messages.filter(
        (message) => message.role === "user" && nativeText(message.content) === "Keep this exact correction."
      );

      assert.equal(corrections.length, 2, "Both accepted corrections must reach the provider");

      return fauxAssistantMessage("Blue notes with both corrections.");
    },
  ]);
  const result = object(
    await flow.main.request("turn/start", {
      input: [{ type: "text", text: "Prepare notes and ask for the color." }],
      clientUserMessageId: "question",
    })
  );

  await eventually(() => flow.events.some((event) => event.id !== undefined), "Pi must publish its question");
  const question = flow.events.find((event) => event.id !== undefined);

  assert.ok(question?.id);

  for (const id of ["correction-1", "correction-2"]) {
    await flow.main.request("turn/steer", {
      expectedTurnId: object(result.turn).id,
      clientUserMessageId: id,
      input: [{ type: "text", text: "Keep this exact correction." }],
    });
  }

  flow.main.respond(question.id, { answers: { color: { answers: ["Blue"] } } });
  await eventually(() => flow.events.some((event) => event.method === "turn/completed"), "Answer must finish Pi work");
  const answered = await flow.history();
  const items = answered.flatMap((turn) => turn.items);

  assert.deepEqual(
    items.filter((item) => item.type === "userMessage").map((item) => [item.clientId, nativeText(item.content)]),
    [
      ["question", "Prepare notes and ask for the color."],
      ["correction-1", "Keep this exact correction."],
      ["correction-2", "Keep this exact correction."],
    ]
  );
  assert.equal(items.findLast((item) => item.type === "agentMessage")?.text, "Blue notes with both corrections.");
  flow.provider.setResponses([
    fauxAssistantMessage(fauxToolCall("request_user_input", { questions: [{ id: "wait", question: "Continue?" }] }), {
      stopReason: "toolUse",
    }),
  ]);
  const start = flow.events.length;
  const waiting = object(
    await flow.main.request("turn/start", {
      input: [{ type: "text", text: "Wait for confirmation." }],
      clientUserMessageId: "cancel",
    })
  );

  await eventually(
    () => flow.events.slice(start).some((event) => event.id !== undefined),
    "The second question must be pending"
  );
  await flow.main.request("turn/interrupt", { turnId: object(waiting.turn).id });
  await eventually(
    () => flow.events.slice(start).some((event) => event.method === "turn/completed"),
    "Interrupted Pi work must settle"
  );
  const interrupted = await flow.history();

  assert.equal(interrupted.at(LAST_TURN)?.status, "interrupted");
  flow.provider.setResponses([fauxAssistantMessage("Fresh work completed.")]);
  const fresh = await flow.send("after-interrupt", "Start fresh work.");

  assert.equal(fresh.status, "completed");
  const freshHistory = await flow.history();

  assert.equal(
    freshHistory.at(LAST_TURN)?.items.findLast((item) => item.type === "agentMessage")?.text,
    "Fresh work completed."
  );
});

await test("Pi recovers a provider rate limit and applies a chosen model to later work", async (t) => {
  const flow = await piWorkflow(t);

  flow.provider.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" }),
    fauxAssistantMessage("Recovered notes."),
  ]);
  const retried = await flow.send("retry", "Review the notes.");

  assert.equal(retried.status, "completed");
  const retriedHistory = await flow.history();

  assert.equal(
    retriedHistory.at(LAST_TURN)?.items.findLast((item) => item.type === "agentMessage")?.text,
    "Recovered notes."
  );
  await flow.main.request("thread/settings/update", { model: "pocket-workflow/review", effort: "high" });
  flow.provider.setResponses([
    (_context, _options, _state, model) => {
      assert.equal(model.id, "review", "Later work must use the chosen provider model");

      return fauxAssistantMessage("Review model completed the request.");
    },
  ]);
  const switched = await flow.send("next-model", "Use the review model.");

  assert.equal(switched.status, "completed");
  const history = object(await flow.main.request("thread/read", { threadId: flow.parent.id }));

  assert.equal(object(history.thread).model, "pocket-workflow/review");
  assert.equal(flow.provider.getPendingResponseCount(), 0);
});
