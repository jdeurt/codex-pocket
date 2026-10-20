import { type Page, expect, test } from "@playwright/test";
import { UpdateHost } from "../fixtures/update-host";

const host = new UpdateHost();
const PROBE_INTERVAL_MS = 15_000;
const DRAFT = "Keep this unsent draft through the update.";
const RESERVED_HEIGHT = 44;
const WATCHDOG_ADVANCE_MS = 46_000;
const RETRY_ADVANCE_MS = 3000;

/**
Open the actual production UI and require its native fixture connection.
@param page - Phone-sized Chromium or WebKit page retained across host replacement.
*/
async function openPocket(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true });
  });
  await page.goto("/?pocket=main");
  await expect(page.locator('meta[name="pocket-build"]')).toHaveAttribute("content", "update-fixture-a");
  await expect(page.locator(".thread-heading")).toContainText("Connected");
  await page.getByRole("button", { name: "Dismiss notification prompt" }).click();
}

/**
Measure the live composer and reserved status row before and after adopting the next build.
@param page - Browser whose layout must survive an automatic document refresh.
@returns CSS pixel geometry and horizontal overflow evidence.
*/
async function geometry(page: Page) {
  return await page.locator(".composer").evaluate((element) => {
    const composer = element.getBoundingClientRect();
    const tail = document.querySelector(".activity-row")?.getBoundingClientRect();

    return {
      left: composer.left,
      width: composer.width,
      bottom: composer.bottom,
      statusHeight: tail?.height,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

test.beforeEach(async () => {
  await host.reset();
  await host.start("a");
});

test.afterEach(async () => {
  await host.stop();
});

test("an open installed page adopts new production assets and keeps its draft and original file", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: "Message Pocket" });
  const before = await test.step("Save a draft and attachment on release A", async () => {
    await openPocket(page);
    await composer.fill(DRAFT);
    await composer.blur();
    await page.getByLabel("Choose attachments").setInputFiles({
      name: "update-proof.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Original attachment bytes survive a deployment."),
    });
    await expect(page.getByText("Ready to send", { exact: true })).toBeVisible();

    return {
      geometry: await geometry(page),
      scripts: await page
        .locator("script[src]")
        .evaluateAll((elements) => elements.map((element) => element.getAttribute("src"))),
    };
  });

  await host.stop();
  await host.start("b");
  await expect(page.locator('meta[name="pocket-build"]')).toHaveAttribute("content", "update-fixture-b");
  await expect(page.locator(".thread-heading")).toContainText("Connected");
  await expect(composer).toHaveValue(DRAFT);
  await expect(page.getByText("update-proof.txt", { exact: true })).toBeVisible();
  await expect(page.getByText("Ready to send", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss notification prompt" }).click();
  expect(page.url()).toContain("?pocket=main");
  expect(await geometry(page)).toEqual(before.geometry);
  expect(before.geometry.statusHeight).toBe(RESERVED_HEIGHT);
  expect(before.geometry.overflow).toBe(false);
  expect(
    await page.locator("script[src]").evaluateAll((elements) => elements.map((element) => element.getAttribute("src")))
  ).not.toEqual(before.scripts);
  // Switching back proves the refreshed JavaScript owns B's version, not just B's HTML.
  await host.stop();
  await host.start("a");
  await expect(page.locator('meta[name="pocket-build"]')).toHaveAttribute("content", "update-fixture-a");
  await expect(composer).toHaveValue(DRAFT);
  await expect(page.getByText("Ready to send", { exact: true })).toBeVisible();
});

test.describe("controlled transport failures", () => {
  // WebKit routes service-worker-owned requests outside Playwright interception.
  // The release/rollback test above keeps the real service worker enabled.
  test.use({ serviceWorkers: "block" });

  test("a temporary 503 and same-build restart reconnect without reloading the document", async ({ page }) => {
    let documents = 0;
    let failures = 0;

    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        documents += 1;
      }
    });
    await page.route("**/api/events**", async (route) => {
      if (failures < 2) {
        failures += 1;
        await route.fulfill({ status: 503, body: "Host restarting" });
      } else {
        await route.continue();
      }
    });
    await openPocket(page);
    await page.getByRole("textbox", { name: "Message Pocket" }).fill(DRAFT);
    await host.stop();
    await expect(page.locator(".thread-heading")).toContainText("Connecting");
    await host.start("a");
    await expect(page.locator(".thread-heading")).toContainText("Connected");
    await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue(DRAFT);
    expect(failures).toBe(2);
    expect(documents).toBe(1);
  });

  test("a pending send finishes before automatic refresh and is never submitted twice", async ({ page }) => {
    let sends = 0;

    const gate = Promise.withResolvers<undefined>();

    await page.route("**/api/messages**", async (route) => {
      const response = await route.fetch();

      sends += 1;
      await gate.promise;
      await route.fulfill({ response });
    });
    await openPocket(page);
    await page.getByRole("textbox", { name: "Message Pocket" }).fill("Send once during an update");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => sends).toBe(1);
    await host.stop();
    await host.start("b");
    // Let a real update probe finish while the POST acknowledgement is deliberately held.
    await page.waitForResponse((response) => response.url().includes("/api/version") && response.ok(), {
      timeout: PROBE_INTERVAL_MS * 2,
    });
    await expect(page.locator('meta[name="pocket-build"]')).toHaveAttribute("content", "update-fixture-a");
    await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeDisabled();
    gate.resolve(undefined);
    await expect(page.locator('meta[name="pocket-build"]')).toHaveAttribute("content", "update-fixture-b");
    await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("");
    expect(sends).toBe(1);
  });

  test("a pending upload settles before adopting the new release", async ({ page }) => {
    const gate = Promise.withResolvers<undefined>();
    const upload = Promise.withResolvers<undefined>();

    await page.route("**/api/uploads**", async (route) => {
      const response = await route.fetch();

      upload.resolve(undefined);
      await gate.promise;
      await route.fulfill({ response });
    });
    await openPocket(page);
    await page.getByLabel("Choose attachments").setInputFiles({
      name: "still-uploading.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Do not interrupt my upload."),
    });
    await upload.promise;
    await host.stop();
    await host.start("b");
    await page.waitForResponse((response) => response.url().includes("/api/version") && response.ok(), {
      timeout: PROBE_INTERVAL_MS * 2,
    });
    await expect(page.locator('meta[name="pocket-build"]')).toHaveAttribute("content", "update-fixture-a");
    await expect(page.getByRole("progressbar")).toBeVisible();
    gate.resolve(undefined);
    await expect(page.locator('meta[name="pocket-build"]')).toHaveAttribute("content", "update-fixture-b");
    await expect(page.getByText("still-uploading.txt", { exact: true })).toBeVisible();
    await expect(page.getByText("Ready to send", { exact: true })).toBeVisible();
  });

  test("a silent event stream is replaced after its heartbeat deadline", async ({ page }) => {
    let streams = 0;

    const before = await test.step("Keep native streams open but suppress heartbeat delivery", async () => {
      await page.clock.install();
      await page.addInitScript(() => {
        /**
        Keep the native transport while suppressing heartbeat callbacks in this scenario.
        */
        class SilentSource extends EventSource {
          /**
        Simulate a silent transport without firing an error or closing the native connection.
        @param url - Actual production stream URL.
        @param options - Native EventSource options.
        */
          constructor(url: string | URL, options?: EventSourceInit) {
            super(url, options);
            this.addEventListener("heartbeat", (event) => {
              event.stopImmediatePropagation();
            });
          }
        }

        Object.defineProperty(globalThis, "EventSource", { value: SilentSource });
      });
      page.on("request", (request) => {
        if (request.url().includes("/api/events")) {
          streams += 1;
        }
      });
      await openPocket(page);

      return streams;
    });

    await page.clock.fastForward(WATCHDOG_ADVANCE_MS);
    await page.clock.fastForward(RETRY_ADVANCE_MS);
    await expect.poll(() => streams).toBeGreaterThan(before);
    await expect(page.locator(".thread-heading")).toContainText("Connected");
  });
});
