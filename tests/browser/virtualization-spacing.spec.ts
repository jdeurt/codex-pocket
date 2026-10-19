import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { expect, test } from "@playwright/test";
import { mount, publish } from "./virtualization-fixture";

const viewport = '[data-slot="message-scroller-viewport"]';

test("visible message edges and pending status use one shared outer gap", async ({ page }) => {
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
          id: `message-${index}`,
          type: "agentMessage",
          text: `Spacing fixture ${index}`,
        })),
      },
      { id: "gap-turn", status: "inProgress", items: [] },
    ],
  };
  await mount(page, state);
  const cases = [
    { id: "gap-last", type: "userMessage", content: [{ text: "Last user bubble" }] },
    { id: "gap-last", type: "agentMessage", text: "Last assistant paragraph\n\n" },
    { id: "gap-last", type: "agentMessage", text: "Last assistant block\n\n```ts\nconst gap = true;\n```\n\n" },
  ];

  for (const item of cases) {
    state.turns[1].items = [item];
    state.queue = [{ id: "gap-queued", text: "Queued bubble", status: "sent" }];
    await publish(page, state);
    await page.locator(viewport).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByRole("status", { name: "Pocket activity" })).toBeVisible();
    const outerGaps = () =>
      page.locator(viewport).evaluate((element) => {
        const last = element.querySelector<HTMLElement>('[data-message-id="gap-last"]');
        const previous = element.querySelector(':scope [data-message-id="message-999"] .markdown > :last-child');
        const visible = last?.querySelector(
          last.dataset.variant === "secondary" ? '[data-slot="bubble-content"]' : ":scope .markdown > :last-child"
        );
        const firstVisible = last?.querySelector(
          last.dataset.variant === "secondary" ? '[data-slot="bubble-content"]' : ":scope .markdown > :first-child"
        );
        const queued = element.querySelector(':scope [data-message-id="gap-queued"] [data-slot="bubble-content"]');
        const status = element.querySelector('[role="status"][aria-label="Pocket activity"]');
        const transcript = element.querySelector(".transcript");

        if (!previous || !firstVisible || !visible || !status || !transcript) {
          return [Infinity];
        }

        // eslint-disable-next-line unicorn/prefer-number-coercion -- CSS dimensions include units.
        const expected = Number.parseFloat(
          globalThis.getComputedStyle(transcript).getPropertyValue("--message-block-gap")
        );
        const gaps = [firstVisible.getBoundingClientRect().top - previous.getBoundingClientRect().bottom];

        if (queued) {
          gaps.push(
            queued.getBoundingClientRect().top - visible.getBoundingClientRect().bottom,
            status.getBoundingClientRect().top - queued.getBoundingClientRect().bottom
          );
        } else {
          gaps.push(status.getBoundingClientRect().top - visible.getBoundingClientRect().bottom);
        }

        return gaps.map((gap) => Math.abs(gap - expected));
      });
    await expect.poll(async () => Math.max(...(await outerGaps()))).toBeLessThan(1);
    state.queue = [];
    await publish(page, state);
    await expect.poll(async () => Math.max(...(await outerGaps()))).toBeLessThan(1);
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
  state.activeTurnId = undefined;
  await publish(page, state);
  const emptyFooter = page.locator('[data-slot="transcript-footer"]');
  await expect(emptyFooter).toBeEmpty();
  await expect(emptyFooter).toHaveCSS("padding-top", "0px");
  await expect(emptyFooter).toHaveCSS("row-gap", "normal");
  await expect(emptyFooter).toHaveCSS("height", "0px");
  state.turns = [];
  state.activeTurnId = "gap-turn";
  state.queue = [{ id: "gap-queued", text: "First queued bubble", status: "sent" }];
  await publish(page, state);
  await expect(page.getByRole("status", { name: "Pocket activity" })).toBeVisible();
  await expect
    .poll(() =>
      page.locator('[data-message-id="gap-queued"] [data-slot="bubble-content"]').evaluate((queued) => {
        const status = globalThis.document.querySelector('[role="status"][aria-label="Pocket activity"]');
        const transcript = queued.closest(".transcript");

        if (!status || !transcript) {
          return Infinity;
        }

        // eslint-disable-next-line unicorn/prefer-number-coercion -- CSS dimensions include units.
        const expected = Number.parseFloat(
          globalThis.getComputedStyle(transcript).getPropertyValue("--message-block-gap")
        );

        return Math.abs(status.getBoundingClientRect().top - queued.getBoundingClientRect().bottom - expected);
      })
    )
    .toBeLessThan(1);
});
