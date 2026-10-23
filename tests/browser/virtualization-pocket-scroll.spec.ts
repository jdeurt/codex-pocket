import { expect, test } from "@playwright/test";
import { expectAnchor, scrollToFraction, settledAnchor } from "./virtualization-measure";
import { history } from "../fixtures/virtualized-history";
import { mount } from "./virtualization-fixture";

const READING_FRACTION = 0.3;

test("a Pocket restores its native virtualizer bookmark after leaving and reopening", async ({ page }) => {
  const state = { ...history(), threadId: "bookmark-parent" };
  const writes = await mount(page, state);
  const anchor = await test.step("Save a settled native reading position", async () => {
    await settledAnchor(page);
    await scrollToFraction(page, READING_FRACTION);
    await expect
      .poll(() =>
        page
          .locator("[data-transcript-row] img")
          .evaluateAll((images: HTMLImageElement[]) =>
            images.every((image) => image.complete && image.naturalWidth > 0)
          )
      )
      .toBe(true);

    return settledAnchor(page);
  });

  await page.goto("about:blank");
  await page.goto("/");
  await expectAnchor(page, anchor);
  expect(writes).toEqual([]);
});
