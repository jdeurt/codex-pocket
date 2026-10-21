/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers, unicorn/no-top-level-assignment-in-function, @typescript-eslint/require-await -- Native fixture is a stateful transport simulator with observed audio dimensions. */
// Isolated native protocol fixture for complete Pocket voice sessions. No model or live thread is used.
import { type Data, object } from "../../src/lib/protocol";
import { readFixtureRequests, writeFixtureRecord } from "./sequential-rpc";
import { appendFileSync } from "node:fs";
import path from "node:path";

const threadId = "realtime-fixture-parent";
const logFile = path.resolve(".local/realtime-fixture/native.jsonl");

let isActive = false;
let isReplied = false;

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
      setTimeout(() => {
        event("thread/realtime/started", { version: "v2", realtimeSessionId: "fixture-session" });
      }, 50);

      return {};
    }

    case "thread/realtime/appendAudio": {
      if (!isActive) {
        throw new Error("Not active");
      }

      if (!isReplied) {
        isReplied = true;
        setTimeout(() => {
          event("thread/realtime/transcript/delta", { role: "user", delta: "Test voice" });
          event("thread/realtime/transcript/done", { role: "user", text: "Test voice" });
          event("thread/realtime/transcript/delta", { role: "assistant", delta: "Hello" });
          event("thread/realtime/outputAudio/delta", { audio: audio() });
          event("thread/realtime/transcript/done", { role: "assistant", text: "Hello" });
        }, 20);
      }

      return {};
    }

    case "thread/realtime/stop": {
      isActive = false;
      setTimeout(() => {
        event("thread/realtime/closed", {});
      }, 0);

      return {};
    }

    default: {
      return {};
    }
  }
}

await readFixtureRequests(execute);
