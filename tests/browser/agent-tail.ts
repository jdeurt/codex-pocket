import { type Locator, expect, test } from "@playwright/test";

const MINIMUM_BOTTOM_GAP = 24;

/** Measure the actual read-only tail against its panel after scrolling to the latest message.
@param chat - Open delegate transcript, including its header and viewport.
*/
export async function checkAgentTail(chat: Locator) {
  const viewport = chat.locator('[data-slot="message-scroller-viewport"]');

  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(1);
  const metrics = await chat.evaluate((element) => {
    const panel = element.getBoundingClientRect();
    const activity = element.querySelector(".activity-row")?.getBoundingClientRect();
    const rows = element.querySelectorAll("[data-transcript-row]");

    if (!activity || rows.length === 0) {
      throw new Error("Delegate transcript tail is not mounted");
    }

    const last = rows.item(rows.length - 1).getBoundingClientRect();

    return { width: panel.width, activityGap: panel.bottom - activity.bottom, messageGap: panel.bottom - last.bottom };
  });

  await test
    .info()
    .attach("delegate-tail-geometry", { body: JSON.stringify(metrics), contentType: "application/json" });
  expect(metrics.activityGap).toBeGreaterThanOrEqual(MINIMUM_BOTTOM_GAP);
  expect(metrics.messageGap).toBeGreaterThanOrEqual(MINIMUM_BOTTOM_GAP);
}
