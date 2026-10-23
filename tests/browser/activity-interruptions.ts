import { type Page, expect, test } from "@playwright/test";
import { send } from "./messages";

/**
Exercises queued steering and interrupt/recovery against the explicitly enabled live harness.
@param page - Browser already connected to the opted-in live test session.
@returns Completion of the existing commentary, steering and interruption assertions.
*/
export async function checkActivityInterruptions(page: Page) {
  const prompt =
    "Send commentary exactly INTERRUPT_ONE, run sleep 1, send a second commentary exactly INTERRUPT_TWO, then run sleep 12. Finish with final answer INTERRUPT_FINAL. Do not modify files.";
  const firstSteer =
    "Steering update one: after the current command, send commentary exactly INTERRUPT_THREE, run sleep 12, then finish with final answer INTERRUPT_FINAL.";
  const secondSteer =
    "Steering update two: after the current command, finish with final answer exactly INTERRUPT_FINAL.";

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

  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();

  await send(page, prompt);
  await expect(page.getByText("INTERRUPT_TWO", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Pocket activity" })).toContainText("running commands");
  await send(page, firstSteer);
  await expect(page.getByText("INTERRUPT_THREE", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Pocket activity" })).toContainText("running commands");
  await send(page, secondSteer);
  await expect(page.getByText("INTERRUPT_FINAL", { exact: true })).toBeVisible();

  for (const isReload of [false, true]) {
    const order = await test.step(
      isReload ? "Reload preserved steering order" : "Inspect completed steering order",
      async () => {
        if (isReload) {
          await page.reload();
        }

        for (const marker of ["INTERRUPT_ONE", "INTERRUPT_TWO", "INTERRUPT_THREE", "INTERRUPT_FINAL"]) {
          await expect(turn.getByText(marker, { exact: true })).toBeVisible();
        }

        return await turn
          .locator('[data-slot="bubble"]')
          .evaluateAll(
            (elements, wanted) =>
              elements.map((element) => element.textContent.trim()).filter((text) => wanted.includes(text)),
            expected
          );
      }
    );

    expect(order).toEqual(expected);
    await expect(turn.locator('[data-slot="trace-collapsible-content"]')).toHaveCount(0);
  }
}
