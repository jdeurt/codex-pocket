import { expect, test } from "@playwright/test";
import { mount, publish } from "./virtualization-fixture";
import { initialSnapshot } from "../../src/lib/protocol";

const ICON_EDGE = 16;
const LABEL_GAP = 8;
const STATUS_GAP = 24;
const ROW_HEIGHT = 44;
const INPUT_GAP = 10;
const TOLERANCE = 1;

test("spinner visible bounds align with transcript text and leave only the label gap", async ({ page }, info) => {
  const state = {
    ...initialSnapshot,
    connection: "connected" as const,
    threadId: "spinner-parent",
    activeTurnId: "spinner-turn",
    activity: "Waiting for updates",
    turns: [
      {
        id: "spinner-turn",
        status: "inProgress",
        items: [
          { id: "spinner-last", type: "agentMessage", text: "Transcript text aligned with the thinking indicator." },
        ],
      },
    ],
  };
  const measure = () =>
    page.locator(".activity-row").evaluate((row) => {
      const text = document.querySelector('[data-message-id="spinner-last"] .markdown > :last-child');
      const spinner = row.querySelector<SVGSVGElement>("[data-slot=spinner]");
      const label = row.querySelector(":scope .activity-indicator > span:last-child");
      const composer = document.querySelector(".composer");

      if (text && spinner && label && composer) {
        const icon = spinner.getBoundingClientRect();
        const circle = spinner.querySelector(":scope circle");
        const view = spinner.viewBox.baseVal;
        const radius = Number(circle?.getAttribute("r"));
        const stroke = Number(getComputedStyle(spinner).strokeWidth.replace("px", ""));
        const scale = icon.width / view.width;
        const left = icon.left + (Number(circle?.getAttribute("cx")) - radius - stroke / 2 - view.x) * scale;
        const right = left + (radius * 2 + stroke) * scale;

        return {
          leftError: left - text.getBoundingClientRect().left,
          visibleWidth: right - left,
          labelGap: label.getBoundingClientRect().left - right,
          statusGap: label.getBoundingClientRect().top - text.getBoundingClientRect().bottom,
          rowHeight: row.getBoundingClientRect().height,
          composerGap: composer.getBoundingClientRect().top - row.getBoundingClientRect().bottom,
          composerTop: composer.getBoundingClientRect().top,
        };
      }

      throw new Error("Expected transcript, spinner, label and composer");
    });

  const geometry = await test.step("Measure the settled visible spinner and status row", async () => {
    await mount(page, state);
    await expect(page.locator(".activity-indicator")).toBeVisible();
    await expect
      .poll(async () => {
        const measurement = await measure();

        return Math.abs(measurement.statusGap - STATUS_GAP);
      })
      .toBeLessThan(TOLERANCE);

    return measure();
  });

  expect(Math.abs(geometry.leftError)).toBeLessThan(TOLERANCE);
  expect(geometry.visibleWidth).toBe(ICON_EDGE);
  expect(geometry.labelGap).toBe(LABEL_GAP);
  expect(geometry.rowHeight).toBe(ROW_HEIGHT);
  expect(Math.abs(geometry.composerGap - INPUT_GAP)).toBeLessThan(TOLERANCE);
  await publish(page, { ...state, activeTurnId: undefined });
  await expect(page.locator(".activity-indicator")).toHaveCount(0);
  expect(await page.locator(".activity-row").evaluate((row) => row.getBoundingClientRect().height)).toBe(ROW_HEIGHT);
  expect(await page.locator(".composer").evaluate((composer) => composer.getBoundingClientRect().top)).toBe(
    geometry.composerTop
  );
  await info.attach("spinner-visible-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
});
