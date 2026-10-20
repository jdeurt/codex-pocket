import { type Item, initialSnapshot } from "../src/lib/protocol";
import { currentActivity, itemActivity } from "../src/server/activity";
import assert from "node:assert/strict";
import { reduceEvent } from "../src/server/reducer";
import test from "node:test";
import { visibleSnapshot } from "../src/server/visible-snapshot";

await test("activity summarizes structured actions without leaking paths, commands or tool arguments", () => {
  const command: Item = { id: "command", type: "commandExecution", command: "private command" };

  assert.equal(itemActivity(command), "Running commands");
  assert.equal(
    itemActivity({ ...command, commandActions: [{ type: "read", path: "/private/project/file.ts" }] }),
    "Reading files"
  );
  assert.equal(
    itemActivity({ ...command, commandActions: [{ type: "read", path: "/private/skills/test/SKILL.md" }] }),
    "Reading skills"
  );
  assert.equal(
    itemActivity({ ...command, commandActions: [{ type: "search", query: "private query" }] }),
    "Searching files"
  );
  assert.equal(itemActivity({ ...command, commandActions: [{ type: "listFiles" }] }), "Listing files");
  assert.equal(itemActivity({ ...command, pluginId: "private-plugin" }), "Using plugins");

  for (const type of ["mcpToolCall", "dynamicToolCall", "functionCallOutput"]) {
    assert.equal(
      itemActivity({
        id: "tool",
        type,
        server: "private-server",
        tool: "private-tool",
        arguments: { secret: "private" },
      }),
      "Calling tools"
    );
  }

  assert.equal(itemActivity({ id: "tool", type: "dynamicToolCall", tool: "toString" }), "Calling tools");
  assert.equal(itemActivity({ id: "tool", type: "dynamicToolCall", tool: "apply_patch" }), "Editing files");
});

await test("activity labels use plural targets and no punctuation across Codex item types", () => {
  for (const type of [
    "commandExecution",
    "fileChange",
    "webSearch",
    "imageView",
    "imageGeneration",
    "mcpToolCall",
    "dynamicToolCall",
    "functionCallOutput",
    "collabAgentToolCall",
    "subAgentActivity",
    "sleep",
    "plan",
    "enteredReviewMode",
    "exitedReviewMode",
    "contextCompaction",
    "hookPrompt",
    "reasoning",
    "futureItem",
  ]) {
    const label = itemActivity({ id: "item", type });

    assert.match(label ?? "", /^[A-Z][a-z]+(?: [a-z]+)*s$/);
  }

  assert.equal(
    itemActivity({ id: "page", type: "webSearch", action: { type: "open_page", url: "https://private.example" } }),
    "Browsing pages"
  );
  assert.equal(itemActivity({ id: "user", type: "userMessage" }), undefined);
  assert.equal(itemActivity({ id: "response", type: "agentMessage" }), "");
});

await test("live activity follows the latest event in this turn, survives reload and clears at completion", () => {
  const state = { ...structuredClone(initialSnapshot), threadId: "thread" };
  const item: Item = {
    id: "read",
    type: "commandExecution",
    command: "private command",
    commandActions: [{ type: "read", path: "/private/file" }],
  };

  reduceEvent(state, {
    method: "turn/started",
    params: { threadId: "thread", turn: { id: "turn", status: "inProgress", items: [] } },
  });

  reduceEvent(state, { method: "item/started", params: { threadId: "thread", turnId: "turn", item } });
  assert.equal(currentActivity(state), "Reading files");
  assert.equal(currentActivity({ ...state, activity: undefined }), "Reading files");
  const visible = visibleSnapshot(state);

  assert.equal(visible.activity, "Reading files");
  assert.equal(JSON.stringify(visible).includes("private"), false);
  reduceEvent(state, {
    method: "item/mcpToolCall/progress",
    params: { threadId: "other", turnId: "turn", message: "private" },
  });
  reduceEvent(state, {
    method: "item/mcpToolCall/progress",
    params: { threadId: "thread", turnId: "old", message: "private" },
  });
  assert.equal(currentActivity(state), "Reading files");
  reduceEvent(state, {
    method: "item/mcpToolCall/progress",
    params: { threadId: "thread", turnId: "turn", message: "private" },
  });
  assert.equal(currentActivity(state), "Calling tools");
  reduceEvent(state, {
    method: "item/reasoning/textDelta",
    params: { threadId: "thread", turnId: "turn", delta: "private thoughts" },
  });
  assert.equal(currentActivity(state), "Considering options");
  reduceEvent(state, {
    method: "item/started",
    params: { threadId: "thread", turnId: "turn", item: { id: "response", type: "agentMessage", text: "Hello" } },
  });
  assert.equal(currentActivity(state), "");
  assert.equal(currentActivity({ ...state, activity: undefined }), "");
  reduceEvent(state, {
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } },
  });
  assert.equal(currentActivity(state), undefined);
  assert.equal(state.activity, undefined);
  reduceEvent(state, {
    method: "turn/started",
    params: { threadId: "thread", turn: { id: "next", status: "inProgress", items: [] } },
  });
  assert.equal(currentActivity(state), "Considering options");
});
