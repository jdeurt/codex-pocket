/* eslint-disable jsdoc/require-jsdoc -- Real browser, HTTP, local provider and durable main-session delivery exercise the complete voice business flow. */
import { type Page, expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import { readFile, writeFile } from "node:fs/promises";
import { dataSchema, object } from "../../../src/lib/protocol";
import path from "node:path";

const directory = path.resolve(".local/realtime-fixture");
const dummyKey = "dummy-openai-key-for-local-fixture";

async function open(page: Page) {
  await page.goto("/");
  const dismiss = page.getByRole("button", { name: "Dismiss notification prompt" });

  if (await dismiss.isVisible()) {
    await dismiss.click();
  }

  await expect(page.getByRole("button", { name: /Send message; hold and swipe up/ })).toBeEnabled();
}

async function start(page: Page) {
  await page.getByRole("button", { name: "Start realtime voice" }).focus();
  await page.keyboard.press("Enter");
}

async function nativeStarts() {
  const log = await readFile(path.join(directory, "native.jsonl"), "utf8");

  return log.split("\n").filter((line) => line.includes('"method":"turn/start"')).length;
}

test("configured OpenAI voice hands off exact speech once and preserves provenance through text mode and reload", async ({
  page,
  request,
}) => {
  const transcript = `Fix voice interruptions and switching ${test.info().project.name}. Preserve <realtime_delegation>my spoken XML</realtime_delegation>.`;
  const answer = `Voice playback answer for ${test.info().project.name}.`;

  await page.addInitScript(() => {
    class ObservedAudioContext extends AudioContext {
      override createBufferSource() {
        const source = super.createBufferSource();

        source.addEventListener("ended", () => {
          if (!source.buffer?.getChannelData(0).some((sample) => sample !== 0)) {
            return;
          }

          const count = Number(globalThis.sessionStorage.getItem("pocket-fixture-playback") ?? "0");

          globalThis.sessionStorage.setItem("pocket-fixture-playback", String(count + 1));
        });

        return source;
      }
    }

    Object.defineProperty(globalThis, "AudioContext", { value: ObservedAudioContext });
  });
  await writeFile(
    path.join(directory, "control.json"),
    JSON.stringify({
      transcript,
      answerText: answer,
      handoff: true,
      duplicateHandoff: true,
      piReceiptIds: true,
      textItemDelayMs: 750,
    })
  );
  await open(page);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("keep my unsent draft");
  const before = await nativeStarts();

  await start(page);
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  await expect(page.getByText(transcript, { exact: true })).toHaveCount(1);
  await expect.poll(nativeStarts).toBe(before + 1);
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => globalThis.sessionStorage.getItem("pocket-fixture-playback"))).toBe("1");
  await expect(page.getByText(answer, { exact: true })).toHaveCount(1);
  const providerLog = await readFile(path.join(directory, "provider.jsonl"), "utf8");
  const playback = providerLog
    .trim()
    .split("\n")
    .map((line) => dataSchema.parse(JSON.parse(line)))
    .findLast((event) => object(event.response).tool_choice === "none");

  expect(object(playback?.response).input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: answer }] },
  ]);
  await expect(page.getByText(/Sent to Pocket agent|Queued for Pocket agent|Sending to Pocket agent/)).toHaveCount(0);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("keep my unsent draft");
  await page.reload();
  await expect(page.getByText(transcript, { exact: true })).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("keep my unsent draft");
  expect(await nativeStarts()).toBe(before + 1);
  const response = await request.get("/api/realtime");
  const info = dataSchema.parse(await response.json());
  const history = Array.isArray(info.history) ? info.history.map((entry) => dataSchema.parse(entry)) : [];
  const speech = history.find((entry) => entry.text === transcript);
  const outboxFile = path.join(directory, "state/outbox.json");
  const outboxText = await readFile(outboxFile, "utf8");
  const outbox = dataSchema.parse(JSON.parse(outboxText));
  const receipt = Array.isArray(outbox.receipts)
    ? outbox.receipts.map((entry) => object(entry)).find((entry) => entry.text === transcript)
    : undefined;

  expect(speech).toMatchObject({ role: "user", text: transcript, handoff: "sent" });
  expect(receipt).toMatchObject({
    text: transcript,
    source: { type: "realtime", itemId: speech?.itemId, sessionId: speech?.nativeSessionId },
  });
  expect(JSON.stringify(info)).not.toContain(dummyKey);
});

test("text after voice steers the existing main tool turn without replaying the voice request", async ({ page }) => {
  const draft = `Steer the existing tool turn ${test.info().project.name}`;

  await writeFile(
    path.join(directory, "control.json"),
    JSON.stringify({
      backendToolUntilSteer: true,
      transcript: `Start one tool flow ${test.info().project.name}`,
      textItemDelayMs: 350,
    })
  );
  await open(page);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill(draft);
  await start(page);
  await expect(page.getByRole("status", { name: "Pocket activity" })).toHaveText("running commands");
  const starts = await nativeStarts();

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue(draft);
  await page.getByRole("button", { name: /Send message; hold and swipe up/ }).click();
  await expect(page.getByText("Fixture backend answer", { exact: true }).last()).toBeVisible();
  await expect(page.getByText(draft, { exact: true })).toHaveCount(1);
  await expect(page.getByRole("status", { name: "Pocket activity" })).toHaveCount(0);
  expect(await nativeStarts()).toBe(starts);
});

test("failed voice handoff retains speech and orders a typed follow-up and response through reload", async ({
  page,
}) => {
  const speech = `Please inspect my voice issue ${test.info().project.name}`;
  const followUp = `Follow up on that saved speech ${test.info().project.name}`;

  await writeFile(path.join(directory, "control.json"), JSON.stringify({ transcript: speech, invalidHandoff: true }));
  await open(page);
  await start(page);
  await expect(page.getByText(/Voice handoff contained unexpected instructions/)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss voice error" }).click();
  await expect(page.getByText(/Voice handoff contained unexpected instructions/)).toHaveCount(0);
  await expect(page.getByText(speech, { exact: true })).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
  const before = await nativeStarts();

  await page.getByRole("textbox", { name: "Message Pocket" }).fill(followUp);
  await page.getByRole("button", { name: /Send message; hold and swipe up/ }).click();
  await expect(page.getByText(followUp, { exact: true })).toHaveCount(1);
  await expect.poll(nativeStarts).toBe(before + 1);
  await expect(page.getByText("Fixture text answer", { exact: true }).last()).toBeVisible();

  for (const shouldReload of [false, true]) {
    if (shouldReload) {
      await page.reload();
    }

    await expect(page.getByText(speech, { exact: true })).toHaveCount(1);
    await expect(page.getByText(followUp, { exact: true })).toHaveCount(1);
    const texts = await page.locator("[data-message-id]").allTextContents();

    expect(texts.indexOf(speech)).toBeLessThan(texts.indexOf(followUp));
    expect(texts.indexOf(followUp)).toBeLessThan(texts.lastIndexOf("Fixture text answer"));
  }

  await page.getByRole("button", { name: "Send saved speech", exact: true }).last().click();
  await expect.poll(nativeStarts).toBe(before + 2);
  await expect(page.getByText(speech, { exact: true })).toHaveCount(1);
});
