import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { classifyTaskLedger } from "../../src/tasks/classification-runtime";
import { readTaskLedger } from "../../src/tasks/management";
import { acceptTaskReceipts } from "../../src/tasks/ingestion";
import { piWorkflow } from "../fixtures/pi-workflow";
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

const describedTaskSchema = z.object({ id: z.string(), originalIntent: z.string() });
const predicateQuestion = z.object({ name: z.string() });
const predicateQuestions = z.array(predicateQuestion);
const intentRequestSchema = z.object({ model: z.string(), input: z.string(), questions: predicateQuestions });
const intentInputSchema = z.object({ current_request: z.string(), tasks: z.array(describedTaskSchema) });

/** Return canned predicate evidence for this orchestration workflow, without claiming classification quality.
@param input - Exact current request and bounded task descriptions.
@param question - Requested predicate.
@returns Synthetic provider answer.
*/
function intentAnswer(input: z.infer<typeof intentInputSchema>, question: { name: string }) {
  const isFollowup = input.current_request === "Make launchcalendar weekly.";

  let probability = 0;

  if (question.name === "actionable") {
    probability = 1;
  } else if (question.name === "independent") {
    probability = isFollowup ? 0 : 1;
  } else if (question.name.startsWith("task_")) {
    const index = Number(question.name.slice("task_".length));

    probability = isFollowup && input.tasks[index]?.originalIntent === "Plan launchcalendar." ? 1 : 0;
  }

  return { type: "predicate", name: question.name, probability };
}

/** Replay the external Decisions contract against bounded intent evidence.
@param url - Requested endpoint.
@param options - Actual provider request.
@returns Synthetic predicate response.
*/
function intentResponse(url: unknown, options: RequestInit) {
  assert.equal(url, "https://api.openai.com/v1/decisions");
  assert.equal(options.method, "POST");
  const body = z.string().parse(options.body);
  const request = intentRequestSchema.parse(JSON.parse(body));
  const input = intentInputSchema.parse(JSON.parse(request.input));

  assert.equal(request.model, "gpt-6-luna");

  const answers = Array.from(request.questions, intentAnswer.bind(undefined, input));

  return Promise.resolve(Response.json({ answers }));
}

/** Encode one synthetic accepted request.
@param text - Original request.
@param index - Stable fixture identity.
@returns Durable receipt.
*/
function acceptedRequest(text: string, index: number) {
  return { id: `message-${String(index)}`, text, status: "sent" as const };
}

/** Provide one exact recorded provider answer.
@param message - Original request.
@returns Synthetic main-agent response.
*/
function recordedAnswer(message: string) {
  return fauxAssistantMessage(`Recorded: ${message}`);
}

/** Read exact original evidence from a source-validated search result.
@param hit - Actual search result.
@returns Exact source bytes.
*/
function originalText(hit: z.infer<typeof taskSearchPage>["results"][number]) {
  return readFile(hit.source.file, "utf8");
}

/** Check literal evidence within an exact original.
@param expected - Original request text.
@param text - Exact source bytes.
@returns Whether the exact original is retained.
*/
function hasOriginal(expected: string, text: string) {
  return text.includes(expected);
}

/** Check source-backed task associations are present in retrieval.
@param hit - Actual search result.
@returns Whether the source has task membership.
*/
function hasAssociation(hit: z.infer<typeof taskSearchPage>["results"][number]) {
  return hit.taskAssociations.length > 0;
}

await test("Pi source ingestion keeps interleaved tasks open and searchable without nonmatch closure across restart", async (t) => {
  const flow = await piWorkflow(t, 2);
  const messages = [
    "Plan launchcalendar.",
    "Make launchcalendar weekly.",
    "Discuss receipts.",
    "Review keyboard.",
    "Prepare roadmap.",
    "Update colors.",
    "Check notifications.",
  ];

  acceptTaskReceipts(flow.parent.id, Array.from(messages, acceptedRequest), {});
  flow.provider.setResponses(Array.from(messages, recordedAnswer));

  for (const [index, message] of messages.entries()) {
    const completed = turnSchema.parse(await flow.send(`message-${String(index)}`, message));

    assert.equal(completed.status, "completed");
  }

  await flow.main.close();
  const active = readTaskLedger(flow.parent.id);

  assert.equal(active.bindings.length, messages.length);
  const reopened = flow.create();

  await reopened.request("thread/resume", {});
  await reopened.close();
  assert.deepEqual(readTaskLedger(flow.parent.id), active, "Restart must not replay source ingestion");
  t.mock.method(globalThis, "fetch", intentResponse);
  const grouped = await classifyTaskLedger(flow.parent.id, "synthetic-classifier-key");

  assert.equal(grouped.tasks.length, messages.length - 1);

  for (const task of grouped.tasks) {
    assert.equal(task.work, "open", "Neither model turn completion nor nonmatches establish resolution");
  }

  const client = await searchClient(flow, flow.parent.id);
  const result = await client.callTool({ name: "pocket_task_search", arguments: { query: "launchcalendar" } });

  assert.equal(result.isError, undefined);
  const page = taskSearchPage.parse(result.structuredContent);
  const texts = await Promise.all(Array.from(page.results, originalText));

  assert.ok(texts.some(hasOriginal.bind(undefined, "Plan launchcalendar.")));
  assert.ok(texts.some(hasOriginal.bind(undefined, "Make launchcalendar weekly.")));
  assert.ok(page.results.some(hasAssociation.bind(undefined)));
});
