/* eslint-disable @typescript-eslint/no-magic-numbers -- Whole-flow live preference changes sampled in animation frames. */
import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { expect, test } from "@playwright/test";
import { mount, publish } from "./virtualization-fixture";
import { ACTIVITY_MOTION } from "../../src/lib/activity-motion";

const viewport = '[data-slot="message-scroller-viewport"]';

test("live reduced motion updates an open activity panel and cancels an active bottom transition", async ({ page }) => {
  const state: Snapshot = {
    ...initialSnapshot,
    connection: "connected",
    activeTurnId: "next",
    turns: [
      {
        id: "history",
        status: "interrupted",
        items: Array.from({ length: 1200 }, (_, index) => ({
          id: `history-${index}`,
          type: "agentMessage",
          text: `History ${index}`,
        })),
      },
      {
        id: "activity",
        status: "completed",
        items: [
          { id: "user", type: "userMessage", content: [{ text: "Read activity" }] },
          ...Array.from({ length: 4 }, (_, index) => ({
            id: `detail-${index}`,
            type: "agentMessage",
            phase: "commentary",
            text: `Activity detail ${index}`,
          })),
          { id: "final", type: "agentMessage", phase: "final_answer", text: "Final visible block" },
        ],
      },
    ],
  };
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const writes = await mount(page, state);
  const scroller = page.locator(viewport);
  await expect(scroller).toHaveAttribute("data-scroll-motion", "idle");
  const panel = page.locator('[data-slot="trace-collapsible-content"]');
  const icon = page.locator('[data-slot="trace-collapsible-trigger"] [data-slot="trace-icon"]');
  const animating = await page
    .getByRole("button", { name: "Show activity", exact: true })
    .evaluate(async (button: HTMLButtonElement) => {
      button.click();
      await new Promise(globalThis.requestAnimationFrame);
      await new Promise(globalThis.requestAnimationFrame);

      return (
        (globalThis.document.querySelector('[data-slot="trace-collapsible-content"]')?.getAnimations().length ?? 0) > 0
      );
    });
  expect(animating).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(panel).toHaveCSS("transition-property", "none");
  await expect(icon).toHaveCSS("transition-property", "none");
  await expect(page.getByRole("button", { name: "Hide activity", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
  await expect
    .poll(() => scroller.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(2);
  await expect(scroller).toHaveAttribute("data-scroll-motion", "idle");

  // Restore motion while the same panel stays open, then change preference
  // during an independently started bottom correction for incoming content.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(panel).toHaveCSS("transition-property", "height");
  await expect(panel).toHaveCSS("transition-duration", `${ACTIVITY_MOTION.duration / 1000}s`);
  await expect(icon).toHaveCSS("transition-timing-function", ACTIVITY_MOTION.easing);
  state.turns.push({
    id: "incoming",
    status: "interrupted",
    items: [{ id: "incoming", type: "agentMessage", text: "New incoming block.\n\n".repeat(20) }],
  });
  await publish(page, state);
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')?.dataset
        .scrollMotion === "smooth",
    undefined,
    { polling: "raf" }
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  const frames = await scroller.evaluate(async (node) => {
    const samples = [];

    for (let index = 0; index < 10; index++) {
      await new Promise(globalThis.requestAnimationFrame);
      samples.push({ phase: node.dataset.scrollMotion, gap: node.scrollHeight - node.scrollTop - node.clientHeight });
    }

    return samples;
  });
  expect(frames.every((frame) => frame.phase !== "smooth" && Math.abs(frame.gap) < 2)).toBe(true);
  await expect(panel).toHaveCSS("transition-property", "none");
  await expect(icon).toHaveCSS("transition-property", "none");

  // Changing only the preference must not pull a history reader anywhere.
  await scroller.dispatchEvent("wheel", { deltaY: -280 });
  await scroller.evaluate((node) => {
    node.scrollTop -= 280;
  });
  const before = await scroller.evaluate((node) => node.scrollTop);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(panel).toHaveCSS("transition-property", "height");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(panel).toHaveCSS("transition-property", "none");
  expect(Math.abs((await scroller.evaluate((node) => node.scrollTop)) - before)).toBeLessThan(1);
  expect(writes).toEqual([]);
});
