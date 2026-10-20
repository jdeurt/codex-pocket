import { expect, test } from "@playwright/test";
import { initialSnapshot } from "../../src/lib/protocol";
import { mount } from "./virtualization-fixture";
import { setVisualViewport } from "./focused-fixture";

const KEYBOARD_HEIGHT = 380;
const CLOSING_HEIGHT = 540;
const STATUS_GAP = 24;
const COMPOSER_GAP = 10;
const TOLERANCE = 1;
const PARAGRAPHS = 4;

test("short transcript settles at the composer after blur without a scroll gesture", async ({ page }, info) => {
  const input = page.getByRole("textbox", { name: "Message Pocket" });
  const measure = () =>
    page.locator('[data-message-id="last-reply"] .markdown > :last-child').evaluate((last) => {
      const label = document.querySelector(".activity-indicator > span:last-child");
      const row = document.querySelector(".activity-row");
      const composer = document.querySelector(".composer");
      const viewport = document.querySelector('[data-slot="message-scroller-viewport"]');

      if (!label || !row || !composer || !viewport) {
        throw new Error("The transcript tail and composer must be mounted.");
      }

      return {
        statusGap: label.getBoundingClientRect().top - last.getBoundingClientRect().bottom,
        composerGap: composer.getBoundingClientRect().top - row.getBoundingClientRect().bottom,
        endDistance: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        contentHeight: last.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top,
        viewportHeight: viewport.clientHeight,
      };
    });

  const difference = async (property: "composerGap" | "statusGap" | "endDistance", expected: number) => {
    const measured = await measure();

    return Math.abs(measured[property] - expected);
  };

  await mount(page, {
    ...initialSnapshot,
    connection: "connected",
    threadId: "keyboard-short",
    activeTurnId: "short-turn",
    activity: "Checking",
    turns: [
      {
        id: "short-turn",
        status: "inProgress",
        items: [
          {
            id: "last-reply",
            type: "agentMessage",
            text: Array.from({ length: PARAGRAPHS }, () => "A short reply that should return to the bottom.").join(
              "\n\n"
            ),
          },
        ],
      },
    ],
  });
  await input.fill("A draft\nwith multiple lines\nthat remains unsent");
  await setVisualViewport(page, KEYBOARD_HEIGHT);
  await expect(page.locator(".chat-shell")).toHaveCSS("height", "380px");
  await expect.poll(() => difference("composerGap", COMPOSER_GAP)).toBeLessThan(TOLERANCE);
  await input.evaluate((element) => {
    element.blur();
  });
  await expect(page.locator(".chat-shell")).not.toHaveAttribute("style", /composer-viewport/);

  for (const height of [CLOSING_HEIGHT, page.viewportSize()?.height ?? CLOSING_HEIGHT]) {
    await setVisualViewport(page, height);
    await expect.poll(() => difference("composerGap", COMPOSER_GAP)).toBeLessThan(TOLERANCE);
    await expect.poll(() => difference("statusGap", STATUS_GAP)).toBeLessThan(TOLERANCE);
    await expect.poll(() => difference("endDistance", 0)).toBeLessThan(TOLERANCE);
  }

  await expect(input).not.toBeFocused();
  await expect(input).toHaveValue("A draft\nwith multiple lines\nthat remains unsent");
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toHaveCount(0);
  await info.attach("keyboard-close-layout", {
    body: JSON.stringify(await measure()),
    contentType: "application/json",
  });
});
