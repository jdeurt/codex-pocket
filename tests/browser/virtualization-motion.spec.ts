/* eslint-disable @typescript-eslint/no-magic-numbers -- Sample complete timed user flows in animation frames. */
import { type Page, expect, test } from "@playwright/test";
import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { mount, publish } from "./virtualization-fixture";
import { readFile, writeFile } from "node:fs/promises";
import { ACTIVITY_MOTION } from "../../src/lib/activity-motion";

const viewport = '[data-slot="message-scroller-viewport"]';
const EPSILON = 2;
interface Frame {
  t: number;
  top: number;
  gap: number;
  phase: string;
  covered: boolean;
  panel: number;
  outerGap: number;
}

function history(): Snapshot {
  return {
    ...initialSnapshot,
    connection: "connected",
    activeTurnId: "next",
    activity: "Motion fixture",
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
          { id: "user", type: "userMessage", content: [{ text: "Inspect activity" }] },
          ...Array.from({ length: 4 }, (_, index) => ({
            id: `detail-${index}`,
            type: "agentMessage",
            phase: "commentary",
            text: `Activity detail ${index}`,
          })),
          { id: "final", type: "agentMessage", phase: "final_answer", text: "Final block" },
        ],
      },
    ],
  };
}

function record(page: Page, duration = ACTIVITY_MOTION.duration * 3) {
  return page.evaluate(
    async ({ selector, time }) => {
      const element = globalThis.document.querySelector<HTMLElement>(selector);

      if (!element) {
        throw new Error("Missing motion viewport");
      }

      const start = globalThis.performance.now();
      const frames: Frame[] = [];
      const read = (marker?: string) => {
        const bounds = element.getBoundingClientRect();
        const blocks = [
          ...element.querySelectorAll(
            ':scope [data-transcript-row]:not([data-activity-row]), :scope [data-activity-row] [data-slot="trace-collapsible-trigger"], :scope [data-slot="transcript-footer"] > *'
          ),
        ]
          .map((item) => item.getBoundingClientRect())
          .filter((box) => box.bottom > bounds.top && box.top < bounds.bottom);
        const control = element.querySelector('[data-slot="trace-collapsible-trigger"]')?.getBoundingClientRect();
        const panel = element.querySelector('[data-slot="trace-collapsible-content"]')?.getBoundingClientRect();
        const previous = element
          .querySelector(':scope [data-message-id="user"] [data-slot="bubble-content"]')
          ?.getBoundingClientRect();
        const final = element
          .querySelector(':scope [data-message-id="final"] .markdown > :last-child')
          ?.getBoundingClientRect();
        const status = element.querySelector('[role="status"]')?.getBoundingClientRect();
        frames.push({
          t: globalThis.performance.now() - start,
          top: element.scrollTop,
          gap: element.scrollHeight - element.scrollTop - element.clientHeight,
          phase: marker ?? (element as HTMLElement).dataset.scrollMotion ?? "idle",
          panel: element.querySelector('[data-slot="trace-collapsible-content"]')?.getBoundingClientRect().height ?? 0,
          outerGap:
            control && previous && final && status
              ? Math.max(
                  Math.abs(control.top - previous.bottom - 16),
                  Math.abs(final.top - (panel?.bottom ?? control.bottom) - 16),
                  Math.abs(status.top - final.bottom - 16)
                )
              : 0,
          covered:
            blocks.length > 0 && blocks[0].top <= bounds.top + 32 && (blocks.at(-1)?.bottom ?? 0) >= bounds.bottom - 64,
        });
      };
      const disclosure = (event: Event) => {
        if (
          event.target instanceof globalThis.Element &&
          event.target.closest('[data-slot="trace-collapsible-trigger"]')
        ) {
          read("disclosure");
        }
      };
      element.addEventListener("click", disclosure, { capture: true });
      read();
      await new Promise<void>((resolve) => {
        const frame = () => {
          read();

          if (globalThis.performance.now() - start >= time) {
            resolve();
          } else {
            globalThis.requestAnimationFrame(frame);
          }
        };
        globalThis.requestAnimationFrame(frame);
      });
      element.removeEventListener("click", disclosure, true);

      return frames;
    },
    { selector: viewport, time: duration }
  );
}

async function settled(page: Page) {
  await expect
    .poll(() =>
      page
        .locator(viewport)
        .evaluate((element) => Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight))
    )
    .toBeLessThan(EPSILON);
  await expect(page.locator(viewport)).toHaveAttribute("data-scroll-motion", "idle");
}

function expectAnimated(frames: Frame[]) {
  const first = frames[0].top;
  const final = frames.at(-1);

  if (!final) {
    throw new Error("Missing motion frames");
  }

  const last = final.top;
  const intermediate = frames.filter(
    (frame) => Math.abs(frame.top - first) > EPSILON && Math.abs(frame.top - last) > EPSILON
  );
  expect(Math.abs(last - first)).toBeGreaterThan(10);
  expect(new Set(intermediate.map((frame) => frame.top)).size).toBeGreaterThan(2);
  expect(frames.some((frame) => frame.phase === "smooth")).toBe(true);
  expect(Math.abs(final.gap)).toBeLessThan(EPSILON);
}

test("bottom disclosure settling is independent, smooth, interruptible and shares activity timing", async ({
  page,
}) => {
  const state = history();
  const writes = await mount(page, state);
  await settled(page);
  const icon = page.locator('[data-slot="trace-collapsible-trigger"] [data-slot="trace-icon"]');
  await expect(icon).toHaveCSS("transition-duration", `${ACTIVITY_MOTION.duration / 1000}s`);
  await expect(icon).toHaveCSS("transition-timing-function", ACTIVITY_MOTION.easing);
  let samples = record(page);
  await page.getByRole("button", { name: "Show activity", exact: true }).click();
  const expanded = await samples;
  expectAnimated(expanded);
  expect(expanded.every((frame) => frame.outerGap < 1)).toBe(true);
  const fullHeight = Math.max(...expanded.map((frame) => frame.panel));
  expect(
    expanded.filter((frame) => frame.panel > EPSILON && frame.panel < fullHeight - EPSILON).length
  ).toBeGreaterThan(2);
  const panel = page.locator('[data-slot="trace-collapsible-content"]');
  await expect(panel).toHaveCSS("transition-property", "height");
  await expect(panel).toHaveCSS("transition-duration", `${ACTIVITY_MOTION.duration / 1000}s`);
  const trigger = expanded.find((frame) => frame.phase === "disclosure");
  const smooth = expanded.filter((frame) => frame.phase === "smooth");
  expect(trigger).toBeDefined();
  expect(smooth[0].t - (trigger?.t ?? 0)).toBeGreaterThan(16);
  expect((smooth.at(-1)?.t ?? 0) - smooth[0].t).toBeGreaterThan(100);
  expect((smooth.at(-1)?.t ?? 0) - smooth[0].t).toBeLessThan(300);
  await settled(page);
  samples = record(page);
  await page.getByRole("button", { name: "Hide activity", exact: true }).click();
  const collapsed = await samples;
  expectAnimated(collapsed);
  expect(collapsed.every((frame) => frame.outerGap < 1)).toBe(true);
  await settled(page);
  const canvas = page.locator(".transcript > div");
  await expect(canvas).toHaveCSS("min-height", "0px");

  for (const name of ["Show activity", "Hide activity", "Show activity"]) {
    await page.getByRole("button", { name, exact: true }).dispatchEvent("click");
    await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
  }

  await settled(page);
  await expect(page.getByRole("button", { name: "Hide activity", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
  await expect(canvas).toHaveCSS("min-height", "0px");
  expect(writes).toEqual([]);
});

test("streaming coalesces motion, local sends return smoothly, and user scrolling wins", async ({ page }, info) => {
  const state = history();
  const writes = await mount(page, state);
  await settled(page);
  const stream = { id: "stream", type: "agentMessage", text: "Starting" };
  state.turns.push({ id: "stream-turn", status: "inProgress", items: [stream] });
  const samples = record(page, ACTIVITY_MOTION.duration * 6);
  await publish(page, state);

  for (let index = 0; index < 35; index++) {
    stream.text += `\n\nStreaming paragraph ${index}.`;
    await publish(page, state);
    await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
  }

  const frames = await samples;
  const starts = frames.filter((frame, index) => frame.phase === "smooth" && frames[index - 1]?.phase !== "smooth");
  expect(starts.length).toBeLessThanOrEqual(1);
  await settled(page);
  await page.locator(viewport).evaluate((element) => {
    element.dispatchEvent(new globalThis.WheelEvent("wheel", { bubbles: true, deltaY: -500 }));
    element.scrollTop -= 500;
  });
  const saved = await page.locator(viewport).evaluate((element) => element.scrollTop);
  stream.text += "\n\nBackground stream. ".repeat(10);
  await publish(page, state);
  await expect
    .poll(async () => Math.abs((await page.locator(viewport).evaluate((element) => element.scrollTop)) - saved))
    .toBeLessThan(EPSILON);
  const returning = record(page);
  state.queue = [{ id: "own-send", text: "New local user send", status: "sending" }];
  await publish(page, state);
  await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
  stream.text += "\n\nMore output during the send transition.";
  await publish(page, state);
  expectAnimated(await returning);
  await settled(page);
  await page.locator(viewport).evaluate((element) => {
    element.dispatchEvent(new globalThis.WheelEvent("wheel", { bubbles: true, deltaY: -800 }));
    element.scrollTop = element.scrollHeight * 0.25;
  });
  await page.evaluate(
    () => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)))
  );
  const longJump = record(page);
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  const jumping = await longJump;
  await writeFile(
    `.local/scroll-motion-${info.project.name}.json`,
    JSON.stringify({ streaming: frames, jump: jumping })
  );
  expectAnimated(jumping);
  expect(jumping.every((frame) => frame.covered)).toBe(true);
  await settled(page);
  await page.locator(viewport).evaluate((element) => {
    element.dispatchEvent(new globalThis.WheelEvent("wheel", { bubbles: true, deltaY: -800 }));
    element.scrollTop -= 800;
  });
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await expect(page.locator(viewport)).toHaveAttribute("data-scroll-motion", "smooth");
  await page.locator(viewport).evaluate((element) => {
    element.dispatchEvent(new globalThis.WheelEvent("wheel", { bubbles: true, deltaY: -300 }));
    element.scrollTop -= 300;
  });
  const stopped = await page.locator(viewport).evaluate((element) => element.scrollTop);
  const interrupted = await record(page);
  expect(Math.max(...interrupted.map((frame) => Math.abs(frame.top - stopped)))).toBeLessThan(EPSILON);
  expect(writes).toEqual([]);
});

test("image and viewport growth settle at bottom, and reduced motion stays instant", async ({ page }) => {
  const state = history();
  await mount(page, state);
  await settled(page);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const image = await readFile("public/icon-192.png");
  await page.route("**/api/images?item=motion*", async (route) => {
    await promise;
    await route.fulfill({ contentType: "image/png", body: image });
  });
  state.turns.push({
    id: "image-turn",
    status: "inProgress",
    items: [
      {
        id: "image-growth",
        type: "agentMessage",
        text: "",
        images: [{ source: "/api/images?item=motion", alt: "Motion image" }],
      },
    ],
  });
  await publish(page, state);
  await settled(page);
  const growth = record(page);
  resolve(true);
  await expect(page.getByRole("img", { name: "Motion image", exact: true })).toHaveJSProperty("complete", true);
  expectAnimated(await growth);
  await settled(page);
  const original = page.viewportSize();

  if (!original) {
    throw new Error("Missing viewport dimensions");
  }

  const resize = record(page);
  await page.setViewportSize({ width: original.width, height: original.height - 160 });
  expectAnimated(await resize);
  await settled(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Show activity", exact: true }).click();
  await settled(page);
  const reduced = record(page);
  // Expansion can move the focused trigger above the shrunken viewport.
  await expect(page.getByRole("button", { name: "Hide activity", exact: true })).toBeFocused();
  await page.keyboard.press("Space");
  const frames = await reduced;
  expect(frames.some((frame) => frame.phase === "smooth")).toBe(false);
  await settled(page);
});
