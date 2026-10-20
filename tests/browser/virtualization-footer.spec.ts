/* eslint-disable @typescript-eslint/no-magic-numbers -- Verify complete long/short/empty transcript footer transitions. */
import { expect, test } from "@playwright/test";
import { suspensionHistory } from "./fixtures/suspension-data";

test("a stable activity provider contributes no gap while its rendered footer is empty", async ({ page }, info) => {
  await page.goto("/virtualization-fixture/dialog");
  await expect(page.locator("main")).toHaveAttribute("data-fixture-ready", "true");
  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  const footer = page.locator('[data-slot="transcript-footer"]');
  const composer = page.getByRole("textbox", { name: "Parent draft" });
  await expect(page.locator('[data-message-id="parent-1199"]')).toBeVisible();
  await composer.fill("Keep the same draft and transcript");
  await viewport.evaluate((element) => {
    element.dataset.fixtureIdentity = "original-viewport";
  });
  await footer.evaluate((element) => {
    element.dataset.fixtureIdentity = "original-footer";
  });
  const state = suspensionHistory();
  const history = state.turns[0].items;

  for (const count of [1200, 3, 0]) {
    state.turns = count ? [{ ...state.turns[0], id: "parent", items: history.slice(0, count) }] : [];

    for (const active of [false, true]) {
      state.activeTurnId = active ? "parent" : undefined;
      state.activity = `footer-${count}-${active}`;
      await page.evaluate((detail) => {
        globalThis.dispatchEvent(new globalThis.CustomEvent("suspension-snapshot", { detail }));
      }, state);
      await expect(page.locator("main")).toHaveAttribute("data-revision", state.activity);
      await expect(viewport).toHaveAttribute("data-fixture-identity", "original-viewport");
      await expect(footer).toHaveAttribute("data-fixture-identity", "original-footer");
      await expect(composer).toHaveValue("Keep the same draft and transcript");

      if (!active) {
        await expect(footer).toBeEmpty();
        await expect(footer).toHaveCSS("padding-top", "0px");
        await expect(footer).toHaveCSS("row-gap", "0px");
        expect(await footer.evaluate((element) => element.getBoundingClientRect().height)).toBe(0);
        continue;
      }

      await expect(footer).toHaveCSS("row-gap", "16px");
      await expect(footer).toHaveCSS("padding-top", count ? "16px" : "0px");
      const latest = page.getByRole("button", { name: "Jump to latest message", exact: true });

      if (await latest.isVisible()) {
        await latest.click();
      }

      await expect(page.getByText("Parent working", { exact: true })).toBeInViewport();

      if (count) {
        await expect
          .poll(() =>
            viewport.evaluate(
              (element, lastId) => {
                const lastBlock = element.querySelector(
                  `[data-message-id="${CSS.escape(lastId)}"] .markdown > :last-child`
                );
                const activity = element.querySelector(".activity-row");

                return lastBlock && activity
                  ? Math.abs(activity.getBoundingClientRect().top - lastBlock.getBoundingClientRect().bottom - 16)
                  : Infinity;
              },
              `parent-${count - 1}`
            )
          )
          .toBeLessThan(1);
      }
    }
  }

  await page.screenshot({ path: `.local/virtualization-footer-${info.project.name}.png` });
});
