import { type Page, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { readSnapshot } from "../../scripts/read-snapshot";
import { send } from "./messages";
import sharp from "sharp";
import { snapshotSchema } from "../../src/lib/protocol";

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

  await send(page, prompt);

  await expect(turn.locator('[data-delivery="sent"]')).toBeVisible();
  await expect
    .poll(async () => {
      const response = await fetch("http://127.0.0.1:3101/api/events");

      if (!response.body) {
        throw new Error("Pocket did not return a snapshot stream.");
      }

      const state = snapshotSchema.parse(await readSnapshot(response.body));
      const current = state.turns.find((entry) =>
        entry.items.some((item) => item.type === "userMessage" && JSON.stringify(item.content).includes(prompt))
      );

      return current?.status;
    })
    .toBe("completed");
  const activity = turn.getByRole("button", { name: "Show activity", exact: true });

  if (await activity.count()) {
    await activity.click();
  }

  return turn;
}

test("real Codex shares each requested image once and preserves deliberate repeats", async ({ page }) => {
  const WIDTH = 240;
  const HEIGHT = 120;

  await mkdir(".local", { recursive: true });
  const directory = await mkdtemp(path.resolve(".local", "image-delivery-"));
  const file = path.join(directory, "logo.png");

  try {
    await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: "#db761c" } })
      .png()
      .toFile(file);
    await page.goto("/");
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    const localPrompt = `Show me this image: ${file}`;
    const local = await completedTurn(page, localPrompt);
    const toolPrompt = `Use the view_image tool to inspect ${file}, then briefly describe its color.`;
    const tool = await completedTurn(page, toolPrompt);

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

    const repeatPrompt = `Show me two copies of ${file} together in one message.`;
    const repeated = await completedTurn(page, repeatPrompt);

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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
