/* eslint-disable jdeurt/const-on-top, jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers, unicorn/no-global-object-property-assignment, unicorn/isolated-functions -- These assertions exercise browser and native lifecycle together. */
import { type Page, expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { dataSchema } from "../../src/lib/protocol";
import path from "node:path";

const directory = path.resolve(".local/realtime-fixture");
const origin = "http://127.0.0.1:3119";
const controlFile = path.join(directory, "control.json");
const nativeLog = path.join(directory, "native.jsonl");

async function control(value: Record<string, unknown>) {
  await writeFile(controlFile, JSON.stringify(value));
}

async function count(method: string) {
  const log = await readFile(nativeLog, "utf8");

  return log.split("\n").filter((line) => line.includes(`"method":"${method}"`)).length;
}

async function phase(page: Page) {
  const response = await page.request.get("/api/realtime");
  const value: unknown = await response.json();

  return dataSchema.parse(value).phase;
}

async function open(page: Page) {
  await page.goto("/");
  const dismiss = page.getByRole("button", { name: "Dismiss notification prompt" });

  if (await dismiss.isVisible()) {
    await dismiss.click();
  }

  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("recovery draft");
  await expect(page.getByRole("button", { name: /Send message; hold and swipe up/ })).toBeEnabled();
}

async function start(page: Page) {
  const button = page.getByRole("button", { name: "Start realtime voice" });

  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
}

test.beforeEach(async () => control({}));
test.afterEach(async () => control({}));

test("rapid restart waits for delayed native close and ignores the old session error", async ({ page }) => {
  await control({ closeDelayMs: 450, lateErrorMs: 100 });
  await open(page);
  await start(page);
  await expect(page.getByText("Test voice").first()).toBeVisible();
  const before = await count("thread/realtime/start");

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await start(page);
  await expect.poll(() => count("thread/realtime/start")).toBe(before + 1);
  await page.waitForTimeout(500);
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  await expect(page.getByText("Test voice").first()).toBeVisible();
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
});

test("native close absent through the deadline blocks a fresh session until closure", async ({ page }) => {
  await control({ closeDelayMs: 6500 });
  await open(page);
  await start(page);
  const before = await count("thread/realtime/start");

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  const button = page.getByRole("button", { name: "Start realtime voice" });

  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Native realtime closure was not confirmed/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
  expect(await count("thread/realtime/start")).toBe(before);
  await expect.poll(() => phase(page)).toBe("idle");
});

test("unexpected microphone track end stops capture and the native session", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);

      (globalThis as typeof globalThis & { droppedTrack?: MediaStreamTrack }).droppedTrack = stream.getAudioTracks()[0];

      return stream;
    };
  });
  await start(page);
  const before = await count("thread/realtime/stop");

  await page.evaluate(() => {
    const track = (globalThis as typeof globalThis & { droppedTrack?: MediaStreamTrack }).droppedTrack;

    track?.stop();
    track?.dispatchEvent(new Event("ended"));
  });
  await expect(page.getByText("Microphone disconnected. Realtime stopped.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
  await expect.poll(() => count("thread/realtime/stop")).toBeGreaterThan(before);
});

test("bursty native audio stops with a visible overrun and releases capture", async ({ page }) => {
  await control({ burstChunks: 100 });
  await open(page);
  await start(page);
  const before = await count("thread/realtime/stop");

  await expect(page.getByText("Audio playback fell behind. Realtime stopped; start again to continue.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
  await expect.poll(() => count("thread/realtime/stop")).toBeGreaterThan(before);
});

test("native RPC disconnect clears the server token and permits a new native connection", async ({ page }) => {
  await control({ disconnectOnAudio: true });
  await open(page);
  await start(page);
  const before = await count("thread/realtime/start");

  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
  await control({});
  await expect.poll(() => phase(page)).toBe("idle");
  const resumed = await page.request.post("/api/realtime", {
    headers: { Origin: origin },
    data: { action: "start" },
  });

  expect(resumed.ok()).toBe(true);
  const result: unknown = await resumed.json();
  const token = dataSchema.parse(result).token;

  expect(typeof token).toBe("string");
  await expect.poll(() => count("thread/realtime/start")).toBe(before + 1);
  await page.request.post("/api/realtime", { headers: { Origin: origin }, data: { action: "stop", token } });
});

test("native disconnect while stop is pending releases the barrier for reconnect", async ({ page }) => {
  await control({ missingClosed: true, disconnectOnStop: true });
  await open(page);
  await start(page);
  const before = await count("thread/realtime/start");

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect.poll(() => phase(page)).toBe("idle");
  await control({});
  const response = await page.request.post("/api/realtime", {
    headers: { Origin: origin },
    data: { action: "start" },
  });

  expect(response.ok()).toBe(true);
  const result: unknown = await response.json();

  await expect.poll(() => count("thread/realtime/start")).toBe(before + 1);
  await page.request.post("/api/realtime", {
    headers: { Origin: origin },
    data: { action: "stop", token: dataSchema.parse(result).token },
  });
});
