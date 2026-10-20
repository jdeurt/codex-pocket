// Isolated process fixture: implements the app-server flow without a model or live session.
import { type Data, type Turn, dataSchema, turnSchema } from "../../src/lib/protocol";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fixtureRequestSchema } from "./replay-protocol";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const directory = z.string().parse(process.env.CODEX_POCKET_STATE_DIR);
const threadId = z.string().parse(process.env.CODEX_THREAD_ID);
const historyFile = path.join(directory, "fake-history.json");
const turns = z.array(turnSchema).parse(JSON.parse(await readFile(historyFile, "utf8")));
const submissionSchema = z.object({
  expectedTurnId: z.string().optional(),
  clientUserMessageId: z.string(),
  input: z.array(dataSchema),
});

type Submission = z.infer<typeof submissionSchema>;

/**
Writes one offline native protocol response or notification.
@param message - Normalized synthetic native record.
*/
function send(message: unknown) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

/**
Scopes a synthetic native notification to the fixture's explicit thread.
@param method - Native notification method.
@param params - Normalized notification fields.
*/
function event(method: string, params: Data) {
  send({ method, params: { threadId, ...params } });
}

/**
Reads one host-controlled failure marker from this private replay directory.
@param stage - Native lifecycle stage selected by the integration flow.
@returns Whether the nonempty marker requests a synthetic failure.
*/
async function isFailing(stage: string) {
  try {
    return !!(await readFile(path.join(directory, `fail-${stage}`), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

/**
Appends a user submission and synthetic recovery reply, then persists the completed native turn.
@param turn - Existing or newly published canonical native turn.
@param params - Validated native submission.
@returns Native completed-turn response.
*/
async function completeTurn(turn: Turn, params: Submission) {
  const input = {
    id: randomUUID(),
    type: "userMessage",
    clientId: params.clientUserMessageId,
    content: params.input,
  };
  const reply = { id: randomUUID(), type: "agentMessage", phase: "final_answer", text: "Recovered work." };

  for (const item of [input, reply]) {
    turn.items.push(item);
    event("item/completed", { turnId: turn.id, item });
  }

  turn.status = "completed";
  event("turn/completed", { turn });
  await writeFile(historyFile, JSON.stringify(turns));

  return { turn };
}

/**
Selects the interrupted native turn for steer or publishes a new synthetic turn for start.
@param method - Native start or steer operation.
@param params - Validated native submission.
@returns Completed canonical turn; a missing steer target rejects.
*/
async function deliver(method: string, params: Submission) {
  const turn =
    method === "turn/steer"
      ? turns.find((entry) => entry.id === params.expectedTurnId)
      : { id: randomUUID(), status: "inProgress", items: [] };

  if (!turn) {
    throw new Error("Missing synthetic steer target.");
  }

  if (method === "turn/start") {
    turns.push(turn);
    event("turn/started", { turn });
  }

  return await completeTurn(turn, params);
}

/**
Implements the native recovery lifecycle with host-selected resume and history failures.
@param method - Decoded native request method.
@param params - Untrusted native parameters, validated before turn delivery.
@returns Synthetic native result; selected lifecycle failures reject.
*/
async function execute(method: string | undefined, params: Data) {
  switch (method) {
    case "config/read": {
      return { config: { sandbox_mode: "read-only", approval_policy: "never" } };
    }

    case "thread/resume": {
      if (await isFailing("resume")) {
        throw new Error("Fixture resume failed");
      }

      return { thread: { id: threadId, turns }, model: "isolated-fixture", reasoningEffort: "low" };
    }

    case "thread/read": {
      return { thread: { id: threadId, turns }, model: "isolated-fixture", reasoningEffort: "low" };
    }

    case "thread/turns/list": {
      if (await isFailing("history")) {
        throw new Error("Fixture history failed");
      }

      return { data: turns, nextCursor: null };
    }

    case "turn/start":
    case "turn/steer": {
      return await deliver(method, submissionSchema.parse(params));
    }

    default: {
      return {};
    }
  }
}

/**
Validates one stdin request and writes either its result or native fixture error.
@param line - Complete native JSON-RPC line.
@returns Completion of synthetic request handling.
*/
async function respond(line: string) {
  const request = fixtureRequestSchema.parse(JSON.parse(line));

  if (request.id === undefined) {
    return;
  }

  try {
    send({ id: request.id, result: await execute(request.method, request.params) });
  } catch (error) {
    send({ id: request.id, error: { code: -32_000, message: error instanceof Error ? error.message : String(error) } });
  }
}

/**
Pumps complete native request lines in arrival order.
@returns Completion of stdin consumption.
*/
async function readRequests() {
  const lines = createInterface({ input: process.stdin });

  for await (const line of lines) {
    await respond(line);
  }
}

/**
Records this private native process before consuming its actual stdin stream.
@returns Completion when the owning bridge closes stdin.
*/
async function replay() {
  await appendFile(path.join(directory, "fake-processes.jsonl"), JSON.stringify({ pid: process.pid }) + "\n");
  await readRequests();
}

await replay();
