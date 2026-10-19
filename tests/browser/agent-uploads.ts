import { type Page, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { replayImage } from "../fixtures/agent-browser-data";

const directory = ".local/agent-browser-screenshots";
const storageKey = "replay:attachment-opens";
const MOBILE_WIDTH = 390;
const NARROW_WIDTH = 320;
const DESKTOP_WIDTH = 1440;

async function headers(page: Page) {
  const measurements = [];
  await mkdir(directory, { recursive: true });

  for (const width of [NARROW_WIDTH, MOBILE_WIDTH, DESKTOP_WIDTH]) {
    await page.setViewportSize({ width, height: 1000 });
    const header = page.locator("main > .chat-header");
    await expect(header.locator("svg, .brand")).toHaveCount(0);
    await expect(header.getByRole("heading", { name: "Pocket", exact: true })).toBeVisible();
    const offset = await header.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const title = element.querySelector(".thread-heading")?.getBoundingClientRect();

      if (!title) {
        throw new Error("Header heading is missing.");
      }

      return Math.abs(box.left + box.width / 2 - (title.left + title.width / 2));
    });
    expect(offset).toBeLessThan(1);
    measurements.push({ width, offset });
    await page.screenshot({ path: `${directory}/header-upload-${width}.png`, animations: "disabled" });
  }

  await writeFile(`${directory}/header-upload-measurements.json`, JSON.stringify(measurements));
}

export async function checkAgentUploads(page: Page) {
  await page.addInitScript((key) => {
    const open = globalThis.indexedDB.open.bind(globalThis.indexedDB);
    globalThis.indexedDB.open = (...args) => {
      if (args[0] === "pocket-attachments") {
        globalThis.sessionStorage.setItem(key, String(Number(globalThis.sessionStorage.getItem(key) ?? 0) + 1));
      }

      return open(...args);
    };
  }, storageKey);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Attach images or files", exact: true })).toBeEnabled();
  const draft = "Keep this parent draft and selected image";
  await page.getByRole("textbox", { name: "Message Pocket" }).fill(draft);
  const name = "parent-navigation.png";
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: "image/png",
    buffer: Buffer.from(replayImage.split(",", 2)[1], "base64"),
  });
  const selected = page.getByRole("list", { name: "Selected attachments" });
  await expect(selected.getByText("Ready to send", { exact: true })).toBeVisible();
  await expect(selected.getByText(name, { exact: true })).toBeVisible();
  await expect(selected.getByRole("img")).toHaveCount(0);
  await headers(page);
  const opens = await page.evaluate((key) => globalThis.sessionStorage.getItem(key), storageKey);
  const actions: string[] = [];
  page.on("request", (request) => {
    if (!["GET", "HEAD"].includes(request.method()) && !request.url().includes("/api/logs")) {
      actions.push(request.url());
    }
  });
  await page.getByRole("button", { name: "6 agents", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });
  await dialog.getByRole("button", { name: /Codex Side Pocket/ }).click();
  await expect(dialog.getByText("Replay child wants approval. This is informative only.")).toBeVisible();
  await expect(dialog.locator('input[type="file"], textarea, form')).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: /Attach|Upload|Send|Approve|Decline|Interrupt|Resume/i })
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Back to agents", exact: true }).click();
  await dialog.getByRole("button", { name: "Back to Pocket", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue(draft);
  await expect(selected.getByText(name, { exact: true })).toBeVisible();
  await expect(selected.getByText("Ready to send", { exact: true })).toBeVisible();
  expect(await page.evaluate((key) => globalThis.sessionStorage.getItem(key), storageKey)).toBe(opens);
  expect(actions).toEqual([]);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue(draft);
  await expect(selected.getByText("Ready to send", { exact: true })).toBeVisible();
}
