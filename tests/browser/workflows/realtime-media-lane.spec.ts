import { expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import { configureVoice } from "../../fixtures/realtime-browser";
import { dataSchema } from "../../../src/lib/protocol";

const origin = "http://127.0.0.1:3119";
const sdp = "v=0\r\ns=API test offer\r\n";

test("realtime accepts SDP controls, rejects legacy audio and isolates restarted call tokens", async ({ request }) => {
  await configureVoice();
  const start = await request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "start", sdp } });
  const first = dataSchema.parse(await start.json());

  expect(start.ok()).toBe(true);
  expect(first.sdp).toContain("v=0");
  expect(JSON.stringify(first)).not.toContain("dummy-openai-key");
  const audio = await request.post("/api/realtime", {
    headers: { Origin: origin },
    data: { action: "audio", token: first.token, audio: {} },
  });

  expect(audio.ok()).toBe(false);
  await request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "stop", token: first.token } });
  const restart = await request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "start", sdp } });
  const second = dataSchema.parse(await restart.json());

  expect(restart.ok()).toBe(true);
  expect(first.token).not.toBe(second.token);
  await request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "stop", token: first.token } });
  const status = await request.get("/api/realtime");

  expect(await status.json()).toMatchObject({ phase: "active" });
  await request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "stop", token: second.token } });
});
