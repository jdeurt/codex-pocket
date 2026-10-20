import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { expect, test } from "@playwright/test";
import { mount } from "./virtualization-fixture";

const MAX_MOUNTED_ROWS = 250;
const MIN_HIT_TARGET = 44;
const ANCHOR_TOLERANCE = 3;
const ACTIVITY_MESSAGES = 3;
const MIN_READER_GAP = 90;
const MISSING_GAP = -1;

test("ordinary activity expansion retains CSS animation and bounded rows", async ({ page }) => {
  const writes = await mount(page, {
    ...initialSnapshot,
    connection: "connected",
    turns: [
      {
        id: "activity-smoke",
        status: "completed",
        items: [
          { id: "question", type: "userMessage", content: [{ text: "Inspect activity" }] },
          ...Array.from({ length: 1200 }, (_, index) => ({
            id: `detail-${String(index)}`,
            type: "agentMessage",
            phase: "commentary",
            text: `Saved activity detail ${String(index)}`,
          })),
          { id: "final", type: "agentMessage", phase: "final_answer", text: "Saved final answer" },
        ],
      },
    ],
  });
  const composer = page.getByRole("textbox", { name: "Message Pocket" });
  const hide = page.getByRole("button", { name: "Hide activity", exact: true });

  await composer.fill("Keep my activity draft");
  await page.getByRole("button", { name: "Show activity", exact: true }).click();

  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-slot="trace-collapsible-content"]')).toHaveCSS("transition-duration", "0.2s");
  await expect(page.locator("[data-activity-virtualizer] [data-transcript-row]").first()).toBeVisible();
  expect(await page.locator("[data-transcript-row]").count()).toBeLessThan(MAX_MOUNTED_ROWS);
  await hide.click();
  await expect(page.getByRole("button", { name: "Show activity", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  await expect(page.getByText("Saved final answer", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Keep my activity draft");
  expect(writes).toEqual([]);
});

test("activity disclosure keeps shared outer gaps and hit target through expansion and virtualization", async ({
  page,
}) => {
  const state: Snapshot = {
    ...initialSnapshot,
    connection: "connected",
    activeTurnId: "next-turn",
    activity: "Activity spacing fixture",
    turns: [
      {
        id: "older",
        status: "interrupted",
        items: Array.from({ length: 1200 }, (_, index) => ({
          id: `older-${String(index)}`,
          type: "agentMessage",
          text: `Older fixture ${String(index)}`,
        })),
      },
      {
        id: "activity-turn",
        status: "completed",
        items: [
          { id: "before-control", type: "userMessage", content: [{ text: "Inspect activity" }] },
          ...Array.from({ length: ACTIVITY_MESSAGES }, (_, index) => ({
            id: `detail-${String(index)}`,
            type: "agentMessage",
            phase: "commentary",
            text: `Visible activity detail ${String(index)}`,
          })),
          { id: "after-control", type: "agentMessage", phase: "final_answer", text: "Final visible block" },
        ],
      },
    ],
  };
  const writes = await mount(page, state);
  const scroller = page.locator('[data-slot="message-scroller-viewport"]');
  const show = page.getByRole("button", { name: "Show activity", exact: true });
  const hide = page.getByRole("button", { name: "Hide activity", exact: true });
  const gapErrors = (isExpanded: boolean) =>
    scroller.evaluate(
      (element, { open, count }) => {
        const control = element.querySelector('[data-slot="trace-collapsible-trigger"]');
        const previous = element.querySelector(
          ':scope [data-message-id="before-control"] [data-slot="bubble-content"]'
        );
        const final = element.querySelector(':scope [data-message-id="after-control"] .markdown > :first-child');
        const status = element.querySelector('[role="status"][aria-label="Pocket activity"]');
        const transcript = element.querySelector(".transcript");
        const details = [...element.querySelectorAll(':scope [data-message-id^="detail-"] .markdown > :first-child')];

        if (!control || !previous || !final || !status || !transcript || (open && details.length !== count)) {
          return [Infinity];
        }

        const expected = Number(
          globalThis.getComputedStyle(transcript).getPropertyValue("--message-block-gap").trim().replace(/px$/, "")
        );
        const boxes = [previous, control, ...(open ? details : []), final, status].map((item) =>
          item.getBoundingClientRect()
        );

        return boxes.slice(1).map((box, index) => Math.abs(box.top - boxes[index].bottom - expected));
      },
      { open: isExpanded, count: ACTIVITY_MESSAGES }
    );

  await scroller.evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    element.scrollBy({ top: -100, behavior: "instant" });
  });

  await expect(show).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => Math.max(...(await gapErrors(false)))).toBeLessThan(1);
  const before = await show.boundingBox();

  if (!before) {
    throw new Error("Missing activity control box");
  }

  expect(before.height).toBeGreaterThanOrEqual(MIN_HIT_TARGET);
  await show.evaluate((control, missingGap) => {
    control.addEventListener(
      "pointerdown",
      () => {
        control.dataset.activationY = String(control.getBoundingClientRect().y);
        const viewport = control.closest('[data-slot="message-scroller-viewport"]');

        control.dataset.activationGap = String(
          viewport ? viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight : missingGap
        );
      },
      { once: true }
    );
  }, MISSING_GAP);
  await show.click();
  const activationY = Number(await hide.getAttribute("data-activation-y"));
  const activationGap = Number(await hide.getAttribute("data-activation-gap"));

  expect(activationGap).toBeGreaterThan(MIN_READER_GAP);
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await expect.poll(async () => Math.max(...(await gapErrors(true)))).toBeLessThan(1);
  const expandedBox = await hide.boundingBox();

  expect(expandedBox?.height).toBeGreaterThanOrEqual(MIN_HIT_TARGET);
  await expect
    .poll(async () => {
      const current = await hide.boundingBox();

      return current ? Math.abs(current.y - activationY) : Infinity;
    })
    .toBeLessThan(ANCHOR_TOLERANCE);
  await scroller.evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    element.scrollTop = 0;
  });
  await expect(hide).toHaveCount(0);
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await expect.poll(async () => Math.max(...(await gapErrors(true)))).toBeLessThan(1);
  expect(await page.locator("[data-transcript-row]").count()).toBeLessThan(MAX_MOUNTED_ROWS);
  await hide.click();
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => Math.max(...(await gapErrors(false)))).toBeLessThan(1);
  const collapsedBox = await show.boundingBox();

  expect(collapsedBox?.height).toBeGreaterThanOrEqual(MIN_HIT_TARGET);
  expect(writes).toEqual([]);
});
