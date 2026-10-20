import { type Locator, type Page, expect, test } from "@playwright/test";

/**
Checks image gestures without introducing hover, press or focus decoration.
@param page - Browser showing the completed image turn.
@param turn - Canonical rendered turn containing the image.
@param label - Viewport label used for evidence and phone-specific touch checks.
@returns Completion of gesture, appearance and preview-close assertions.
*/
export async function checkImageAppearance(page: Page, turn: Locator, label: string) {
  const frame = turn.locator(".chat-image").first();
  const trigger = frame.getByRole("button", { name: /^Preview image:/ });

  const before = await test.step("Decode and reveal the actual image before gesture checks", async () => {
    await expect
      .poll(() => frame.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await frame.scrollIntoViewIfNeeded();

    return await frame.screenshot();
  });
  const unchanged = async () => {
    for (const element of [frame, trigger]) {
      await expect(element).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(element).toHaveCSS("box-shadow", "none");
      await expect(element).toHaveCSS("outline-style", "none");
      await expect(element).toHaveCSS("-webkit-tap-highlight-color", "rgba(0, 0, 0, 0)");
    }

    expect(await frame.screenshot()).toEqual(before);
  };

  const box = await test.step("Verify undecorated hover and capture native pointer bounds", async () => {
    await trigger.hover();
    await unchanged();

    return await trigger.boundingBox();
  });

  if (!box) {
    throw new Error("Image trigger bounds are unavailable.");
  }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await unchanged();
  await frame.screenshot({ path: `.local/image-appearance-${label}-pressed.png` });
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close image preview", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await unchanged();

  if (label === "phone") {
    await trigger.tap();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close image preview", exact: true }).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await unchanged();
  }

  await expect(frame).toHaveCSS("user-select", "none");
  await page.keyboard.press("Tab");
  await trigger.focus();
  await unchanged();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.mouse.click(1, 1);
}
