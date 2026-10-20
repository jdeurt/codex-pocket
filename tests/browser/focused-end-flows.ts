import { assertDocumentStable, input, scrollTop, scroller, setVisualViewport } from "./focused-fixture";
import { expect, test } from "@playwright/test";

const FOCUSED_VIEWPORT_HEIGHT = 380;
const FOCUSED_VIEWPORT_TOP = 24;
const RESIZE_DRAFT_LINES = 8;
const RESIZED_VIEWPORT_HEIGHT = 420;
const ZOOMED_VIEWPORT_HEIGHT = 230;
const RESTORED_VIEWPORT_HEIGHT = 460;

/**
Register whole-chat composer focus flows under the caller's offline chat fixture.
*/
export function composerFocusEndTests() {
  test("read-only agent resizing preserves the covered parent's native position and draft", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: "Agents", exact: true });
    const { offset, height, size } =
      await test.step("Focus the parent draft and open the read-only agent", async () => {
        await page.getByRole("button", { name: "Dismiss notification prompt" }).click();
        await input(page).fill("Covered parent draft");
        await page.getByRole("button", { name: "1 agent", exact: true }).click();
        await expect(scroller(page)).toHaveAttribute("data-scroll-suspended", "true");
        await dialog.getByRole("button", { name: /Focus fixture agent/ }).click();
        await expect(dialog.getByRole("list", { name: "Conversation", exact: true })).toBeVisible();
        await expect(dialog.getByRole("textbox")).toHaveCount(0);

        return {
          offset: await scrollTop(page),
          height: await scroller(page).evaluate((element) => element.clientHeight),
          size: page.viewportSize(),
        };
      });

    if (!size) {
      throw new Error("Viewport dimensions are unavailable");
    }

    await page.setViewportSize({ width: size.width, height: RESIZED_VIEWPORT_HEIGHT });
    await expect.poll(() => scroller(page).evaluate((element) => element.clientHeight)).toBeLessThan(height);
    await expect.poll(() => scrollTop(page)).toBe(offset);
    await expect(scroller(page)).toHaveAttribute("data-scroll-suspended", "true");
    await page.setViewportSize(size);
    await dialog.getByRole("button", { name: "Back to agents", exact: true }).click();
    await dialog.getByRole("button", { name: "Back to Pocket", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(input(page)).toHaveValue("Covered parent draft");
    await input(page).click();
    await expect(input(page)).toBeFocused();
    await assertDocumentStable(page);
  });

  test("true transcript end survives composer focus, draft growth and keyboard viewport changes", async ({
    page,
  }, info) => {
    const jump = page.getByRole("button", { name: "Jump to latest message" });
    const activity = page.getByRole("status", { name: "Pocket activity", exact: true });
    const agents = page.getByRole("button", { name: "1 agent", exact: true });
    const distance = () =>
      scroller(page).evaluate((element) => Math.round(element.scrollHeight - element.clientHeight - element.scrollTop));
    const size = page.viewportSize();
    const { footerBottom, composerTop } =
      await test.step("Focus the real end and grow the keyboard draft", async () => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.getByRole("button", { name: "Dismiss notification prompt" }).click();
        await expect(agents).toBeVisible();
        await scroller(page).evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect.poll(distance).toBe(0);
        await expect(jump).toHaveCount(0);

        await input(page).click();
        await expect(input(page)).toBeFocused();
        await expect.poll(distance).toBe(0);
        await expect(jump).toHaveCount(0);
        await setVisualViewport(page, FOCUSED_VIEWPORT_HEIGHT, FOCUSED_VIEWPORT_TOP);
        await expect(page.locator(".chat-shell")).toHaveCSS("height", "380px");
        await expect.poll(distance).toBe(0);
        await expect(jump).toHaveCount(0);
        await expect(activity).toBeInViewport({ ratio: 1 });
        await expect(agents).toBeInViewport({ ratio: 1 });

        await input(page).fill("Preserved focused draft\n".repeat(RESIZE_DRAFT_LINES));
        await expect.poll(distance).toBe(0);
        await expect(input(page)).toBeFocused();
        await expect(activity).toBeInViewport({ ratio: 1 });
        await expect(agents).toBeInViewport({ ratio: 1 });

        return {
          footerBottom: await page
            .locator('[data-slot="transcript-footer"]')
            .evaluate((element) => element.getBoundingClientRect().bottom),
          composerTop: await page.locator(".composer-wrap").evaluate((element) => element.getBoundingClientRect().top),
        };
      });

    expect(footerBottom).toBeLessThanOrEqual(composerTop);
    await assertDocumentStable(page);
    await page.screenshot({ path: info.outputPath("focused-transcript-end.png") });

    await input(page).evaluate((element) => {
      element.blur();
    });
    await expect(page.locator(".chat-shell")).not.toHaveAttribute("style", /composer-viewport/);
    await expect.poll(distance).toBe(0);
    await expect(input(page)).toHaveValue("Preserved focused draft\n".repeat(RESIZE_DRAFT_LINES));
    await expect(jump).toHaveCount(0);

    if (!size) {
      throw new Error("Viewport dimensions are unavailable");
    }

    await setVisualViewport(page, RESIZED_VIEWPORT_HEIGHT);
    await page.setViewportSize({ width: size.width, height: RESIZED_VIEWPORT_HEIGHT });
    await input(page).click();
    await expect.poll(distance).toBe(0);
    await expect(jump).toHaveCount(0);
    await expect(activity).toBeInViewport({ ratio: 1 });
    await expect(agents).toBeInViewport({ ratio: 1 });
    await assertDocumentStable(page);
  });

  test("composer focus and visual viewport changes preserve a history reader's native anchor", async ({ page }) => {
    const jump = page.getByRole("button", { name: "Jump to latest message" });
    const before = await test.step("Position the native history reader before focusing the composer", async () => {
      await page.getByRole("button", { name: "Dismiss notification prompt" }).click();
      await scroller(page).evaluate((element) => {
        element.scrollTop = Math.round(element.scrollHeight / 2);
      });
      await expect(jump).toBeVisible();

      return await scrollTop(page);
    });

    await input(page).click();
    await input(page).fill("History reader draft");
    await expect.poll(() => scrollTop(page)).toBe(before);
    await setVisualViewport(page, FOCUSED_VIEWPORT_HEIGHT, FOCUSED_VIEWPORT_TOP);
    await expect(page.locator(".chat-shell")).toHaveCSS("height", "380px");
    await expect.poll(() => scrollTop(page)).toBe(before);
    await expect(jump).toBeVisible();
    await input(page).fill("History reader draft\n".repeat(RESIZE_DRAFT_LINES));
    await expect.poll(() => scrollTop(page)).toBe(before);
    await expect(input(page)).toBeFocused();

    await setVisualViewport(page, ZOOMED_VIEWPORT_HEIGHT, 0, 2);
    await expect(page.locator(".chat-shell")).not.toHaveAttribute("style", /composer-viewport/);
    await expect.poll(() => scrollTop(page)).toBe(before);
    await setVisualViewport(page, RESTORED_VIEWPORT_HEIGHT);
    await expect(page.locator(".chat-shell")).toHaveCSS("height", "460px");
    await expect.poll(() => scrollTop(page)).toBe(before);
    await input(page).evaluate((element) => {
      element.blur();
    });
    await expect.poll(() => scrollTop(page)).toBe(before);
    await expect(input(page)).toHaveValue("History reader draft\n".repeat(RESIZE_DRAFT_LINES));
    await assertDocumentStable(page);
  });
}
