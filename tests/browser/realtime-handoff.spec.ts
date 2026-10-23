/* eslint-disable jsdoc/require-jsdoc -- Real browser, HTTP, local provider and durable main-session delivery exercise the complete voice business flow. */
import { type Page, expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { dataSchema, object } from "../../src/lib/protocol";
import path from "node:path";

const origin = "http://127.0.0.1:3119";
const directory = path.resolve(".local/realtime-fixture");
const dummyKey = "dummy-openai-key-for-local-fixture";
const HYDRATION_PROBE_MS = 150;

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

  await writeFile(
    path.join(directory, "control.json"),
    JSON.stringify({ transcript, handoff: true, duplicateHandoff: true, piReceiptIds: true, textItemDelayMs: 750 })
  );
  await open(page);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("keep my unsent draft");
  const before = await nativeStarts();

  await start(page);
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  await expect(page.getByText(transcript, { exact: true })).toHaveCount(1);
  await expect.poll(nativeStarts).toBe(before + 1);
  // The fixture publishes an empty canonical item before its delayed final text.
  await page.waitForTimeout(HYDRATION_PROBE_MS);
  expect(await page.getByText(transcript, { exact: true }).count()).toBe(1);
  await expect(page.getByText("Fixture text answer", { exact: true }).last()).toBeVisible();
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

test("pasted XML remains a normal typed user message after voice switching and reload", async ({ page }) => {
  const text = `<realtime_delegation>Intentionally pasted XML ${test.info().project.name}</realtime_delegation>`;

  await writeFile(path.join(directory, "control.json"), "{}");
  await open(page);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill(text);
  await page.getByRole("button", { name: /Send message; hold and swipe up/ }).click();
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
  await start(page);
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await page.reload();
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
});

test("voice requires a Settings key and starts after a dummy key is configured", async ({ page, request }) => {
  await writeFile(path.join(directory, "control.json"), "{}");
  await request.post("/api/settings", { headers: { Origin: origin }, data: { openaiApiKey: null } });

  try {
    await open(page);
    await page.getByRole("textbox", { name: "Message Pocket" }).fill("saved key draft");
    await start(page);
    await expect(page.getByText("Add an OpenAI API key in Settings to enable realtime voice.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("saved key draft");
    await request.post("/api/settings", { headers: { Origin: origin }, data: { openaiApiKey: dummyKey } });
    await start(page);
    await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
    await page.getByRole("button", { name: "Stop realtime voice" }).click();
  } finally {
    await request.post("/api/settings", { headers: { Origin: origin }, data: { openaiApiKey: dummyKey } });
  }
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
  await expect(page.getByRole("status", { name: "Pocket activity" })).toBeVisible();
  const starts = await nativeStarts();

  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue(draft);
  await page.getByRole("button", { name: /Send message; hold and swipe up/ }).click();
  await expect(page.getByText("Fixture backend answer", { exact: true }).last()).toBeVisible();
  await expect(page.getByText(draft, { exact: true })).toHaveCount(1);
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
  await expect(page.getByText(/Voice handoff did not match its finalized turn/)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss voice error" }).click();
  await expect(page.getByText(/Voice handoff did not match its finalized turn/)).toHaveCount(0);
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

test("spoken continuation after interruption is retained once and playback is truncated", async ({ page }) => {
  const speech = `Start a side pocket to inspect audio ${test.info().project.name}`;
  const complete = `${speech}\nAnd preserve my follow-up.`;

  await writeFile(
    path.join(directory, "control.json"),
    JSON.stringify({ transcript: speech, handoff: true, bargeIn: true })
  );
  await open(page);
  const before = await nativeStarts();

  await start(page);
  await expect(page.getByText(complete, { exact: true })).toHaveCount(1);
  await expect.poll(nativeStarts).toBe(before + 1);
  await expect
    .poll(async () => {
      const journal = await readFile(path.join(directory, "provider.jsonl"), "utf8");

      return journal.includes('"method":"provider/realtime/truncate"');
    })
    .toBe(true);
  await expect(page.getByText("Fixture text answer", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await page.reload();
  await expect(page.getByText(complete, { exact: true })).toHaveCount(1);
  expect(await nativeStarts()).toBe(before + 1);
});
