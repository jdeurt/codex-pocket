import {
  assertDocumentStable,
  input,
  mountFocusedChat,
  scrollTop,
  scrollWithWheel,
  scroller,
  setVisualViewport,
  touchTranscript,
} from "./focused-fixture";
import { expect, test } from "@playwright/test";
import { composerFocusEndTests } from "./focused-end-flows";

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

test.beforeEach(async ({ page }) => {
  await mountFocusedChat(page);
});

composerFocusEndTests();

test("focused composer contains page scrolling and preserves transcript and textarea scrolling", async ({
  page,
  browserName,
  isMobile,
}, info) => {
  const isMobileWebkit = browserName === "webkit" && isMobile;
  const attach = page.getByRole("button", { name: "Attach images or files", exact: true });

  const composerBottom = await test.step("Focus the parent draft and contain native document panning", async () => {
    if (isMobileWebkit) {
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

    return await page.locator(".composer-wrap").evaluate((element) => element.getBoundingClientRect().bottom);
  });
  const before = await test.step("Position the transcript at its native midpoint", async () => {
    await scroller(page).evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
    });

    return await scrollTop(page);
  });
  const shortHeight = await test.step("Check focused wheel and transcript-boundary containment", async () => {
    await scrollWithWheel(page, scroller(page), -TRANSCRIPT_WHEEL_DELTA, isMobileWebkit);
    await expect.poll(() => scrollTop(page)).toBeLessThan(before - MIN_TRANSCRIPT_TRAVEL);
    await expect(input(page)).toBeFocused();
    await assertDocumentStable(page);

    await scrollWithWheel(page, page.locator(".chat-header"), HEADER_WHEEL_DELTA, isMobileWebkit);
    await assertDocumentStable(page);
    expect(await page.locator(".composer-wrap").evaluate((element) => element.getBoundingClientRect().bottom)).toBe(
      composerBottom
    );

    // Overscroll at both transcript boundaries must not chain to the document.
    for (const isEnd of [false, true]) {
      await scroller(page).evaluate((element, atEnd) => {
        element.scrollTop = atEnd ? element.scrollHeight : 0;
      }, isEnd);
      await scrollWithWheel(page, scroller(page), isEnd ? BOUNDARY_WHEEL_DELTA : -BOUNDARY_WHEEL_DELTA, isMobileWebkit);
      await assertDocumentStable(page);
    }

    return await input(page).evaluate((element) => element.clientHeight);
  });
  const nextControl = await test.step("Grow the editor and preserve native text selection", async () => {
    await input(page).fill(Array.from({ length: 45 }, (_, index) => `Draft line ${String(index)}`).join("\n"));
    await expect.poll(() => input(page).evaluate((element) => element.clientHeight)).toBeGreaterThan(shortHeight);
    await expect
      .poll(() => input(page).evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeGreaterThan(MIN_EDITOR_OVERFLOW);
    expect(await input(page).evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(MAX_EDITOR_HEIGHT);
    await input(page).evaluate((element) => {
      element.scrollTop = 0;
    });
    await scrollWithWheel(page, input(page), EDITOR_WHEEL_DELTA, isMobileWebkit);
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

    return (await attach.count()) > 0 ? attach : page.getByRole("button", { name: /^Send message(?:;|$)/ });
  });
  const keyboardBefore = await test.step("Release composer focus and focus the native transcript", async () => {
    await expect(nextControl).toBeFocused();
    await expect(page.locator("body")).toHaveCSS("position", "static");
    await expect(page.locator(".chat-shell")).not.toHaveAttribute("style", /composer-viewport/);

    // Keyboard navigation scrolls the transcript after focus moves into it.
    await scroller(page).evaluate((element) => {
      element.tabIndex = 0;
      element.scrollTop = element.scrollHeight / 2;
      element.focus();
    });

    return await scrollTop(page);
  });

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
  const originalHeight = await test.step("Install visual-only viewport events and focus the parent draft", async () => {
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

    return await page.locator(".chat-shell").evaluate((element) => element.clientHeight);
  });
  const before = await test.step("Apply keyboard-like viewport changes before measuring native scroll", async () => {
    await setVisualViewport(page, FOCUSED_VIEWPORT_HEIGHT, FOCUSED_VIEWPORT_TOP);
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

    return await scrollTop(page);
  });

  await scrollWithWheel(page, scroller(page), -BACKWARD_WHEEL_DELTA, browserName === "webkit" && isMobile);
  await expect.poll(() => scrollTop(page)).toBeLessThan(before);

  await setVisualViewport(page, RESTORED_VIEWPORT_HEIGHT);
  await expect(page.locator(".chat-shell")).toHaveCSS("height", "460px");
  await input(page).fill("Growing draft\n".repeat(GROWING_DRAFT_LINES));
  expect(await page.locator(".composer-wrap").evaluate((element) => element.getBoundingClientRect().bottom)).toBe(
    RESTORED_VIEWPORT_HEIGHT
  );
  await assertDocumentStable(page);
  await page.screenshot({ path: info.outputPath("keyboard-viewport.png") });

  await setVisualViewport(page, ZOOMED_VIEWPORT_HEIGHT, 0, 2);
  await expect(page.locator(".chat-shell")).not.toHaveAttribute("style", /composer-viewport/);
  await setVisualViewport(page, FOCUSED_VIEWPORT_HEIGHT);
  await input(page).evaluate((element) => {
    element.blur();
  });
  await expect(page.locator("body")).toHaveCSS("position", "static");
  await expect(page.locator(".chat-shell")).not.toHaveAttribute("style", /composer-viewport/);
  await setVisualViewport(page, HIDDEN_VIEWPORT_HEIGHT);
  expect(await page.locator(".chat-shell").evaluate((element) => element.clientHeight)).toBe(originalHeight);
  await input(page).focus();
  await expect(page.locator(".chat-shell")).toHaveCSS("height", "280px");
  await setVisualViewport(page, originalHeight);
  await assertDocumentStable(page);
});

test("real browser viewport resize keeps the composer within the focused shell", async ({ page }) => {
  const size = await test.step("Fill the resizing draft before capturing the original viewport", async () => {
    await input(page).fill("Resize draft\n".repeat(RESIZE_DRAFT_LINES));

    return page.viewportSize();
  });

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
  const before = await test.step("Require mobile Chromium and focus the transcript before native touch", async () => {
    test.skip(browserName !== "chromium" || !isMobile, "Native touch injection is available through Chromium CDP.");
    await input(page).fill("Touch draft");
    await scroller(page).evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
    });

    return await scrollTop(page);
  });
  const { cdp, x, y } = await test.step("Require actual transcript geometry before opening CDP", async () => {
    const bounds = await scroller(page).boundingBox();

    if (!bounds) {
      throw new Error("Transcript geometry is unavailable");
    }

    return {
      cdp: await page.context().newCDPSession(page),
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
  });

  try {
    await touchTranscript(page, cdp, x, y);
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(before + MIN_EDITOR_TRAVEL);
    await expect(input(page)).toBeFocused();
    await assertDocumentStable(page);
  } finally {
    await cdp.detach();
  }
});
