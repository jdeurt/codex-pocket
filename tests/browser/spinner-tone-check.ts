import { type Page, expect, test } from "@playwright/test";
import { TONAL_BANDS, createTonalFixtures } from "../fixtures/spinner-tonal-images";
import { readFile, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import path from "node:path";
import sharp from "sharp";
import { type spinnerClient } from "../fixtures/spinner-client";

const BACKGROUND = 33;
const BAND_SAMPLE_X = 8;
const BAND_WIDTH = 3.5;
const CHANNEL_MAX = 255;
const OPACITY = 0.7;
const HALF_ALPHA = 128;
const OPAQUE_SAMPLE_Y = 10;
const ALPHA_SAMPLE_Y = 20;
const PIXEL_TOLERANCE = 3;
const ALPHA_TOLERANCE = 4;
const MIN_PIXEL = 40;
const MAX_PIXEL = 155;
const BAND_COUNT = 4;
const SUBTLE_SPAN = 12;
const FULL_SPAN = 40;
const PALETTE_COUNT = 3;
const LAST_SAMPLE = -1;

/**
Checks image-derived contrast and alpha composition against rendered native spinner pixels.
@param page - Browser showing the active spinner.
@param main - Real stdio MCP client bound to private spinner storage.
@param directory - Private fixture and database directory.
@param label - Evidence label distinguishing the rendered viewport.
@param capture - Actual slot screenshot operation for the mounted browser.
@returns Completion of palette, tonal-band, alpha and original-byte assertions.
*/
export async function checkSpinnerTone(
  page: Page,
  main: Awaited<ReturnType<typeof spinnerClient>>,
  directory: string,
  label: string,
  capture: () => Promise<Buffer>
) {
  const fixtures = await createTonalFixtures(directory);
  const transforms = new Set<string>();
  const dismiss = page.getByRole("button", { name: "Dismiss notification prompt", exact: true });

  // The prompt's shadow reaches the composer row; isolate the image's own tonal response.
  if ((await dismiss.count()) > 0) {
    await dismiss.click();
  }

  for (const [name, bands] of Object.entries(TONAL_BANDS)) {
    const levels = Object.values(bands);
    const { current, tone } = await test.step(`Select and validate ${name} image-derived tone`, async () => {
      const selected = await main.call("spinner_set", { path: fixtures[name] });
      const asset = selected.current;
      const derived = asset?.tone;

      if (!asset || !derived) {
        throw new Error("Set must persist an image-derived tone.");
      }

      return { current: asset, tone: derived };
    });

    const bytes = await test.step(`Wait for the rendered ${name} spinner before capturing pixels`, async () => {
      transforms.add(JSON.stringify(tone));
      await expect(page.locator("[data-activity-spinner] img")).toHaveAttribute("src", `/api/spinner/${current.id}`);
      await page.waitForFunction((id) => {
        const img = globalThis.document.querySelector<HTMLImageElement>("[data-activity-spinner] img");

        const SPINNER_EDGE = 32;

        return img?.complete && img.naturalWidth === SPINNER_EDGE && img.currentSrc.includes(id);
      }, current.id);

      return await capture();
    });

    const { data, info } = await test.step(`Retain and decode ${name} pixel evidence`, async () => {
      await writeFile(`.local/spinner-tone-${label}-${name}.png`, bytes);

      return await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    });
    const value = (x: number, y: number) => data[(y * info.width + x) * info.channels];

    const opaque: number[] = [];

    const response =
      await test.step(`Require ${name} tonal bands and alpha before requesting original bytes`, async () => {
        expect(value(0, 0)).toBe(BACKGROUND);

        for (const [band, level] of levels.entries()) {
          const x = Math.round(BAND_SAMPLE_X + band * BAND_WIDTH);
          const normalized = tone.contrast * level + tone.brightness * CHANNEL_MAX;
          const expected = BACKGROUND + OPACITY * (normalized - BACKGROUND);
          const halfAlpha = BACKGROUND + OPACITY * (HALF_ALPHA / CHANNEL_MAX) * (normalized - BACKGROUND);
          const pixel = value(x, OPAQUE_SAMPLE_Y);

          expect(Math.abs(pixel - expected)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
          // SVG filtering and alpha compositing round at multiple 8-bit boundaries, especially in WebKit.
          expect(Math.abs(value(x, ALPHA_SAMPLE_Y) - halfAlpha)).toBeLessThanOrEqual(ALPHA_TOLERANCE);
          expect(pixel).toBeGreaterThan(MIN_PIXEL);
          expect(pixel).toBeLessThan(MAX_PIXEL);
          opaque.push(pixel);
        }

        expect(new Set(opaque).size).toBe(BAND_COUNT);
        expect((opaque.at(LAST_SAMPLE) ?? 0) - opaque[0]).toBeGreaterThanOrEqual(
          name === "subtle" ? SUBTLE_SPAN : FULL_SPAN
        );

        return await page.request.get(`/api/spinner/${current.id}`);
      });

    expect(await response.body()).toEqual(await readFile(fixtures[name]));
  }

  expect(transforms.size).toBe(PALETTE_COUNT);
}

/**
Checks that reading a legacy asset backfills its missing persisted tone.
@param main - Real stdio MCP client bound to private spinner storage.
@param directory - Private database directory.
@param id - Existing asset whose persisted tone is removed for migration replay.
@param url - Isolated asset route triggering the native backfill.
@returns Native asset response after the migration request.
*/
export async function checkLegacyTone(
  main: Awaited<ReturnType<typeof spinnerClient>>,
  directory: string,
  id: string,
  url: string
) {
  const before = await main.call("spinner_status");
  const database = new Database(path.join(directory, "spinners.sqlite"));

  const legacy = await test.step("Remove persisted tone from the existing native asset", async () => {
    try {
      database.prepare("UPDATE spinner_assets SET tone=NULL WHERE id=?").run(id);
    } finally {
      database.close();
    }

    return await main.call("spinner_status");
  });

  const response = await test.step("Require the legacy null tone before requesting its native asset", async () => {
    expect(legacy.current?.tone).toBeNull();

    return await fetch(url);
  });
  const upgraded = await main.call("spinner_status");

  expect(upgraded.current?.tone).toEqual(before.current?.tone);

  return response;
}
