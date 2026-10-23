/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers, unicorn/no-global-object-property-assignment, unicorn/isolated-functions -- These assertions exercise browser and native lifecycle together. */
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

async function open(page: Page, draft = "recovery draft") {
  await page.goto("/");
  const dismiss = page.getByRole("button", { name: "Dismiss notification prompt" });

  if (await dismiss.isVisible()) {
    await dismiss.click();
  }

  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Send message; hold and swipe up/ })).toBeEnabled();
  await page.getByRole("textbox", { name: "Message Pocket" }).fill(draft);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue(draft);
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
  const before = await count("thread/realtime/stop");
  const button = page.getByRole("button", { name: "Start realtime voice" });

  await button.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByText("Audio playback fell behind. Realtime stopped; start again to continue.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
  await expect.poll(() => count("thread/realtime/stop")).toBeGreaterThan(before);
});

test("stop bypasses a withheld audio acknowledgement without restarting native RPC", async ({ page }) => {
  await control({ audioAckDelayMs: 7000, closeDelayMs: 7000 });
  await open(page);
  const beforeAudio = await count("thread/realtime/appendAudio");
  const beforeRelease = await count("fixture/realtime/audioAckReleased");

  await start(page);
  await expect.poll(() => count("thread/realtime/appendAudio")).toBeGreaterThan(beforeAudio);
  const beforeStop = await count("thread/realtime/stop");
  const beforeStart = await count("thread/realtime/start");
  const stoppedAt = Date.now();

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect.poll(() => count("thread/realtime/stop"), { timeout: 2000 }).toBeGreaterThan(beforeStop);
  expect(Date.now() - stoppedAt).toBeLessThan(2500);
  const button = page.getByRole("button", { name: "Start realtime voice" });

  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Native realtime closure was not confirmed/)).toBeVisible();
  await expect.poll(() => phase(page)).toBe("uncertain");
  expect(await count("thread/realtime/start")).toBe(beforeStart);
  await expect.poll(() => count("fixture/realtime/audioAckReleased")).toBe(beforeRelease + 1);
  await expect.poll(() => phase(page)).toBe("idle");
  await control({});
  await start(page);
  await expect.poll(() => count("thread/realtime/start")).toBe(beforeStart + 1);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
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

test("short output fragments do not exhaust playback before eight seconds of audio", async ({ page }) => {
  await control({ burstChunks: 100, burstSamples: 240 });
  await open(page);
  await start(page);
  await page.waitForTimeout(1600);
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  await expect(page.getByText("Audio playback fell behind.")).toHaveCount(0);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
});

test("continuous microphone audio survives delayed mobile HTTP responses", async ({ page }) => {
  await open(page);
  let requests = 0;

  await page.route("**/api/realtime", async (route) => {
    const body: unknown = route.request().postDataJSON();

    if (dataSchema.parse(body).action === "audio") {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    await route.continue();
  });
  await start(page);
  await expect.poll(() => requests).toBeGreaterThan(8);
  await page.waitForTimeout(1800);
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
});

test("native control work does not stall continuous microphone delivery or stop", async ({ page }) => {
  await control({ settingsDelayMs: 1500 });
  await open(page);
  await start(page);
  const before = await count("thread/realtime/appendAudio");
  const settings = page.request.post("/api/session", {
    headers: { Origin: origin },
    data: { model: "fixture-model" },
  });

  await expect.poll(() => count("thread/realtime/appendAudio"), { timeout: 1200 }).toBeGreaterThan(before + 2);
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  const settingsResponse = await settings;

  expect(settingsResponse.ok()).toBe(true);
  const beforeStop = await count("thread/realtime/stop");

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect.poll(() => count("thread/realtime/stop")).toBeGreaterThan(beforeStop);
});

test("text after voice waits for native closure and preserves the draft", async ({ page }) => {
  await control({ closeDelayMs: 1000 });
  await open(page);
  await start(page);
  const before = await count("turn/start");

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect(page.getByRole("status", { name: "Realtime voice stopping" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("recovery draft");
  await page.getByRole("button", { name: /Send message; hold and swipe up/ }).click();
  await expect.poll(() => count("turn/start")).toBe(before + 1);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("");
  await expect(page.getByText("Delivery is uncertain.")).toHaveCount(0);
  await expect(page.getByText("Fixture text answer")).toBeVisible();
  await expect(page.getByRole("status", { name: "Pocket activity" })).toHaveCount(0);
});

test("voice to text keeps the submitted message visible through native item hydration", async ({ page }) => {
  const draft = "hydration draft";

  await control({ closeDelayMs: 700, textItemDelayMs: 900 });
  await open(page, draft);
  await start(page);
  await page.evaluate((text) => {
    const monitor = { seen: false, gaps: 0, observer: undefined as MutationObserver | undefined };
    const inspect = () => {
      const isVisible = [...document.querySelectorAll("[data-message-id] p")].some(
        (entry) => entry.textContent === text && entry.getClientRects().length > 0
      );

      if (isVisible) {
        monitor.seen = true;
      } else if (monitor.seen) {
        monitor.gaps++;
      }
    };

    monitor.observer = new MutationObserver(inspect);
    monitor.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    (globalThis as typeof globalThis & { deliveryMonitor?: typeof monitor }).deliveryMonitor = monitor;
  }, draft);
  const before = await count("turn/start");

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect(page.getByRole("status", { name: "Realtime voice stopping" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue(draft);
  await page.getByRole("button", { name: /Send message; hold and swipe up/ }).click();
  await expect.poll(() => count("turn/start")).toBe(before + 1);
  await expect(page.getByRole("status", { name: "Pocket activity" })).toBeVisible();
  await expect(page.getByText("Fixture text answer")).toBeVisible();
  const monitor = await page.evaluate(() => {
    const active = (
      globalThis as typeof globalThis & {
        deliveryMonitor?: { seen: boolean; gaps: number; observer?: MutationObserver };
      }
    ).deliveryMonitor;

    active?.observer?.disconnect();

    return { seen: active?.seen, gaps: active?.gaps };
  });

  expect(monitor).toEqual({ seen: true, gaps: 0 });
  await expect(page.getByText(draft, { exact: true })).toHaveCount(1);
  await expect(page.getByRole("status", { name: "Pocket activity" })).toHaveCount(0);
  expect(await count("turn/start")).toBe(before + 1);
});

test("text after voice steers the active backend tool turn and keeps its transcript", async ({ page }) => {
  const draft = "backend draft";

  await control({ backendToolUntilSteer: true, closeDelayMs: 700, textItemDelayMs: 900 });
  await open(page, draft);
  await start(page);
  await expect(page.getByText("Test voice").first()).toBeVisible();
  await expect(page.getByRole("status", { name: "Pocket activity" })).toBeVisible();
  const beforeStart = await count("turn/start");
  const beforeSteer = await count("turn/steer");

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect(page.getByRole("status", { name: "Realtime voice stopping" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue(draft);
  await page.getByRole("button", { name: /Send message; hold and swipe up/ }).click();
  await expect.poll(() => count("turn/steer")).toBe(beforeSteer + 1);
  await expect(page.getByText(draft, { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Pocket activity" })).toBeVisible();
  await expect(page.getByText("Fixture backend answer")).toBeVisible();
  await expect(page.getByText(draft, { exact: true })).toHaveCount(1);
  await expect(page.getByRole("status", { name: "Pocket activity" })).toHaveCount(0);
  expect(await count("turn/start")).toBe(beforeStart);
  expect(await count("turn/steer")).toBe(beforeSteer + 1);
});
