import { type Page, expect } from "@playwright/test";

const REQUIRED_STABLE_FRAMES = 8;
const pixelTolerance = 3;
export const viewport = '[data-slot="message-scroller-viewport"]';

/**
Checks actual mounted row bounds for uncovered regions inside the transcript viewport.
@param page - Browser containing the offline virtualized transcript.
@returns Whether painted rows cover the visible viewport.
*/
export async function hasVisibleCoverage(page: Page) {
  return page.locator(viewport).evaluate((element) => {
    const TOP_GAP = 32;
    const BOTTOM_GAP = 64;
    const LAST_ROW = -1;
    const bounds = element.getBoundingClientRect();
    const visible = [
      ...element.querySelectorAll<HTMLElement>(
        ':scope [data-transcript-row]:not([data-activity-row]), :scope [data-activity-row] [data-slot="trace-collapsible-trigger"]'
      ),
    ]
      .map((item) => item.getBoundingClientRect())
      .filter((item) => item.bottom > bounds.top && item.top < bounds.bottom);

    return (
      visible.length > 0 &&
      visible[0].top <= bounds.top + TOP_GAP &&
      (visible.at(LAST_ROW)?.bottom ?? 0) >= bounds.bottom - BOTTOM_GAP
    );
  });
}

/**
Dispatches pointer activity before positioning the standard native transcript scroller.
@param page - Browser containing the mounted transcript.
@param fraction - Requested fraction of the available scroll range.
@returns Completion of the native scroll input.
*/
export async function scrollToFraction(page: Page, fraction: number) {
  await page.locator(viewport).evaluate((element, part) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    element.scrollTop = (element.scrollHeight - element.clientHeight) * part;
  }, fraction);
  await expect.poll(() => hasVisibleCoverage(page)).toBe(true);
}

/**
Captures the first visible non-activity transcript row and its viewport offset.
@param page - Browser containing the mounted transcript.
@returns Visible row identity and vertical offset.
*/
async function visibleAnchor(page: Page) {
  return page.locator(viewport).evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const item = [...element.querySelectorAll<HTMLElement>("[data-transcript-row]:not([data-activity-row])")].find(
      (candidate) => candidate.getBoundingClientRect().bottom > top
    );

    if (!item?.dataset.transcriptRow) {
      throw new Error("No visible transcript anchor");
    }

    return { id: item.dataset.transcriptRow, top: item.getBoundingClientRect().top - top };
  });
}

/**
Waits for browser animation frames before sampling a stable transcript anchor.
@param page - Browser containing the mounted transcript.
@returns Anchor identity and offset after browser layout settles.
*/
export async function settledAnchor(page: Page) {
  await page.locator(viewport).evaluate(
    (element, requiredFrames) =>
      new Promise<void>((resolve) => {
        let last = element.scrollTop;
        let stableFrames = 0;

        const sample = () => {
          stableFrames = Math.abs(element.scrollTop - last) < 1 ? stableFrames + 1 : 0;
          last = element.scrollTop;

          if (stableFrames >= requiredFrames) {
            resolve();
          } else {
            globalThis.requestAnimationFrame(sample);
          }
        };

        globalThis.requestAnimationFrame(sample);
      }),
    REQUIRED_STABLE_FRAMES
  );

  return visibleAnchor(page);
}

/**
Waits until the saved visible row returns to its prior native viewport offset.
@param page - Browser containing the mounted transcript.
@param anchor - Previously sampled row identity and vertical offset.
@returns Completion of the retained-anchor assertion.
*/
export async function expectAnchor(page: Page, anchor: { id: string; top: number }) {
  await expect
    .poll(async () => {
      return page.locator(viewport).evaluate((element, saved) => {
        const message = [...element.querySelectorAll<HTMLElement>("[data-transcript-row]")].find(
          (candidate) => candidate.dataset.transcriptRow === saved.id
        );

        return message
          ? Math.abs(message.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.top)
          : Infinity;
      }, anchor);
    })
    .toBeLessThan(pixelTolerance);
}
