/* eslint-disable @typescript-eslint/no-magic-numbers -- Strict per-frame whole-flow layout and focus replay. */
import { type Page, expect, test } from "@playwright/test";
import type { Snapshot } from "../../src/lib/protocol";
import { suspensionHistory } from "./fixtures/suspension-data";

const viewport = '[data-slot="message-scroller-viewport"]';

async function publish(page: Page, state: Snapshot) {
  await page.evaluate((detail) => {
    globalThis.dispatchEvent(new globalThis.CustomEvent("suspension-snapshot", { detail }));
  }, state);
  await expect(page.locator("main")).toHaveAttribute("data-revision", state.activity ?? "");
}

async function anchor(page: Page) {
  return page.locator(viewport).evaluate((node) => {
    const top = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll<HTMLElement>("[data-transcript-row]")].find(
      (element) => element.getBoundingClientRect().bottom > top
    );

    if (!row?.dataset.transcriptRow) {
      throw new Error("Missing visible parent anchor");
    }

    return { id: row.dataset.transcriptRow, top: node.scrollTop, y: row.getBoundingClientRect().top - top };
  });
}

function record(page: Page, id: string) {
  return page.locator(viewport).evaluate(async (node, key) => {
    const frames = [];

    for (let index = 0; index < 40; index++) {
      const row = [...node.querySelectorAll<HTMLElement>("[data-transcript-row]")].find(
        (element) => element.dataset.transcriptRow === key
      );
      frames.push({
        top: node.scrollTop,
        y: row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : Infinity,
      });
      await new Promise(globalThis.requestAnimationFrame);
    }

    return frames;
  }, id);
}

test("dialog append, disappearing activity footer and composer focus preserve parent offset and visible anchor", async ({
  page,
}, info) => {
  const state: Snapshot = { ...suspensionHistory(), activeTurnId: "parent" };
  await page.goto("/virtualization-fixture/dialog");
  const parent = page.locator(viewport);
  const composer = page.getByRole("textbox", { name: "Parent draft" });
  const trigger = page.getByRole("button", { name: "Open child overlay", exact: true });
  const dialog = page.getByRole("dialog", { name: "Child overlay", exact: true });
  await expect(page.locator('[data-message-id="parent-1199"]')).toBeVisible();
  await composer.fill("Retain the parent draft");
  await expect(parent).toHaveAttribute("data-scroll-motion", "idle");

  for (const stage of ["append", "settled"]) {
    await parent.dispatchEvent("wheel", { deltaY: -280 });
    await parent.evaluate((node) => {
      node.scrollTop = 280;
    });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve));
        })
    );
    const before = await anchor(page);
    await trigger.evaluate((button: HTMLButtonElement) => button.click());
    await expect(dialog).toBeVisible();
    const incoming = record(page, before.id);
    state.activity = stage;

    if (stage === "append") {
      state.turns[0].items.push({
        id: "incoming",
        type: "agentMessage",
        text: "Incoming parent stream.\n\n".repeat(100),
      });
    } else {
      state.activeTurnId = undefined;
      state.error = "Synthetic banner expands the composer region";
    }

    await publish(page, state);
    const during = await incoming;
    expect(Math.max(...during.map((frame) => Math.abs(frame.top - before.top)))).toBeLessThan(1);
    expect(Math.max(...during.map((frame) => Math.abs(frame.y - before.y)))).toBeLessThan(1);
    const returning = record(page, before.id);
    await dialog.getByRole("button", { name: "Return to parent" }).click();
    await expect(dialog).toBeHidden();
    await expect(stage === "append" ? trigger : composer).toBeFocused();
    const after = await returning;
    expect(Math.max(...after.map((frame) => Math.abs(frame.top - before.top)))).toBeLessThan(1);
    expect(Math.max(...after.map((frame) => Math.abs(frame.y - before.y)))).toBeLessThan(1);
    await expect(composer).toHaveValue("Retain the parent draft");
  }

  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await expect
    .poll(() => parent.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(2);
  await page.screenshot({ path: `.local/virtualization-dialog-${info.project.name}.png` });
});
