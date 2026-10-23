/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers -- Browser recovery assertions follow complete microphone and provider lifecycles. */
import { type Page, expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { object } from "../../src/lib/protocol";
import { observeMicrophone } from "../fixtures/realtime-media-probe";

const directory = path.resolve(".local/realtime-fixture");
const controlFile = path.join(directory, "control.json");

async function count(method: string) {
  const log = await readFile(path.join(directory, "provider.jsonl"), "utf8");

  return log.split("\n").filter((line) => line.includes(`"method":"${method}"`)).length;
}

async function open(page: Page) {
  await page.goto("/");
  const dismiss = page.getByRole("button", { name: "Dismiss notification prompt" });

  if (await dismiss.isVisible()) {
    await dismiss.click();
  }

  await expect(page.getByRole("button", { name: /Send message; hold and swipe up/ })).toBeEnabled();
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("recovery draft");
}

async function start(page: Page) {
  await page.getByRole("button", { name: "Start realtime voice" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
}

test.beforeEach(async () => writeFile(controlFile, "{}"));

test("unexpected microphone track end stops capture and the OpenAI session", async ({ page }) => {
  await observeMicrophone(page, "droppedTrack");
  await open(page);
  await start(page);
  const before = await count("provider/realtime/stop");

  await page.evaluate(() => {
    const track = (globalThis as typeof globalThis & { droppedTrack?: MediaStreamTrack }).droppedTrack;

    track?.stop();
    track?.dispatchEvent(new Event("ended"));
  });
  await expect(page.getByText("Microphone disconnected. Realtime stopped.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("recovery draft");
  await expect.poll(() => count("provider/realtime/stop")).toBeGreaterThan(before);
});

test("bursty OpenAI audio stops with a visible overrun and releases capture", async ({ page }) => {
  await writeFile(controlFile, JSON.stringify({ burstChunks: 100 }));
  await open(page);
  await page.getByRole("button", { name: "Start realtime voice" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Audio playback fell behind|Audio event stream fell behind/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("recovery draft");
});

test("provider disconnect clears the token and permits a fresh OpenAI session", async ({ page }) => {
  await writeFile(controlFile, JSON.stringify({ disconnectOnAudio: true }));
  await open(page);
  await page.getByRole("button", { name: "Start realtime voice" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/OpenAI Realtime disconnected/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("recovery draft");
  await writeFile(controlFile, "{}");
  await start(page);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
});

test("short output fragments and delayed mobile HTTP responses keep microphone delivery running", async ({ page }) => {
  await writeFile(controlFile, JSON.stringify({ burstChunks: 100, burstSamples: 120 }));
  await page.route("**/api/realtime", async (route) => {
    const body = object(route.request().postDataJSON());

    if (body.action === "audio") {
      const response = await route.fetch();

      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ response });
    } else {
      await route.continue();
    }
  });
  await open(page);
  await start(page);
  const before = await count("provider/realtime/appendAudio");

  await expect.poll(() => count("provider/realtime/appendAudio")).toBeGreaterThan(before + 3);
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("recovery draft");
  await page.unrouteAll({ behavior: "wait" });
});

test("switching to text finalizes trailing speech and preserves the typed draft through reload", async ({ page }) => {
  const transcript = `Trailing spoken intent ${test.info().project.name}`;

  await writeFile(controlFile, JSON.stringify({ deferTranscript: true, finalDelayMs: 250, transcript }));
  await open(page);
  const before = await count("provider/realtime/appendAudio");

  await start(page);
  await expect.poll(() => count("provider/realtime/appendAudio")).toBeGreaterThan(before);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("recovery draft");
  await expect(page.getByText(transcript, { exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByText(transcript, { exact: true })).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("recovery draft");
});

test("missing final speech is reported while switching to text and leaves the draft intact", async ({ page }) => {
  await writeFile(controlFile, JSON.stringify({ deferTranscript: true, missingFinal: true }));
  await open(page);
  const before = await count("provider/realtime/appendAudio");

  await start(page);
  await expect.poll(() => count("provider/realtime/appendAudio")).toBeGreaterThan(before);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect(
    page.getByText("Final speech transcription was not confirmed. Check your transcript before retrying.")
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("recovery draft");
});
