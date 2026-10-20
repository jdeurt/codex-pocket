import { type Locator, type Page, expect } from "@playwright/test";
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

async function bounds(image: Locator) {
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  const box = await image.boundingBox();

  if (!box) {
    throw new Error("Image bounds are unavailable");
  }

  return box;
}

async function swipeDown(page: Page) {
  const popup = page.getByRole("dialog");
  const box = await bounds(popup.locator("img"));
  const client = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2;
  const startY = box.y + box.height / START_FRACTION;
  const DISTANCE = 400;
  const STEPS = 8;

  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: startY }],
  });

  for (let step = 1; step <= STEPS; step += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: startY + (DISTANCE * step) / STEPS }],
    });
  }

  await expect(popup).toHaveAttribute("data-swiping", "");
  const offset = await popup.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42);

  expect(offset).toBeGreaterThan(DISTANCE / 2);
  const dismissal = popup.evaluate(
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

  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(popup).toHaveCount(0);
  expect(await dismissal).toBeGreaterThan(offset);
  await client.detach();
}

async function checkImagePage(page: Page, browserName: string, portrait: string, landscape: string) {
  const markdown = `IMAGES_BEFORE\n\n![Portrait one](${portrait}) ![Portrait two](${portrait})\n\n![Landscape](${landscape})\n\nIMAGES_AFTER`;
  const first = page.getByRole("img", { name: "Portrait one", exact: true });
  const second = page.getByRole("img", { name: "Portrait two", exact: true });
  const wide = page.getByRole("img", { name: "Landscape", exact: true });
  const paragraph = page.getByText("IMAGES_BEFORE", { exact: true });
  const preview = page.getByRole("dialog", { name: "Portrait one", exact: true });
  const close = page.getByRole("button", { name: "Close image preview", exact: true });

  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await send(
    page,
    `Reply with exactly the following Markdown, no code fence or extra text. Do not use tools.\n\n${markdown}`
  );

  await expect(page.getByText("IMAGES_AFTER", { exact: true })).toBeVisible();
  const a = await bounds(first);
  const b = await bounds(second);
  const landscapeBox = await bounds(wide);

  expect(Math.abs(a.width / a.height - 1 / 2)).toBeLessThan(RATIO_TOLERANCE);
  expect(Math.abs(landscapeBox.width / landscapeBox.height - 2)).toBeLessThan(RATIO_TOLERANCE);
  expect(Math.abs(a.y - b.y)).toBeLessThan(1);
  expect(b.x - a.x - a.width).toBe(IMAGE_GAP);
  const frame = first.locator("xpath=../..");

  await expect(frame).toHaveCSS("border-width", "0px");
  await expect(frame).toHaveCSS("box-shadow", "none");
  const frameBox = await frame.boundingBox();

  expect(frameBox?.width).toBe(a.width);
  expect(frameBox?.height).toBe(a.height);
  const before = await paragraph.boundingBox();

  expect(before?.x).toBe(a.x);
  expect(Math.round(a.y - (before?.y ?? 0) - (before?.height ?? 0))).toBe(IMAGE_GAP);
  await page.setViewportSize({ width: NARROW_WIDTH, height: PHONE_HEIGHT });
  const narrowFirst = await bounds(first);
  const narrowSecond = await bounds(second);

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
  const full = await bounds(preview.locator("img"));

  expect(full.x).toBeGreaterThanOrEqual(0);
  expect(full.y).toBeGreaterThanOrEqual(0);
  expect(full.x + full.width).toBeLessThanOrEqual(PHONE_WIDTH);
  expect(full.y + full.height).toBeLessThanOrEqual(PHONE_HEIGHT);
  const closeBox = await close.boundingBox();

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

export async function checkImagePreviews(page: Page, browserName: string) {
  const PORTRAIT_WIDTH = 600;
  const LONG_EDGE = 1200;

  await mkdir(".local", { recursive: true });
  const directory = await mkdtemp(path.resolve(".local", "image-fixtures-"));
  const portrait = path.join(directory, "portrait.png");
  const landscape = path.join(directory, "landscape.png");

  try {
    await sharp({ create: { width: PORTRAIT_WIDTH, height: LONG_EDGE, channels: 3, background: "#7d9990" } })
      .png()
      .toFile(portrait);
    await sharp({ create: { width: LONG_EDGE, height: PORTRAIT_WIDTH, channels: 3, background: "#998b7d" } })
      .png()
      .toFile(landscape);
    await checkImagePage(page, browserName, portrait, landscape);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
