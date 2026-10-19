import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { expect, test } from "@playwright/test";
import { mount, publish } from "./virtualization-fixture";

const MAX_MOUNTED_ROWS = 250;

test("shared projected history preserves one scroller, media, pending drafts and streaming", async ({ page }) => {
  const state: Snapshot = {
    ...initialSnapshot,
    connection: "connected",
    activeTurnId: "visibility",
    turns: [
      {
        id: "visibility",
        status: "inProgress",
        items: [
          ...Array.from({ length: 1200 }, (_, index) => ({
            id: `visible-${index}`,
            type: "agentMessage",
            text: `History ${index}`,
          })),
          { id: "literal", type: "agentMessage", text: "<!-- literal HTML remains visible -->" },
          { id: "media", type: "agentMessage", text: "", images: [{ source: "/icon-192.png", alt: "Kept image" }] },
          { id: "action", type: "agentMessage", text: '```pocket-copy\n"Kept copy action"\n```' },
        ],
      },
    ],
    requests: [
      {
        id: "pending-visible",
        method: "item/tool/requestUserInput",
        params: { questions: [{ id: "choice", question: "Pending fixture answer?" }] },
      },
    ],
  };
  const writes = await mount(page, state);
  const answer = page.getByRole("textbox", { name: "Your answer", exact: true });
  await answer.fill("Preserved pending draft");
  const viewport = await page.locator('[data-slot="message-scroller-viewport"]').elementHandle();

  if (!viewport) {
    throw new Error("Missing persistent scroller");
  }

  await expect(page.locator('[data-message-id="literal"]')).toContainText("literal HTML remains visible");
  await expect(page.getByRole("img", { name: "Kept image", exact: true })).toHaveJSProperty("complete", true);
  await expect(page.locator('[data-transcript-row="visibility/media"]')).toBeAttached();
  await expect(page.locator('[data-transcript-row="visibility/action"]')).toBeAttached();
  expect(await page.locator("[data-transcript-row]").count()).toBeLessThan(MAX_MOUNTED_ROWS);
  state.turns[0].items.push({ id: "streamed", type: "agentMessage", text: "First streaming token" });
  await publish(page, state);
  await expect(page.locator('[data-message-id="streamed"]')).toContainText("First streaming token");
  await expect(answer).toHaveValue("Preserved pending draft");
  // The shared projection can remove every body row while a request stays open.
  state.turns = [];
  await publish(page, state);
  await expect(page.locator("[data-transcript-row]")).toHaveCount(0);
  await expect(answer).toHaveValue("Preserved pending draft");
  expect(await viewport.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.locator('[data-slot="transcript-footer"]')).toHaveCSS("padding-top", "0px");
  state.turns = [
    {
      id: "visibility",
      status: "inProgress",
      items: [{ id: "streamed", type: "agentMessage", text: "Streaming from an empty projection" }],
    },
  ];
  await publish(page, state);
  await expect(page.locator('[data-message-id="streamed"]')).toContainText("Streaming from an empty projection");
  await expect(answer).toHaveValue("Preserved pending draft");
  expect(writes).toEqual([]);
});
