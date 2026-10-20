import { activeThreadPage, pageItems, pageTurns, savedThread } from "./agent-browser-pages";
import { appendFileSync, readFileSync, watchFile, writeFileSync } from "node:fs";
import { replayParent, replayTurns } from "./agent-browser-data";
import { createInterface } from "node:readline";
import { fixtureRequestSchema } from "./replay-protocol";
import { z } from "zod";
// OFFLINE JSON-RPC replay. Refuses every mutation directed at a child session.

/**
Requires the fake host's explicitly isolated replay directory before registering any I/O.
@returns Private replay directory; missing configuration throws.
*/
function replayDirectory() {
  const directory = process.env.POCKET_REPLAY_DIRECTORY;

  if (!directory) {
    throw new Error("Missing isolated replay directory.");
  }

  return directory;
}

const directory = replayDirectory();
const APPROVAL_DELAY_MS = 750;

/**
Writes one synthetic native protocol record on the real child stdout pipe.
@param value - Native result, notification or request produced by the offline replay.
*/
function emit(value: unknown) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

const stageSchema = z.object({ stage: z.string() });

/**
Validates the current fake-host control stage at the private file boundary.
@returns Host-selected replay stage.
*/
function stage() {
  return stageSchema.parse(JSON.parse(readFileSync(`${directory}/control.json`, "utf8"))).stage;
}

const replay = { promptSent: false, activeReads: 0, maxReads: 0 };
const HISTORY_DELAY_MS = 30;
const APPEND_POLL_MS = 50;
const APPEND_REPETITIONS = 12;
const APPEND_STREAM_MS = 200;
const appended = new Set<string>();

/**
Publishes the synthetic parent turn, item, streamed delta and completion in native order.
@param current - Validated append control identity, already reserved in the deduplication set.
*/
function streamParentAppend(current: string) {
  const id = `parent-incoming-${current.slice("parent-append:".length).replaceAll(":", "-")}`;
  const turn = { id, status: "inProgress", items: [] };

  const text = `${id}. Parent streamed start. `;
  const item = { id, type: "agentMessage", phase: "final_answer", text };

  emit({ method: "turn/started", params: { threadId: replayParent, turn } });
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
}

/**
Returns a synthetic native turn page and schedules the parent's one-time approval request.
@param params - Validated native parameter record.
@param state - Host-selected replay stage.
@returns Native turn page with original paging and summary behavior.
*/
function turnPage(params: Record<string, unknown>, state: string) {
  const page = pageTurns(params, state);

  if (params.threadId === replayParent && !replay.promptSent) {
    replay.promptSent = true;
    setTimeout(() => {
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
      });
    }, APPROVAL_DELAY_MS);
  }

  return page;
}

/**
Implements read-only native discovery/history and forbids every child mutation.
@param method - Checked native method.
@param params - Decoded native parameter record.
@param state - Host-selected replay stage.
@returns Synthetic native response; unsupported or forbidden operations throw.
*/
function response(method: string, params: Record<string, unknown>, state: string): unknown {
  switch (method) {
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
      return params.archived ? { data: [], nextCursor: null } : activeThreadPage(params, state);
    }

    case "thread/read": {
      if (state === "unavailable" && params.threadId === "native-codex") {
        throw new Error("Synthetic auth failure");
      }

      return { thread: savedThread(params, state) };
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

      return pageItems(items, params);
    }

    case "turn/start":
    case "turn/steer": {
      if (params.threadId !== replayParent) {
        throw new Error("Child action forbidden in replay");
      }

      return { turn: { id: "parent-recovery", status: "completed", items: [] } };
    }

    default: {
      throw new Error(`Unsupported replay operation ${method}`);
    }
  }
}

/**
Tracks concurrent child-history reads and applies the fake native history latency.
@param id - Validated native request identity.
@param method - Checked native method.
@param params - Decoded native parameter record.
@param result - Completed native response to emit immediately or after history latency.
*/
function deliverResult(id: string | number, method: string, params: Record<string, unknown>, result: unknown) {
  const isHistory = params.threadId !== replayParent && ["thread/turns/list", "thread/items/list"].includes(method);

  if (!isHistory) {
    emit({ id, result });

    return;
  }

  replay.activeReads++;
  replay.maxReads = Math.max(replay.maxReads, replay.activeReads);
  writeFileSync(`${directory}/rpc-metrics.json`, JSON.stringify({ maxReads: replay.maxReads }));
  setTimeout(() => {
    replay.activeReads--;
    emit({ id, result });
  }, HISTORY_DELAY_MS);
}

/**
Reads control state before responding and serializes native operation errors.
@param id - Validated native request identity.
@param method - Checked native method.
@param params - Decoded native parameter record.
*/
function serveRequest(id: string | number, method: string, params: Record<string, unknown>) {
  const state = stage();

  try {
    const result = response(method, params, state);

    deliverResult(id, method, params, result);
  } catch (error) {
    emit({ id, error: { code: -32_600, message: String(error) } });
  }
}

// Inject real parent notifications through JSON-RPC/SSE while a child overlay is
// open. This is synthetic output, never an action dispatched to a harness.
watchFile(`${directory}/control.json`, { interval: APPEND_POLL_MS, persistent: false }, () => {
  const current = stage();

  if (!current.startsWith("parent-append:") || appended.has(current)) {
    return;
  }

  appended.add(current);
  streamParentAppend(current);
});

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

  serveRequest(request.id, request.method, request.params);
});
