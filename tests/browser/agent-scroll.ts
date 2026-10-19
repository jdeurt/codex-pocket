import { type Page, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const SCROLLED_OFFSET = 280;
const OFFSET_TOLERANCE = 2;

export async function checkAgentScroll(page: Page, control: (stage: string) => Promise<void>) {
  const mutations: string[] = [];
  const measurements = [];
  page.on("request", (request) => {
    if (!["GET", "HEAD"].includes(request.method()) && !request.url().includes("/api/logs")) {
      mutations.push(request.url());
    }
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "6 agents", exact: true });
  await expect(trigger).toBeVisible();
  const parent = page.locator('main > [class] [data-slot="message-scroller-viewport"]').first();
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });

  for (const position of ["scrolled", "bottom"]) {
    await parent.evaluate(
      (element, offset) => {
        element.scrollTop = offset ?? element.scrollHeight;
      },
      position === "scrolled" ? SCROLLED_OFFSET : null
    );
    const before = await parent.evaluate((element) => element.scrollTop);
    expect(before).toBeGreaterThan(SCROLLED_OFFSET - OFFSET_TOLERANCE);
    const oldHeight = await parent.evaluate((element) => element.scrollHeight);
    // Do not scroll the offscreen activity control into view before opening.
    await trigger.evaluate((button: HTMLButtonElement) => button.click());
    const row = dialog.getByRole("button", { name: /Researching an exceptionally long/ });
    await row.click();
    await expect(dialog.getByRole("heading", { name: "Side Pocket", exact: true })).toBeFocused();
    await expect(dialog.getByText("Saved native-codex result", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Pocket restarted", { exact: true })).toHaveCount(0);
    await control(`parent-append:${position}`);
    // Parent remains mounted and consumes the actual RPC -> bridge -> SSE update.
    await expect(parent.locator(`[data-slot="bubble"][data-message-id="parent-incoming-${position}"]`)).toHaveCount(1);
    await expect.poll(() => parent.evaluate((element) => element.scrollHeight)).toBeGreaterThan(oldHeight);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => resolve()));
        })
    );
    const during = await parent.evaluate((element) => element.scrollTop);
    expect(Math.abs(during - before)).toBeLessThan(OFFSET_TOLERANCE);
    await page.keyboard.press("Escape");
    await expect(row).toBeFocused();
    await dialog.getByRole("button", { name: "Back to Pocket", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    const after = await parent.evaluate((element) => element.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(OFFSET_TOLERANCE);
    measurements.push({ position, before, during, after });
  }

  expect(mutations).toEqual([]);
  await writeFile(".local/agent-browser-replay/navigation-result.json", JSON.stringify(measurements));
}
