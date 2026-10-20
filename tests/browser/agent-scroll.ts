import { type Locator, type Page, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const SCROLLED_OFFSET = 280;
const OFFSET_TOLERANCE = 2;

async function anchor(parent: Locator, id?: string) {
  return parent.evaluate((element, match) => {
    const viewport = element.getBoundingClientRect();
    const bubbles = [...element.querySelectorAll<HTMLElement>('[data-slot="bubble"][data-message-id]')];
    const bubble = bubbles.find((entry) => {
      const box = entry.getBoundingClientRect();

      return match ? entry.dataset.messageId === match : box.bottom > viewport.top && box.top < viewport.bottom;
    });

    if (!bubble) {
      throw new Error("Parent visible message anchor is missing.");
    }

    return { id: bubble.dataset.messageId, offset: bubble.getBoundingClientRect().top - viewport.top };
  }, id);
}

export async function checkAgentScroll(page: Page, control: (stage: string) => Promise<void>) {
  const mutations: string[] = [];
  const measurements = [];
  const trigger = page.getByRole("button", { name: "6 agents", exact: true });
  const draft = "Keep my parent draft while output streams";
  const composer = page.getByRole("textbox", { name: "Message Pocket" });
  const parent = page.locator('main > [class] [data-slot="message-scroller-viewport"]').first();
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });

  page.on("request", (request) => {
    if (!["GET", "HEAD"].includes(request.method()) && !request.url().includes("/api/logs")) {
      mutations.push(request.url());
    }
  });
  await page.goto("/");

  await expect(trigger).toBeVisible();

  await composer.fill(draft);

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(() => {
            resolve();
          })
        );
      })
  );

  for (const position of ["scrolled", "bottom"]) {
    const row = dialog.getByRole("button", { name: /Researching an exceptionally long/ });

    if (position === "scrolled") {
      await parent.dispatchEvent("wheel", { deltaY: -SCROLLED_OFFSET });
    }

    await parent.evaluate(
      (element, offset) => {
        element.scrollTop = offset ?? element.scrollHeight;
      },
      position === "scrolled" ? SCROLLED_OFFSET : null
    );
    const before = await parent.evaluate((element) => element.scrollTop);

    expect(before).toBeGreaterThan(SCROLLED_OFFSET - OFFSET_TOLERANCE);
    const beforeAnchor = await anchor(parent);

    // Do not scroll the offscreen activity control into view before opening.
    await trigger.evaluate((button: HTMLButtonElement) => {
      button.click();
    });

    await row.click();
    await expect(dialog.getByRole("heading", { name: "Side Pocket", exact: true })).toBeFocused();
    await expect(dialog.getByText("Saved native-codex result", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("note")).toHaveCount(0);
    const appendKey = `${position}:${crypto.randomUUID()}`;

    await control(`parent-append:${appendKey}`);
    // Parent remains mounted and consumes the actual RPC -> bridge -> SSE update.
    const incomingId = `parent-incoming-${appendKey.replaceAll(":", "-")}`;
    const incoming = parent.locator(`[data-slot="bubble"][data-message-id="${incomingId}"]`);

    await expect(incoming).toContainText("STREAM_FINISHED");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          globalThis.requestAnimationFrame(() =>
            globalThis.requestAnimationFrame(() => {
              resolve();
            })
          );
        })
    );
    const during = await parent.evaluate((element) => element.scrollTop);

    expect(Math.abs(during - before)).toBeLessThan(OFFSET_TOLERANCE);
    const duringAnchor = await anchor(parent, beforeAnchor.id);

    expect(Math.abs(duringAnchor.offset - beforeAnchor.offset)).toBeLessThan(OFFSET_TOLERANCE);
    await page.keyboard.press("Escape");
    await expect(row).toBeFocused();
    await dialog.getByRole("button", { name: "Back to Pocket", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    const after = await parent.evaluate((element) => element.scrollTop);

    expect(Math.abs(after - before)).toBeLessThan(OFFSET_TOLERANCE);
    const afterAnchor = await anchor(parent, beforeAnchor.id);

    expect(Math.abs(afterAnchor.offset - beforeAnchor.offset)).toBeLessThan(OFFSET_TOLERANCE);
    await expect(composer).toHaveValue(draft);
    await expect(parent).not.toHaveAttribute("data-scroll-suspended", "true");
    await page.locator("main").getByRole("button", { name: "Jump to latest message", exact: true }).click();
    await expect
      .poll(() => parent.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
      .toBeLessThan(OFFSET_TOLERANCE);
    await expect(incoming).toBeInViewport();
    await expect(composer).toHaveValue(draft);
    measurements.push({
      position,
      before,
      during,
      after,
      beforeAnchor,
      duringAnchor,
      afterAnchor,
    });
  }

  expect(mutations).toEqual([]);
  await writeFile(".local/agent-browser-replay/navigation-result.json", JSON.stringify(measurements));
}
