import { type Page, expect } from "@playwright/test";
import { send } from "./messages";

export async function checkActivityInterruptions(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  const prompt =
    "Send commentary exactly INTERRUPT_ONE, run sleep 1, send a second commentary exactly INTERRUPT_TWO, then run sleep 12. Finish with final answer INTERRUPT_FINAL. Do not modify files.";
  const firstSteer =
    "Steering update one: after the current command, send commentary exactly INTERRUPT_THREE, run sleep 12, then finish with final answer INTERRUPT_FINAL.";
  const secondSteer =
    "Steering update two: after the current command, finish with final answer exactly INTERRUPT_FINAL.";

  await send(page, prompt);
  await expect(page.getByText("INTERRUPT_TWO", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Pocket activity" })).toContainText("Running commands");
  await send(page, firstSteer);
  await expect(page.getByText("INTERRUPT_THREE", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Pocket activity" })).toContainText("Running commands");
  await send(page, secondSteer);
  await expect(page.getByText("INTERRUPT_FINAL", { exact: true })).toBeVisible();
  const turn = page
    .locator('[data-slot="message-scroller-item"]')
    .filter({ has: page.getByText(prompt, { exact: true }) });
  const expected = [
    prompt,
    "INTERRUPT_ONE",
    "INTERRUPT_TWO",
    firstSteer,
    "INTERRUPT_THREE",
    secondSteer,
    "INTERRUPT_FINAL",
  ];

  for (const reload of [false, true]) {
    if (reload) {
      await page.reload();
    }

    for (const marker of ["INTERRUPT_ONE", "INTERRUPT_TWO", "INTERRUPT_THREE", "INTERRUPT_FINAL"]) {
      await expect(turn.getByText(marker, { exact: true })).toBeVisible();
    }

    const order = await turn
      .locator('[data-slot="bubble"]')
      .evaluateAll(
        (elements, wanted) =>
          elements.map((element) => element.textContent.trim()).filter((text) => wanted.includes(text)),
        expected
      );

    expect(order).toEqual(expected);
    await expect(turn.locator('[data-slot="trace-collapsible-content"]')).toHaveCount(0);
  }
}
