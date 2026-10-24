import { type Page, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { readSnapshot } from "../../scripts/read-snapshot";
import { send } from "./messages";
import sharp from "sharp";
import { snapshotSchema } from "../../src/lib/protocol";

/**
Find the prompted native turn in a validated live snapshot stream.
@param stream - Response stream after the route supplied an SSE body.
@param prompt - Exact sent user prompt identifying the turn.
@returns Current native turn status if present.
*/
async function matchingTurnStatus(stream: ReadableStream<Uint8Array>, prompt: string) {
  const state = snapshotSchema.parse(await readSnapshot(stream));
  const current = state.turns.find((entry) =>
    entry.items.some((item) => item.type === "userMessage" && JSON.stringify(item.content).includes(prompt))
  );

  return current?.status;
}

/**
Waits for a prompted live turn to finish and leave no active activity row.
@param page - Browser connected to the explicitly opted-in live harness.
@param prompt - Exact sent prompt identifying the rendered turn.
@returns Rendered completed turn locator.
*/
async function completedTurn(page: Page, prompt: string) {
  const turn = page
    .locator('[data-slot="message-scroller-item"]')
    .filter({ has: page.getByText(prompt, { exact: true }) });

  const activity = turn.getByRole("button", { name: "Show activity", exact: true });

  await send(page, prompt);

  await expect(turn.locator('[data-delivery="sent"]')).toBeVisible();
  await expect
    .poll(async () => {
      const response = await fetch("http://127.0.0.1:3101/api/events");

      if (!response.body) {
        throw new Error("Pocket did not return a snapshot stream.");
      }

      return await matchingTurnStatus(response.body, prompt);
    })
    .toBe("completed");

  if (await activity.count()) {
    await activity.click();
  }

  return turn;
}

/**
Exercise original-path, tool-output and deliberately repeated images in the opted-in live session.
@param page - Browser connected to the explicitly enabled live harness.
@param file - Private generated image removed by the outer fixture.
@returns Completion of image rendering and reload assertions.
*/
async function checkImageDelivery(page: Page, file: string) {
  const WIDTH = 240;
  const HEIGHT = 120;
  const localPrompt = `Show me this image: ${file}`;
  const local = await test.step("Create and share the original native image", async () => {
    await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: "#db761c" } })
      .png()
      .toFile(file);
    await page.goto("/");
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();

    return await completedTurn(page, localPrompt);
  });
  const toolPrompt = `Use the view_image tool to inspect ${file}, then briefly describe its color.`;
  const tool = await completedTurn(page, toolPrompt);

  const repeatPrompt = `Show me two copies of ${file} together in one message.`;
  const repeated = await test.step("Require one image per request before deliberate repeats", async () => {
    for (const [turn, source] of [
      [local, /\/api\/images\?(?:path|item)=/],
      [tool, /\/api\/images\?item=/],
    ] as const) {
      await expect(turn.locator("img")).toHaveCount(1);
      await expect
        .poll(() => turn.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBeGreaterThan(0);
      await expect(turn.locator("img")).toHaveAttribute("src", source);
    }

    return await completedTurn(page, repeatPrompt);
  });

  await expect(repeated.locator("img")).toHaveCount(2);
  await page.reload();

  for (const [prompt, count] of [
    [localPrompt, 1],
    [toolPrompt, 1],
    [repeatPrompt, 2],
  ] as const) {
    const turn = page
      .locator('[data-slot="message-scroller-item"]')
      .filter({ has: page.getByText(prompt, { exact: true }) });
    const activity = turn.getByRole("button", { name: "Show activity", exact: true });

    if (await activity.count()) {
      await activity.click();
    }

    await expect(turn.locator("img")).toHaveCount(count);
  }

  await page.screenshot({ path: ".local/image-delivery-mobile.png", fullPage: true });
}

test("real Codex shares each requested image once and preserves deliberate repeats", async ({ page }) => {
  const directory = await test.step("Create private image-delivery inputs", async () => {
    await mkdir(".local", { recursive: true });

    return await mkdtemp(path.resolve(".local", "image-delivery-"));
  });
  const file = path.join(directory, "logo.png");

  await (async () => checkImageDelivery(page, file))().finally(async () => {
    await rm(directory, { recursive: true, force: true });
  });
});
