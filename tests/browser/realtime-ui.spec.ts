/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers, unicorn/isolated-functions, unicorn/consistent-function-scoping, unicorn/prefer-number-coercion -- Browser checks follow one complete gesture and conversation flow; computed CSS lengths include units. */
import { type Page, expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { dataSchema } from "../../src/lib/protocol";
import path from "node:path";

const origin = "http://127.0.0.1:3119";
const controlFile = path.resolve(".local/realtime-fixture/control.json");
const nativeLog = path.resolve(".local/realtime-fixture/provider.jsonl");

test.beforeEach(async () => writeFile(controlFile, "{}"));

async function openChat(page: Page) {
  await page.goto("/");
  const dismiss = page.getByRole("button", { name: "Dismiss notification prompt" });

  if (await dismiss.isVisible()) {
    await dismiss.click();
  }

  await expect(page.getByRole("button", { name: /Send message; hold and swipe up/ })).toBeEnabled();
}

async function countProvider(method: string) {
  const log = await readFile(nativeLog, "utf8");

  return log.split("\n").filter((line) => line.includes(`"method":"provider/realtime/${method}"`)).length;
}

const countStarts = () => countProvider("start");
const countStops = () => countProvider("stop");
const countAudio = () => countProvider("appendAudio");

async function cancelWithoutClick(page: Page) {
  const button = page.getByRole("button", { name: /Send message; hold and swipe up/ });
  const box = await button.boundingBox();

  if (!box) {
    throw new Error("Send button is missing.");
  }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await expect(page.locator(".voice-pill-track")).toBeVisible();
  await button.evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
    element.releasePointerCapture(1);
  });
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await expect(page.locator(".voice-pill-track")).toHaveCount(0);
}

async function waitForIdle(page: Page) {
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/realtime");
      const info: unknown = await response.json();

      return typeof info === "object" && info !== null && "phase" in info ? info.phase : null;
    })
    .toBe("idle");
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const composer = document.querySelector(".composer");
    const input = document.querySelector(".composer textarea, .composer .realtime-spectrum");
    const button = document.querySelector(".send-button");

    if (!composer || !input || !button) {
      throw new Error("Composer geometry is unavailable.");
    }

    const bounds = (element: Element) => {
      const box = element.getBoundingClientRect();

      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };

    return {
      composer: bounds(composer),
      input: bounds(input),
      button: bounds(button),
      textPaddingLeft: Number.parseFloat(getComputedStyle(input).paddingLeft),
      composerHeight: Number.parseFloat(getComputedStyle(composer).height),
    };
  });
}

function closeTo(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.75);
}

test("composer keeps text geometry through realtime at narrow and wide viewports", async ({ page }) => {
  await openChat(page);
  const widths = test.info().project.name.includes("desktop") ? [768, 1280] : [320, 412];

  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("textbox", { name: "Message Pocket" }).fill("unsent geometry draft\nsecond line");
    const normal = await geometry(page);
    const control = page.getByRole("button", { name: "Start realtime voice" });

    expect(normal.input.height).toBeGreaterThan(44);
    await control.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Stop realtime voice" })).toBeVisible();
    const voice = await geometry(page);
    const textInset = normal.input.x + normal.textPaddingLeft - normal.composer.x;

    await test.info().attach(`composer-geometry-${String(width)}`, {
      body: JSON.stringify({ normal, voice }),
      contentType: "application/json",
    });
    closeTo(voice.composer.x, normal.composer.x);
    expect(
      Math.abs(voice.composer.y - normal.composer.y),
      JSON.stringify({ width, normal, voice })
    ).toBeLessThanOrEqual(0.75);
    closeTo(voice.composer.width, normal.composer.width);
    closeTo(voice.composer.height, normal.composer.height);
    closeTo(voice.composerHeight, normal.composerHeight);
    closeTo(voice.input.x - voice.composer.x, textInset);
    closeTo(voice.button.x - voice.input.right, textInset);
    closeTo(voice.button.x, normal.button.x);
    closeTo(voice.button.y, normal.button.y);
    closeTo(voice.button.width, normal.button.width);
    closeTo(voice.button.height, normal.button.height);
    await page.getByRole("button", { name: "Stop realtime voice" }).click();
    await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue(
      "unsent geometry draft\nsecond line"
    );
    await waitForIdle(page);
  }
});

test("held send grows into an anchored pill and only an armed release starts voice", async ({ page }) => {
  await openChat(page);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("unsent gesture draft");
  const button = page.getByRole("button", { name: /Send message; hold and swipe up/ });
  const original = await button.boundingBox();

  if (!original) {
    throw new Error("Send button is missing.");
  }

  const x = original.x + original.width / 2;
  const y = original.y + original.height / 2;
  const starts = await countStarts();

  let sends = 0;

  await page.route("**/api/messages", (route) => {
    sends++;

    return route.abort();
  });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  const track = page.locator(".voice-pill-track");

  await expect(track).toBeVisible();
  await track.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map(async (animation) => animation.finished));
  });
  await expect(button.locator(".lucide-arrow-up")).toBeVisible();
  await expect(button.locator(".lucide-mic")).toHaveCount(0);
  const trackBox = await track.boundingBox();

  if (!trackBox) {
    throw new Error("Voice pill track is missing.");
  }

  closeTo(trackBox.x, original.x);
  closeTo(trackBox.y + trackBox.height, original.y + original.height);
  closeTo(trackBox.width, original.width);
  expect(trackBox.height).toBeGreaterThan(original.height);
  await page.mouse.move(x, y - 34);
  await expect(button.locator(".lucide-arrow-up")).toBeVisible();
  await expect(button.locator(".lucide-mic")).toHaveCount(0);
  const middle = await button.boundingBox();

  if (!middle) {
    throw new Error("Sliding send button is missing.");
  }

  closeTo(middle.y, original.y - 34);
  await page.mouse.move(x, y - 72);
  await expect(button.locator(".lucide-mic")).toBeVisible();
  await expect(button.locator(".lucide-arrow-up")).toHaveCount(0);
  const top = await button.boundingBox();

  if (!top) {
    throw new Error("Armed send button is missing.");
  }

  closeTo(top.y, trackBox.y);
  await page.mouse.move(x, y - 18);
  await expect(button.locator(".lucide-arrow-up")).toBeVisible();
  await expect(button.locator(".lucide-mic")).toHaveCount(0);
  await page.mouse.up();
  await expect(track).toHaveCount(0);
  await expect(button).toBeVisible();
  expect(await countStarts()).toBe(starts);
  expect(sends).toBe(0);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await expect(track).toBeVisible();
  await page.mouse.up();
  await expect(track).toHaveCount(0);
  expect(await countStarts()).toBe(starts);
  expect(sends).toBe(0);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.move(x, y - 36);
  await button.evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
    element.releasePointerCapture(1);
  });
  await page.mouse.up();
  await expect(track).toHaveCount(0);
  expect(await countStarts()).toBe(starts);
  expect(sends).toBe(0);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await expect(track).toBeVisible();
  await page.mouse.move(x, y - 72);
  await expect(button.locator(".lucide-mic")).toBeVisible();
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Stop realtime voice" })).toBeVisible();
  await expect.poll(countStarts).toBe(starts + 1);
  expect(sends).toBe(0);
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("unsent gesture draft");
  await waitForIdle(page);
});

test("switching Pockets stops the old microphone owner and keeps each draft and audio route scoped", async ({
  page,
}) => {
  const namedId = crypto.randomUUID();
  const created = await page.request.post("/api/pockets", {
    headers: { Origin: origin },
    data: { action: "create", id: namedId, name: "Voice other" },
  });

  expect(created.ok()).toBe(true);
  await openChat(page);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("unsent main draft");
  const previousStarts = await countStarts();
  const previousAudio = await countAudio();

  await page.getByRole("button", { name: "Start realtime voice" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  await expect(page.getByText("Test voice").first()).toBeVisible();
  await expect.poll(countAudio).toBeGreaterThan(previousAudio);
  const beforeStop = await countStops();

  await page.getByRole("button", { name: "Open Pockets" }).click();
  await page
    .getByRole("link")
    .filter({ has: page.getByText("Voice other", { exact: true }) })
    .click();
  await expect(page).toHaveURL(new RegExp(`pocket=${namedId}`));
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeVisible();
  await expect(page.getByText("Test voice")).toHaveCount(0);
  await expect.poll(countStops).toBeGreaterThan(beforeStop);
  const beforeNamedAudio = await countAudio();

  await expect(page.getByRole("button", { name: "Start realtime voice" })).toBeEnabled();
  await page.getByRole("button", { name: "Start realtime voice" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  await expect.poll(countAudio).toBeGreaterThan(beforeNamedAudio);
  const log = await readFile(nativeLog, "utf8");
  const sessions = log
    .trim()
    .split("\n")
    .map((line) => dataSchema.parse(JSON.parse(line)))
    .filter((entry) => entry.method === "provider/realtime/start")
    .slice(previousStarts)
    .map((entry) => entry.sessionId);
  const audioOwners = log
    .trim()
    .split("\n")
    .map((line) => dataSchema.parse(JSON.parse(line)))
    .filter((entry) => entry.method === "provider/realtime/appendAudio")
    .map((entry) => entry.sessionId)
    .filter((id) => sessions.includes(id));

  expect(sessions).toHaveLength(2);
  expect(new Set(audioOwners)).toEqual(new Set(sessions));
  await page.getByRole("button", { name: "Stop realtime voice" }).click();
  await page.getByRole("button", { name: "Open Pockets" }).click();
  await page.locator('a.pocket-link[href="/"]').click();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("unsent main draft");
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toHaveCount(0);
  const deleted = await page.request.post("/api/pockets", {
    headers: { Origin: origin },
    data: { action: "delete", id: namedId },
  });

  expect(deleted.ok()).toBe(true);
});

test("a cancelled pointer gesture does not swallow later keyboard send or stop", async ({ page }) => {
  await openChat(page);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("keyboard draft");
  let sends = 0;

  await page.route("**/api/messages", (route) => {
    sends++;

    return route.abort();
  });
  await cancelWithoutClick(page);
  const send = page.getByRole("button", { name: /Send message; hold and swipe up/ });

  await send.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => sends).toBe(1);
  await page.reload();
  await expect(send).toBeEnabled();
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("voice draft");
  await cancelWithoutClick(page);
  const start = page.getByRole("button", { name: "Start realtime voice" });

  await start.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Realtime voice active" })).toBeVisible();
  const beforeStop = await countStops();
  const stop = page.getByRole("button", { name: "Stop realtime voice" });

  await stop.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("voice draft");
  await expect.poll(countStops).toBeGreaterThan(beforeStop);
  await waitForIdle(page);
});
