import { type Page, expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import { expectAnchor, scrollToFraction, settledAnchor } from "../virtualization-measure";

const READING_FRACTION = 0.35;
const MOUNTED_ROW_LIMIT = 250;
const END_TOLERANCE = 3;

test("saved native history stays readable and restores the reader's place after leaving the page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Earlier note 319", { exact: true })).toBeVisible();
  await scrollToFraction(page, READING_FRACTION);
  const anchor = await settledAnchor(page);

  expect(await page.locator("[data-transcript-row]").count()).toBeLessThanOrEqual(MOUNTED_ROW_LIMIT);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("Keep this reading draft.");
  await page.goto("about:blank");
  await page.goto("/");
  await expectAnchor(page, anchor);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("Keep this reading draft.");
  expect(await page.locator("[data-transcript-row]").count()).toBeLessThanOrEqual(MOUNTED_ROW_LIMIT);
});

test("a provider's copy action copies decoded text only after the user activates it", async ({ page }) => {
  const writes: string[] = [];

  await page.exposeFunction("recordWorkflowClipboard", (text: string) => {
    writes.push(text);
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text: string) => {
          const host = globalThis as typeof globalThis & { recordWorkflowClipboard?: (value: string) => Promise<void> };

          if (!host.recordWorkflowClipboard) {
            throw new Error("Missing external clipboard recorder");
          }

          return host.recordWorkflowClipboard(text);
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("Give me the exact text to copy.");
  await page.getByRole("button", { name: /^Send message(?:;|$)/ }).click();
  const copy = page.getByRole("button", { name: "Copy text", exact: true }).last();

  await expect(copy).toBeVisible();
  expect(writes).toEqual([]);
  await copy.click();
  await expect(page.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
  expect(writes).toEqual(["café ✓\nKeep exact text."]);
});

/** Measure the viewport after real native messages have been rendered.
@param page - Browser showing the persisted native conversation.
@returns Remaining distance to the latest message.
*/
async function nativeDistanceFromEnd(page: Page) {
  return page
    .locator('[data-slot="message-scroller-viewport"]')
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}

test("new native agent replies follow after returning from earlier history", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Earlier note 319", { exact: true })).toBeVisible();
  await scrollToFraction(page, READING_FRACTION);
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  const previousDistance = await nativeDistanceFromEnd(page);

  expect(previousDistance).toBeLessThanOrEqual(END_TOLERANCE);
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("Continue from the latest message.");
  await page.getByRole("button", { name: /^Send message(?:;|$)/ }).click();
  await expect(page.getByRole("button", { name: "Copy text", exact: true }).last()).toBeVisible();
  await expect.poll(nativeDistanceFromEnd.bind(undefined, page)).toBeLessThanOrEqual(END_TOLERANCE);
});
