import { type Page, expect, test } from "@playwright/test";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";

const CAPTURE_FRAMES = 7;
const RGB_CHANNELS = 3;
const MIN_BRIGHTNESS = 50;
const MAX_BRIGHTNESS = 230;
const FRAME_INTERVAL_MS = 70;

export async function alignment(page: Page) {
  return page.evaluate(() => {
    const row = globalThis.document.querySelector(".activity-indicator");

    if (!row) {
      throw new Error("Missing activity row.");
    }

    const spinner = row.querySelector("[data-activity-spinner]");
    const text = row.querySelector(":scope > span:last-child");

    if (!spinner || !text) {
      throw new Error("Missing spinner or activity label.");
    }

    const slot = spinner.getBoundingClientRect();
    const label = text.getBoundingClientRect();

    return {
      slot: { x: slot.x, y: slot.y, width: slot.width, height: slot.height },
      label: { x: label.x, y: label.y },
      rowHeight: row.getBoundingClientRect().height,
    };
  });
}

export async function captureSlot(page: Page) {
  const clip = await page.evaluate(() => {
    const rect = globalThis.document.querySelector("[data-activity-spinner]")?.getBoundingClientRect();

    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  });

  if (!clip) {
    throw new Error("Spinner must be visible for pixel inspection.");
  }

  // Viewport capture avoids Playwright's element-autoscroll stability wait inside Safari's live scroller.
  return page.screenshot({ clip, timeout: 10_000 });
}

export async function animatedGrayscale(page: Page) {
  const transfer = page.locator("[data-activity-spinner] feFuncR");

  expect(await page.locator("[data-activity-spinner] img").getAttribute("style")).toContain("url(");
  const frames = new Set<string>();
  const readTone = () => Promise.all([transfer.getAttribute("slope"), transfer.getAttribute("intercept")]);
  const transform = await readTone();

  for (let index = 0; index < CAPTURE_FRAMES; index++) {
    const bytes = await captureSlot(page);

    await writeFile(`.local/spinner-frame-${test.info().project.name}-${String(index)}.png`, bytes);
    const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });

    let brightest = 0;
    let maximumChroma = 0;

    for (let pixel = 0; pixel < data.length; pixel += info.channels) {
      const channels = data.subarray(pixel, pixel + RGB_CHANNELS);

      maximumChroma = Math.max(maximumChroma, Math.max(...channels) - Math.min(...channels));
      brightest = Math.max(brightest, data[pixel]);
    }

    expect(maximumChroma).toBeLessThanOrEqual(2);
    expect(brightest).toBeGreaterThan(MIN_BRIGHTNESS);
    expect(brightest).toBeLessThan(MAX_BRIGHTNESS);
    frames.add(data.toString("base64"));
    expect(await readTone()).toEqual(transform);
    await new Promise((resolve) => setTimeout(resolve, FRAME_INTERVAL_MS));
  }

  expect(frames.size).toBeGreaterThan(2);
}
