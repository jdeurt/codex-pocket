import { type Page, expect, test } from "@playwright/test";
import { initialSnapshot } from "../../src/lib/protocol";
import { mount } from "./virtualization-fixture";
import { setVisualViewport } from "./focused-fixture";

const INSET_GAIN = 16;
const SAFE_AREA = 34;
const LANDSCAPE_SAFE_AREA = 21;
const SMALL_SAFE_AREA = 8;
const HIT_TARGET = 44;
const KEYBOARD_HEIGHT = 380;
const TOLERANCE = 1;
const STATUS_GAP = 10;

/** Emulate native inset changes in the copied standalone CSS rule.
@param page - Browser rendering the actual standalone rule.
@param pixels - Native bottom inset for this orientation or keyboard state.
*/
async function safeArea(page: Page, pixels: number) {
  await page.evaluate((value) => {
    globalThis.document.documentElement.style.setProperty("--pocket-test-safe-area", `${String(value)}px`);
  }, pixels);
}

/**
Read layout footprint so moving the composer must grow the transcript rather than leave a dead strip.
@param page - Browser displaying the real chat layout.
@returns Native rectangle and padding measurements.
*/
async function layout(page: Page) {
  return page.locator(".chat-shell").evaluate((shell) => {
    const footer = shell.querySelector(".composer-wrap");
    const viewport = shell.querySelector('[data-slot="message-scroller-viewport"]')?.getBoundingClientRect();
    const box = footer?.getBoundingClientRect();
    const send = shell.querySelector(".send-button")?.getBoundingClientRect();
    const composer = shell.querySelector(".composer")?.getBoundingClientRect();
    const activity = shell.querySelector(".activity-row")?.getBoundingClientRect();

    if (!footer || !viewport || !box || !send || !composer || !activity) {
      throw new Error("The composer, status row and transcript must be mounted before measurement.");
    }

    return {
      screenWidth: globalThis.innerWidth,
      screenHeight: globalThis.innerHeight,
      sendBottom: send.bottom,
      sendHeight: send.height,
      sendWidth: send.width,
      footerHeight: box.height,
      footerBottom: box.bottom,
      composerBottom: composer.bottom,
      statusHeight: activity.height,
      statusGap: composer.top - activity.bottom,
      padding: Number(getComputedStyle(footer).paddingBottom.replace("px", "")),
      viewportHeight: viewport.height,
    };
  });
}

test("standalone iOS padding expands the transcript and keeps keyboard controls inside the viewport", async ({
  page,
  browserName,
}, info) => {
  const baseline = await test.step("Measure browser mode before emulating standalone", async () => {
    test.skip(browserName !== "webkit", "The standalone adjustment is iOS/WebKit only.");
    await mount(page, {
      ...initialSnapshot,
      connection: "connected",
      turns: [{ id: "short", status: "completed", items: [{ id: "text", type: "agentMessage", text: "Hello" }] }],
    });

    return layout(page);
  });
  const standalone =
    await test.step("Enable the actual standalone CSS media branch in the emulated browser", async () => {
      await page.locator("body").evaluate((body) => {
        const browser = body.ownerDocument.defaultView;
        const visit = (rules: CSSRuleList) => {
          for (const rule of rules) {
            if (
              browser &&
              rule instanceof browser.CSSSupportsRule &&
              rule.conditionText.includes("-webkit-touch-callout")
            ) {
              const style = globalThis.document.createElement("style");

              style.dataset.pocketStandalone = "";
              style.textContent = rule.cssText
                .replace(/@supports[^{}]+/, "@media all")
                .replace("(display-mode: standalone)", "all")
                .replaceAll("env(safe-area-inset-bottom)", "var(--pocket-test-safe-area, 0px)");
              globalThis.document.head.append(style);
            }

            if (browser && rule instanceof browser.CSSGroupingRule) {
              visit(rule.cssRules);
            }
          }
        };

        for (const sheet of globalThis.document.styleSheets) {
          visit(sheet.cssRules);
        }
      });
      await expect
        .poll(async () => {
          const measured = await layout(page);

          return measured.padding;
        })
        .toBe(0);

      return layout(page);
    });

  const inset = await test.step("Reduce the simulated portrait safe area by exactly 16px", async () => {
    await safeArea(page, SAFE_AREA);
    await expect
      .poll(async () => {
        const measured = await layout(page);

        return measured.padding;
      })
      .toBe(SAFE_AREA - INSET_GAIN);

    return layout(page);
  });
  const previous = await test.step("Measure the transcript gain against the previous full-inset layout", async () => {
    const priorRule = await page.addStyleTag({ content: `.composer-wrap { padding-bottom: ${String(SAFE_AREA)}px; }` });
    const measured = await layout(page);

    await priorRule.evaluate((element) => {
      if (element instanceof HTMLElement) {
        element.remove();
      }
    });

    return measured;
  });
  const rotated = await test.step("Measure the same safe area after an orientation change", async () => {
    await page.setViewportSize({ width: standalone.screenHeight, height: standalone.screenWidth });
    await safeArea(page, LANDSCAPE_SAFE_AREA);
    await expect
      .poll(async () => {
        const measured = await layout(page);

        return measured.footerBottom;
      })
      .toBeLessThanOrEqual(standalone.screenWidth + TOLERANCE);

    return layout(page);
  });

  expect(baseline.padding - standalone.padding).toBe(INSET_GAIN);
  expect(baseline.footerHeight - standalone.footerHeight).toBe(INSET_GAIN);
  expect(standalone.viewportHeight - baseline.viewportHeight).toBe(INSET_GAIN);
  expect(inset.footerHeight - standalone.footerHeight).toBe(SAFE_AREA - INSET_GAIN);
  expect(previous.footerHeight - inset.footerHeight).toBe(INSET_GAIN);
  expect(inset.composerBottom - previous.composerBottom).toBe(INSET_GAIN);
  expect(inset.viewportHeight - previous.viewportHeight).toBe(INSET_GAIN);
  expect(inset.screenHeight - inset.composerBottom).toBe(SAFE_AREA - INSET_GAIN);
  expect(rotated.padding).toBe(LANDSCAPE_SAFE_AREA - INSET_GAIN);
  expect(rotated.sendBottom).toBeLessThanOrEqual(rotated.screenHeight - rotated.padding + TOLERANCE);
  expect(rotated.sendHeight).toBeGreaterThanOrEqual(HIT_TARGET);
  expect(rotated.sendWidth).toBeGreaterThanOrEqual(HIT_TARGET);

  for (const measured of [standalone, inset, rotated]) {
    expect(measured.statusHeight).toBe(HIT_TARGET);
    expect(measured.statusGap).toBe(STATUS_GAP);
  }

  await test.step("Clamp smaller native insets to zero rather than negative padding", async () => {
    await safeArea(page, SMALL_SAFE_AREA);
    await expect
      .poll(async () => {
        const measured = await layout(page);

        return measured.padding;
      })
      .toBe(0);
  });
  await info.attach("standalone-layout", {
    body: JSON.stringify({ baseline, standalone, previous, inset, rotated, safeArea: "emulated 0, 8, 21 and 34px" }),
    contentType: "application/json",
  });
  await page.getByRole("textbox", { name: "Message Pocket" }).focus();
  await safeArea(page, 0);
  await setVisualViewport(page, KEYBOARD_HEIGHT);
  await expect
    .poll(async () => {
      const measured = await layout(page);

      return measured.footerBottom;
    })
    .toBeLessThanOrEqual(KEYBOARD_HEIGHT + TOLERANCE);
  await expect(page.getByRole("button", { name: /^Send message(?:;|$)/ })).toBeInViewport();
});
