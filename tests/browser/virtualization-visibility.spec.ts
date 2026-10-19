import { type Item, type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { expect, test } from "@playwright/test";
import { mount, publish } from "./virtualization-fixture";

const MAX_MOUNTED_ROWS = 250;

test("empty rendered Markdown adds no row while media, actions, streaming and pending drafts survive", async ({
  page,
}) => {
  const invisible: Item[] = [
    { id: "definition", type: "agentMessage", text: "[unused]: /target" },
    { id: "heading", type: "agentMessage", text: "# " },
    { id: "quote", type: "agentMessage", text: "> " },
    { id: "whitespace", type: "agentMessage", text: "\n \n" },
  ];
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
          ...invisible,
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

  for (const item of invisible) {
    await expect(page.locator(`[data-transcript-row="visibility/${item.id}"]`)).toHaveCount(0);
  }

  await expect(page.locator('[data-message-id="literal"]')).toContainText("literal HTML remains visible");
  await expect(page.getByRole("img", { name: "Kept image", exact: true })).toHaveJSProperty("complete", true);
  await expect(page.locator('[data-transcript-row="visibility/media"]')).toBeAttached();
  await expect(page.locator('[data-transcript-row="visibility/action"]')).toBeAttached();
  expect(await page.locator("[data-transcript-row]").count()).toBeLessThan(MAX_MOUNTED_ROWS);
  invisible[0].text = "First streaming token";
  await publish(page, state);
  await expect(page.locator('[data-message-id="definition"]')).toContainText("First streaming token");
  await expect(answer).toHaveValue("Preserved pending draft");
  invisible[0].text = "[unused]: /target";
  await publish(page, state);
  await expect(page.locator('[data-transcript-row="visibility/definition"]')).toHaveCount(0);
  state.turns[0].items = [{ id: "last-empty", type: "agentMessage", text: "[only-definition]: /target" }];
  await publish(page, state);
  await expect(page.locator("[data-transcript-row]")).toHaveCount(0);
  await expect(answer).toHaveValue("Preserved pending draft");
  expect(await viewport.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.locator('[data-slot="transcript-footer"]')).toHaveCSS("padding-top", "0px");
  state.turns[0].items[0].text = "Streaming from an empty rendered message";
  await publish(page, state);
  await expect(page.locator('[data-message-id="last-empty"]')).toContainText(
    "Streaming from an empty rendered message"
  );
  await expect(answer).toHaveValue("Preserved pending draft");
  expect(writes).toEqual([]);
});
