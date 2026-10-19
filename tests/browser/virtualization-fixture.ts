import { type Page, expect } from "@playwright/test";
import type { Snapshot } from "../../src/lib/protocol";
import { readFile } from "node:fs/promises";

export async function mount(page: Page, state: Snapshot) {
  const writes: string[] = [];
  await page.route("**/api/**", (route) => {
    if (route.request().method() !== "GET" && !route.request().url().includes("/api/logs")) {
      writes.push(route.request().url());
    }

    return route.fulfill({ json: {} });
  });
  const image = await readFile("public/icon-192.png");
  await page.route("**/api/images?*", (route) => route.fulfill({ contentType: "image/png", body: image }));
  // The real Chat/useThread path, with no bridge, real transcript or sending.
  await page.addInitScript((snapshot) => {
    class FixtureSource extends EventTarget {
      readyState = 1;
      receive = (event: Event) => this.emit((event as MessageEvent).data);
      constructor() {
        super();
        globalThis.addEventListener("fixture-snapshot", this.receive);
        queueMicrotask(() => this.emit(snapshot));
      }
      emit(data: unknown) {
        if (this.readyState === 1) {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
        }
      }
      close() {
        this.readyState = 2;
        globalThis.removeEventListener("fixture-snapshot", this.receive);
      }
    }

    Object.defineProperty(globalThis, "EventSource", { value: FixtureSource });
  }, state);
  await page.goto("/");

  if (state.turns.length > 0) {
    await expect(page.locator("[data-transcript-row]").last()).toBeVisible();
  }

  await page.getByRole("button", { name: "Dismiss notification prompt" }).click();

  return writes;
}

export async function publish(page: Page, state: Snapshot) {
  await page.evaluate((snapshot) => {
    globalThis.dispatchEvent(new globalThis.MessageEvent("fixture-snapshot", { data: snapshot }));
  }, state);
}
