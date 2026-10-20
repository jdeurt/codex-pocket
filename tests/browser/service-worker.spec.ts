import { expect, test } from "@playwright/test";

test("native worker claims its page and serves only the static fallback during offline navigation", async ({
  page,
  context,
}) => {
  await page.goto("/offline.html");
  await page.evaluate(async () => {
    await globalThis.navigator.serviceWorker.register("/sw.js");
    await globalThis.navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => Boolean(globalThis.navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.goto("/offline-navigation-check");
  await expect(page.getByRole("heading", { name: "Your computer is offline." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/");
  await expect(page.locator(".chat-shell")).toHaveCount(0);
  await context.setOffline(false);
});
