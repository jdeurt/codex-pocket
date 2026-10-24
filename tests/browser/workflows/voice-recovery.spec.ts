import { type Response, expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import {
  configureVoice,
  installRealtimePeer,
  openVoice,
  providerAction,
  negotiateVoice,
} from "../../fixtures/realtime-browser";

test("provider control loss releases media and permits a fresh call", async ({ page }) => {
  await configureVoice();
  await installRealtimePeer(page);
  await openVoice(page);
  await negotiateVoice(page);
  await providerAction("disconnect");
  await expect(page.getByText(/GPT-Live disconnected/)).toBeVisible();
  expect(await page.evaluate(() => globalThis.pocketMediaProbe.microphone?.readyState)).toBe("ended");
  await negotiateVoice(page);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
});

/** Observe the real call-negotiation response without requiring RTP connectivity.
@param response - Browser HTTP response.
@returns Whether the native media offer has been negotiated.
*/
function isVoiceNegotiated(response: Response) {
  return response.url().endsWith("/api/realtime") && response.request().method() === "POST";
}

test("ending voice shows a loading indicator and gray bars until shutdown finishes", async ({ page }) => {
  const shutdown = Promise.withResolvers<undefined>();
  const stopping = Promise.withResolvers<undefined>();

  await configureVoice();
  await installRealtimePeer(page);
  await openVoice(page);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("Keep my draft after hanging up.");
  const negotiated = page.waitForResponse(isVoiceNegotiated.bind(undefined));

  await page.getByRole("button", { name: "Start realtime voice" }).focus();
  await page.keyboard.press("Enter");
  await negotiated;
  await page.route("**/api/realtime", async (route) => {
    const body: unknown = route.request().postDataJSON();

    if (typeof body === "object" && body !== null && "action" in body && body.action === "stop") {
      stopping.resolve(undefined);
      await shutdown.promise;
    }

    await route.fallback();
  });
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await stopping.promise;
  const status = page.getByRole("status", { name: "Realtime voice stopping" });

  await expect(status).toHaveText("Ending call…");
  await expect(status.locator('[data-slot="spinner"]')).toBeVisible();
  await expect(status.locator("canvas")).toHaveCSS("filter", "grayscale(1)");
  expect(await page.evaluate(() => globalThis.pocketMediaProbe.microphone?.readyState)).toBe("ended");
  shutdown.resolve(undefined);
  await expect(status).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("Keep my draft after hanging up.");
});
