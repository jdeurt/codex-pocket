import { type Locator, type Page } from "@playwright/test";

/** Dispatch a complete touch gesture through the actual mounted screen listeners.
@param surface - Element where the gesture starts.
@param dx - Horizontal travel in CSS pixels.
@param dy - Vertical travel in CSS pixels.
@param isCancelled - Whether the browser cancels instead of releasing the touch.
*/
export async function swipe(surface: Locator, dx: number, dy = 0, isCancelled = false) {
  const start = { identifier: 1, clientX: 180, clientY: 240 };
  const end = { identifier: 1, clientX: start.clientX + dx, clientY: start.clientY + dy };

  await surface.dispatchEvent("touchstart", { touches: [start], changedTouches: [start] });
  await surface.dispatchEvent("touchmove", { touches: [end], changedTouches: [end] });
  await surface.dispatchEvent(isCancelled ? "touchcancel" : "touchend", { touches: [], changedTouches: [end] });
}

/** Exercise native Chromium touch input, with portable event dispatch on WebKit.
@param page - Browser displaying Pocket.
@param surface - Visible navigation screen.
@param dx - Horizontal travel in CSS pixels.
*/
export async function swipeScreen(page: Page, surface: Locator, dx: number) {
  if (page.context().browser()?.browserType().name() !== "chromium") {
    await swipe(surface, dx);

    return;
  }

  const box = await surface.boundingBox();

  if (!box) {
    throw new Error("Swipe surface is not visible.");
  }

  const client = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const steps = 6;

  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });

  for (let step = 1; step <= steps; step++) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (dx * step) / steps, y }],
    });
  }

  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
}
