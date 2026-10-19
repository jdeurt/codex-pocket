/* eslint-disable @typescript-eslint/no-magic-numbers -- Explicit source levels and composited pixel expectations are the integration fixture. */
import { type Page, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { createTonalFixtures } from "../fixtures/spinner-tonal-images";
import path from "node:path";
import sharp from "sharp";
import type { spinnerClient } from "../fixtures/spinner-client";

export async function checkSpinnerTone(
  page: Page,
  main: Awaited<ReturnType<typeof spinnerClient>>,
  directory: string,
  label: string,
  capture: () => Promise<Buffer>
) {
  const fixtures = await createTonalFixtures(directory);
  const transforms = new Set<string>();

  for (const [name, levels] of Object.entries({
    dark: [4, 16, 28, 40],
    bright: [216, 228, 240, 252],
    subtle: [112, 116, 120, 124],
  })) {
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

      return img?.complete && img.naturalWidth === 32 && img.currentSrc.includes(id);
    }, current.id);
    const bytes = await capture();
    await writeFile(`.local/spinner-tone-${label}-${name}.png`, bytes);
    const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const value = (x: number, y: number) => data[(y * info.width + x) * info.channels];
    expect(value(0, 0)).toBe(33);
    const opaque: number[] = [];

    for (const [band, level] of levels.entries()) {
      const x = 9 + band * 4;
      const normalized = tone.contrast * level + tone.brightness * 255;
      const expected = 33 + 0.7 * (normalized - 33);
      const halfAlpha = 33 + 0.7 * (128 / 255) * (normalized - 33);
      const pixel = value(x, 10);
      expect(Math.abs(pixel - expected)).toBeLessThanOrEqual(3);
      // SVG filtering and alpha compositing round at multiple 8-bit boundaries, especially in WebKit.
      expect(Math.abs(value(x, 20) - halfAlpha)).toBeLessThanOrEqual(4);
      expect(pixel).toBeGreaterThan(40);
      expect(pixel).toBeLessThan(155);
      opaque.push(pixel);
    }

    expect(new Set(opaque).size).toBe(4);
    expect((opaque.at(-1) ?? 0) - opaque[0]).toBeGreaterThanOrEqual(name === "subtle" ? 12 : 40);
    const response = await page.request.get(`/api/spinner/${current.id}`);
    expect(await response.body()).toEqual(await readFile(fixtures[name]));
  }

  expect(transforms.size).toBe(3);
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
