import { type Page, test } from "@playwright/test";
import { checkImageAppearance } from "./image-appearance";
import { initialSnapshot } from "../../src/lib/protocol";
import path from "node:path";

async function showImage(page: Page) {
  const state = {
    ...initialSnapshot,
    connection: "connected",
    turns: [
      {
        id: "image-appearance",
        status: "completed",
        items: [
          {
            id: "image",
            type: "agentMessage",
            phase: "final_answer",
            text: `![Image appearance fixture](${path.resolve("public/icon-192.png")})`,
          },
        ],
      },
    ],
  };
  await page.route("**/api/events", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify(state)}\n\n` })
  );
  await page.goto("http://127.0.0.1:3101/");

  return page
    .locator('[data-slot="message-scroller-item"]')
    .filter({ has: page.getByRole("img", { name: "Image appearance fixture", exact: true }) });
}

test("images keep their appearance through hover, press, touch and keyboard preview controls", async ({
  page,
  browser,
}) => {
  await checkImageAppearance(page, await showImage(page), "phone");
  await page.screenshot({ path: ".local/image-appearance-phone.png", fullPage: true });
  const desktop = await browser.newPage({ viewport: { width: 1024, height: 768 }, isMobile: false, hasTouch: false });

  try {
    await checkImageAppearance(desktop, await showImage(desktop), "desktop");
    await desktop.screenshot({ path: ".local/image-appearance-desktop.png", fullPage: true });
  } finally {
    await desktop.close();
  }
});
