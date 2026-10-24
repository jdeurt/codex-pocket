import { expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import {
  configureVoice,
  installRealtimePeer,
  openVoice,
  providerAction,
  startVoice,
} from "../../fixtures/realtime-browser";

const CAPTION_DELAY_MS = 1500;

test("realtime owns the conversation and returns worker results without duplicate assistant replies", async ({
  page,
}) => {
  const spoken = `Can you inspect that audio problem ${test.info().project.name}?`;
  const request = "Inspect transport buffering and report the cause.";
  const answer = "The worker's detailed internal result.";
  const reply = `I found the cause ${test.info().project.name}.`;

  await configureVoice({
    transcript: spoken,
    request,
    answerText: answer,
    replyText: reply,
    handoff: true,
    finalDelayMs: CAPTION_DELAY_MS,
  });
  await installRealtimePeer(page);
  await openVoice(page);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("keep this draft");
  await startVoice(page);
  await providerAction("speech");
  await expect(page.getByText(reply, { exact: true })).toHaveCount(1);
  await expect(page.getByText(spoken, { exact: true })).toHaveCount(1);
  await expect(page.getByText(request, { exact: true })).toHaveCount(0);
  await expect(page.getByText(answer, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send saved speech" })).toHaveCount(0);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("keep this draft");
  await page.reload();
  await expect(page.getByText(reply, { exact: true })).toHaveCount(1);
  await expect(page.getByText(spoken, { exact: true })).toHaveCount(1);
});
