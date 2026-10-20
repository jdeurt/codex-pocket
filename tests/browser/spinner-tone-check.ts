import { type Page, expect } from "@playwright/test";
import { TONAL_BANDS, createTonalFixtures } from "../fixtures/spinner-tonal-images";
import { readFile, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import path from "node:path";
import sharp from "sharp";
import { type spinnerClient } from "../fixtures/spinner-client";

const BACKGROUND = 33;
const BAND_SAMPLE_X = 9;
const BAND_WIDTH = 4;
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

export async function checkSpinnerTone(
  page: Page,
  main: Awaited<ReturnType<typeof spinnerClient>>,
  directory: string,
  label: string,
  capture: () => Promise<Buffer>
) {
  const fixtures = await createTonalFixtures(directory);
  const transforms = new Set<string>();

  for (const [name, bands] of Object.entries(TONAL_BANDS)) {
    const levels = Object.values(bands);
    const selected = await main.call("spinner_set", { path: fixtures[name] });
    const current = selected.current;

    if (!current?.tone) {
      throw new Error("Set must persist an image-derived tone.");
    }

    const tone = current.tone;
    transforms.add(JSON.stringify(tone));
    await expect(page.locator("[data-activity-spinner] img")).toHaveAttribute("src", `/api/spinner/${current.id}`);
    await page.waitForFunction((id) => {
      const img = globalThis.document.querySelector<HTMLImageElement>("[data-activity-spinner] img");

      const SPINNER_EDGE = 32;

      return img?.complete && img.naturalWidth === SPINNER_EDGE && img.currentSrc.includes(id);
    }, current.id);
    const bytes = await capture();
    await writeFile(`.local/spinner-tone-${label}-${name}.png`, bytes);
    const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const value = (x: number, y: number) => data[(y * info.width + x) * info.channels];
    expect(value(0, 0)).toBe(BACKGROUND);
    const opaque: number[] = [];

    for (const [band, level] of levels.entries()) {
      const x = BAND_SAMPLE_X + band * BAND_WIDTH;
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
    const response = await page.request.get(`/api/spinner/${current.id}`);
    expect(await response.body()).toEqual(await readFile(fixtures[name]));
  }

  expect(transforms.size).toBe(PALETTE_COUNT);
}

export async function checkLegacyTone(
  main: Awaited<ReturnType<typeof spinnerClient>>,
  directory: string,
  id: string,
  url: string
) {
  const before = await main.call("spinner_status");
  const database = new Database(path.join(directory, "spinners.sqlite"));
  database.prepare("UPDATE spinner_assets SET tone=NULL WHERE id=?").run(id);
  database.close();
  const legacy = await main.call("spinner_status");
  expect(legacy.current?.tone).toBeNull();
  const response = await fetch(url);
  const upgraded = await main.call("spinner_status");
  expect(upgraded.current?.tone).toEqual(before.current?.tone);

  return response;
}
