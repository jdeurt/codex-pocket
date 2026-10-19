// OFFLINE JSON-RPC replay. Refuses every mutation directed at a child session.
import { appendFileSync, readFileSync } from "node:fs";
import { replayParent, replayThreads, replayTurns } from "./agent-browser-data";
import { createInterface } from "node:readline";

const directory = process.env.POCKET_REPLAY_DIRECTORY;

if (!directory) {
  throw new Error("Missing isolated replay directory.");
}

const APPROVAL_DELAY_MS = 750;
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const stage = () => JSON.parse(readFileSync(`${directory}/control.json`, "utf8")).stage as string;
const replay = { promptSent: false };

function response(request: { method: string }, params: Record<string, unknown>, state: string): unknown {
  switch (request.method) {
    case "initialize": {
      return { userAgent: "offline-replay" };
    }

    case "config/read": {
      return {
        config: {
          sandbox_mode: "danger-full-access",
          approval_policy: "never",
          model: "gpt-replay",
          model_reasoning_effort: "high",
        },
      };
    }

    case "thread/resume": {
      if (params.threadId !== replayParent) {
        throw new Error("Child resume forbidden in replay");
      }

      return { thread: { id: replayParent, turns: [] }, model: "gpt-replay", reasoningEffort: "high" };
    }

    case "thread/list": {
      const threads = replayThreads(state === "settled");

      return params.archived
        ? { data: [], nextCursor: null }
        : params.cursor
          ? { data: threads.slice(2), nextCursor: null }
          : { data: threads.slice(0, 2), nextCursor: "second-page" };
    }

    case "thread/read": {
      if (state === "unavailable" && params.threadId === "native-codex") {
        throw new Error("Synthetic auth failure");
      }

      const thread = replayThreads(state === "settled").find((entry) => entry.id === params.threadId) ?? {
        id: params.threadId,
        name: "Saved Side Pocket",
        model: "gpt-replay",
        reasoningEffort: "high",
      };

      if (params.threadId === "missing-session") {
        throw new Error("Synthetic missing session");
      }

      return { thread: { ...thread, turns: params.includeTurns ? replayTurns(String(params.threadId), state) : [] } };
    }

    case "thread/turns/list": {
      const turns = replayTurns(String(params.threadId), state);
      const page = params.cursor
        ? { data: turns.slice(1), nextCursor: null }
        : {
            data: turns.slice(0, 1).map((turn) => ({ ...turn, items: [], itemsView: "summary" })),
            nextCursor: turns.length > 1 ? "more-turns" : null,
          };

      if (params.threadId === replayParent && !replay.promptSent) {
        replay.promptSent = true;
        setTimeout(
          () =>
            emit({
              id: "parent-approval",
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: replayParent,
                turnId: "parent-approval-turn",
                reason: "Replay parent approval remains writable.",
                command: "echo replay",
                availableDecisions: ["accept", "decline"],
              },
            }),
          APPROVAL_DELAY_MS
        );
      }

      return page;
    }

    case "thread/items/list": {
      const turn = replayTurns(String(params.threadId), state).find((entry) => entry.id === params.turnId);

      if (!turn) {
        throw new Error("Replay turn not found.");
      }

      return params.cursor
        ? { data: turn.items.slice(2).map((item) => ({ item })), nextCursor: null }
        : {
            data: turn.items.slice(0, 2).map((item) => ({ item })),
            nextCursor: turn.items.length > 2 ? "more-items" : null,
          };
    }

    case "turn/start":
    case "turn/steer": {
      if (params.threadId !== replayParent) {
        throw new Error("Child action forbidden in replay");
      }

      return { turn: { id: "parent-recovery", status: "completed", items: [] } };
    }

    default: {
      throw new Error(`Unsupported replay operation ${request.method}`);
    }
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(
    `${directory}/rpc.jsonl`,
    JSON.stringify({ method: request.method ?? "response", threadId: request.params?.threadId, id: request.id }) + "\n"
  );

  if (!request.method || request.id === undefined) {
    return;
  }

  const params = request.params ?? {};
  const state = stage();

  try {
    const result = response(request, params, state);
    emit({ id: request.id, result });
  } catch (error) {
    emit({ id: request.id, error: { code: -32_600, message: String(error) } });
  }
});
