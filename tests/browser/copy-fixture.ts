import { type Page, expect } from "@playwright/test";
import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";

type ClipboardMode = "resolve" | "reject" | "pending" | "unavailable";

declare global {
  interface Window {
    copyTest: { calls: string[]; resolve?: () => void };
  }
}

/**
Installs a deterministic native clipboard boundary before the page loads.
@param page - Isolated browser receiving the clipboard spy.
@param mode - Native clipboard outcome exercised by the workflow.
@returns Completion of the browser initialization script.
*/
async function spyClipboard(page: Page, mode: ClipboardMode) {
  await page.addInitScript((behavior) => {
    const state: Window["copyTest"] = { calls: [] };

    globalThis.window.copyTest = state;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value:
        behavior === "unavailable"
          ? undefined
          : {
              writeText(text: string) {
                state.calls.push(text);

                if (behavior === "reject") {
                  return Promise.reject(new DOMException("Clipboard denied", "NotAllowedError"));
                }

                if (behavior === "pending") {
                  return new Promise<void>((resolve) => {
                    state.resolve = resolve;
                  });
                }

                return Promise.resolve();
              },
            },
    });
  }, mode);
}

/**
Mounts the real chat with an offline assistant payload and captures attempted API mutations.
@param page - Isolated browser using fixture routes.
@param text - Exact assistant Markdown, including embedded copy payloads.
@param options - Additional canonical items and the native/spied clipboard mode for this mounted fixture.
@returns Rendered Markdown, captured mutations and the canonical snapshot update operation.
*/
export async function showChat(
  page: Page,
  text: string,
  options: {
    items?: Snapshot["turns"][number]["items"];
    clipboard?: ClipboardMode | "native";
  } = {}
) {
  const { items = [], clipboard = "resolve" } = options;
  const assistant = { id: "assistant-copy", type: "agentMessage", phase: "final_answer", text };
  const state: Snapshot = {
    ...structuredClone(initialSnapshot),
    connection: "connected",
    turns: [
      {
        id: "copy-flow",
        status: "completed",
        items: [...items, assistant],
      },
    ],
  };
  const writes: string[] = [];
  const markdown = page.locator('[data-message-id="assistant-copy"] .markdown');

  if (clipboard !== "native") {
    await spyClipboard(page, clipboard);
  }

  // Keep unrelated notification setup local and dismiss it before inspecting chat.
  await page.addInitScript(() => Reflect.deleteProperty(globalThis, "Notification"));
  await page.route("**/api/notifications", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(state)}\n\n`,
    })
  );
  await page.route("**/api/logs", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/messages", (route) => {
    writes.push(route.request().postData() ?? "");

    return route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss notification prompt", exact: true }).click();

  await expect(markdown).toBeVisible();

  return {
    markdown,
    writes,
    stream: async (next: string) => {
      state.turns[0].status = "inProgress";
      state.activeTurnId = "copy-flow";
      assistant.text = next;
      // Reconnect through the real event-stream hook with the next streamed snapshot.
      await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
    },
  };
}

/**
Reads clipboard writes captured by the browser's native-boundary spy.
@param page - Browser with the spy installed before navigation.
@returns Exact payloads submitted by actual copy gestures.
*/
export const clipboardCalls = (page: Page) => page.evaluate(() => globalThis.window.copyTest.calls);
