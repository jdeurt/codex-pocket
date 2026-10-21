/* eslint-disable jdeurt/const-on-top, jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers, unicorn/isolated-functions -- Browser integration samples actual canvas pixels against rendered composer geometry. */
import { type Page, expect, test } from "@playwright/test";
import path from "node:path";
import { writeFile } from "node:fs/promises";

test.beforeEach(async () => writeFile(path.resolve(".local/realtime-fixture/control.json"), "{}"));

async function profile(page: Page) {
  return page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>(".composer");
    const spectrum = document.querySelector<HTMLElement>(".realtime-spectrum");
    const button = document.querySelector<HTMLElement>(".send-button");
    const canvas = spectrum?.querySelector("canvas");
    const context = canvas?.getContext("2d");

    if (!composer || !spectrum || !button || !canvas || !context) {
      throw new Error("Realtime spectrum is unavailable.");
    }

    const composerBox = composer.getBoundingClientRect();
    const spectrumBox = spectrum.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const scale = canvas.width / spectrumBox.width;
    const middleY = Math.floor(canvas.height / 2);
    const runs: { start: number; end: number }[] = [];
    const alpha = (x: number, y: number) => pixels[(y * canvas.width + x) * 4 + 3];

    let start = -1;

    for (let x = 0; x < canvas.width; x++) {
      if (alpha(x, middleY) > 100 && start < 0) {
        start = x;
      } else if (alpha(x, middleY) <= 100 && start >= 0) {
        runs.push({ start, end: x - 1 });
        start = -1;
      }
    }

    if (start >= 0) {
      runs.push({ start, end: canvas.width - 1 });
    }

    const bars = runs.map((run) => {
      const centerX = Math.floor((run.start + run.end) / 2);

      let top = canvas.height;
      let bottom = 0;

      for (let y = 0; y < canvas.height; y++) {
        if (alpha(centerX, y) <= 100) {
          continue;
        }

        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }

      return {
        left: run.start / scale,
        right: (run.end + 1) / scale,
        halfHeight: (bottom - top + 1) / (2 * scale),
      };
    });

    return {
      bars,
      radius: Math.min(
        composerBox.height / 2,
        Number(getComputedStyle(composer).borderTopLeftRadius.replace("px", ""))
      ),
      leftInset: spectrumBox.left - composerBox.left,
      rightGap: buttonBox.left - spectrumBox.right,
      spectrumWidth: spectrumBox.width,
      composerHeight: composerBox.height,
    };
  });
}

test("full frequency input follows the inset composer capsule at both waveform ends", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(AnalyserNode.prototype, "getByteFrequencyData", {
      configurable: true,
      value(data: Uint8Array) {
        data.fill(255);
      },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Send message; hold and swipe up/ })).toBeEnabled();
  const widths = test.info().project.name.includes("desktop") ? [768, 1280] : [320, 412];

  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    const start = page.getByRole("button", { name: "Start realtime voice" });

    await start.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
    await expect
      .poll(async () => {
        const result = await profile(page);

        return result.bars[16]?.halfHeight ?? 0;
      })
      .toBeGreaterThan(19);
    const shape = await profile(page);

    expect(shape.bars).toHaveLength(32);
    expect(shape.composerHeight).toBe(58);
    expect(shape.radius).toBe(29);
    expect(Math.abs(shape.leftInset - 17)).toBeLessThanOrEqual(0.75);
    expect(Math.abs(shape.rightGap - shape.leftInset)).toBeLessThanOrEqual(0.75);
    const middle = shape.bars[16].halfHeight;

    for (let index = 0; index < shape.bars.length; index++) {
      const bar = shape.bars[index];
      const distance = Math.min(shape.leftInset + bar.left, shape.leftInset + shape.spectrumWidth - bar.right);
      const capsule = distance >= shape.radius ? 1 : Math.sqrt(1 - (1 - distance / shape.radius) ** 2);
      const factor = capsule ** 2.45;

      expect(Math.abs(bar.halfHeight - middle * factor)).toBeLessThanOrEqual(0.75);
      expect(Math.abs(bar.halfHeight - shape.bars[shape.bars.length - 1 - index].halfHeight)).toBeLessThanOrEqual(0.5);
    }

    expect(shape.bars[0].halfHeight / middle).toBeLessThan(0.82);
    expect(shape.bars[0].halfHeight / middle).toBeGreaterThan(0.76);
    await page.getByRole("button", { name: "Stop realtime voice" }).click();
    await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/realtime");
        const info: unknown = await response.json();

        return typeof info === "object" && info !== null && "phase" in info ? info.phase : null;
      })
      .toBe("idle");
  }
});
