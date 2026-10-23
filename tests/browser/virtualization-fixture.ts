import { type Page, expect, test } from "@playwright/test";
import { type Snapshot } from "../../src/lib/protocol";
import { readFile } from "node:fs/promises";

/**
Mounts the real chat using an offline canonical snapshot and captures attempted mutations.
@param page - Isolated browser receiving fixture API routes.
@param state - Canonical parent snapshot replayed through the native event source.
@returns Captured non-read requests after chat initialization.
*/
export async function mount(page: Page, state: Snapshot) {
  const writes: string[] = [];

  const image = await test.step("Install read-only API capture before loading the image fixture", async () => {
    await page.route("**/api/**", (route) => {
      if (route.request().method() !== "GET" && !route.request().url().includes("/api/logs")) {
        writes.push(route.request().url());
      }

      return route.fulfill({ json: {} });
    });

    return await readFile("public/icon-192.png");
  });

  await page.route("**/api/realtime", (route) => route.fulfill({ json: { history: [] } }));
  await page.route("**/api/images?*", (route) => route.fulfill({ contentType: "image/png", body: image }));
  // The real Chat/useThread path, with no bridge, real transcript or sending.
  await page.addInitScript((snapshot) => {
    /**
    Owns the offline browser snapshot listener and native message event lifecycle.
    */
    class FixtureSource extends EventTarget {
      readyState = 1;

      /**
Receives canonical fixture updates through the native browser event boundary.
@param event - Native snapshot message event dispatched by the replay publisher.
*/
      receive = (event: Event) => {
        this.emit(event instanceof MessageEvent ? event.data : undefined);
      };

      /**
      Registers fixture snapshot updates before scheduling the initial canonical state.
      */
      constructor() {
        super();
        globalThis.addEventListener("fixture-snapshot", this.receive);
        queueMicrotask(() => {
          this.emit(snapshot);
        });
      }

      /**
      Dispatches a native message event only while the fixture source remains open.
      @param data - Canonical initial or updated state delivered by the fixture.
      */
      emit(data: unknown) {
        if (this.readyState === 1) {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
        }
      }

      /**
      Closes the fixture source and removes its browser snapshot listener.
      */
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

/**
Publishes a canonical update to the mounted offline event source.
@param page - Browser with the fixture source already installed.
@param state - Canonical next snapshot delivered to the real chat subscription.
@returns Completion of browser event dispatch.
*/
export async function publish(page: Page, state: Snapshot) {
  await page.evaluate((snapshot) => {
    globalThis.dispatchEvent(new MessageEvent("fixture-snapshot", { data: snapshot }));
  }, state);
}
