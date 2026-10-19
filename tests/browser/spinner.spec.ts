/* eslint-disable unicorn/no-await-expression-member -- Flow assertions inspect sequential wire results inline. */
/* eslint-disable unicorn/no-top-level-assignment-in-function -- Playwright lifecycle hooks own the isolated server fixture. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- Flow assertions use explicit fixture dimensions, timings and HTTP statuses. */
import { type ChildProcess, spawn } from "node:child_process";
import { type Page, expect, test } from "@playwright/test";
import { checkLegacyTone, checkSpinnerTone } from "./spinner-tone-check";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createSpinnerSite } from "../fixtures/spinner-site";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { spinnerClient } from "../fixtures/spinner-client";

const origin = "http://127.0.0.1:3103";
let directory: string;
let project: string;
let host: ChildProcess | undefined;
let main: Awaited<ReturnType<typeof spinnerClient>>;
let output = "";

async function startServer() {
  output = "";
  host = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", project, "--hostname", "127.0.0.1", "--port", "3103"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "development",
        CODEX_THREAD_ID: "spinner-fixture",
        CODEX_CWD: directory,
        CODEX_POCKET_STATE_DIR: directory,
        CODEX_BINARY: process.execPath,
        CODEX_SERVER_ARGS: JSON.stringify([path.resolve("tests/fixtures/spinner-harness.mjs")]),
        CODEX_ALLOWED_ORIGINS: origin,
        POCKET_CHILD_ID: "",
        POCKET_COMMAND_ID: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  host.stdout?.on("data", (data) => {
    output += String(data);
  });
  host.stderr?.on("data", (data) => {
    output += String(data);
  });
  await expect
    .poll(
      async () => {
        if (host?.exitCode !== null) {
          throw new Error(output);
        }

        try {
          return (await fetch(`${origin}/api/spinner`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 90_000, message: "isolated Next dev fixture starts" }
    )
    .toBe(200);
}

async function stopServer() {
  if (host && host.exitCode === null) {
    const closed = once(host, "exit");
    host.kill("SIGTERM");
    await closed;
  }

  host = undefined;
}

test.beforeAll(async () => {
  await mkdir(".local", { recursive: true });
  directory = await mkdtemp(path.join(os.tmpdir(), "pocket-spinner-browser-"));
  project = process.cwd();

  if (test.info().project.name === "webkit") {
    // Safari's existing chat scroller can stall forced layouts. Verify this standalone feature
    // against the same Next routes/component/styles without changing that separately owned scroller.
    project = await createSpinnerSite();
  }

  main = await spinnerClient(directory);
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  await writeFile(`.local/spinner-server-${test.info().project.name}.log`, output);
  await main?.client.close();
  await rm(directory, { recursive: true, force: true });

  if (project !== process.cwd()) {
    await rm(project, { recursive: true, force: true });
  }
});

async function ready(page: Page) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-activity-spinner]")).toBeVisible();
}

async function alignment(page: Page) {
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

async function captureSlot(page: Page) {
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

async function animatedGrayscale(page: Page) {
  expect(await page.locator("[data-activity-spinner] img").getAttribute("style")).toContain("url(");
  const frames = new Set<string>();
  const transfer = page.locator("[data-activity-spinner] feFuncR");
  const readTone = () => Promise.all([transfer.getAttribute("slope"), transfer.getAttribute("intercept")]);
  const transform = await readTone();

  for (let index = 0; index < 7; index++) {
    const bytes = await captureSlot(page);
    await writeFile(`.local/spinner-frame-${test.info().project.name}-${index}.png`, bytes);
    const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let brightest = 0;
    let maximumChroma = 0;

    for (let pixel = 0; pixel < data.length; pixel += info.channels) {
      const channels = data.subarray(pixel, pixel + 3);
      maximumChroma = Math.max(maximumChroma, Math.max(...channels) - Math.min(...channels));
      brightest = Math.max(brightest, data[pixel]);
    }

    expect(maximumChroma).toBeLessThanOrEqual(2);
    expect(brightest).toBeGreaterThan(50);
    expect(brightest).toBeLessThan(230);
    frames.add(data.toString("base64"));
    expect(await readTone()).toEqual(transform);
    await new Promise((resolve) => setTimeout(resolve, 70));
  }

  expect(frames.size).toBeGreaterThan(2);
}

test("tool-managed GIF animates in grayscale across desktop/mobile, persists through restart, and resets without shifting", async ({
  browser,
  browserName,
}) => {
  const uploaded = path.join(directory, "private-upload-kirby.gif");
  await copyFile(path.resolve("tests/fixtures/spinners/kirbyjam.gif"), uploaded);
  const chosen = await main.call("spinner_set", { path: uploaded });

  if (!chosen.current) {
    throw new Error("Expected custom spinner selection.");
  }

  const id = chosen.current.id;
  const url = `${origin}/api/spinner/${id}`;
  const response = await checkLegacyTone(main, directory, id, url);
  const etag = response.headers.get("etag");

  if (!etag) {
    throw new Error("Managed asset must have an ETag.");
  }

  expect(response.headers.get("content-type")).toBe("image/gif");
  expect(response.headers.get("cache-control")).toBe("private, no-cache");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(uploaded));
  expect((await fetch(url, { headers: { "if-none-match": etag } })).status).toBe(304);
  expect((await fetch(url, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(404);
  expect((await fetch(`${origin}/api/spinner/not-a-managed-id`)).status).toBe(404);
  expect((await fetch(`${origin}/api/spinner?path=${encodeURIComponent(uploaded)}`, { method: "POST" })).status).toBe(
    405
  );
  const publicPreference = await (await fetch(`${origin}/api/spinner`)).text();
  expect(publicPreference).not.toContain(directory);
  expect(publicPreference).not.toContain("private-upload");
  expect(publicPreference).not.toContain("saved");

  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1100, height: 800 },
      isMobile: mobile,
      hasTouch: mobile,
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
        .toBe(128);
      const customPosition = await alignment(page);
      expect(customPosition.slot.width).toBe(32);
      expect(customPosition.slot.height).toBe(32);
      await animatedGrayscale(page);
      await page.screenshot({ path: `.local/spinner-${browserName}-${mobile ? "phone" : "desktop"}.png` });
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
      await new Promise((resolve) => setTimeout(resolve, 150));
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
      expect((await main.call("spinner_status")).saved.some((asset) => asset.id === id)).toBe(true);
      await main.call("spinner_set", { path: uploaded });
      await expect(slot.locator("img")).toBeVisible();

      const wide = path.join(directory, "wide.png");
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
        .toBe(160);
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
      expect(rows.filter((value) => Math.abs(value - background) > 3).length).toBeGreaterThanOrEqual(7);
      expect(rows.filter((value) => Math.abs(value - background) > 3).length).toBeLessThanOrEqual(9);
      await checkSpinnerTone(page, main, directory, `${browserName}-${mobile ? "phone" : "desktop"}`, () =>
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
  await stopServer();
  await startServer();
  expect((await main.call("spinner_status")).current?.id).toBe(id);
  const page = await browser.newPage({ reducedMotion: "no-preference" });

  try {
    await ready(page);
    const slot = page.locator("[data-activity-spinner]");
    await expect(slot.locator("img")).toHaveAttribute("src", `/api/spinner/${id}`);
    const position = await alignment(page);
    await rm(path.join(directory, "spinner-assets", id));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(slot.locator('svg[data-slot="spinner"]')).toBeVisible();
    await expect(slot.locator("img")).toHaveCount(0);
    expect(await alignment(page)).toEqual(position);
    await main.call("spinner_delete", { id });
    await expect(slot.locator("img")).toHaveCount(0);
    await expect(slot.locator('svg[data-slot="spinner"]')).toBeVisible();
    expect(await alignment(page)).toEqual(position);
    expect((await fetch(url, { headers: { "if-none-match": etag } })).status).toBe(404);
    expect(await readFile(uploaded)).toEqual(await readFile(path.resolve("tests/fixtures/spinners/kirbyjam.gif")));
  } finally {
    await page.close();
  }
});
