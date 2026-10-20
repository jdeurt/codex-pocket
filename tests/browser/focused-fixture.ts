import { type AgentCatalog, type AgentEntry, type AgentTranscript } from "../../src/lib/agents";
import { type CDPSession, type Locator, type Page, expect } from "@playwright/test";
import { focusedSnapshot } from "../fixtures/focused-transcript";

const MIN_TRANSCRIPT_HEIGHT = 1000;
const focusedAgent: AgentEntry = {
  id: "focused-agent",
  parentId: "focused-scroll-fixture",
  name: "Focus fixture agent",
  source: "native",
  harness: "codex",
  status: "running",
  preview: "Offline focus verification",
};
const focusedAgents: AgentCatalog = {
  agents: [focusedAgent],
  warnings: [],
  updatedAt: 1,
};
const focusedAgentTranscript: AgentTranscript = {
  agent: focusedAgent,
  state: { ...focusedSnapshot, threadId: focusedAgent.id, activeTurnId: undefined },
  history: "available",
  updatedAt: 1,
};

/**
Emit a keyboard-like visual resize without changing the browser's layout viewport.
@param page - Browser with an available native or emulated visual viewport.
@param height - Visible viewport height after the keyboard transition.
@param [offsetTop] - Visible viewport pan from the layout viewport's top edge.
@param [scale] - Native pinch scale, with one representing an unzoomed viewport.
@returns Completion of the browser's resize and scroll event dispatch.
*/
export async function setVisualViewport(page: Page, height: number, offsetTop = 0, scale = 1) {
  await page.evaluate(
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
}

/**
Selects the real parent transcript viewport for focus and native scroll checks.
@param page - Browser containing the mounted parent conversation.
@returns First transcript viewport locator.
*/
export const scroller = (page: Page) => page.locator('[data-slot="message-scroller-viewport"]').first();
/**
Selects the actual writable parent composer.
@param page - Browser containing the mounted parent conversation.
@returns Accessible parent message textbox locator.
*/
export const input = (page: Page) => page.getByRole("textbox", { name: "Message Pocket", exact: true });
/**
Samples the actual parent transcript scroll offset.
@param page - Browser containing the mounted parent conversation.
@returns Native vertical transcript offset.
*/
export const scrollTop = (page: Page) => scroller(page).evaluate((element) => element.scrollTop);

/**
Verifies that transcript interactions have not scrolled the outer document.
@param page - Browser showing the real mounted chat.
@returns Completion of window/document/body offset assertions.
*/
export async function assertDocumentStable(page: Page) {
  expect(
    await page.evaluate(() => ({
      window: globalThis.scrollY,
      root: globalThis.document.documentElement.scrollTop,
      body: globalThis.document.body.scrollTop,
      shell: globalThis.document.querySelector(".chat-shell")?.scrollTop,
    }))
  ).toEqual({ window: 0, root: 0, body: 0, shell: 0 });
}

/**
Scrolls the real transcript using native wheel input or the mobile WebKit DOM fallback.
@param page - Browser providing native mouse input.
@param target - Mounted transcript viewport.
@param delta - Requested vertical wheel displacement.
@param isMobileWebkit - Whether the browser lacks Playwright wheel injection.
@returns Completion of the requested scroll input.
*/
export async function scrollWithWheel(page: Page, target: Locator, delta: number, isMobileWebkit: boolean) {
  if (isMobileWebkit) {
    // Playwright cannot inject wheel/swipe scrolling in mobile WebKit.
    await target.evaluate((element, amount) => {
      element.scrollBy(0, amount);
    }, delta);
  } else {
    await target.hover();
    await page.mouse.wheel(0, delta);
  }
}

/**
Mounts the real focused chat with one canonical offline snapshot and blocked API mutations.
@param page - Isolated browser receiving native snapshot events.
@returns Completion of writable-composer and transcript-readiness assertions.
*/
export async function mountFocusedChat(page: Page) {
  // No route can send a message or touch the running Pocket service.
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const agents = url.searchParams.has("agent") ? focusedAgentTranscript : focusedAgents;

    return route.fulfill({ json: url.pathname === "/api/agents" ? agents : {} });
  });
  await page.addInitScript((state) => {
    /**
    Replays a single canonical snapshot through the browser's native event dispatch.
    */
    class FixtureEventSource extends EventTarget {
      readyState = 1;

      /**
      Schedules the initial fixture snapshot after the native event target is initialized.
      */
      constructor() {
        super();
        setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(state) })), 0);
      }

      /**
      Leaves the connection-free snapshot fixture closed without native network work.
      */
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
}

/**
Injects the existing Chromium touch gesture with frame cadence required by the native compositor.
@param page - Mobile Chromium browser providing the same frame waits as the original gesture.
@param cdp - Owned native CDP session, detached by the caller.
@param x - Actual viewport-center horizontal coordinate.
@param y - Actual viewport-center vertical coordinate.
@returns Completion of native touch start, moves and end.
*/
export async function touchTranscript(page: Page, cdp: CDPSession, x: number, y: number) {
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
    await page.waitForTimeout(FRAME_MS);
  }

  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
