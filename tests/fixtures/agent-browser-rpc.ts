import { appendFileSync, readFileSync, watchFile, writeFileSync } from "node:fs";
import { replayParent, replayThreads, replayTurns } from "./agent-browser-data";
import { createInterface } from "node:readline";
import { fixtureRequestSchema } from "./replay-protocol";
import { z } from "zod";

// OFFLINE JSON-RPC replay. Refuses every mutation directed at a child session.

const directory = process.env.POCKET_REPLAY_DIRECTORY;

if (!directory) {
  throw new Error("Missing isolated replay directory.");
}

const APPROVAL_DELAY_MS = 750;
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const stage = () =>
  z.object({ stage: z.string() }).parse(JSON.parse(readFileSync(`${directory}/control.json`, "utf8"))).stage;
const replay = { promptSent: false, activeReads: 0, maxReads: 0 };
const HISTORY_DELAY_MS = 30;
const PAGE_LIMIT = 20;
const APPEND_POLL_MS = 50;
const APPEND_REPETITIONS = 12;
const APPEND_STREAM_MS = 200;
const appended = new Set<string>();

// Inject real parent notifications through JSON-RPC/SSE while a child overlay is
// open. This is synthetic output, never an action dispatched to a harness.
watchFile(`${directory}/control.json`, { interval: APPEND_POLL_MS, persistent: false }, () => {
  const current = stage();

  if (!current.startsWith("parent-append:") || appended.has(current)) {
    return;
  }

  appended.add(current);
  const id = `parent-incoming-${current.slice("parent-append:".length).replaceAll(":", "-")}`;
  const turn = { id, status: "inProgress", items: [] };

  emit({ method: "turn/started", params: { threadId: replayParent, turn } });
  const text = `${id}. Parent streamed start. `;
  const item = { id, type: "agentMessage", phase: "final_answer", text };

  emit({
    method: "item/started",
    params: {
      threadId: replayParent,
      turnId: id,
      item,
    },
  });
  setTimeout(() => {
    const delta = `${"Parent output arriving while reading a child. ".repeat(APPEND_REPETITIONS)} STREAM_FINISHED`;

    emit({ method: "item/agentMessage/delta", params: { threadId: replayParent, turnId: id, itemId: id, delta } });
    emit({
      method: "item/completed",
      params: { threadId: replayParent, turnId: id, item: { ...item, text: text + delta } },
    });
    emit({ method: "turn/completed", params: { threadId: replayParent, turn: { ...turn, status: "completed" } } });
  }, APPEND_STREAM_MS).unref();
});

function turnPage(params: Record<string, unknown>, state: string) {
  const turns = replayTurns(String(params.threadId), state);
  const ordered = params.sortDirection === "desc" ? turns.toReversed() : turns;
  const offset = Number(params.cursor ?? 0);
  const limit = Math.min(Number(params.limit ?? PAGE_LIMIT), PAGE_LIMIT);
  const page = {
    data: ordered
      .slice(offset, offset + limit)
      .map((turn, index) =>
        params.itemsView === "notLoaded"
          ? { ...turn, items: [], itemsView: "notLoaded" }
          : params.sortDirection !== "desc" && index === 0
            ? { ...turn, items: [], itemsView: "summary" }
            : turn
      ),
    nextCursor: offset + limit < ordered.length ? String(offset + limit) : null,
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
      const threads = replayThreads(state === "settled", state === "history-changed" ? 2 : 1);

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

      const thread = replayThreads(state === "settled", state === "history-changed" ? 2 : 1).find(
        (entry) => entry.id === params.threadId
      ) ?? {
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
      return turnPage(params, state);
    }

    case "thread/items/list": {
      const turns = replayTurns(String(params.threadId), state);
      const items = params.turnId
        ? turns.find((turn) => turn.id === params.turnId)?.items
        : turns.flatMap((turn) => turn.items);

      if (!items) {
        throw new Error("Replay turn not found.");
      }

      const ordered = params.sortDirection === "desc" ? items.toReversed() : items;
      const offset = Number(params.cursor ?? 0);
      const limit = Math.min(Number(params.limit ?? 2), 2);

      return {
        data: ordered.slice(offset, offset + limit).map((item) => ({ item })),
        nextCursor: offset + limit < ordered.length ? String(offset + limit) : null,
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
  const request = fixtureRequestSchema.parse(JSON.parse(line));

  appendFileSync(
    `${directory}/rpc.jsonl`,
    JSON.stringify({
      method: request.method ?? "response",
      threadId: request.params.threadId,
      id: request.id,
      itemsView: request.params.itemsView,
      sortDirection: request.params.sortDirection,
      limit: request.params.limit,
      cursor: request.params.cursor,
    }) + "\n"
  );

  if (!request.method || request.id === undefined) {
    return;
  }

  const params = request.params;
  const state = stage();

  try {
    const result = response({ method: request.method }, params, state);
    const history =
      request.params.threadId !== replayParent && ["thread/turns/list", "thread/items/list"].includes(request.method);

    if (!history) {
      emit({ id: request.id, result });

      return;
    }

    replay.activeReads++;
    replay.maxReads = Math.max(replay.maxReads, replay.activeReads);
    writeFileSync(`${directory}/rpc-metrics.json`, JSON.stringify({ maxReads: replay.maxReads }));
    setTimeout(() => {
      replay.activeReads--;
      emit({ id: request.id, result });
    }, HISTORY_DELAY_MS);
  } catch (error) {
    emit({ id: request.id, error: { code: -32_600, message: String(error) } });
  }
});
