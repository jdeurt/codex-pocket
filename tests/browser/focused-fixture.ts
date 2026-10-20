import { type CDPSession, type Locator, type Page, expect } from "@playwright/test";
import { focusedSnapshot } from "../fixtures/focused-transcript";

const MIN_TRANSCRIPT_HEIGHT = 1000;

/**
Selects the real parent transcript viewport for focus and native scroll checks.
@param page - Browser containing the mounted parent conversation.
@returns First transcript viewport locator.
*/
export const scroller = (page: Page) => page.locator('[data-slot="message-scroller-viewport"]').first();
/**
Selects the actual writable parent composer.
@param page - Browser containing the mounted parent conversation.
@returns Accessible parent message textbox locator.
*/
export const input = (page: Page) => page.getByRole("textbox", { name: "Message Pocket", exact: true });
/**
Samples the actual parent transcript scroll offset.
@param page - Browser containing the mounted parent conversation.
@returns Native vertical transcript offset.
*/
export const scrollTop = (page: Page) => scroller(page).evaluate((element) => element.scrollTop);

/**
Verifies that transcript interactions have not scrolled the outer document.
@param page - Browser showing the real mounted chat.
@returns Completion of window/document/body offset assertions.
*/
export async function assertDocumentStable(page: Page) {
  expect(
    await page.evaluate(() => ({
      window: globalThis.scrollY,
      root: globalThis.document.documentElement.scrollTop,
      body: globalThis.document.body.scrollTop,
      shell: globalThis.document.querySelector(".chat-shell")?.scrollTop,
    }))
  ).toEqual({ window: 0, root: 0, body: 0, shell: 0 });
}

/**
Scrolls the real transcript using native wheel input or the mobile WebKit DOM fallback.
@param page - Browser providing native mouse input.
@param target - Mounted transcript viewport.
@param delta - Requested vertical wheel displacement.
@param isMobileWebkit - Whether the browser lacks Playwright wheel injection.
@returns Completion of the requested scroll input.
*/
export async function scrollWithWheel(page: Page, target: Locator, delta: number, isMobileWebkit: boolean) {
  if (isMobileWebkit) {
    // Playwright cannot inject wheel/swipe scrolling in mobile WebKit.
    await target.evaluate((element, amount) => {
      element.scrollBy(0, amount);
    }, delta);
  } else {
    await target.hover();
    await page.mouse.wheel(0, delta);
  }
}

/**
Mounts the real focused chat with one canonical offline snapshot and blocked API mutations.
@param page - Isolated browser receiving native snapshot events.
@returns Completion of writable-composer and transcript-readiness assertions.
*/
export async function mountFocusedChat(page: Page) {
  // No route can send a message or touch the running Pocket service.
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.addInitScript((state) => {
    /**
    Replays a single canonical snapshot through the browser's native event dispatch.
    */
    class FixtureEventSource extends EventTarget {
      readyState = 1;

      /**
      Schedules the initial fixture snapshot after the native event target is initialized.
      */
      constructor() {
        super();
        setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(state) })), 0);
      }

      /**
      Leaves the connection-free snapshot fixture closed without native network work.
      */
      close() {
        /*
        This fixture does not open a connection.
        */
      }
    }

    Object.defineProperty(globalThis, "EventSource", { value: FixtureEventSource });
  }, focusedSnapshot);
  await page.goto("/");
  await expect(input(page)).toBeEnabled();
  await expect
    .poll(() => scroller(page).evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(MIN_TRANSCRIPT_HEIGHT);
}

/**
Injects the existing Chromium touch gesture with frame cadence required by the native compositor.
@param page - Mobile Chromium browser providing the same frame waits as the original gesture.
@param cdp - Owned native CDP session, detached by the caller.
@param x - Actual viewport-center horizontal coordinate.
@param y - Actual viewport-center vertical coordinate.
@returns Completion of native touch start, moves and end.
*/
export async function touchTranscript(page: Page, cdp: CDPSession, x: number, y: number) {
  const TOUCH_START_OFFSET = 100;
  const TOUCH_STEPS = 10;
  const TOUCH_STEP_DISTANCE = 20;
  const FRAME_MS = 16;

  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y + TOUCH_START_OFFSET }] });

  for (let step = 1; step <= TOUCH_STEPS; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + TOUCH_START_OFFSET - step * TOUCH_STEP_DISTANCE }],
    });
    await page.waitForTimeout(FRAME_MS);
  }

  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
