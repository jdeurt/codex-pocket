import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import { alignment, animatedGrayscale, captureSlot } from "./spinner-helpers";
import { readFile, rm } from "node:fs/promises";
import { SPINNER_ORIGIN } from "../fixtures/browser-defaults";
import { checkSpinnerTone } from "./spinner-tone-check";
import path from "node:path";
import sharp from "sharp";
import { type spinnerClient } from "../fixtures/spinner-client";

const SOURCE_GIF_WIDTH = 128;
const SLOT_EDGE = 32;
const STATIC_CAPTURE_DELAY_MS = 150;
const WIDE_IMAGE_WIDTH = 160;
const BACKGROUND_TOLERANCE = 3;
const MIN_RENDERED_ROWS = 7;
const MAX_RENDERED_ROWS = 9;
const HTTP_NOT_FOUND = 404;

/**
Opens the isolated spinner app and waits for its actual activity slot.
@param page - Browser bound to the private spinner server.
@returns Completion of the visible-slot assertion.
*/
async function ready(page: Page) {
  await page.goto(SPINNER_ORIGIN, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-activity-spinner]")).toBeVisible();
}

/**
Verify actual GIF frames, reduction, reset, image fit and tonal rendering in one private browser context.
@param context - Private browser context closed by the outer replay.
@param main - Native MCP client bound to the isolated spinner state.
@param uploaded - Original GIF input retained throughout the replay.
@param id - Managed GIF identity restored after each viewport.
@param label - Browser and viewport evidence label.
@returns Completion of rendering, persistence and alignment assertions.
*/
export async function checkSpinnerViewport(
  context: BrowserContext,
  main: Awaited<ReturnType<typeof spinnerClient>>,
  uploaded: string,
  id: string,
  label: string
) {
  const page = await context.newPage();
  const slot = page.locator("[data-activity-spinner]");

  const customPosition = await test.step("Load the managed GIF and require decoded native dimensions", async () => {
    await page.bringToFront();
    await ready(page);

    await expect(slot.locator("img")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const image = globalThis.document.querySelector<HTMLImageElement>("[data-activity-spinner] img");

          return image?.complete ? image.naturalWidth : 0;
        })
      )
      .toBe(SOURCE_GIF_WIDTH);

    return await alignment(page);
  });

  const still =
    await test.step("Verify animation, reload and reduced-motion fallback before capturing a still frame", async () => {
      expect(customPosition.slot.width).toBe(SLOT_EDGE);
      expect(customPosition.slot.height).toBe(SLOT_EDGE);
      await animatedGrayscale(page);
      await page.screenshot({ path: `.local/spinner-${label}.png` });
      await page.reload();
      await expect(slot.locator("img")).toBeVisible();
      expect(await alignment(page)).toEqual(customPosition);

      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(slot.locator("img")).toHaveCount(0);
      await expect(slot.locator('svg[data-slot="spinner"]')).toBeVisible();
      expect(
        await page.evaluate(() => {
          const arc = globalThis.document.querySelector("[data-activity-spinner] .spinner-arc");

          return arc ? globalThis.getComputedStyle(arc).animationName : "missing";
        })
      ).toBe("none");

      return await captureSlot(page);
    });

  const spinnerLibrary7 = await test.step("Verify the still frame and reset without shifting the slot", async () => {
    await new Promise((resolve) => setTimeout(resolve, STATIC_CAPTURE_DELAY_MS));
    expect(await captureSlot(page)).toEqual(still);
    expect(await alignment(page)).toEqual(customPosition);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(slot.locator("img")).toBeVisible();

    await main.call("spinner_reset");
    await expect(slot.locator("img")).toHaveCount(0);
    await expect(slot.locator('svg[data-slot="spinner"]')).toBeVisible();
    expect(await alignment(page)).toEqual(customPosition);
    expect(
      await page.evaluate(() => {
        const svg = globalThis.document.querySelector("[data-activity-spinner] svg");

        return svg ? globalThis.getComputedStyle(svg).transform : "missing";
      })
    ).toBe("none");

    return await main.call("spinner_status");
  });

  const wide = await test.step("Require the saved GIF after reset and restore its native selection", async () => {
    expect(spinnerLibrary7.saved.some((asset) => asset.id === id)).toBe(true);
    await main.call("spinner_set", { path: uploaded });
    await expect(slot.locator("img")).toBeVisible();

    return path.join(path.dirname(uploaded), "wide.png");
  });

  const { data, info } =
    await test.step("Require contained wide-image geometry before decoding the rendered slot", async () => {
      await sharp({ create: { width: 160, height: 40, channels: 3, background: "red" } })
        .png()
        .toFile(wide);
      await main.call("spinner_set", { path: wide });
      await expect
        .poll(() =>
          page.evaluate(
            () => globalThis.document.querySelector<HTMLImageElement>("[data-activity-spinner] img")?.naturalWidth
          )
        )
        .toBe(WIDE_IMAGE_WIDTH);
      expect(
        await page.evaluate(() => {
          const image = globalThis.document.querySelector("[data-activity-spinner] img");

          return image ? globalThis.getComputedStyle(image).objectFit : "missing";
        })
      ).toBe("contain");
      expect(await alignment(page)).toEqual(customPosition);

      return await sharp(await captureSlot(page))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    });

  const background = data[0];
  const rows = Array.from(
    { length: info.height },
    (_, row) => data[(row * info.width + Math.floor(info.width / 2)) * info.channels]
  );

  expect(rows.filter((value) => Math.abs(value - background) > BACKGROUND_TOLERANCE).length).toBeGreaterThanOrEqual(
    MIN_RENDERED_ROWS
  );
  expect(rows.filter((value) => Math.abs(value - background) > BACKGROUND_TOLERANCE).length).toBeLessThanOrEqual(
    MAX_RENDERED_ROWS
  );
  await checkSpinnerTone(page, main, path.dirname(uploaded), label, () => captureSlot(page));
  expect(await alignment(page)).toEqual(customPosition);
  await main.call("spinner_set", { path: uploaded });
  await expect(slot.locator("img")).toHaveAttribute("src", `/api/spinner/${id}`);
}

/**
Verify missing managed bytes fall back without shifting after the private server restarts.
@param page - Browser page closed by the outer replay.
@param main - Native MCP client retaining the private database.
@param id - Selected managed asset removed from private storage.
@param url - Private asset route for conditional revalidation.
@param etag - Validator issued before the managed bytes were removed.
@param uploaded - Original user file that must remain intact.
@returns Completion of fallback, deletion, route and original-byte assertions.
*/
export async function checkMissingSpinner(
  page: Page,
  main: Awaited<ReturnType<typeof spinnerClient>>,
  id: string,
  url: string,
  etag: string,
  uploaded: string
) {
  const slot = page.locator("[data-activity-spinner]");

  const position = await test.step("Require the selected GIF after private server restart", async () => {
    await ready(page);

    await expect(slot.locator("img")).toHaveAttribute("src", `/api/spinner/${id}`);

    return await alignment(page);
  });

  await rm(path.join(path.dirname(uploaded), "spinner-assets", id));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(slot.locator('svg[data-slot="spinner"]')).toBeVisible();
  await expect(slot.locator("img")).toHaveCount(0);
  expect(await alignment(page)).toEqual(position);
  await main.call("spinner_delete", { id });
  await expect(slot.locator("img")).toHaveCount(0);
  await expect(slot.locator('svg[data-slot="spinner"]')).toBeVisible();
  expect(await alignment(page)).toEqual(position);
  expect(await fetch(url, { headers: { "if-none-match": etag } })).toHaveProperty("status", HTTP_NOT_FOUND);
  expect(await readFile(uploaded)).toEqual(await readFile(path.resolve("tests/fixtures/spinners/kirbyjam.gif")));
}
