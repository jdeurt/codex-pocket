import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  type TaskContextState,
  groupTaskContext,
  ingestTaskEntry,
  readTaskState,
  saveTaskState,
} from "../src/server/task-context";
import { saveTaskSource, searchTaskArchive, taskDirectory } from "../src/server/task-archive";
import { checkTaskSearch } from "./fixtures/task-search-checks";
import { settleTaskIndex } from "../src/server/task-search";
import assert from "node:assert/strict";
import { isSameTask } from "../src/server/task-decisions";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";

const evidenceSchema = z.object({ matched_user_messages: z.array(z.string()), candidate_user_message: z.string() });
const questionSchema = z.object({ type: z.string() });
const LARGE_OUTPUT_REPETITIONS = 2000;
const requestSchema = z.object({
  model: z.string(),
  input: z.string(),
  questions: z.array(questionSchema),
});

/** Append a real source record before persisting active context, matching the Pi ingestion boundary.
@param owner - Isolated parent namespace.
@param state - Active working state.
@param role - Native source role.
@param text - Exact original text.
@param original - Optional native message envelope.
*/
async function append(owner: string, state: TaskContextState, role: string, text: string, original?: unknown) {
  const entry = {
    id: crypto.randomUUID(),
    sequence: state.revision,
    role,
    text,
    original: original ?? { role, content: text, toolCallId: "interleaved-call" },
  };

  await saveTaskSource(owner, entry);
  ingestTaskEntry(state, entry);
  await saveTaskState(owner, state);
}

/** Use the documented production classifier with an intercepted offline HTTP boundary.
@param candidate - Next candidate user message.
@param matched - Entire matched user set.
@returns The documented predicate decision.
*/
const isSameTaskRequest = (candidate: string, matched: string[]) => isSameTask("offline-test-key", candidate, matched);

/** Exercise archive persistence, open-anchor rebuilding and exact retrieval across restart boundaries.
@param owner - Isolated parent namespace.
@param count - Current number of provider requests.
*/
async function exerciseArchive(owner: string, count: () => number) {
  const state = await readTaskState(owner);

  await append(owner, state, "user", "A: build the calendar");
  await append(owner, state, "assistant", "tool call: `calendar-write` with exact arguments", {
    timestamp: "2026-10-23T08:00:00.000Z",
    message: {
      role: "assistant",
      provider: "openai",
      content: [
        { type: "text", text: "tool call: `calendar-write` with exact arguments" },
        { type: "toolCall", id: "interleaved-call", name: "calendar-write", arguments: { path: "notes/calendar.md" } },
      ],
    },
  });
  await append(owner, state, "user", "B: a separate task");
  const longOutput =
    "interleaved-call result: exact bytes ✓\n" +
    "retained output ".repeat(LARGE_OUTPUT_REPETITIONS) +
    "late-calendar-needle";

  await append(owner, state, "toolResult", longOutput, {
    timestamp: "2026-10-23T08:00:01.000Z",
    message: {
      role: "toolResult",
      toolCallId: "interleaved-call",
      toolName: "calendar-write",
      content: [
        { type: "text", text: longOutput },
        { type: "image", mimeType: "image/png", data: "private-image-payload" },
      ],
    },
  });
  await append(owner, state, "user", "A: make that weekly");
  assert.deepEqual(await groupTaskContext(owner, state, isSameTaskRequest), []);
  const original = state.open;

  assert.ok(original);
  const unchangedRequests = count();

  await groupTaskContext(owner, state, isSameTaskRequest);
  assert.equal(count(), unchangedRequests);
  const restored = await readTaskState(owner);

  for (const label of ["C", "D", "E", "F"]) {
    await append(owner, restored, "user", `${label}: independent work`);
  }

  await groupTaskContext(owner, restored, isSameTaskRequest);
  assert.ok(restored.open);
  assert.equal(restored.open.id, original.id);
  assert.equal(restored.open.file, original.file);
  await append(owner, restored, "user", "A: final correction resets the counter");
  await groupTaskContext(owner, restored, isSameTaskRequest);
  assert.ok(restored.open);
  assert.equal(restored.open.id, original.id);

  for (const label of ["G", "H", "I", "J", "K"]) {
    await append(owner, restored, "user", `${label}: unrelated work`);
  }

  const closed = await groupTaskContext(owner, restored, isSameTaskRequest);

  assert.ok(closed.includes(original.id));
  assert.ok(restored.messages.every((message) => !message.text.startsWith("A:")));
  const markdown = await readFile(path.join(taskDirectory(owner), original.file), "utf8");

  assert.match(markdown, /Status: closed/);
  assert.match(markdown, /interleaved-call result: exact bytes ✓/);
  assert.match(markdown, /`calendar-write`/);
  assert.match(markdown, /Result of source/);
  assert.match(markdown, /2026-10-23T08:00:01.000Z/);
  assert.match(markdown, /Truncated:/);
  assert.doesNotMatch(markdown, /late-calendar-needle|private-image-payload/);
  const results = await searchTaskArchive(owner, "exact bytes ✓");

  assert.ok(results.length > 0);
  await checkTaskSearch(owner, original.file, longOutput);
  const final = await readTaskState(owner);
  const before = count();

  await groupTaskContext(owner, final, isSameTaskRequest);
  assert.equal(count(), before);
  assert.deepEqual(await searchTaskArchive("different-parent", "calendar"), []);
}

await test("task context resumes open anchors, archives exact interleaving and retrieves originals after restart", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pocket-task-archive-"));
  const previous = process.env.CODEX_POCKET_STATE_DIR;
  const owner = "archive-parent";

  let requests = 0;

  process.env.CODEX_POCKET_STATE_DIR = root;
  t.mock.method(globalThis, "fetch", (_url: unknown, options: RequestInit) => {
    requests++;
    const content = z.string().parse(options.body);
    const body = requestSchema.parse(JSON.parse(content));
    const evidence = evidenceSchema.parse(JSON.parse(body.input));

    assert.equal(body.model, "gpt-6-luna");
    assert.equal(body.questions[0].type, "predicate");
    const prefix = evidence.matched_user_messages[0].split(":", 1)[0];

    return Promise.resolve(
      Response.json({
        answers: [
          {
            type: "predicate",
            name: "same_task",
            probability: evidence.candidate_user_message.startsWith(prefix + ":") ? 1 : 0,
          },
        ],
      })
    );
  });

  try {
    await exerciseArchive(owner, () => requests);
  } finally {
    await settleTaskIndex(owner);

    if (previous === undefined) {
      delete process.env.CODEX_POCKET_STATE_DIR;
    } else {
      process.env.CODEX_POCKET_STATE_DIR = previous;
    }

    await rm(root, { recursive: true, force: true });
  }
});
