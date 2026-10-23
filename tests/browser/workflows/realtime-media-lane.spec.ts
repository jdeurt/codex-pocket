/* eslint-disable @typescript-eslint/no-magic-numbers -- PCM dimensions and metadata counts exercise the complete HTTP/provider session boundary. */
import { expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import { readFile, writeFile } from "node:fs/promises";
import { dataSchema } from "../../../src/lib/protocol";
import path from "node:path";

const origin = "http://127.0.0.1:3119";
const directory = path.resolve(".local/realtime-fixture");

/** Count metadata-only provider frames without exposing microphone payloads.
@returns Number of matching transport records.
*/
async function count() {
  const log = await readFile(path.join(directory, "provider.jsonl"), "utf8");

  return log.split("\n").filter((line) => line.includes('"method":"provider/realtime/appendAudio"')).length;
}

test("old microphone tokens cannot enter a restarted OpenAI session", async ({ request }) => {
  await writeFile(path.join(directory, "control.json"), "{}");
  const startA = await request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "start" } });
  const first = dataSchema.parse(await startA.json());
  const audio = {
    data: Buffer.alloc(480).toString("base64"),
    sampleRate: 24_000,
    numChannels: 1,
    samplesPerChannel: 240,
  };
  const sentA = await request.post("/api/realtime", {
    headers: { Origin: origin },
    data: { action: "audio", token: first.token, audio },
  });

  expect(startA.ok()).toBe(true);
  expect(sentA.ok()).toBe(true);
  await request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "stop", token: first.token } });
  const startB = await request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "start" } });
  const second = dataSchema.parse(await startB.json());
  const before = await count();
  const stale = await request.post("/api/realtime", {
    headers: { Origin: origin },
    data: { action: "audio", token: first.token, audio },
  });

  expect(startB.ok()).toBe(true);
  expect(stale.ok()).toBe(false);
  expect(await count()).toBe(before);
  const sentB = await request.post("/api/realtime", {
    headers: { Origin: origin },
    data: { action: "audio", token: second.token, audio },
  });

  expect(sentB.ok()).toBe(true);
  await expect.poll(() => count()).toBe(before + 1);
  await request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "stop", token: second.token } });
  const native = await readFile(path.join(directory, "native.jsonl"), "utf8");

  expect(native).not.toContain("thread/realtime/");
});
