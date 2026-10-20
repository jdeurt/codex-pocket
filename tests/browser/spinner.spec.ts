import { type Page, expect, test } from "@playwright/test";
import { type SpinnerServer, startSpinnerServer, stopSpinnerServer } from "../fixtures/spinner-server";
import { alignment, animatedGrayscale, captureSlot } from "./spinner-helpers";
import { checkLegacyTone, checkSpinnerTone } from "./spinner-tone-check";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { SPINNER_ORIGIN } from "../fixtures/browser-defaults";
import assert from "node:assert/strict";
import { createSpinnerSite } from "../fixtures/spinner-site";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { spinnerClient } from "../fixtures/spinner-client";

const HTTP_NOT_MODIFIED = 304;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const SOURCE_GIF_WIDTH = 128;
const SLOT_EDGE = 32;
const STATIC_CAPTURE_DELAY_MS = 150;
const WIDE_IMAGE_WIDTH = 160;
const BACKGROUND_TOLERANCE = 3;
const MIN_RENDERED_ROWS = 7;
const MAX_RENDERED_ROWS = 9;

const origin = SPINNER_ORIGIN;
const server: SpinnerServer = { directory: "", project: "", output: "" };

test.beforeAll(async ({ browserName }) => {
  await mkdir(".local", { recursive: true });
  server.directory = await mkdtemp(path.join(os.tmpdir(), "pocket-spinner-browser-"));
  server.project = process.cwd();

  if (browserName === "webkit") {
    // Safari's existing chat scroller can stall forced layouts. Verify this standalone feature
    // against the same Next routes/component/styles without changing that separately owned scroller.
    server.project = await createSpinnerSite();
  }

  server.main = await spinnerClient(server.directory);
  await startSpinnerServer(server, origin);
});

test.afterAll(async () => {
  await stopSpinnerServer(server);
  await writeFile(`.local/spinner-server-${test.info().project.name}.log`, server.output);
  await server.main?.client.close();
  await rm(server.directory, { recursive: true, force: true });

  if (server.project !== process.cwd()) {
    await rm(server.project, { recursive: true, force: true });
  }
});

async function ready(page: Page) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-activity-spinner]")).toBeVisible();
}

test("tool-managed GIF animates in grayscale across desktop/mobile, persists through restart, and resets without shifting", async ({
  browser,
  browserName,
}) => {
  const main = server.main;

  assert.ok(main);
  const uploaded = path.join(server.directory, "private-upload-kirby.gif");

  await copyFile(path.resolve("tests/fixtures/spinners/kirbyjam.gif"), uploaded);
  const chosen = await main.call("spinner_set", { path: uploaded });

  if (!chosen.current) {
    throw new Error("Expected custom spinner selection.");
  }

  const id = chosen.current.id;
  const url = `${origin}/api/spinner/${id}`;
  const response = await checkLegacyTone(main, server.directory, id, url);
  const etag = response.headers.get("etag");

  if (!etag) {
    throw new Error("Managed asset must have an ETag.");
  }

  expect(response.headers.get("content-type")).toBe("image/gif");
  expect(response.headers.get("cache-control")).toBe("private, no-cache");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(uploaded));
  const response2 = await fetch(url, { headers: { "if-none-match": etag } });

  expect(response2.status).toBe(HTTP_NOT_MODIFIED);
  const response3 = await fetch(url, { headers: { "sec-fetch-site": "cross-site" } });

  expect(response3.status).toBe(HTTP_NOT_FOUND);
  const response4 = await fetch(`${origin}/api/spinner/not-a-managed-id`);

  expect(response4.status).toBe(HTTP_NOT_FOUND);
  const response5 = await fetch(`${origin}/api/spinner?path=${encodeURIComponent(uploaded)}`, { method: "POST" });

  expect(response5.status).toBe(HTTP_METHOD_NOT_ALLOWED);
  const response6 = await fetch(`${origin}/api/spinner`);
  const publicPreference = await response6.text();

  expect(publicPreference).not.toContain(server.directory);
  expect(publicPreference).not.toContain("private-upload");
  expect(publicPreference).not.toContain("saved");

  for (const isMobile of [false, true]) {
    const context = await browser.newContext({
      viewport: isMobile ? { width: 390, height: 844 } : { width: 1100, height: 800 },
      isMobile: isMobile,
      hasTouch: isMobile,
      reducedMotion: "no-preference",
    });
    const page = await context.newPage();

    await page.bringToFront();

    try {
      await ready(page);
      const slot = page.locator("[data-activity-spinner]");
      const img = slot.locator("img");

      await expect(img).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const image = globalThis.document.querySelector<HTMLImageElement>("[data-activity-spinner] img");

            return image?.complete ? image.naturalWidth : 0;
          })
        )
        .toBe(SOURCE_GIF_WIDTH);
      const customPosition = await alignment(page);

      expect(customPosition.slot.width).toBe(SLOT_EDGE);
      expect(customPosition.slot.height).toBe(SLOT_EDGE);
      await animatedGrayscale(page);
      await page.screenshot({ path: `.local/spinner-${browserName}-${isMobile ? "phone" : "desktop"}.png` });
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
      const still = await captureSlot(page);

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
      const spinnerLibrary7 = await main.call("spinner_status");

      expect(spinnerLibrary7.saved.some((asset) => asset.id === id)).toBe(true);
      await main.call("spinner_set", { path: uploaded });
      await expect(slot.locator("img")).toBeVisible();

      const wide = path.join(server.directory, "wide.png");

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
      const { data, info } = await sharp(await captureSlot(page))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
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
      await checkSpinnerTone(page, main, server.directory, `${browserName}-${isMobile ? "phone" : "desktop"}`, () =>
        captureSlot(page)
      );
      expect(await alignment(page)).toEqual(customPosition);
      await main.call("spinner_set", { path: uploaded });
      await expect(slot.locator("img")).toHaveAttribute("src", `/api/spinner/${id}`);
    } finally {
      await context.close();
    }
  }

  // Restart the real Next process, retaining only this test's private state and fake harness.
  await stopSpinnerServer(server);
  await startSpinnerServer(server, origin);
  const spinnerLibrary8 = await main.call("spinner_status");

  expect(spinnerLibrary8.current?.id).toBe(id);
  const page = await browser.newPage({ reducedMotion: "no-preference" });

  try {
    await ready(page);
    const slot = page.locator("[data-activity-spinner]");

    await expect(slot.locator("img")).toHaveAttribute("src", `/api/spinner/${id}`);
    const position = await alignment(page);

    await rm(path.join(server.directory, "spinner-assets", id));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(slot.locator('svg[data-slot="spinner"]')).toBeVisible();
    await expect(slot.locator("img")).toHaveCount(0);
    expect(await alignment(page)).toEqual(position);
    await main.call("spinner_delete", { id });
    await expect(slot.locator("img")).toHaveCount(0);
    await expect(slot.locator('svg[data-slot="spinner"]')).toBeVisible();
    expect(await alignment(page)).toEqual(position);
    const response9 = await fetch(url, { headers: { "if-none-match": etag } });

    expect(response9.status).toBe(HTTP_NOT_FOUND);
    expect(await readFile(uploaded)).toEqual(await readFile(path.resolve("tests/fixtures/spinners/kirbyjam.gif")));
  } finally {
    await page.close();
  }
});
