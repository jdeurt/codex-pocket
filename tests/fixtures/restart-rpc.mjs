// Isolated process fixture: implements the app-server flow without a model or live session.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { randomUUID } from "node:crypto";

const directory = process.env.CODEX_POCKET_STATE_DIR;
const threadId = process.env.CODEX_THREAD_ID;
const historyFile = path.join(directory, "fake-history.json");
const turns = JSON.parse(await readFile(historyFile, "utf8"));

await appendFile(path.join(directory, "fake-processes.jsonl"), JSON.stringify({ pid: process.pid }) + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const event = (method, params) => send({ method, params: { threadId, ...params } });
const lines = createInterface({ input: process.stdin });

async function failing(stage) {
  try {
    return !!(await readFile(path.join(directory, `fail-${stage}`), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function respond(line) {
  const { id, method, params = {} } = JSON.parse(line);

  if (id === undefined) {
    return;
  }

  let result = {};

  switch (method) {
    case "config/read": {
      result = { config: { sandbox_mode: "read-only", approval_policy: "never" } };
      break;
    }

    case "thread/resume": {
      if (await failing("resume")) {
        send({ id, error: { code: -32_000, message: "Fixture resume failed" } });

        return;
      }

      result = { thread: { id: threadId, turns }, model: "isolated-fixture", reasoningEffort: "low" };
      break;
    }

    case "thread/read": {
      result = { thread: { id: threadId, turns }, model: "isolated-fixture", reasoningEffort: "low" };
      break;
    }

    case "thread/turns/list": {
      if (await failing("history")) {
        send({ id, error: { code: -32_000, message: "Fixture history failed" } });

        return;
      }

      result = { data: turns, nextCursor: null };
      break;
    }

    case "turn/start":
    case "turn/steer": {
      const turn =
        method === "turn/steer"
          ? turns.find((entry) => entry.id === params.expectedTurnId)
          : { id: randomUUID(), status: "inProgress", items: [] };

      if (method === "turn/start") {
        turns.push(turn);
        event("turn/started", { turn });
      }

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
      result = { turn };
      break;
    }

    default: {
      break;
    }
  }

  send({ id, result });
}

for await (const line of lines) {
  await respond(line);
}
