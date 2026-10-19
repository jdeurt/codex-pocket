import { type Page, expect } from "@playwright/test";
import { replayParent, replayRestartBoundary } from "../fixtures/agent-browser-data";
import type { RestartEvent } from "../../src/lib/protocol";
import { readFile } from "node:fs/promises";

const READ_OLDER_PIXELS = -280;

export async function checkAgentRestartNavigation(page: Page) {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "6 agents", exact: true });
  await expect(trigger).toBeVisible();
  const parent = page.locator('main > [class] [data-slot="message-scroller-viewport"]').first();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => resolve()));
      })
  );
  await expect(parent).toHaveAttribute("data-scroll-motion", "idle");
  const restarts = JSON.parse(
    await readFile(".local/agent-browser-replay/state/restart-events.json", "utf8")
  ) as RestartEvent[];
  expect(restarts).toHaveLength(1);
  expect(restarts[0]).toEqual({
    id: expect.stringMatching(/^pocket-restart:/),
    threadId: replayParent,
    after: replayRestartBoundary,
  });
  // Positive first: the real RPC -> Bridge -> SSE parent projection must render
  // the saved typed event, once and after its exact persisted message boundary.
  const parentNotice = parent.getByRole("note");
  // Repeated runs retain earlier appends. Read the event's tail explicitly;
  // the separate anchor checks start on a fresh page after this round trip.
  await parent.hover();
  await page.mouse.wheel(0, READ_OLDER_PIXELS);
  await parentNotice.scrollIntoViewIfNeeded();
  await expect(parentNotice).toHaveCount(1);
  await expect(parentNotice).toHaveText("Pocket restarted");
  await expect(parentNotice).toBeInViewport();
  expect(
    await parent
      .locator(`[data-message-id="${replayRestartBoundary.itemId}"], [data-system-event="pocket-restarted"]`)
      .evaluateAll((elements) => elements.map((element) => element.dataset.messageId ?? "restart"))
  ).toEqual([replayRestartBoundary.itemId, "restart"]);
  await trigger.evaluate((button: HTMLButtonElement) => button.click());
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });
  await dialog.getByRole("button", { name: /Researching an exceptionally long/ }).click();
  await expect(dialog.getByText("Saved native-codex result", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("note")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Back to agents", exact: true }).click();
  await dialog.getByRole("button", { name: "Back to Pocket", exact: true }).click();
  await expect(dialog).toBeHidden();
  // Inspect the appropriate visible tail, rather than requiring offscreen
  // virtual rows to stay mounted after returning from the child.
  await parentNotice.scrollIntoViewIfNeeded();
  await expect(parentNotice).toHaveCount(1);
  await expect(parentNotice).toHaveText("Pocket restarted");
  await expect(parentNotice).toBeInViewport();
}
