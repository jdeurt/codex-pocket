import { type Page, expect, test } from "@playwright/test";
import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { mkdir, writeFile } from "node:fs/promises";
import { mount, publish } from "./virtualization-fixture";
import path from "node:path";

const directory = path.resolve(".local/viewer-tests");
const guide = path.join(directory, "A deliberately long filename for a narrow phone readable document.md");
const state: Snapshot = {
  ...initialSnapshot,
  connection: "connected",
  threadId: "viewer-test",
  activeTurnId: "live",
  turns: [
    {
      id: "live",
      status: "inProgress",
      items: [{ id: "reply", type: "agentMessage", text: `[Open guide](<${guide}>)` }],
    },
  ],
};
const TOLERANCE = 1;
const ROWS = 150;
const HIT_TARGET = 44;
const HEADER_GAP = 8;

/**
Measure document and viewer geometry without relying on screenshots.
@param page - Browser displaying the real file overlay.
@returns Pixel measurements suitable for retained test evidence.
*/
async function viewerGeometry(page: Page) {
  return page.locator(".file-viewer").evaluate((element) => {
    const header = element.querySelector("header");
    const button = header?.querySelector("button")?.getBoundingClientRect();
    const heading = header?.querySelector("h1")?.getBoundingClientRect();

    return {
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      viewport: window.innerWidth,
      buttonWidth: button?.width ?? 0,
      buttonHeight: button?.height ?? 0,
      headingLeft: heading?.left ?? 0,
      buttonRight: button?.right ?? 0,
      centerOffset: button && heading ? (heading.top + heading.bottom - button.top - button.bottom) / 2 : Infinity,
    };
  });
}

test("file links preserve mounted chat, shared Markdown and measured header geometry", async ({ page }, info) => {
  const geometry = await test.step("Open the local document from the real chat", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(
      guide,
      '# Guide\n\nShared paragraph.\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n[Text](./note.txt)\n\n```pocket-copy\n"Copy me"\n```\n'
    );
    await writeFile(path.join(directory, "note.txt"), "Native text document");
    await mount(page, state);
    await page.route("**/api/files?*", (route) => route.continue());
    await page.getByRole("textbox", { name: "Message Pocket" }).fill("Draft retained through file navigation");
    await page.getByRole("link", { name: "Open guide" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Guide", exact: true })).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Copy/ })).toHaveCount(1);

    return viewerGeometry(page);
  });

  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + TOLERANCE);
  expect(geometry.width).toBe(geometry.viewport);
  expect(geometry.buttonWidth).toBeGreaterThanOrEqual(HIT_TARGET);
  expect(geometry.buttonHeight).toBeGreaterThanOrEqual(HIT_TARGET);
  expect(geometry.headingLeft - geometry.buttonRight).toBe(HEADER_GAP);
  expect(Math.abs(geometry.centerOffset)).toBeLessThanOrEqual(TOLERANCE);
  await info.attach("file-viewer-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
  await page.getByRole("link", { name: "Text", exact: true }).click();
  await expect(page.locator(".file-viewer iframe")).toBeVisible();
  await expect(page.frameLocator(".file-viewer iframe").locator("body")).toContainText("Native text document");
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.getByRole("heading", { name: "Guide", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue(
    "Draft retained through file navigation"
  );
});

test("streaming reveals only changed text and preserves selection and remounts without replaying animations", async ({
  page,
}, info) => {
  const stream = { id: "stream", type: "agentMessage", text: "Stable prefix " };
  const snapshot: Snapshot = {
    ...state,
    turns: [
      {
        id: "live",
        status: "inProgress",
        items: [
          ...Array.from({ length: ROWS }, (_, index) => ({
            id: `row-${String(index)}`,
            type: "agentMessage",
            text: `Earlier message ${String(index)}`,
          })),
          stream,
        ],
      },
    ],
  };

  const measurements = await test.step("Append only the new Markdown suffix", async () => {
    await mount(page, snapshot);
    await expect(page.locator("[data-pocket-fresh]")).toHaveCount(0);
    await page.locator("[data-message-id=stream] .markdown-paragraph").evaluate((element) => {
      const range = element.ownerDocument.createRange();

      range.selectNodeContents(element);
      globalThis.getSelection()?.removeAllRanges();
      globalThis.getSelection()?.addRange(range);
    });
    stream.text = "Stable prefix **new content**";
    await publish(page, snapshot);
    await expect(page.locator("[data-message-id=stream] [data-pocket-fresh]")).toHaveText("new content");
    await expect(page.locator("[data-message-id=stream]")).toHaveText("Stable prefix new content");
    expect(await page.evaluate(() => globalThis.getSelection()?.toString())).toBe("Stable prefix");
    await page.evaluate(() => globalThis.getSelection()?.removeAllRanges());

    return page.locator('[data-slot="message-scroller-viewport"]').evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      gap: element.scrollHeight - element.clientHeight - element.scrollTop,
    }));
  });

  expect(measurements.scrollWidth).toBeLessThanOrEqual(measurements.width + TOLERANCE);
  await info.attach("stream-layout", { body: JSON.stringify(measurements), contentType: "application/json" });
  await page.locator('[data-slot="message-scroller-viewport"]').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.locator("[data-message-id=stream]")).toHaveCount(0);
  await page.locator('[data-slot="message-scroller-viewport"]').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator("[data-message-id=stream]")).toBeVisible();
  expect(
    await page
      .locator("[data-message-id=stream]")
      .evaluate((element) => element.getAnimations({ subtree: true }).length)
  ).toBe(0);
  stream.text += "\n\n```js\nconst old = 1;\n```";
  await publish(page, snapshot);
  await expect(page.locator("[data-message-id=stream] pre [data-pocket-fresh]")).toHaveText("const old = 1;");
  stream.text = stream.text.replace("const old = 1;", "const old = 1;\nconst added = 2;");
  await publish(page, snapshot);
  await expect(page.locator("[data-message-id=stream] pre [data-pocket-fresh]")).toHaveText("const added = 2;");
  await expect(page.locator("[data-message-id=stream] pre")).toHaveText("const old = 1;\nconst added = 2;");
  await page.emulateMedia({ reducedMotion: "reduce" });
  stream.text = "Stable prefix **new content** and more";
  await publish(page, snapshot);
  await expect(page.locator("[data-message-id=stream]")).toContainText("and more");
  expect(
    await page
      .locator("[data-message-id=stream]")
      .evaluate((element) => element.getAnimations({ subtree: true }).length)
  ).toBe(0);
});
