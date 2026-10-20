import { expect, test } from "@playwright/test";
import { expectAnchor, hasVisibleCoverage, scrollToFraction, settledAnchor, viewport } from "./virtualization-measure";
import { mount, publish } from "./virtualization-fixture";
import { readFile, writeFile } from "node:fs/promises";
import { type Snapshot } from "../../src/lib/protocol";
import { history } from "../fixtures/virtualized-history";

const MIN_MOUNTED_ROWS = 150;
const SCROLL_STOPS = {
  middle: 0.5,
  nearStart: 0.02,
  nearEnd: 0.95,
  upper: 0.25,
  lower: 0.75,
  start: 0,
  end: 1,
  center: 0.4,
};
const WHEEL_DELTA = 5000;
const ACTIVITY_STOPS = { upper: 0.1, lower: 0.8, nearStart: 0.05, nearEnd: 0.9, top: 0.3, bottom: 0.6 };
const PREPEND_FRACTION = 0.55;
const PREPEND_COUNT = 100;
const STREAM_CHUNKS = 8;
const STREAM_PARAGRAPHS = 5;
const STEER_PARAGRAPHS = 30;
const END_TOLERANCE = 40;
const QUEUED_LINES = 100;
const OFFSET_TOLERANCE = 3;
const HISTORY_COUNT = 140;
const PARENT_SCROLL_FRACTION = 0.4;
const APPEND_COUNT = 30;

const LAST_MOUNTED_ROW = -1;
const MAX_MOUNTED_ROWS = 250;
const row = "[data-transcript-row]";

test("large single-turn history stays bounded through rapid scrollbar, wheel and keyboard scrolling", async ({
  page,
}, info) => {
  const writes = await mount(page, history());
  const mounted: number[] = [];

  await expect(page.locator('[data-message-id="message-1199"]')).toBeVisible();
  expect(await page.locator(row).count()).toBeGreaterThanOrEqual(MIN_MOUNTED_ROWS);
  expect(await page.locator(row).count()).toBeLessThan(MAX_MOUNTED_ROWS);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("Unsent parent draft");

  for (const fraction of Object.values(SCROLL_STOPS)) {
    await scrollToFraction(page, fraction);
    mounted.push(await page.locator(row).count());
    expect(mounted.at(LAST_MOUNTED_ROW)).toBeLessThan(MAX_MOUNTED_ROWS);
  }

  await page.locator(viewport).hover();

  if (info.project.use.browserName === "webkit" && info.project.use.isMobile) {
    await page.locator(viewport).evaluate((element) => {
      element.scrollBy({ top: -5000, behavior: "auto" });
    });
  } else {
    await page.mouse.wheel(0, -WHEEL_DELTA);
  }

  await expect.poll(() => hasVisibleCoverage(page)).toBe(true);
  await page.locator(viewport).focus();
  await page.keyboard.press("PageUp");
  await expect.poll(() => hasVisibleCoverage(page)).toBe(true);
  // Consecutive scrollbar teleports without waiting for layout between jumps.
  await page.locator(viewport).evaluate(async (element, stops) => {
    for (const part of stops) {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * part;
      await new Promise(globalThis.requestAnimationFrame);
    }
  }, Object.values(ACTIVITY_STOPS));
  await expect.poll(() => hasVisibleCoverage(page)).toBe(true);
  await page.screenshot({ path: `.local/virtualization-${info.project.name}-history.png` });
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await expect(page.locator('[data-message-id="message-1199"]')).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("Unsent parent draft");
  expect(writes).toEqual([]);
  await info.attach("mounted-row-counts", { body: JSON.stringify(mounted), contentType: "application/json" });
  await writeFile(`.local/virtualization-${info.project.name}-counts.json`, JSON.stringify(mounted));
});

test("prepend, streaming, append and steering preserve the reader anchor and follow only at bottom", async ({
  page,
}, info) => {
  const state = history();
  const stream = { id: "stream", type: "agentMessage", text: "Streaming start" };
  const afterSteer = { id: "after-steer", type: "agentMessage", text: "After steering" };

  const initialAnchor = await test.step("Mount history and capture the native reader anchor", async () => {
    await mount(page, state);
    await scrollToFraction(page, PREPEND_FRACTION);

    return await settledAnchor(page);
  });
  const { promise: imageReady, resolve: releaseImage } =
    await test.step("Prepend history without moving the reader before deferring media", async () => {
      state.turns[0].items.unshift(...history(PREPEND_COUNT, -PREPEND_COUNT).turns[0].items);
      await publish(page, state);
      await expectAnchor(page, initialAnchor);

      return Promise.withResolvers<boolean>();
    });
  const delayedImage = await readFile("public/icon-192.png");

  const anchorIndex = await test.step("Install the delayed image response before locating the saved row", async () => {
    await page.route("**/api/images?item=anchor-growth*", async (route) => {
      await imageReady;
      await route.fulfill({ contentType: "image/png", body: delayedImage });
    });

    return state.turns[0].items.findIndex((item) => initialAnchor.id.endsWith(`/${item.id}`));
  });
  const anchor = await test.step("Capture reader position before releasing the deferred media bytes", async () => {
    try {
      state.turns[0].items[anchorIndex - 2].images = [
        { source: "/api/images?item=anchor-growth", alt: "Image above reader" },
      ];
      await publish(page, state);
      await expectAnchor(page, initialAnchor);
      // Let the size tree and initial scroll correction settle before pixels arrive.
      await settledAnchor(page);
      await settledAnchor(page);
      await page.locator(viewport).evaluate((element) => {
        element.scrollBy({ top: 200, behavior: "auto" });
      });

      return await settledAnchor(page);
    } finally {
      releaseImage(true);
    }
  });

  await expect(page.getByRole("img", { name: "Image above reader", exact: true })).toHaveJSProperty("complete", true);
  await expectAnchor(page, anchor);

  state.turns[0].items.push(stream);
  state.activeTurnId = state.turns[0].id;
  state.activity = "Inspecting virtualization fixture";
  await publish(page, state);
  await expectAnchor(page, anchor);
  await expect(page.getByRole("status", { name: "Pocket activity" })).toHaveText(state.activity);

  for (let index = 0; index < STREAM_CHUNKS; index++) {
    stream.text += "\n\nMore streaming text with **markdown**. ".repeat(STREAM_PARAGRAPHS);
    await publish(page, state);
  }

  await expectAnchor(page, anchor);
  state.turns[0].items.push({ id: "steer", type: "userMessage", content: [{ text: "Steer fixture" }] });
  await publish(page, state);
  await expectAnchor(page, anchor);
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await expect(page.locator('[data-message-id="steer"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toHaveCount(0);
  await expect
    .poll(() =>
      page.locator(viewport).evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
    )
    .toBeLessThan(END_TOLERANCE);

  state.turns[0].items.push(afterSteer);
  await publish(page, state);
  await expect(page.locator('[data-message-id="after-steer"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toHaveCount(0);
  await expect
    .poll(() =>
      page.locator(viewport).evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
    )
    .toBeLessThan(END_TOLERANCE);
  afterSteer.text += "\n\nFollow this growing response. ".repeat(STEER_PARAGRAPHS);
  await publish(page, state);
  await expect
    .poll(() =>
      page.locator(viewport).evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
    )
    .toBeLessThan(END_TOLERANCE);
  await page.screenshot({ path: `.local/virtualization-${info.project.name}-streaming.png` });
});

test("empty and short chats preserve drafts, activity, images, selection and reduced motion", async ({
  page,
}, info) => {
  const preview = page.getByRole("button", { name: "Preview image: Virtualized image" });
  const code = page.locator('[data-message-id="activity-final"] [data-slot="code-block-content"]');

  const state: Snapshot = { ...history(0), turns: [] };
  const anchor = await test.step("Retain the empty-chat draft through queue and short-history updates", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });

    await mount(page, state);
    await page.getByRole("textbox", { name: "Message Pocket" }).fill("Preserved first draft");
    state.queue = [{ id: "first-queued", text: "Queued first message.\n".repeat(QUEUED_LINES), status: "sending" }];
    await publish(page, state);
    await expect(page.locator('[data-message-id="first-queued"]')).toBeVisible();
    await expect
      .poll(() =>
        page.locator(viewport).evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
      )
      .toBeLessThan(OFFSET_TOLERANCE);
    state.queue = [];
    state.turns = history(HISTORY_COUNT).turns;
    await publish(page, state);
    await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("Preserved first draft");
    await expect(page.locator(row)).toHaveCount(HISTORY_COUNT);
    await scrollToFraction(page, PARENT_SCROLL_FRACTION);

    return await settledAnchor(page);
  });
  const scroller = await page.locator(viewport).elementHandle();

  state.turns[0].items.push(...history(APPEND_COUNT, HISTORY_COUNT).turns[0].items);
  await publish(page, state);
  await expectAnchor(page, anchor);
  expect(
    await scroller.evaluate(
      (element) => element === globalThis.document.querySelector('[data-slot="message-scroller-viewport"]')
    )
  ).toBe(true);
  state.turns[0].items.splice(HISTORY_COUNT);
  await publish(page, state);
  await expect(page.locator(row)).toHaveCount(HISTORY_COUNT);
  await expectAnchor(page, anchor);
  expect(
    await scroller.evaluate(
      (element) => element === globalThis.document.querySelector('[data-slot="message-scroller-viewport"]')
    )
  ).toBe(true);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("Preserved first draft");
  state.turns.push({
    id: "activity-turn",
    status: "completed",
    items: [
      { id: "activity-user", type: "userMessage", content: [{ text: "Activity fixture" }] },
      ...Array.from({ length: 700 }, (_, index) => ({
        id: `activity-${String(index)}`,
        type: "agentMessage",
        phase: "commentary",
        text: `Activity detail ${String(index)}\n\n${"Activity paragraph.\n\n".repeat(index % STREAM_PARAGRAPHS)}`,
      })),
      {
        id: "activity-final",
        type: "agentMessage",
        phase: "final_answer",
        text: "Final image\n\n![Virtualized image](/icon-192.png)\n\n```ts\nconst copyFixture = true;\n```",
      },
    ],
  });
  await publish(page, state);
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await page.getByRole("button", { name: "Show activity" }).click();
  await expect(page.getByRole("button", { name: "Hide activity" })).toHaveAttribute("aria-expanded", "true");
  expect(await page.locator(row).count()).toBeLessThan(MAX_MOUNTED_ROWS);
  await expect(page.locator('[data-message-id="activity-final"]')).toBeVisible();

  if (info.project.use.hasTouch) {
    await preview.tap();
  } else {
    await preview.click();
  }

  await expect(page.getByRole("button", { name: "Close image preview" })).toBeVisible();
  await page.getByRole("button", { name: "Close image preview" }).click();

  await code.focus();
  await expect(code).toBeFocused();
  await code.evaluate((element) => {
    const range = globalThis.document.createRange();

    range.selectNodeContents(element);
    globalThis.getSelection()?.removeAllRanges();
    globalThis.getSelection()?.addRange(range);
  });
  expect(await page.evaluate(() => globalThis.getSelection()?.toString())).toContain("copyFixture");
  await page.screenshot({ path: `.local/virtualization-${info.project.name}-image.png` });
  await scrollToFraction(page, 0);
  await scrollToFraction(page, 1);
  await expect(page.locator('[data-transcript-row="activity-turn/activity-699"]')).toBeVisible();
  expect(await page.locator(row).count()).toBeLessThan(MAX_MOUNTED_ROWS);
});
