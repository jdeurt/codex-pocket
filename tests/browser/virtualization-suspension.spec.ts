/* eslint-disable @typescript-eslint/no-magic-numbers -- Complete overlay navigation with large synthetic history. */
import { type Page, expect, test } from "@playwright/test";
import type { Snapshot } from "../../src/lib/protocol";
import { readFile } from "node:fs/promises";
import { suspensionHistory } from "./fixtures/suspension-data";

const viewport = '[data-slot="message-scroller-viewport"]';

async function publish(page: Page, state: Snapshot) {
  await page.evaluate(
    (snapshot) => globalThis.dispatchEvent(new globalThis.CustomEvent("suspension-snapshot", { detail: snapshot })),
    state
  );
}

async function position(page: Page) {
  return page.locator(viewport).evaluate((element) => element.scrollTop);
}

async function pausedPosition(page: Page) {
  const value = await page.getByRole("dialog", { name: "Child overlay" }).getAttribute("data-parent-offset");

  if (value === null) {
    throw new Error("Missing offset at overlay activation");
  }

  return Number(value);
}

async function exactPosition(page: Page, expected: number) {
  await expect.poll(async () => Math.abs((await position(page)) - expected)).toBeLessThan(1);
}

async function returnToParent(page: Page, expected: number) {
  const visible = await page
    .getByRole("button", { name: "Return to parent" })
    .evaluate(async (button: HTMLButtonElement) => {
      button.click();
      const offsets = [];

      for (let frame = 0; frame < 8; frame++) {
        await new Promise(globalThis.requestAnimationFrame);
        const node = globalThis.document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');

        if (node && node.clientHeight > 0) {
          offsets.push(node.scrollTop);
        }
      }

      return offsets;
    });
  expect(visible.length).toBeGreaterThan(0);
  expect(Math.max(...visible.map((offset) => Math.abs(offset - expected)))).toBeLessThan(1);
}

for (const hide of [false, true]) {
  test(`parent suspension preserves offset, cache and drafts with ${hide ? "hidden" : "covered"} layout`, async ({
    page,
  }, info) => {
    test.setTimeout(40_000);
    await page.emulateMedia({ reducedMotion: hide ? "reduce" : "no-preference" });
    const image = await readFile("public/icon-192.png");
    await page.route("**/api/**", (route) => route.fulfill({ contentType: "image/png", body: image }));
    const state = suspensionHistory();
    await page.goto("/virtualization-fixture");
    await expect(page.locator('[data-message-id="parent-1199"]')).toBeVisible();
    await page.getByRole("textbox", { name: "Parent draft", exact: true }).fill("Keep parent text");
    await page.getByRole("textbox", { name: "Pending answer draft" }).fill("Keep pending answer");

    if (hide) {
      await page.getByRole("checkbox", { name: "Hide parent layout" }).check();
    }

    const element = await page.locator(viewport).elementHandle();
    await page.locator(viewport).dispatchEvent("wheel", { deltaY: -1000 });
    await page.locator(viewport).evaluate((node) => {
      node.scrollTop = node.scrollHeight * 0.55;
    });
    await page.evaluate(
      () => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)))
    );
    await page.getByRole("button", { name: "Open child overlay" }).click();
    await expect(page.locator(viewport)).toHaveAttribute("data-scroll-suspended", "true");
    const paused = await pausedPosition(page);
    const preceding = () =>
      page.locator(viewport).evaluate((node) => {
        const top = node.getBoundingClientRect().top;

        return (
          [...node.querySelectorAll<HTMLElement>("[data-transcript-row]")].findLast(
            (item) => item.getBoundingClientRect().bottom <= top
          )?.dataset.transcriptRow ?? ""
        );
      });

    if (!hide) {
      await expect.poll(preceding).not.toBe("");
    }

    const precedingId = hide ? "parent/parent-650" : await preceding();
    const growthIndex = state.turns[0].items.findIndex((item) => precedingId.endsWith(`/${item.id}`));
    expect(growthIndex).toBeGreaterThanOrEqual(0);
    state.turns[0].items[growthIndex].images = [
      { source: "/api/images?item=suspension-growth", alt: "Background image" },
    ];
    await publish(page, state);

    if (!hide) {
      await expect(page.locator('img[alt="Background image"]')).toHaveJSProperty("complete", true);
      await exactPosition(page, paused);
    }

    state.turns[0].items.unshift(
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `older-${index}`,
        type: "agentMessage",
        text: `Prepended ${index}`,
      }))
    );
    const stream = { id: "background", type: "agentMessage", text: "Background stream" };
    state.turns[0].items.push(stream);
    state.queue = [{ id: "background-queued", status: "sending", text: "Background queued output" }];
    await publish(page, state);

    for (let index = 0; index < 12; index++) {
      stream.text += "\n\nStream while child is open.";
      await publish(page, state);
      await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));

      if (!hide) {
        await exactPosition(page, paused);
      }
    }

    await expect(page.locator(viewport)).toHaveAttribute("data-scroll-motion", "idle");
    await returnToParent(page, paused);
    await expect(page.locator(viewport)).not.toHaveAttribute("data-scroll-suspended", "true");
    await exactPosition(page, paused);
    await expect(page.getByRole("textbox", { name: "Parent draft", exact: true })).toHaveValue("Keep parent text");
    await page.getByRole("button", { name: "Jump to latest message" }).click();
    await expect(page.locator('[data-message-id="background"]')).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Pending answer draft" })).toHaveValue("Keep pending answer");
    expect(
      await element?.evaluate((node) => node === document.querySelector('[data-slot="message-scroller-viewport"]'))
    ).toBe(true);
    expect(await page.locator("[data-transcript-row]").count()).toBeLessThan(250);

    // Suspend while following the bottom, then append. Returning must not follow.
    await expect
      .poll(() => page.locator(viewport).evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
      .toBeLessThan(2);
    await page.getByRole("button", { name: "Open child overlay" }).click();
    const bottomBefore = await pausedPosition(page);
    const later = { id: "later", type: "agentMessage", text: "New output while away.\n\n".repeat(30) };
    state.turns[0].items.push(later);
    state.queue = [];
    await publish(page, state);

    if (!hide) {
      await exactPosition(page, bottomBefore);
    }

    await returnToParent(page, bottomBefore);
    await expect(page.locator(viewport)).not.toHaveAttribute("data-scroll-suspended", "true");
    await exactPosition(page, bottomBefore);
    later.text += "\n\nMore output after return.";
    await publish(page, state);
    await exactPosition(page, bottomBefore);
    await page.getByRole("button", { name: "Jump to latest message" }).click();
    await expect
      .poll(() => page.locator(viewport).evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
      .toBeLessThan(2);

    // Even returning to an unchanged bottom must not silently rearm follow.
    await page.getByRole("button", { name: "Open child overlay" }).click();
    const unchanged = await pausedPosition(page);
    await returnToParent(page, unchanged);
    await expect(page.locator(viewport)).not.toHaveAttribute("data-scroll-suspended", "true");
    await exactPosition(page, unchanged);
    state.turns[0].items.push({ id: "after-unchanged", type: "agentMessage", text: "After return.\n\n".repeat(20) });
    await publish(page, state);
    await page.evaluate(() => new Promise((resolve) => globalThis.setTimeout(resolve, 350)));
    await exactPosition(page, unchanged);
    await page.getByRole("button", { name: "Jump to latest message" }).click();
    await expect
      .poll(() => page.locator(viewport).evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
      .toBeLessThan(2);

    if (!hide) {
      const moving = { id: "moving", type: "agentMessage", text: "Start a bottom transition.\n\n".repeat(20) };
      state.turns[0].items.push(moving);
      await publish(page, state);
      await expect(page.locator(viewport)).toHaveAttribute("data-scroll-motion", "smooth");
      await page.getByRole("button", { name: "Open child overlay" }).click();
      const interrupted = await pausedPosition(page);
      await expect(page.locator(viewport)).toHaveAttribute("data-scroll-motion", "idle");
      moving.text += "Background growth.\n\n".repeat(20);
      await publish(page, state);
      await exactPosition(page, interrupted);
      await page.getByRole("button", { name: "Return to parent" }).click();
      // Explicit latest must cancel restoration even before its idle refresh.
      await page.getByRole("button", { name: "Jump to latest message" }).click();
      await expect
        .poll(() => page.locator(viewport).evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
        .toBeLessThan(2);

      // The activity sublist must suspend its own anchor writer as well.
      state.turns[0].status = "completed";

      for (const item of state.turns[0].items) {
        item.phase = "commentary";
      }

      state.turns[0].items.push({
        id: "group-final",
        type: "agentMessage",
        phase: "final_answer",
        text: "Grouped final",
      });
      await publish(page, state);
      await page.getByRole("button", { name: "Show activity", exact: true }).click();
      await page.locator(viewport).dispatchEvent("wheel", { deltaY: -1000 });
      await page.locator(viewport).evaluate((node) => {
        node.scrollTop = node.scrollHeight * 0.5;
      });
      await page.evaluate(
        () =>
          new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)))
      );
      await page.getByRole("button", { name: "Open child overlay" }).click();
      const nestedOffset = await pausedPosition(page);
      state.turns[0].items.unshift({
        id: "nested-prepend",
        type: "agentMessage",
        phase: "commentary",
        text: "Older nested activity",
      });
      await publish(page, state);
      await exactPosition(page, nestedOffset);
      await page.getByRole("button", { name: "Return to parent" }).click();
      await expect(page.locator(viewport)).not.toHaveAttribute("data-scroll-suspended", "true");
      await exactPosition(page, nestedOffset);
      expect(await page.locator("[data-transcript-row]").count()).toBeLessThan(250);
      await page.getByRole("button", { name: "Open child overlay" }).click();
      const interrupt = await page.evaluate(async () => {
        globalThis.document.querySelector<HTMLButtonElement>("#fixture-return")?.click();
        await new Promise(globalThis.requestAnimationFrame);
        const node = globalThis.document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');

        if (!node) {
          throw new Error("Missing parent viewport");
        }

        const restoring = node.dataset.scrollSuspended;
        node.dispatchEvent(new globalThis.WheelEvent("wheel", { bubbles: true, deltaY: -150 }));
        node.scrollTop -= 150;
        const top = node.scrollTop;

        for (let frame = 0; frame < 8; frame++) {
          await new Promise(globalThis.requestAnimationFrame);
        }

        return { restoring, drift: Math.abs(node.scrollTop - top) };
      });
      expect(interrupt.restoring).toBe("true");
      expect(interrupt.drift).toBeLessThan(1);
    }

    await page.screenshot({
      path: `.local/virtualization-suspension-${info.project.name}-${hide ? "hidden" : "covered"}.png`,
    });
  });
}
