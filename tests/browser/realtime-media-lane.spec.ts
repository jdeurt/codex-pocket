import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { dataSchema } from "../../src/lib/protocol";
import path from "node:path";

const directory = path.resolve(".local/realtime-fixture");
const origin = "http://127.0.0.1:3119";
const controlFile = path.join(directory, "control.json");
const nativeLog = path.join(directory, "native.jsonl");
const AUDIO_ACK_DELAY_MS = 7000;
const AUDIO_SAMPLES = 240;
const PCM_BYTES_PER_SAMPLE = 2;
const SAMPLE_RATE = 24_000;
const MONO_CHANNELS = 1;
const FIRST_APPEND = 1;
const TWO_SESSIONS = 2;
const STOP_QUEUE_SETTLE_MS = 100;

/**
Count metadata-only native fixture calls without exposing audio payloads.
@param method - Native method to count.
@returns Number of recorded calls for this method.
*/
const count = async (method: string) => {
  const log = await readFile(nativeLog, "utf8");

  return log.split("\n").filter((line) => line.includes(`"method":"${method}"`)).length;
};

test("queued old microphone audio cannot enter a restarted native session", async ({ request }) => {
  const beforeRelease = await count("fixture/realtime/audioAckReleased");
  const startA = await (async () => {
    await writeFile(controlFile, JSON.stringify({ audioAckDelayMs: AUDIO_ACK_DELAY_MS }));

    return request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "start" } });
  })();
  const first = dataSchema.parse(await startA.json());
  const audio = {
    data: Buffer.alloc(AUDIO_SAMPLES * PCM_BYTES_PER_SAMPLE).toString("base64"),
    sampleRate: SAMPLE_RATE,
    numChannels: MONO_CHANNELS,
    samplesPerChannel: AUDIO_SAMPLES,
  };
  const beforeAudio = await count("thread/realtime/appendAudio");
  const send = async (token: unknown) => {
    await expect
      .poll(async () => {
        const response = await request.get("/api/realtime");

        return dataSchema.parse(await response.json()).phase;
      })
      .toBe("active");

    return request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "audio", token, audio } });
  };
  const pendingA = send(first.token);
  const queuedA = send(first.token);
  const stoppedA = await (async () => {
    await expect.poll(() => count("thread/realtime/appendAudio")).toBe(beforeAudio + FIRST_APPEND);
    await new Promise((resolve) => setTimeout(resolve, STOP_QUEUE_SETTLE_MS));

    return request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "stop", token: first.token } });
  })();
  const firstResponse = await pendingA;
  const queuedResponse = await queuedA;
  const startB = await (async () => {
    await writeFile(controlFile, "{}");

    return request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "start" } });
  })();
  const second = dataSchema.parse(await startB.json());
  const sentB = await send(second.token);
  const log = await (async () => {
    await expect.poll(() => count("fixture/realtime/audioAckReleased")).toBeGreaterThan(beforeRelease);

    return readFile(nativeLog, "utf8");
  })();
  const sessions = log
    .trim()
    .split("\n")
    .map((line) => dataSchema.parse(JSON.parse(line)))
    .filter((entry) => entry.method === "thread/realtime/appendAudio")
    .slice(-TWO_SESSIONS)
    .map((entry) => entry.nativeSessionId);
  const afterAudio = await count("thread/realtime/appendAudio");
  const stoppedB = await request.post("/api/realtime", {
    headers: { Origin: origin },
    data: { action: "stop", token: second.token },
  });

  expect(stoppedA.ok()).toBe(true);
  expect(firstResponse.ok()).toBe(false);
  expect(queuedResponse.ok()).toBe(false);
  expect(startB.ok()).toBe(true);
  expect(sentB.ok()).toBe(true);
  expect(sessions).toEqual([first.nativeSessionId, second.nativeSessionId]);
  expect(afterAudio).toBe(beforeAudio + TWO_SESSIONS);
  expect(stoppedB.ok()).toBe(true);
});
