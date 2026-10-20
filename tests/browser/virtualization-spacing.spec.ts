import { type Page, expect, test } from "@playwright/test";
import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { mount, publish } from "./virtualization-fixture";

const STATUS_HEIGHT = 44;
const INPUT_GAP = 10;
const VISIBLE_STATUS_GAP = 16;
const viewport = '[data-slot="message-scroller-viewport"]';

/** Measure from the final visible component to status text, excluding the reserved hit area.
@param page - Chat following the actual transcript end with a visible status label.
@param selector - Last visible transcript element, including its displayed border or background.
*/
async function expectStatusGap(page: Page, selector: string) {
  await expect
    .poll(async () => {
      const gap = await page.locator(selector).evaluate((last) => {
        const label = globalThis.document.querySelector(".activity-indicator > span:last-child, .agents-label");

        return label ? label.getBoundingClientRect().top - last.getBoundingClientRect().bottom : Infinity;
      });

      // Native scrollHeight is integer-rounded even when message rectangles are fractional.
      return Math.abs(gap - VISIBLE_STATUS_GAP);
    })
    .toBeLessThan(1);
  // WebKit's fallback scroll fade must not obscure the final visible component.
  await expect(page.locator(viewport)).toHaveCSS("mask-image", "none");
}

test("visible messages keep their shared outer gap while status stays in the composer", async ({ page }) => {
  const state: Snapshot = {
    ...initialSnapshot,
    connection: "connected",
    activeTurnId: "gap-turn",
    activity: "Checking shared message gap",
    turns: [
      {
        id: "long-turn",
        status: "interrupted",
        items: Array.from({ length: 1000 }, (_, index) => ({
          id: `message-${String(index)}`,
          type: "agentMessage",
          text: `Spacing fixture ${String(index)}`,
        })),
      },
      { id: "gap-turn", status: "inProgress", items: [] },
    ],
  };
  const cases = [
    { id: "gap-last", type: "userMessage", content: [{ text: "Last user bubble" }] },
    { id: "gap-last", type: "agentMessage", text: "Last assistant paragraph\n\n" },
    { id: "gap-last", type: "agentMessage", text: "Last assistant block\n\n```ts\nconst gap = true;\n```\n\n" },
  ];
  const emptyFooter = page.locator('[data-slot="transcript-footer"]');

  await mount(page, state);

  for (const item of cases) {
    const outerGaps = async () => {
      const measurement = await page.locator(viewport).evaluate((element) => {
        const last = element.querySelector<HTMLElement>('[data-message-id="gap-last"]');
        const previous = element.querySelector(':scope [data-message-id="message-999"] .markdown > :last-child');
        const visible = last?.querySelector(
          last.dataset.variant === "secondary" ? '[data-slot="bubble-content"]' : ":scope .markdown > :last-child"
        );
        const firstVisible = last?.querySelector(
          last.dataset.variant === "secondary" ? '[data-slot="bubble-content"]' : ":scope .markdown > :first-child"
        );
        const queued = element.querySelector(':scope [data-message-id="gap-queued"] [data-slot="bubble-content"]');
        const transcript = element.querySelector(".transcript");

        if (!previous || !firstVisible || !visible || !transcript) {
          return { expected: 0, gaps: [Infinity] };
        }

        return {
          expected: Number(
            globalThis.getComputedStyle(transcript).getPropertyValue("--message-block-gap").trim().replace(/px$/, "")
          ),
          gaps: [
            firstVisible.getBoundingClientRect().top - previous.getBoundingClientRect().bottom,
            ...(queued ? [queued.getBoundingClientRect().top - visible.getBoundingClientRect().bottom] : []),
          ],
        };
      });

      return measurement.gaps.map((gap) => Math.abs(gap - measurement.expected));
    };

    state.turns[1].items = [
      item,
      { id: "empty-stream", type: "agentMessage", text: "\n\n" },
      { id: "empty-user", type: "userMessage", content: [{ text: " \n" }] },
      { id: "empty-image-output", type: "imageOutput", images: [] },
    ];
    state.queue = [{ id: "gap-queued", text: "Queued bubble", status: "sent" }];
    await publish(page, state);
    await page.locator(viewport).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByRole("status", { name: "Pocket activity" })).toBeVisible();
    await expect(page.locator('[data-transcript-row^="gap-turn/empty-"]')).toHaveCount(0);

    await expect.poll(async () => Math.max(...(await outerGaps()))).toBeLessThan(1);
    await expectStatusGap(page, '[data-message-id="gap-queued"] [data-slot="bubble-content"]');
    state.queue = [];
    await publish(page, state);
    await expect.poll(async () => Math.max(...(await outerGaps()))).toBeLessThan(1);
    await expectStatusGap(
      page,
      item.type === "userMessage"
        ? '[data-message-id="gap-last"] [data-slot="bubble-content"]'
        : '[data-message-id="gap-last"] .markdown > :last-child'
    );
  }

  state.turns[1].items = [
    {
      id: "attachment-only",
      type: "userMessage",
      attachments: [{ id: "fixture-file", kind: "file", name: "fixture.txt", size: 7, mediaType: "text/plain" }],
    },
  ];
  await publish(page, state);
  await expect(page.locator('[data-transcript-row="gap-turn/attachment-only"]')).toBeAttached();
  await expectStatusGap(page, '[data-message-id="attachment-only"] [data-slot="bubble-content"]');
  await page.route("**/api/agents", (route) =>
    route.fulfill({
      json: {
        agents: [
          {
            id: "spacing-agent",
            parentId: "parent",
            name: "Spacing agent",
            source: "side-pocket",
            harness: "codex",
            status: "running",
            preview: "",
          },
        ],
        warnings: [],
        updatedAt: 1,
      },
    })
  );
  await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
  await expect(page.getByRole("button", { name: "1 agent", exact: true })).toBeVisible();
  state.activeTurnId = undefined;
  await publish(page, state);
  await expect(page.getByRole("status", { name: "Pocket activity" })).toHaveCount(0);
  await expectStatusGap(page, '[data-message-id="attachment-only"] [data-slot="bubble-content"]');

  await expect(emptyFooter).toBeEmpty();
  await expect(emptyFooter).toHaveCSS("padding-top", "0px");
  expect(await emptyFooter.evaluate((element) => element.getBoundingClientRect().height)).toBe(0);
  state.turns = [];
  state.activeTurnId = "gap-turn";
  state.queue = [{ id: "gap-queued", text: "First queued bubble", status: "sent" }];
  await publish(page, state);
  await expect(page.getByRole("status", { name: "Pocket activity" })).toBeVisible();
  await expect(page.locator(".transcript .activity-indicator")).toHaveCount(0);
  await expect(page.locator(".composer-wrap .activity-row")).toHaveCSS("height", `${String(STATUS_HEIGHT)}px`);
  await expect
    .poll(() =>
      page.locator(".activity-row").evaluate((row) => {
        const input = globalThis.document.querySelector(".composer");

        return (input?.getBoundingClientRect().top ?? 0) - row.getBoundingClientRect().bottom;
      })
    )
    .toBe(INPUT_GAP);
});
