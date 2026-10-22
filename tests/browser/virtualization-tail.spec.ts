import { type Page, expect, test } from "@playwright/test";
import { mount, publish } from "./virtualization-fixture";
import { type AgentCatalog } from "../../src/lib/agents";
import { type Snapshot } from "../../src/lib/protocol";
import { history } from "../fixtures/virtualized-history";
import { viewport } from "./virtualization-measure";

const HIT_TARGET = 44;
const COMPOSER_GAP = 10;
const ALIGNMENT_TOLERANCE = 0.5;
const ACTIVITY_COUNT = 120;
const READER_DISTANCE = 200;

/**
Returns a scoped running agent or an empty catalog for the real overview subscription.
@param isActive - Whether the offline worker is currently running.
@returns Valid agent discovery data without starting a harness.
*/
function catalog(isActive: boolean): AgentCatalog {
  return {
    agents: isActive
      ? [
          {
            id: "tail-agent",
            parentId: "parent",
            name: "Tail agent",
            source: "side-pocket",
            harness: "codex",
            status: "running",
            preview: "",
          },
        ]
      : [],
    warnings: [],
    updatedAt: Date.now(),
  };
}

/**
Measures the actual activity line and composer layout independently of virtual estimates.
@param page - Browser containing the real chat and notification prompt.
@returns Visible row height, viewport height and composer position.
*/
function tailGeometry(page: Page) {
  return page.locator(".activity-row").evaluate((row) => {
    const scroller = globalThis.document.querySelector('[data-slot="message-scroller-viewport"]');
    const composer = globalThis.document.querySelector(".composer-wrap");

    return {
      rowHeight: row.getBoundingClientRect().height,
      rowTop: row.getBoundingClientRect().top,
      inputGap: (composer?.getBoundingClientRect().top ?? 0) - row.getBoundingClientRect().bottom,
      viewportHeight: scroller?.getBoundingClientRect().height,
      composerTop: composer?.getBoundingClientRect().top,
      viewportBottom: scroller?.getBoundingClientRect().bottom,
    };
  });
}

test("agent presence retains activity-line geometry and a mobile hit target", async ({ page }) => {
  let isActive = false;

  const state: Snapshot = { ...history(), activeTurnId: "live", activity: "Checking the current task" };
  const writes = await mount(page, state);
  const original = await test.step("Measure the activity line with the permission banner still present", async () => {
    await page.reload();
    await expect(page.getByRole("button", { name: "Dismiss notification prompt" })).toBeVisible();
    await expect
      .poll(() =>
        page.locator(viewport).evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
      )
      .toBeLessThan(1);

    return await tailGeometry(page);
  });
  const agent = page.getByRole("button", { name: "1 agent", exact: true });
  const hitTarget = await test.step("Add the running agent without changing the surrounding layout", async () => {
    await page.route("**/api/agents", (route) => route.fulfill({ json: catalog(isActive) }));
    isActive = true;
    await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
    await expect(agent).toBeVisible();
    await expect.poll(() => tailGeometry(page)).toEqual(original);

    return await agent.boundingBox();
  });

  await expect
    .poll(() =>
      page.locator(".activity-row").evaluate((row) => {
        const indicator = row.querySelector(".activity-indicator")?.getBoundingClientRect();
        const label = row.querySelector(".agents-label")?.getBoundingClientRect();

        return indicator && label
          ? Math.abs(indicator.top + indicator.height / 2 - label.top - label.height / 2)
          : Infinity;
      })
    )
    .toBeLessThan(ALIGNMENT_TOLERANCE);
  expect(hitTarget?.height).toBeGreaterThanOrEqual(HIT_TARGET);
  expect(hitTarget?.width).toBeGreaterThanOrEqual(HIT_TARGET);
  await agent.click({ position: { x: 2, y: 2 } });
  await expect(page.getByRole("dialog", { name: "Agents", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Agents", exact: true })).toHaveCount(0);
  await publish(page, { ...state, activeTurnId: undefined });
  await expect(page.getByRole("status", { name: "Pocket activity" })).toHaveCount(0);
  await expect.poll(() => tailGeometry(page)).toEqual(original);
  await publish(page, state);
  await expect(page.getByRole("status", { name: "Pocket activity" })).toBeVisible();
  isActive = false;
  await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
  await expect(agent).toHaveCount(0);
  await expect.poll(() => tailGeometry(page)).toEqual(original);
  await publish(page, { ...state, activeTurnId: undefined });
  await expect(page.getByRole("status", { name: "Pocket activity" })).toHaveCount(0);
  await expect.poll(() => tailGeometry(page)).toEqual(original);
  expect(original.rowHeight).toBe(HIT_TARGET);
  // The native scroll offset rounds fractional content heights to physical pixels.
  expect(Math.abs(original.inputGap - COMPOSER_GAP)).toBeLessThan(ALIGNMENT_TOLERANCE);
  expect(original.viewportBottom).toBe(original.composerTop);
  expect(writes).toEqual([]);
});

test("jump after activity collapse reaches the agent control and the actual transcript end", async ({ page }, info) => {
  const state: Snapshot = {
    ...history(),
    activeTurnId: "live",
    activity: "Checking the current task",
    turns: [
      ...history().turns,
      {
        id: "tail-disclosure",
        status: "completed",
        items: [
          { id: "tail-question", type: "userMessage", content: [{ text: "Inspect saved activity" }] },
          ...Array.from({ length: ACTIVITY_COUNT }, (_, index) => ({
            id: `tail-detail-${String(index)}`,
            type: "agentMessage",
            phase: "commentary",
            text: `Saved activity ${String(index)}\n\nA variable-height activity paragraph.`,
          })),
          { id: "tail-answer", type: "agentMessage", phase: "final_answer", text: "Latest answer" },
        ],
      },
    ],
  };
  const writes = await mount(page, state);
  const agent = page.getByRole("button", { name: "1 agent", exact: true });
  const latest = page.getByRole("button", { name: "Jump to latest message", exact: true });

  await page.route("**/api/agents", (route) => route.fulfill({ json: catalog(true) }));
  await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
  await expect(agent).toBeVisible();
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("Retain this draft");
  await page.getByRole("button", { name: "Show activity", exact: true }).click();
  await expect(page.locator("[data-activity-virtualizer]")).toBeVisible();
  await page.getByRole("button", { name: "Hide activity", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show activity", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  await expect(page.locator('[data-slot="trace-collapsible-content"]')).toBeHidden();
  await page.locator(viewport).evaluate((element, distance) => {
    element.scrollBy({ top: -distance, behavior: "instant" });
  }, READER_DISTANCE);
  await expect(latest).toBeVisible();
  await expect(agent).not.toBeInViewport();
  await expect(page.locator(viewport)).not.toHaveCSS("mask-image", "none");
  await expect
    .poll(async () => {
      const measured = await tailGeometry(page);

      return measured.viewportBottom === measured.composerTop;
    })
    .toBe(true);
  await page.screenshot({ path: `.local/composer-fade-${info.project.name}.png` });
  await latest.click();
  await expect(latest).toHaveCount(0);
  await expect
    .poll(() =>
      page.locator(viewport).evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
    )
    .toBeLessThan(1);
  await expect(agent).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("Retain this draft");
  expect(writes).toEqual([]);
});
