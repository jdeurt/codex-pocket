/* eslint-disable jdeurt/const-on-top, jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers, unicorn/no-top-level-assignment-in-function, @typescript-eslint/require-await -- Native fixture is a stateful transport simulator with observed audio dimensions. */
// Isolated native protocol fixture for complete Pocket voice sessions. No model or live thread is used.
import { type Data, object } from "../../src/lib/protocol";
import { appendFileSync, readFileSync } from "node:fs";
import { readFixtureRequests, writeFixtureRecord } from "./sequential-rpc";
import path from "node:path";
import { z } from "zod";

const threadId = "realtime-fixture-parent";
const logFile = path.resolve(".local/realtime-fixture/native.jsonl");
const controlFile = path.resolve(".local/realtime-fixture/control.json");

let isActive = false;
let isReplied = false;

const controlSchema = z.object({
  closeDelayMs: z.number().optional(),
  missingClosed: z.boolean().optional(),
  lateErrorMs: z.number().optional(),
  burstChunks: z.number().optional(),
  disconnectOnAudio: z.boolean().optional(),
  disconnectOnStop: z.boolean().optional(),
});

function control(): z.infer<typeof controlSchema> {
  try {
    const raw: unknown = JSON.parse(readFileSync(controlFile, "utf8"));

    return controlSchema.parse(raw);
  } catch {
    return {};
  }
}

function event(method: string, params: Data) {
  writeFixtureRecord({ method, params: { threadId, ...params } });
}

function audio() {
  const samples = 2400;
  const data = Buffer.alloc(samples * 2);

  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 420) / 24_000) * 7000), i * 2);
  }

  return { data: data.toString("base64"), sampleRate: 24_000, numChannels: 1, samplesPerChannel: samples };
}

async function execute(method: string | undefined, params: Data) {
  appendFileSync(
    logFile,
    JSON.stringify({
      method,
      token: undefined,
      sampleRate: object(params.audio).sampleRate,
      voice: params.voice,
      model: params.model,
    }) + "\n"
  );

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
      return { thread: { id: threadId, turns: [] }, model: "fixture-model", reasoningEffort: "high" };
    }

    case "thread/turns/list": {
      return { data: [], nextCursor: null };
    }

    case "thread/realtime/listVoices": {
      return { voices: { v1: ["cove"], v2: ["marin", "cove"], v3: ["marin"], defaultV1: "cove", defaultV2: "marin" } };
    }

    case "thread/realtime/start": {
      if (isActive) {
        throw new Error("Already active");
      }

      isActive = true;
      isReplied = false;
      const sessionId = params.realtimeSessionId;

      setTimeout(() => {
        event("thread/realtime/started", { version: "v2", realtimeSessionId: sessionId });
      }, 50);

      return {};
    }

    case "thread/realtime/appendAudio": {
      if (!isActive) {
        throw new Error("Not active");
      }

      if (!isReplied) {
        isReplied = true;
        const options = control();

        setTimeout(() => {
          event("thread/realtime/transcript/delta", { role: "user", delta: "Test voice" });
          event("thread/realtime/transcript/done", { role: "user", text: "Test voice" });
          event("thread/realtime/transcript/delta", { role: "assistant", delta: "Hello" });

          for (let i = 0; i < (options.burstChunks ?? 1); i++) {
            event("thread/realtime/outputAudio/delta", { audio: audio() });
          }

          event("thread/realtime/transcript/done", { role: "assistant", text: "Hello" });
        }, 20);

        if (options.disconnectOnAudio) {
          setTimeout(() => process.kill(process.pid, "SIGTERM"), 90);
        }
      }

      return {};
    }

    case "thread/realtime/stop": {
      isActive = false;
      const options = control();

      if (options.disconnectOnStop) {
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 80);
      }

      if (options.lateErrorMs !== undefined) {
        setTimeout(() => {
          event("thread/realtime/error", { message: "Stopped session error" });
        }, options.lateErrorMs);
      }

      if (!options.missingClosed) {
        setTimeout(() => {
          event("thread/realtime/closed", {});
        }, options.closeDelayMs ?? 0);
      }

      return {};
    }

    default: {
      return {};
    }
  }
}

await readFixtureRequests(execute);
