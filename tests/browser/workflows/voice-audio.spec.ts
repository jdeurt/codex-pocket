/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers -- Browser integration steps follow actual user action order and fixture timing. */
import { type Page, expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import { readFile, writeFile } from "node:fs/promises";
import { dataSchema } from "../../../src/lib/protocol";
import path from "node:path";
import { observeMicrophone } from "../../fixtures/realtime-media-probe";

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
  await observeMicrophone(page, "voiceFixtureTrack");
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
  await expect(page.getByText("Test voice")).toHaveCount(previousSpeech + 1);
  await expect(page.getByText("Hello", { exact: true })).toHaveCount(previousReplies + 1);
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

test("microphone permission failure retains the draft and permits a successful text send", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")) },
    });
  });
  await openChat(page);
  const composer = page.getByRole("textbox", { name: "Message Pocket" });
  const text = "Continue after microphone permission failed.";

  await composer.fill(text);
  await page.getByRole("button", { name: "Start realtime voice" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Permission denied")).toBeVisible();
  await expect(composer).toHaveValue(text);
  await page.getByRole("button", { name: "Dismiss voice error" }).click();
  await page.getByRole("button", { name: /Send message; hold and swipe up/ }).click();
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
  await expect(page.getByText("Fixture text answer", { exact: true }).last()).toBeVisible();
  await expect(composer).toHaveValue("");
});
