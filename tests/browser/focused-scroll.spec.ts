import { type Locator, type Page, expect, test } from "@playwright/test";
import { focusedSnapshot } from "../fixtures/focused-transcript";

const MIN_TRANSCRIPT_HEIGHT = 1000;
const TRANSCRIPT_WHEEL_DELTA = 400;
const MIN_TRANSCRIPT_TRAVEL = 100;
const HEADER_WHEEL_DELTA = 1200;
const BOUNDARY_WHEEL_DELTA = 100_000;
const MIN_EDITOR_OVERFLOW = 500;
const MAX_EDITOR_HEIGHT = 168;
const EDITOR_WHEEL_DELTA = 250;
const MIN_EDITOR_TRAVEL = 50;
const FOCUSED_VIEWPORT_HEIGHT = 380;
const FOCUSED_VIEWPORT_TOP = 24;
const FOCUSED_COMPOSER_BOTTOM = 404;
const RESTORED_VIEWPORT_HEIGHT = 460;
const GROWING_DRAFT_LINES = 30;
const ZOOMED_VIEWPORT_HEIGHT = 230;
const HIDDEN_VIEWPORT_HEIGHT = 280;
const RESIZE_DRAFT_LINES = 8;
const RESIZED_VIEWPORT_HEIGHT = 420;
const BACKWARD_WHEEL_DELTA = 200;

const scroller = (page: Page) => page.locator('[data-slot="message-scroller-viewport"]').first();
const input = (page: Page) => page.getByRole("textbox", { name: "Message Pocket", exact: true });
const scrollTop = (page: Page) => scroller(page).evaluate((element) => element.scrollTop);

async function assertDocumentStable(page: Page) {
  expect(
    await page.evaluate(() => ({
      window: globalThis.scrollY,
      root: globalThis.document.documentElement.scrollTop,
      body: globalThis.document.body.scrollTop,
      shell: globalThis.document.querySelector(".chat-shell")?.scrollTop,
    }))
  ).toEqual({ window: 0, root: 0, body: 0, shell: 0 });
}

test.beforeEach(async ({ page }) => {
  // No route can send a message or touch the running Pocket service.
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.addInitScript((state) => {
    class FixtureEventSource extends EventTarget {
      readyState = 1;

      constructor() {
        super();
        setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(state) })), 0);
      }

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
});

async function scrollWithWheel(page: Page, target: Locator, delta: number, mobileWebkit: boolean) {
  if (mobileWebkit) {
    // Playwright cannot inject wheel/swipe scrolling in mobile WebKit.
    await target.evaluate((element, amount) => {
      element.scrollBy(0, amount);
    }, delta);
  } else {
    await target.hover();
    await page.mouse.wheel(0, delta);
  }
}

test("focused composer contains page scrolling and preserves transcript and textarea scrolling", async ({
  page,
  browserName,
  isMobile,
}, info) => {
  const mobileWebkit = browserName === "webkit" && isMobile;

  if (mobileWebkit) {
    info.annotations.push({
      type: "limit",
      description: "Mobile WebKit scrolling uses DOM offsets; native wheel/swipes unsupported by Playwright.",
    });
  }

  await input(page).fill("Draft stays local");
  await expect(page.locator("body")).toHaveCSS("position", "fixed");
  await page.evaluate(() => {
    const DOCUMENT_PAN_DISTANCE = 300;

    globalThis.scrollTo(0, DOCUMENT_PAN_DISTANCE);
  });
  await assertDocumentStable(page);
  const composerBottom = await page
    .locator(".composer-wrap")
    .evaluate((element) => element.getBoundingClientRect().bottom);

  await scroller(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  const before = await scrollTop(page);

  await scrollWithWheel(page, scroller(page), -TRANSCRIPT_WHEEL_DELTA, mobileWebkit);
  await expect.poll(() => scrollTop(page)).toBeLessThan(before - MIN_TRANSCRIPT_TRAVEL);
  await expect(input(page)).toBeFocused();
  await assertDocumentStable(page);

  await scrollWithWheel(page, page.locator(".chat-header"), HEADER_WHEEL_DELTA, mobileWebkit);
  await assertDocumentStable(page);
  expect(await page.locator(".composer-wrap").evaluate((element) => element.getBoundingClientRect().bottom)).toBe(
    composerBottom
  );

  // Overscroll at both transcript boundaries must not chain to the document.
  for (const end of [false, true]) {
    await scroller(page).evaluate((element, atEnd) => {
      element.scrollTop = atEnd ? element.scrollHeight : 0;
    }, end);
    await scrollWithWheel(page, scroller(page), end ? BOUNDARY_WHEEL_DELTA : -BOUNDARY_WHEEL_DELTA, mobileWebkit);
    await assertDocumentStable(page);
  }

  const shortHeight = await input(page).evaluate((element) => element.clientHeight);

  await input(page).fill(Array.from({ length: 45 }, (_, index) => `Draft line ${String(index)}`).join("\n"));
  await expect.poll(() => input(page).evaluate((element) => element.clientHeight)).toBeGreaterThan(shortHeight);
  await expect
    .poll(() => input(page).evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(MIN_EDITOR_OVERFLOW);
  expect(await input(page).evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(MAX_EDITOR_HEIGHT);
  await input(page).evaluate((element) => {
    element.scrollTop = 0;
  });
  await scrollWithWheel(page, input(page), EDITOR_WHEEL_DELTA, mobileWebkit);
  await expect.poll(() => input(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(MIN_EDITOR_TRAVEL);
  await assertDocumentStable(page);

  await input(page).focus();
  await page.keyboard.press("ControlOrMeta+a");
  expect(
    await input(page).evaluate((element: HTMLTextAreaElement) => element.selectionEnd - element.selectionStart)
  ).toBeGreaterThan(MIN_TRANSCRIPT_TRAVEL);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Shift+ArrowRight");
  expect(
    await input(page).evaluate((element: HTMLTextAreaElement) => element.selectionEnd - element.selectionStart)
  ).toBe(1);
  await page.keyboard.press("Tab");
  const attach = page.getByRole("button", { name: "Attach images or files", exact: true });
  const nextControl =
    (await attach.count()) > 0 ? attach : page.getByRole("button", { name: "Send message", exact: true });

  await expect(nextControl).toBeFocused();
  await expect(page.locator("body")).toHaveCSS("position", "static");
  await expect(page.locator(".chat-shell")).not.toHaveAttribute("style", /composer-viewport/);

  // Keyboard navigation scrolls the transcript after focus moves into it.
  await scroller(page).evaluate((element) => {
    element.tabIndex = 0;
    element.scrollTop = element.scrollHeight / 2;
    element.focus();
  });
  const keyboardBefore = await scrollTop(page);

  await page.keyboard.press("PageUp");
  await expect.poll(() => scrollTop(page)).toBeLessThan(keyboardBefore);
  await page.keyboard.press("PageDown");
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(keyboardBefore - MIN_TRANSCRIPT_TRAVEL);
  await assertDocumentStable(page);

  await input(page).focus();
  await input(page).fill("Short again");
  await expect.poll(() => input(page).evaluate((element) => element.clientHeight)).toBe(shortHeight);
  await assertDocumentStable(page);
  await page.screenshot({ path: info.outputPath("focused-composer.png") });
});

test("focused shell follows keyboard-like visual viewport changes and releases them on blur", async ({
  page,
  browserName,
  isMobile,
}, info) => {
  // Emulation does not open an OS keyboard. Emit its visual-only resize/pan
  // sequence independently of layout viewport resizing (Safari's behavior).
  await page.addInitScript(() => {
    const viewport = new EventTarget();

    Object.defineProperties(viewport, {
      height: { configurable: true, get: () => globalThis.innerHeight },
      offsetTop: { configurable: true, value: 0 },
      scale: { configurable: true, value: 1 },
    });
    Object.defineProperty(globalThis, "visualViewport", { configurable: true, value: viewport });
  });
  await page.reload();
  await expect(input(page)).toBeEnabled();
  await input(page).fill("Keyboard viewport draft");
  const originalHeight = await page.locator(".chat-shell").evaluate((element) => element.clientHeight);
  const setViewport = (height: number, offsetTop = 0, scale = 1) =>
    page.evaluate(
      (values) => {
        const viewport = globalThis.visualViewport;

        if (!viewport) {
          throw new Error("Visual viewport is unavailable");
        }

        for (const [name, value] of Object.entries(values)) {
          Object.defineProperty(viewport, name, { configurable: true, value });
        }

        viewport.dispatchEvent(new Event("resize"));
        viewport.dispatchEvent(new Event("scroll"));
      },
      { height, offsetTop, scale }
    );

  await setViewport(FOCUSED_VIEWPORT_HEIGHT, FOCUSED_VIEWPORT_TOP);
  await expect(page.locator(".chat-shell")).toHaveCSS("height", "380px");
  await expect(page.locator(".chat-shell")).toHaveCSS("top", "24px");
  expect(await page.locator(".composer-wrap").evaluate((element) => element.getBoundingClientRect().bottom)).toBe(
    FOCUSED_COMPOSER_BOTTOM
  );
  await assertDocumentStable(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(() => {
            resolve();
          })
        )
      )
  );
  await scroller(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  const before = await scrollTop(page);

  await scrollWithWheel(page, scroller(page), -BACKWARD_WHEEL_DELTA, browserName === "webkit" && isMobile);
  await expect.poll(() => scrollTop(page)).toBeLessThan(before);

  await setViewport(RESTORED_VIEWPORT_HEIGHT);
  await expect(page.locator(".chat-shell")).toHaveCSS("height", "460px");
  await input(page).fill("Growing draft\n".repeat(GROWING_DRAFT_LINES));
  expect(await page.locator(".composer-wrap").evaluate((element) => element.getBoundingClientRect().bottom)).toBe(
    RESTORED_VIEWPORT_HEIGHT
  );
  await assertDocumentStable(page);
  await page.screenshot({ path: info.outputPath("keyboard-viewport.png") });

  await setViewport(ZOOMED_VIEWPORT_HEIGHT, 0, 2);
  await expect(page.locator(".chat-shell")).not.toHaveAttribute("style", /composer-viewport/);
  await setViewport(FOCUSED_VIEWPORT_HEIGHT);
  await input(page).evaluate((element) => {
    element.blur();
  });
  await expect(page.locator("body")).toHaveCSS("position", "static");
  await expect(page.locator(".chat-shell")).not.toHaveAttribute("style", /composer-viewport/);
  await setViewport(HIDDEN_VIEWPORT_HEIGHT);
  expect(await page.locator(".chat-shell").evaluate((element) => element.clientHeight)).toBe(originalHeight);
  await input(page).focus();
  await expect(page.locator(".chat-shell")).toHaveCSS("height", "280px");
  await setViewport(originalHeight);
  await assertDocumentStable(page);
});

test("real browser viewport resize keeps the composer within the focused shell", async ({ page }) => {
  await input(page).fill("Resize draft\n".repeat(RESIZE_DRAFT_LINES));
  const size = page.viewportSize();

  if (!size) {
    throw new Error("Viewport dimensions are unavailable");
  }

  await page.setViewportSize({ width: size.width, height: 420 });
  await expect
    .poll(() => page.locator(".chat-shell").evaluate((element) => element.clientHeight))
    .toBe(RESIZED_VIEWPORT_HEIGHT);
  expect(await page.locator(".composer-wrap").evaluate((element) => element.getBoundingClientRect().bottom)).toBe(
    RESIZED_VIEWPORT_HEIGHT
  );
  await assertDocumentStable(page);
  await page.setViewportSize(size);
  await expect.poll(() => page.locator(".chat-shell").evaluate((element) => element.clientHeight)).toBe(size.height);
  await input(page).evaluate((element) => {
    element.blur();
  });
  await assertDocumentStable(page);
});

test("Chromium phone touch scrolls the transcript while the composer stays focused", async ({
  page,
  browserName,
  isMobile,
}) => {
  test.skip(browserName !== "chromium" || !isMobile, "Native touch injection is available through Chromium CDP.");
  await input(page).fill("Touch draft");
  await scroller(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  const before = await scrollTop(page);
  const bounds = await scroller(page).boundingBox();

  if (!bounds) {
    throw new Error("Transcript geometry is unavailable");
  }

  const cdp = await page.context().newCDPSession(page);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
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
    // A real gesture needs frame cadence for the compositor to produce scrolling.
    await page.waitForTimeout(FRAME_MS);
  }

  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(before + MIN_EDITOR_TRAVEL);
  await expect(input(page)).toBeFocused();
  await assertDocumentStable(page);
  await cdp.detach();
});
