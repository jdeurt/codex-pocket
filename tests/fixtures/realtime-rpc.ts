/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers, unicorn/no-top-level-assignment-in-function -- Native fixture is a stateful transport simulator with observed audio dimensions. */
// Isolated native protocol fixture for complete Pocket voice sessions. No model or live thread is used.
import { type Data, type Turn, object, turnSchema } from "../../src/lib/protocol";
import { appendFileSync, readFileSync } from "node:fs";
import { readPipelinedFixtureRequests, writeFixtureRecord } from "./sequential-rpc";
import path from "node:path";
import { z } from "zod";
import { unexpectedRequest } from "./unexpected-request";
import { t as attempt } from "try";

const mainThreadId = "realtime-fixture-parent";
const backendTurnId = "voice-backend-turn";
const logFile = path.resolve(".local/realtime-fixture/native.jsonl");
const controlFile = path.resolve(".local/realtime-fixture/control.json");

let isBackendToolActive = false;
let activeThreadId = mainThreadId;
let textTurnSequence = 0;

const savedTurns: Turn[] = [];

const controlSchema = z.object({
  closeDelayMs: z.number().optional(),
  missingClosed: z.boolean().optional(),
  lateErrorMs: z.number().optional(),
  burstChunks: z.number().optional(),
  burstSamples: z.number().int().positive().max(12_000).optional(),
  settingsDelayMs: z.number().int().nonnegative().optional(),
  textItemDelayMs: z.number().int().nonnegative().optional(),
  backendToolUntilSteer: z.boolean().optional(),
  piReceiptIds: z.boolean().optional(),
  answerText: z.string().optional(),
  disconnectOnAudio: z.boolean().optional(),
  disconnectOnStop: z.boolean().optional(),
  audioAckDelayMs: z.number().optional(),
});

function control(): z.infer<typeof controlSchema> {
  const outcome = attempt(() => {
    const raw: unknown = JSON.parse(readFileSync(controlFile, "utf8"));

    return controlSchema.parse(raw);
  });

  return outcome.ok ? outcome.value : {};
}

function event(method: string, params: Data) {
  const turn = savedTurns.find((entry) => entry.id === params.turnId);
  const item = object(params.item);

  if (method === "turn/started") {
    savedTurns.push(turnSchema.parse(params.turn));
  } else if (method === "turn/completed") {
    const completed = object(params.turn);
    const existing = savedTurns.find((entry) => entry.id === completed.id);

    if (existing) {
      existing.status = "completed";
    }
  } else if (turn && typeof item.id === "string" && typeof item.type === "string") {
    const index = turn.items.findIndex((entry) => entry.id === item.id);
    const parsed = { ...item, id: item.id, type: item.type };

    if (index === -1) {
      turn.items.push(parsed);
    } else {
      turn.items[index] = parsed;
    }
  }

  writeFixtureRecord({ method, params: { threadId: activeThreadId, ...params } });
}

function userItem(clientId: string) {
  return control().piReceiptIds
    ? { id: clientId, type: "userMessage" }
    : { id: `user-${clientId}`, type: "userMessage", clientId };
}

async function ordinary(method: string | undefined, params: Data): Promise<Data> {
  switch (method) {
    case "initialize": {
      return {};
    }

    case "config/read": {
      return {
        config: {
          sandbox_mode: "read-only",
          approval_policy: "never",
          model: "fixture-model",
          model_reasoning_effort: "high",
          experimental_realtime_ws_model: null,
        },
      };
    }

    case "thread/resume": {
      activeThreadId = typeof params.threadId === "string" ? params.threadId : mainThreadId;

      return { thread: { id: activeThreadId, turns: [] }, model: "fixture-model", reasoningEffort: "high" };
    }

    case "thread/turns/list": {
      return { data: savedTurns, nextCursor: null };
    }

    case "thread/settings/update": {
      await new Promise((resolve) => setTimeout(resolve, control().settingsDelayMs ?? 0));

      return {};
    }

    case "thread/read": {
      return { thread: { id: activeThreadId, model: "fixture-model", reasoningEffort: "high", turns: savedTurns } };
    }

    case "turn/start": {
      const delay = control().textItemDelayMs ?? 0;
      const clientId =
        typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : "missing-client-id";
      const input = Array.isArray(params.input) ? params.input : [];
      const text = input.map((entry) => object(entry).text).find((entry) => typeof entry === "string") ?? "";
      const turn = {
        id: control().backendToolUntilSteer ? backendTurnId : `text-turn-${String(++textTurnSequence)}`,
        status: "inProgress",
        items: [],
      };
      const item = userItem(clientId);

      setTimeout(() => {
        event("turn/started", { turn });
        event("item/started", { turnId: turn.id, item });
        setTimeout(() => {
          event("item/completed", { turnId: turn.id, item: { ...item, content: [{ type: "text", text }] } });

          if (control().backendToolUntilSteer) {
            isBackendToolActive = true;
            event("item/started", {
              turnId: turn.id,
              item: {
                id: "voice-backend-tool",
                type: "commandExecution",
                command: "fixture backend work",
                status: "inProgress",
              },
            });

            return;
          }

          event("item/completed", {
            turnId: turn.id,
            item: {
              id: `${turn.id}-answer`,
              type: "agentMessage",
              text: control().answerText ?? "Fixture text answer",
              phase: "final_answer",
            },
          });
          event("turn/completed", { turn: { ...turn, status: "completed" } });
        }, delay);
      }, 20);

      return { turn };
    }

    case "turn/steer": {
      if (isBackendToolActive) {
        const clientId =
          typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : "missing-client-id";
        const input = Array.isArray(params.input) ? params.input : [];
        const text = input.map((entry) => object(entry).text).find((entry) => typeof entry === "string") ?? "";
        const item = userItem(clientId);

        setTimeout(() => {
          event("item/started", { turnId: backendTurnId, item });
          setTimeout(() => {
            event("item/completed", { turnId: backendTurnId, item: { ...item, content: [{ type: "text", text }] } });
            event("item/completed", {
              turnId: backendTurnId,
              item: {
                id: "voice-backend-tool",
                type: "commandExecution",
                command: "fixture backend work",
                status: "completed",
                exitCode: 0,
              },
            });
            event("item/completed", {
              turnId: backendTurnId,
              item: {
                id: "voice-backend-answer",
                type: "agentMessage",
                text: "Fixture backend answer",
                phase: "final_answer",
              },
            });
            event("turn/completed", { turn: { id: backendTurnId, status: "completed", items: [] } });
            isBackendToolActive = false;
          }, control().textItemDelayMs ?? 0);
        }, 20);
      }

      return { turnId: typeof params.expectedTurnId === "string" ? params.expectedTurnId : backendTurnId };
    }

    default: {
      return unexpectedRequest(method);
    }
  }
}

async function execute(method: string | undefined, params: Data) {
  appendFileSync(
    logFile,
    JSON.stringify({ method, threadId: activeThreadId, clientId: params.clientUserMessageId }) + "\n"
  );

  if (method?.startsWith("thread/realtime/")) {
    unexpectedRequest(method);
  }

  if (method === "thread/list") {
    // This voice fixture has no discoverable external Codex Side Pockets.
    return { data: [], nextCursor: null };
  }

  return method === "thread/start"
    ? {
        thread: { id: `realtime-fixture-named-${crypto.randomUUID()}`, turns: [] },
        model: "fixture-model",
        reasoningEffort: "high",
      }
    : await ordinary(method, params);
}

await readPipelinedFixtureRequests(execute);
