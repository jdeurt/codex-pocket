import { type CDPSession, type Locator, type Page, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { send } from "./messages";
import sharp from "sharp";

const TOUCH_TARGET = 44;
const PHONE_WIDTH = 390;
const NARROW_WIDTH = 320;
const PHONE_HEIGHT = 844;
const IMAGE_GAP = 16;
const RATIO_TOLERANCE = 0.01;
const START_FRACTION = 4;
const DRAG_DISTANCE = 400;
const DRAG_STEPS = 8;

/**
Waits for decoded native image dimensions before requiring actual browser geometry.
@param image - Rendered image whose intrinsic content must be loaded.
@returns Non-null image bounding box.
*/
async function bounds(image: Locator) {
  const box = await test.step("Decode the native image before measuring browser bounds", async () => {
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);

    return await image.boundingBox();
  });

  if (!box) {
    throw new Error("Image bounds are unavailable");
  }

  return box;
}

/**
Dispatch native touch movement and require the preview's dragging state.
@param client - Native Chromium debugging session owned by the swipe fixture.
@param popup - Actual open image dialog.
@param x - Horizontal touch coordinate.
@param startY - Initial vertical touch coordinate.
@returns Observed vertical transform after the drag.
*/
async function dragPreview(client: CDPSession, popup: Locator, x: number, startY: number) {
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: startY }],
  });

  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: startY + (DRAG_DISTANCE * step) / DRAG_STEPS }],
    });
  }

  await expect(popup).toHaveAttribute("data-swiping", "");

  return await popup.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42);
}

/**
Require a real drag before observing the dialog's remaining dismissal trajectory.
@param popup - Dialog still connected during the native touch gesture.
@param offset - Actual transform sampled before touch release.
@returns Furthest observed transform once the dialog disconnects.
*/
function observeDismissal(popup: Locator, offset: number) {
  expect(offset).toBeGreaterThan(DRAG_DISTANCE / 2);

  return popup.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        let furthest = 0;

        const sample = () => {
          furthest = Math.max(furthest, new DOMMatrixReadOnly(getComputedStyle(element).transform).m42);

          if (element.isConnected) {
            requestAnimationFrame(sample);
          } else {
            resolve(furthest);
          }
        };

        sample();
      })
  );
}

/**
Release a real native drag and verify continued animated movement before the dialog disappears.
@param client - Native debugging session released by the outer swipe fixture.
@param popup - Open native image dialog.
@param x - Horizontal touch coordinate.
@param startY - Initial vertical touch coordinate.
@returns Completion of dismissal and movement assertions.
*/
async function releasePreviewDrag(client: CDPSession, popup: Locator, x: number, startY: number) {
  const offset = await dragPreview(client, popup, x, startY);
  const dismissal = observeDismissal(popup, offset);

  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(popup).toHaveCount(0);
  expect(await dismissal).toBeGreaterThan(offset);
}

/**
Exercises native Chromium touch dismissal while measuring the actual animated displacement.
@param page - Browser showing an open image preview.
@returns Completion of dismissal and movement assertions.
*/
async function swipeDown(page: Page) {
  const popup = page.getByRole("dialog");
  const box = await bounds(popup.locator("img"));
  const client = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2;
  const startY = box.y + box.height / START_FRACTION;

  await releasePreviewDrag(client, popup, x, startY).finally(async () => {
    await client.detach();
  });
}

/**
Checks original Markdown image layout, previews and reload persistence in the live workflow.
@param page - Browser connected to the explicitly opted-in live harness.
@param browserName - Playwright browser engine determining native touch support.
@param portrait - Absolute generated portrait fixture path.
@param landscape - Absolute generated landscape fixture path.
@returns Completion of the existing image layout and interaction assertions.
*/
async function checkImagePage(page: Page, browserName: string, portrait: string, landscape: string) {
  const markdown = `IMAGES_BEFORE\n\n![Portrait one](${portrait}) ![Portrait two](${portrait})\n\n![Landscape](${landscape})\n\nIMAGES_AFTER`;
  const first = page.getByRole("img", { name: "Portrait one", exact: true });
  const second = page.getByRole("img", { name: "Portrait two", exact: true });
  const wide = page.getByRole("img", { name: "Landscape", exact: true });
  const paragraph = page.getByText("IMAGES_BEFORE", { exact: true });
  const preview = page.getByRole("dialog", { name: "Portrait one", exact: true });
  const close = page.getByRole("button", { name: "Close image preview", exact: true });

  const frame = first.locator("xpath=../..");
  const { a, b, landscapeBox } = await test.step("Send original Markdown and measure decoded images", async () => {
    await page.goto("/");
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await send(
      page,
      `Reply with exactly the following Markdown, no code fence or extra text. Do not use tools.\n\n${markdown}`
    );

    await expect(page.getByText("IMAGES_AFTER", { exact: true })).toBeVisible();

    return { a: await bounds(first), b: await bounds(second), landscapeBox: await bounds(wide) };
  });

  const frameBox = await test.step("Require original image aspect ratios, sibling gaps and frame styling", async () => {
    expect(Math.abs(a.width / a.height - 1 / 2)).toBeLessThan(RATIO_TOLERANCE);
    expect(Math.abs(landscapeBox.width / landscapeBox.height - 2)).toBeLessThan(RATIO_TOLERANCE);
    expect(Math.abs(a.y - b.y)).toBeLessThan(1);
    expect(b.x - a.x - a.width).toBe(IMAGE_GAP);

    await expect(frame).toHaveCSS("border-width", "0px");
    await expect(frame).toHaveCSS("box-shadow", "none");

    return await frame.boundingBox();
  });

  const before =
    await test.step("Require the image frame to fit its content before measuring the preceding paragraph", async () => {
      expect(frameBox?.width).toBe(a.width);
      expect(frameBox?.height).toBe(a.height);

      return await paragraph.boundingBox();
    });

  const { narrowFirst, narrowSecond } =
    await test.step("Require outer spacing before measuring narrow-screen wrapping", async () => {
      expect(before?.x).toBe(a.x);
      expect(Math.round(a.y - (before?.y ?? 0) - (before?.height ?? 0))).toBe(IMAGE_GAP);
      await page.setViewportSize({ width: NARROW_WIDTH, height: PHONE_HEIGHT });

      return { narrowFirst: await bounds(first), narrowSecond: await bounds(second) };
    });

  const full = await test.step("Verify narrow wrapping then open the original fitted preview", async () => {
    expect(narrowSecond.y).toBeGreaterThan(narrowFirst.y + narrowFirst.height);
    expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBe(NARROW_WIDTH);
    await page.setViewportSize({ width: PHONE_WIDTH, height: PHONE_HEIGHT });
    await page.screenshot({ path: ".local/image-previews-mobile.png" });
    await page.getByRole("button", { name: "Preview image: Portrait one", exact: true }).click();

    await expect(preview).toBeVisible();
    await expect
      .poll(() => preview.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42))
      .toBe(0);
    await expect(preview).toHaveCSS("border-radius", "24px");

    return await bounds(preview.locator("img"));
  });

  const closeBox =
    await test.step("Require the full image inside the viewport before measuring its close control", async () => {
      expect(full.x).toBeGreaterThanOrEqual(0);
      expect(full.y).toBeGreaterThanOrEqual(0);
      expect(full.x + full.width).toBeLessThanOrEqual(PHONE_WIDTH);
      expect(full.y + full.height).toBeLessThanOrEqual(PHONE_HEIGHT);

      return await close.boundingBox();
    });

  expect(closeBox?.width).toBeGreaterThanOrEqual(TOUCH_TARGET);
  expect(closeBox?.height).toBeGreaterThanOrEqual(TOUCH_TARGET);
  await page.screenshot({ path: ".local/image-viewer-mobile.png" });

  if (browserName === "chromium") {
    await swipeDown(page);
  } else {
    await close.click();
    await expect(preview).toHaveCount(0);
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Preview image: Landscape", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCSS("transition-duration", "0s");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(first).toBeVisible();
  await bounds(first);
}

/**
Creates private portrait/landscape inputs and removes them after the live preview workflow.
@param page - Browser connected to the explicitly opted-in live harness.
@param browserName - Playwright browser engine used for native interaction selection.
@returns Completion of the workflow and private image cleanup.
*/
export async function checkImagePreviews(page: Page, browserName: string) {
  const PORTRAIT_WIDTH = 600;
  const LONG_EDGE = 1200;

  const directory = await test.step("Create private image layout inputs", async () => {
    await mkdir(".local", { recursive: true });

    return await mkdtemp(path.resolve(".local", "image-fixtures-"));
  });
  const portrait = path.join(directory, "portrait.png");
  const landscape = path.join(directory, "landscape.png");

  await Promise.try(() =>
    sharp({ create: { width: PORTRAIT_WIDTH, height: LONG_EDGE, channels: 3, background: "#7d9990" } })
      .png()
      .toFile(portrait)
  )
    .then(() =>
      sharp({ create: { width: LONG_EDGE, height: PORTRAIT_WIDTH, channels: 3, background: "#998b7d" } })
        .png()
        .toFile(landscape)
    )
    .then(() => checkImagePage(page, browserName, portrait, landscape))
    .finally(() => rm(directory, { recursive: true, force: true }));
}
