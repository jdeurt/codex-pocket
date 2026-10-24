import { type Page, expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import {
  configureVoice,
  installRealtimePeer,
  openVoice,
  providerAction,
  startVoice,
  negotiateVoice,
} from "../../fixtures/realtime-browser";

import { expectAnchor, scrollToFraction, settledAnchor, viewport } from "../virtualization-measure";

const CAPTION_DELAY_MS = 1500;
const REPLY_REPEATS = 30;
const READING_FRACTION = 0.35;
const STREAM_DELAY_MS = 1200;
const END_TOLERANCE = 8;

/** Measure actual scroll geometry independently of the transcript's follow state.
@param page - Browser displaying the live conversation.
@returns Remaining distance below the viewport.
*/
async function distanceFromEnd(page: Page) {
  return page.locator(viewport).evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}

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

test("streaming replies follow the end and preserve a reader who scrolls up", async ({ page }) => {
  const first = "First spoken answer. " + "Here is the evidence from the investigation. ".repeat(REPLY_REPEATS);
  const partial = "I’m continuing the investigation.";
  const second = partial + " More details from the same spoken reply. ".repeat(REPLY_REPEATS);
  const third = "New information while you read earlier messages.";

  await configureVoice({ transcript: "Start the investigation.", replyText: first });
  await installRealtimePeer(page);
  await openVoice(page);
  await negotiateVoice(page);
  await providerAction("speech");
  await expect(page.getByText(first, { exact: true })).toHaveCount(1);
  await expect.poll(distanceFromEnd.bind(undefined, page)).toBeLessThanOrEqual(END_TOLERANCE);
  await scrollToFraction(page, READING_FRACTION);
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await expect.poll(distanceFromEnd.bind(undefined, page)).toBeLessThanOrEqual(END_TOLERANCE);
  await configureVoice({
    transcript: "Please continue.",
    replyText: second,
    partialReplyText: partial,
    replyDelayMs: STREAM_DELAY_MS,
  });
  await providerAction("speech");
  await expect(page.getByText(partial, { exact: true })).toBeVisible();
  await expect.poll(distanceFromEnd.bind(undefined, page)).toBeLessThanOrEqual(END_TOLERANCE);
  await expect(page.getByText(second, { exact: true })).toHaveCount(1);
  await expect.poll(distanceFromEnd.bind(undefined, page)).toBeLessThanOrEqual(END_TOLERANCE);
  await scrollToFraction(page, READING_FRACTION);
  const anchor = await settledAnchor(page);

  await configureVoice({ transcript: "One more update.", replyText: third });
  await providerAction("speech");
  await expect(page.getByText(third, { exact: true })).toHaveCount(1);
  await expectAnchor(page, anchor);
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await expect.poll(distanceFromEnd.bind(undefined, page)).toBeLessThanOrEqual(END_TOLERANCE);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
});
