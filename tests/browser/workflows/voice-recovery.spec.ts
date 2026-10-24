import { expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import {
  configureVoice,
  installRealtimePeer,
  openVoice,
  providerAction,
  startVoice,
} from "../../fixtures/realtime-browser";

test("microphone loss stops the direct call and preserves the draft", async ({ page }) => {
  await configureVoice();
  await installRealtimePeer(page);
  await openVoice(page);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("recovery draft");
  await startVoice(page);
  await page.evaluate(() => {
    const track = globalThis.pocketMediaProbe.microphone;

    track?.stop();
    track?.dispatchEvent(new Event("ended"));
  });
  await expect(page.getByText("Microphone disconnected. Realtime stopped.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("recovery draft");
});

test("provider control loss releases media and permits a fresh call", async ({ page }) => {
  await configureVoice();
  await installRealtimePeer(page);
  await openVoice(page);
  await startVoice(page);
  await providerAction("disconnect");
  await expect(page.getByText(/OpenAI Realtime disconnected/)).toBeVisible();
  expect(await page.evaluate(() => globalThis.pocketMediaProbe.microphone?.readyState)).toBe("ended");
  await startVoice(page);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
});
