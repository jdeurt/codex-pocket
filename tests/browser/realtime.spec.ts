/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers, unicorn/isolated-functions, unicorn/no-global-object-property-assignment -- Browser integration steps follow actual user action order and fixture timing. */
import { type Page, expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { dataSchema } from "../../src/lib/protocol";
import path from "node:path";

const nativeLog = path.resolve(".local/realtime-fixture/provider.jsonl");
const controlFile = path.resolve(".local/realtime-fixture/control.json");
const origin = "http://127.0.0.1:3119";

test.beforeEach(async () => writeFile(controlFile, "{}"));

async function countNativeStops() {
  const log = await readFile(nativeLog, "utf8");

  return log.split("\n").filter((line) => line.includes('"method":"provider/realtime/stop"')).length;
}

async function openChat(page: Page) {
  await page.goto("/");
  const dismiss = page.getByRole("button", { name: "Dismiss notification prompt" });

  if (await dismiss.isVisible()) {
    await dismiss.click();
  }

  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach images or files" })).toBeEnabled();
}

async function activateByKeyboard(page: Page) {
  const control = page.getByRole("button", { name: "Start realtime voice" });

  await control.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop realtime voice" })).toBeVisible();
}

test("realtime voice keeps draft and attachment, exchanges audio, applies next-session settings, and stops tracks", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        const stream = await original(constraints);

        (globalThis as typeof globalThis & { voiceFixtureTrack?: MediaStreamTrack }).voiceFixtureTrack =
          stream.getAudioTracks()[0];

        return stream;
      },
    });
  });
  await openChat(page);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("unsent draft");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("private draft attachment") });
  await expect(page.getByText("note.txt")).toBeVisible();
  const initialResponse = await request.get("/api/realtime");
  const initial = dataSchema.parse(await initialResponse.json());
  const previousReplies = Array.isArray(initial.history)
    ? initial.history.filter((entry) => dataSchema.parse(entry).text === "Hello").length
    : 0;
  const previousSpeech = Array.isArray(initial.history)
    ? initial.history.filter((entry) => dataSchema.parse(entry).text === "Test voice").length
    : 0;
  const control = page.getByRole("button", { name: "Start realtime voice" });

  await control.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  await expect(page.getByText("Test voice").last()).toBeVisible();
  await expect(page.getByText("Hello", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("What are we working on?")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach images or files" })).toHaveCount(0);
  const settings = await request.get(`${origin}/api/realtime`);

  expect(settings.ok()).toBe(true);
  expect(await settings.json()).toMatchObject({ voices: expect.arrayContaining(["marin", "cedar"]) });
  const changed = await request.post(`${origin}/api/realtime`, {
    headers: { Origin: origin },
    data: { action: "settings", voice: "cedar", model: "fixture-audio-model" },
  });

  expect(changed.ok()).toBe(true);
  expect(await changed.json()).toMatchObject({ effectiveFor: expect.stringContaining("next realtime session") });
  const beforeFirstStop = await countNativeStops();

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect.poll(countNativeStops).toBeGreaterThan(beforeFirstStop);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("unsent draft");
  await expect(page.getByText("note.txt")).toBeVisible();
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { voiceFixtureTrack?: MediaStreamTrack }).voiceFixtureTrack?.readyState
    )
  ).toBe("ended");
  await activateByKeyboard(page);
  await expect(page.getByText("Test voice")).toHaveCount(previousSpeech + 2);
  await expect(page.getByText("Hello", { exact: true })).toHaveCount(previousReplies + 2);
  const beforeSecondStop = await countNativeStops();

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect.poll(countNativeStops).toBeGreaterThan(beforeSecondStop);
  const nativeOutput = await readFile(nativeLog, "utf8");
  const records = nativeOutput
    .trim()
    .split("\n")
    .map((line) => dataSchema.parse(JSON.parse(line)));

  expect(
    records.some((record) => record.method === "provider/realtime/appendAudio" && record.sampleRate === 24_000)
  ).toBe(true);
  expect(records.findLast((record) => record.method === "provider/realtime/start")).toMatchObject({
    voice: "cedar",
    model: "fixture-audio-model",
  });
});

test("permission rejection and cancelled hold restore composer without sending or recording", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")) },
    });
  });
  await openChat(page);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("keep me");
  let sends = 0;

  await page.route("**/api/messages", (route) => {
    sends++;

    return route.abort();
  });
  const button = page.getByRole("button", { name: /Send message; hold and swipe up/ });

  await expect(button).toBeEnabled();
  const box = await button.boundingBox();

  if (!box) {
    throw new Error("Send button is missing.");
  }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await expect(page.locator(".voice-pill-track")).toBeVisible();
  await expect(button.locator(".lucide-arrow-up")).toBeVisible();
  await page.mouse.up();
  expect(sends).toBe(0);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("keep me");
  const control = page.getByRole("button", { name: "Start realtime voice" });

  await control.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Permission denied")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("keep me");
  expect(sends).toBe(0);
});

test("ordinary tap sends while hold, swipe and cancelled drag have distinct outcomes", async ({ page }) => {
  await openChat(page);
  const textbox = page.getByRole("textbox", { name: "Message Pocket" });
  const button = page.getByRole("button", { name: /Send message; hold and swipe up/ });

  let sends = 0;

  await page.route("**/api/messages", (route) => {
    sends++;

    return route.abort();
  });
  await textbox.fill("tap to send");
  await button.click();
  await expect.poll(() => sends).toBe(1);
  await page.reload();
  await expect(button).toBeEnabled();
  await textbox.fill("draft for voice");
  const box = await button.boundingBox();

  if (!box) {
    throw new Error("Send button is missing.");
  }

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 32, y);
  await page.mouse.up();
  expect(sends).toBe(1);
  await expect(textbox).toHaveValue("draft for voice");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await expect(page.locator(".voice-pill-track")).toBeVisible();
  await page.mouse.move(x, y - 72);
  await expect(button.locator(".lucide-mic")).toBeVisible();
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Stop realtime voice" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  expect(sends).toBe(1);
  const beforeStop = await countNativeStops();

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect.poll(countNativeStops).toBeGreaterThan(beforeStop);
  await expect(textbox).toHaveValue("draft for voice");
});

test("event stream failure stops the microphone and allows a fresh realtime session", async ({ page }) => {
  await openChat(page);
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        const stream = await original(constraints);

        (globalThis as typeof globalThis & { voiceFixtureTrack?: MediaStreamTrack }).voiceFixtureTrack =
          stream.getAudioTracks()[0];

        return stream;
      },
    });
  });
  const beforeStop = await countNativeStops();

  await page.route("**/api/realtime/events", (route) => route.abort("failed"));
  const control = page.getByRole("button", { name: "Start realtime voice" });

  await control.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Realtime event stream failed.")).toBeVisible();
  await expect.poll(countNativeStops).toBeGreaterThan(beforeStop);
  await expect(page.getByRole("button", { name: "Stop realtime voice" })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { voiceFixtureTrack?: MediaStreamTrack }).voiceFixtureTrack?.readyState
    )
  ).toBe("ended");
  await page.unroute("**/api/realtime/events");
  await activateByKeyboard(page);
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  const beforeRecoveryStop = await countNativeStops();

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect.poll(countNativeStops).toBeGreaterThan(beforeRecoveryStop);
});

test("stop during pending microphone permission leaves no recording or native session", async ({ page }) => {
  await openChat(page);
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);

      (
        globalThis as typeof globalThis & { voiceFixtureTrack?: MediaStreamTrack; releaseVoiceMic?: () => void }
      ).voiceFixtureTrack = stream.getAudioTracks()[0];

      return new Promise<MediaStream>((resolve) => {
        (globalThis as typeof globalThis & { releaseVoiceMic?: () => void }).releaseVoiceMic = () => {
          resolve(stream);
        };
      });
    };
  });
  const nativeOutput = await readFile(nativeLog, "utf8");
  const startsBefore = nativeOutput
    .split("\n")
    .filter((line) => line.includes('"method":"provider/realtime/start"')).length;
  const control = page.getByRole("button", { name: "Start realtime voice" });

  await control.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop realtime voice" })).toBeVisible();
  await page.waitForFunction(() => "releaseVoiceMic" in globalThis);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { releaseVoiceMic?: () => void }).releaseVoiceMic?.();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (globalThis as typeof globalThis & { voiceFixtureTrack?: MediaStreamTrack }).voiceFixtureTrack?.readyState
      )
    )
    .toBe("ended");
  const after = await readFile(nativeLog, "utf8");
  const startsAfter = after.split("\n").filter((line) => line.includes('"method":"provider/realtime/start"')).length;

  expect(startsAfter).toBe(startsBefore);
});

test("stop while audio context is suspended releases the acquired microphone", async ({ page }) => {
  await openChat(page);
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const NativeContext = AudioContext;

    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);

      (globalThis as typeof globalThis & { voiceFixtureTrack?: MediaStreamTrack }).voiceFixtureTrack =
        stream.getAudioTracks()[0];

      return stream;
    };
    globalThis.AudioContext = class extends NativeContext {
      override resume() {
        (globalThis as typeof globalThis & { resumeEntered?: boolean }).resumeEntered = true;

        return new Promise<void>(() => {
          // Simulate a browser that never resumes audio playback.
        });
      }
    };
  });
  const control = page.getByRole("button", { name: "Start realtime voice" });

  await control.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (globalThis as typeof globalThis & { resumeEntered?: boolean }).resumeEntered);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (globalThis as typeof globalThis & { voiceFixtureTrack?: MediaStreamTrack }).voiceFixtureTrack?.readyState
      )
    )
    .toBe("ended");
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
});
