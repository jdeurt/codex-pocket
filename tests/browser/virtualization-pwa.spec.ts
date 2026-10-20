import { type Page, expect, test } from "@playwright/test";
import { initialSnapshot } from "../../src/lib/protocol";
import { mount } from "./virtualization-fixture";
import { setVisualViewport } from "./focused-fixture";

const INSET_GAIN = 16;
const SAFE_AREA = 34;
const HIT_TARGET = 44;
const KEYBOARD_HEIGHT = 380;
const TOLERANCE = 1;

/**
Read layout footprint so moving the composer must grow the transcript rather than leave a dead strip.
@param page - Browser displaying the real chat layout.
@returns Native rectangle and padding measurements.
*/
async function layout(page: Page) {
  return page.locator(".chat-shell").evaluate((shell) => {
    const footer = shell.querySelector(".composer-wrap");
    const viewport = shell.querySelector('[data-slot="message-scroller-viewport"]');
    const box = footer?.getBoundingClientRect();
    const send = shell.querySelector('[aria-label="Send message"]')?.getBoundingClientRect();

    return {
      screenWidth: globalThis.innerWidth,
      screenHeight: globalThis.innerHeight,
      sendBottom: send?.bottom ?? 0,
      sendHeight: send?.height ?? 0,
      sendWidth: send?.width ?? 0,
      footerHeight: box?.height ?? 0,
      footerBottom: box?.bottom ?? 0,
      padding: footer ? Number(getComputedStyle(footer).paddingBottom.replace("px", "")) : 0,
      viewportHeight: viewport?.getBoundingClientRect().height ?? 0,
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
                .replace("(display-mode: standalone)", "all");
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

  const inset = await test.step("Preserve a simulated nonzero native safe-area inset", async () => {
    await page.locator("style[data-pocket-standalone]").evaluateAll((elements, pixels) => {
      for (const element of elements) {
        element.textContent = element.textContent.replaceAll(
          "env(safe-area-inset-bottom)",
          () => `${String(pixels)}px`
        );
      }
    }, SAFE_AREA);
    await expect
      .poll(async () => {
        const measured = await layout(page);

        return measured.padding;
      })
      .toBe(SAFE_AREA);

    return layout(page);
  });
  const rotated = await test.step("Measure the same safe area after an orientation change", async () => {
    await page.setViewportSize({ width: standalone.screenHeight, height: standalone.screenWidth });
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
  expect(inset.footerHeight - standalone.footerHeight).toBe(SAFE_AREA);
  expect(rotated.padding).toBe(SAFE_AREA);
  expect(rotated.sendBottom).toBeLessThanOrEqual(rotated.screenHeight - SAFE_AREA + TOLERANCE);
  expect(rotated.sendHeight).toBeGreaterThanOrEqual(HIT_TARGET);
  expect(rotated.sendWidth).toBeGreaterThanOrEqual(HIT_TARGET);
  await info.attach("standalone-layout", {
    body: JSON.stringify({ baseline, standalone, inset, rotated, safeArea: "emulated zero and 34px insets" }),
    contentType: "application/json",
  });
  await page.getByRole("textbox", { name: "Message Pocket" }).focus();
  await setVisualViewport(page, KEYBOARD_HEIGHT);
  await expect
    .poll(async () => {
      const measured = await layout(page);

      return measured.footerBottom;
    })
    .toBeLessThanOrEqual(KEYBOARD_HEIGHT + TOLERANCE);
  await expect(page.getByRole("button", { name: "Send message" })).toBeInViewport();
});
