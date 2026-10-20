import { type Item, type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { type Page, expect, test } from "@playwright/test";
import { mount, publish } from "./virtualization-fixture";
import { writeFile } from "node:fs/promises";

const ACTIVITY_VARIANTS = 6;
const IMAGE_CADENCE = 83;
const STABLE_FRAMES = 3;
const OFFSET_TOLERANCE = 3;
const SCROLL_STOPS = {
  nearStart: 0.02,
  middle: 0.5,
  nearEnd: 0.9,
  upper: 0.2,
  lower: 0.75,
  start: 0,
  end: 1,
  center: 0.55,
};

const viewport = '[data-slot="message-scroller-viewport"]';
const MAX_ROWS = 250;

async function painted(page: Page) {
  return page.locator(viewport).evaluate((element) => {
    const TOP_GAP = 32;
    const BOTTOM_GAP = 64;
    const LAST_ROW = -1;
    const bounds = element.getBoundingClientRect();
    const leaves = [...element.querySelectorAll<HTMLElement>("[data-transcript-row]:not([data-activity-row])")];
    const blocks = [
      ...leaves,
      ...element.querySelectorAll<HTMLElement>(
        ':scope [data-slot="trace-collapsible-trigger"], :scope [data-slot="transcript-footer"] > *'
      ),
    ]
      .map((item) => item.getBoundingClientRect())
      .filter((box) => box.bottom > bounds.top && box.top < bounds.bottom)
      .sort((left, right) => left.top - right.top);
    const anchor = leaves.find((item) => {
      const box = item.getBoundingClientRect();

      return box.bottom > bounds.top && box.top < bounds.bottom;
    });

    return {
      count: element.querySelectorAll("[data-transcript-row]").length,
      covered:
        blocks.length > 0 &&
        blocks[0].top <= bounds.top + TOP_GAP &&
        (blocks.at(LAST_ROW)?.bottom ?? 0) >= bounds.bottom - BOTTOM_GAP,
      anchor: anchor
        ? { id: anchor.dataset.transcriptRow ?? "", top: anchor.getBoundingClientRect().top - bounds.top }
        : null,
    };
  });
}

async function scroll(page: Page, fraction: number) {
  await page.locator(viewport).evaluate((element, part) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    element.scrollTop = (element.scrollHeight - element.clientHeight) * part;
  }, fraction);
  await expect
    .poll(async () => {
      const frame = await painted(page);

      return frame.covered;
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const frame = await painted(page);

      return frame.count;
    })
    .toBeLessThan(MAX_ROWS);
}

test("a thousand activity messages stay virtualized through scrolling, media growth, prepend and reopen", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const details: Item[] = Array.from({ length: 1200 }, (_, index) => ({
    id: `detail-${String(index)}`,
    type: "agentMessage",
    phase: "commentary",
    text: `Activity ${String(index)}\n\n${"Variable **markdown** paragraph.\n\n".repeat(index % ACTIVITY_VARIANTS)}`,
    ...(index % IMAGE_CADENCE === 0 && {
      images: [{ source: `/api/images?item=detail-${String(index)}`, alt: `Activity image ${String(index)}` }],
    }),
  }));
  const turn = {
    id: "long-activity",
    status: "completed",
    items: [
      { id: "user", type: "userMessage", content: [{ text: "Inspect long activity" }] },
      ...details,
      { id: "final", type: "agentMessage", phase: "final_answer", text: "Activity complete" },
    ],
  };
  const state: Snapshot = { ...initialSnapshot, connection: "connected", turns: [turn] };
  const writes = await mount(page, state);
  const scroller = await page.locator(viewport).elementHandle();
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("Keep the parent draft");
  await page.getByRole("button", { name: "Show activity", exact: true }).click();
  await expect(page.getByRole("button", { name: "Hide activity", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
  const counts: number[] = [];

  for (const fraction of Object.values(SCROLL_STOPS)) {
    await scroll(page, fraction);
    const frame = await painted(page);
    counts.push(frame.count);
  }

  await page.locator(viewport).evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        let previous = element.scrollTop;
        let stable = 0;
        const frame = () => {
          stable = Math.abs(element.scrollTop - previous) < 1 ? stable + 1 : 0;
          previous = element.scrollTop;

          if (stable > STABLE_FRAMES) {
            resolve();
          } else {
            globalThis.requestAnimationFrame(frame);
          }
        };
        globalThis.requestAnimationFrame(frame);
      })
  );
  const { anchor } = await painted(page);

  if (!anchor) {
    throw new Error("Missing activity reader anchor");
  }

  const expectAnchor = async () => {
    await expect
      .poll(() =>
        page.locator(viewport).evaluate((element, saved) => {
          const item = [...element.querySelectorAll<HTMLElement>("[data-transcript-row]")].find(
            (candidate) => candidate.dataset.transcriptRow === saved.id
          );

          return item
            ? Math.abs(item.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.top)
            : Infinity;
        }, anchor)
      )
      .toBeLessThan(OFFSET_TOLERANCE);
  };
  const index = turn.items.findIndex((item) => anchor.id.endsWith(`/${item.id}`));
  turn.items[index - 2].images = [{ source: "/api/images?item=reader-growth", alt: "Image above activity reader" }];
  await publish(page, state);
  await expect(page.getByRole("img", { name: "Image above activity reader" })).toHaveJSProperty("complete", true);
  await expectAnchor();
  turn.items.splice(
    1,
    0,
    ...Array.from({ length: 100 }, (_, offset) => ({
      id: `prepended-${String(offset)}`,
      type: "agentMessage",
      phase: "commentary",
      text: `Older activity ${String(offset)}`,
    }))
  );
  await publish(page, state);
  await expectAnchor();
  await page.screenshot({ path: `.local/virtualization-${info.project.name}-activity.png` });
  await scroll(page, 0);
  await page.getByRole("button", { name: "Hide activity", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show activity", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  await page.getByRole("button", { name: "Show activity", exact: true }).click();
  await scroll(page, 1);
  await expect(page.locator('[data-message-id="detail-1199"]')).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("Keep the parent draft");
  expect(
    await scroller.evaluate(
      (element) => element === globalThis.document.querySelector('[data-slot="message-scroller-viewport"]')
    )
  ).toBe(true);
  expect(writes).toEqual([]);
  await writeFile(`.local/virtualization-${info.project.name}-activity-counts.json`, JSON.stringify(counts));
});
