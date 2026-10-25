import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { groupTaskContext, readTaskState } from "../../src/tasks/legacy-runtime";
import { isSameTask } from "../../src/tasks/classifier";
import { piWorkflow } from "../fixtures/pi-workflow";
import { eventually } from "../fixtures/workflow";
import { taskSearchPage } from "../../src/tasks/retrieval/protocol";
import { turnSchema } from "../../src/lib/protocol";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

/** Connect the public archive tool under an explicit parent identity in a new process.
@param scope - Private state and cleanup owner.
@param owner - Parent whose history may be retrieved.
@returns Connected production MCP client.
*/
async function searchClient(scope: { directory: string; cleanup: (close: () => unknown) => void }, owner: string) {
  const client = new Client({ name: "history-workflow", version: "1" });

  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "scripts/mcp.ts"],
      cwd: process.cwd(),
      env: { CODEX_POCKET_STATE_DIR: scope.directory, POCKET_THREAD_ID: owner },
      stderr: "pipe",
    })
  );
  scope.cleanup(() => client.close());

  return client;
}

await test("Pi migration preserves saved native history and search returns original scoped source passages after restart", async (t) => {
  const bytes = await readFile(new URL("../fixtures/history/codex-notes.json", import.meta.url), "utf8");
  const turns = z.array(turnSchema).parse(JSON.parse(bytes));
  const flow = await piWorkflow(t, 1, turns);
  const imported = await flow.history();

  assert.deepEqual(imported, turns);
  await flow.main.close();
  const client = await searchClient(flow, flow.parent.id);
  const result = await client.callTool({ name: "pocket_task_search", arguments: { query: "launchcalendar" } });

  assert.equal(result.isError, undefined);
  const page = taskSearchPage.parse(result.structuredContent);
  const hit = page.results.find((entry) => entry.source.id === "calendar-tool");

  assert.ok(hit, "The migrated MCP output must be searchable, not only the user request");
  assert.match(hit.excerpt, /Córdoba review is Thursday at 16:00 UTC/);
  const source = await readFile(hit.source.file, "utf8");

  assert.match(source, /Keep the original agenda/);
  assert.match(source, /calendar-tool/);
  const passageFile = await readFile(hit.file, "utf8");

  assert.equal(passageFile.slice(hit.passage.start, hit.passage.end), hit.excerpt);
  const other = await searchClient(flow, "other-parent");
  const isolated = await other.callTool({ name: "pocket_task_search", arguments: { query: "launchcalendar" } });

  assert.equal(isolated.isError, undefined);
  assert.deepEqual(taskSearchPage.parse(isolated.structuredContent).results, []);
  const forged = await other.callTool({
    name: "pocket_task_search",
    arguments: { query: "launchcalendar", owner: flow.parent.id },
  });

  assert.equal(forged.isError, true);
  const retried = await client.callTool({ name: "pocket_task_search", arguments: { query: "launchcalendar" } });
  const restored = taskSearchPage.parse(retried.structuredContent);

  assert.equal(restored.results.find((entry) => entry.source.id === "calendar-tool")?.excerpt, hit.excerpt);
});

await test("Pi source ingestion archives a continuing task after five unrelated messages and retrieves its original content", async (t) => {
  const flow = await piWorkflow(t, 2);
  const source = await readFile(new URL("../fixtures/history/task-decisions.json", import.meta.url), "utf8");
  const exchange = z.object({ candidate: z.string(), matched: z.array(z.string()), continues: z.boolean() });
  const exchanges = z.array(exchange).parse(JSON.parse(source));
  const messages = [
    "Plan launchcalendar.",
    "Make launchcalendar weekly.",
    "Discuss receipts.",
    "Review keyboard.",
    "Prepare roadmap.",
    "Update colors.",
    "Check notifications.",
  ];

  flow.provider.setResponses(messages.map((message) => fauxAssistantMessage(`Recorded: ${message}`)));

  for (const [index, message] of messages.entries()) {
    const completed = turnSchema.parse(await flow.send(`message-${String(index)}`, message));

    assert.equal(completed.status, "completed");
    assert.equal(completed.items.find((item) => item.type === "agentMessage")?.text, `Recorded: ${message}`);
  }

  const canonical = await flow.history();

  assert.equal(canonical.length, messages.length);
  await eventually(async () => {
    const state = await readTaskState(flow.parent.id);

    return (
      state.messages.length === messages.length &&
      state.messages.every((message, index) =>
        message.entries.some((entry) => entry.role === "assistant" && entry.text === `Recorded: ${messages[index]}`)
      )
    );
  }, "All seven user messages and their final answers must reach active context before shutdown");
  const active = await readTaskState(flow.parent.id);

  assert.equal(active.messages.length, messages.length);
  assert.deepEqual(
    active.messages.map((message) => message.text),
    messages
  );
  assert.deepEqual(
    active.messages.map((message) => message.entries.map((entry) => [entry.role, entry.text])),
    messages.map((text) => [
      ["user", text],
      ["assistant", `Recorded: ${text}`],
    ])
  );
  await flow.main.close();
  const reopened = flow.create();

  await reopened.request("thread/resume", {});
  await reopened.close();
  const resumed = await readTaskState(flow.parent.id);

  assert.deepEqual(resumed.messages, active.messages, "Resuming must not replay already ingested native messages");
  assert.equal(resumed.revision, active.revision);
  t.mock.method(globalThis, "fetch", (url: unknown, options: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/decisions");
    assert.equal(options.method, "POST");
    const body = z.string().parse(options.body);
    const request = z.object({ model: z.string(), input: z.string() }).parse(JSON.parse(body));
    const evidence = z
      .object({ matched_user_messages: z.array(z.string()), candidate_user_message: z.string() })
      .parse(JSON.parse(request.input));
    const expected = exchanges.shift();

    assert.ok(expected, "Unexpected classifier request");
    assert.equal(request.model, "gpt-6-luna");
    assert.deepEqual(evidence, { matched_user_messages: expected.matched, candidate_user_message: expected.candidate });

    return Promise.resolve(
      Response.json({ answers: [{ type: "predicate", name: "same_task", probability: expected.continues ? 1 : 0 }] })
    );
  });
  const grouped = await groupTaskContext(flow.parent.id, resumed, (candidate, matched) =>
    isSameTask("synthetic-classifier-key", undefined, candidate, matched)
  );

  assert.equal(exchanges.length, 0, "All required classifier inputs must be consumed");
  assert.equal(grouped.closed.length, 1);
  const restored = await readTaskState(flow.parent.id);

  assert.deepEqual(
    restored.messages.map((message) => message.text),
    messages.slice(2)
  );
  const client = await searchClient(flow, flow.parent.id);
  const result = await client.callTool({ name: "pocket_task_search", arguments: { query: "launchcalendar" } });

  assert.equal(result.isError, undefined);
  const page = taskSearchPage.parse(result.structuredContent);
  const texts = await Promise.all(page.results.map((hit) => readFile(hit.source.file, "utf8")));

  assert.ok(texts.some((text) => text.includes("Plan launchcalendar.")));
  assert.ok(texts.some((text) => text.includes("Make launchcalendar weekly.")));
});
