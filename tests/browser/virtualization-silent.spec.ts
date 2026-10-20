import { type Locator, expect, test } from "@playwright/test";
import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { mount, publish } from "./virtualization-fixture";
import { writeFile } from "node:fs/promises";

const BATCHES = 4;
const TURNS_PER_BATCH = 50;
const PARAGRAPHS = 24;

function silentTurns(start: number) {
  return Array.from({ length: TURNS_PER_BATCH }, (_, index) => {
    const id = `silent-${start + index}`;

    return {
      id,
      status: index % 2 === 0 ? "completed" : "inProgress",
      items: [
        { id: `${id}-assistant`, type: "agentMessage", text: " \n\n" },
        { id: `${id}-user`, type: "userMessage", content: [{ text: " \n" }] },
        { id: `${id}-image`, type: "imageOutput", images: [] },
      ],
    };
  });
}

async function geometry(viewport: Locator) {
  return viewport.evaluate((element) => ({
    rows: [...element.querySelectorAll<HTMLElement>("[data-transcript-row]")].map((row) => row.dataset.transcriptRow),
    canvasHeight: element.querySelector(":scope .transcript > div")?.getBoundingClientRect().height,
    scrollHeight: element.scrollHeight,
  }));
}

// OFFLINE whole-flow replay through Chat/Conversation and the real measured list.
test("repeated silent turns create no message containers or accumulated scroll extent", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const visible = {
    id: "visible",
    status: "completed",
    items: [
      { id: "prompt", type: "userMessage", content: [{ text: "Visible prompt 0" }] },
      {
        id: "answer",
        type: "agentMessage",
        phase: "final_answer",
        text: Array.from(
          { length: PARAGRAPHS },
          () => "A shared Markdown paragraph keeps its natural leading and trailing edges."
        ).join("\n\n"),
      },
    ],
  };
  const state: Snapshot = {
    ...initialSnapshot,
    connection: "connected",
    model: "silent-fixture-0",
    turns: [visible],
  };
  const writes = await mount(page, state);
  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  await expect(viewport).toHaveAttribute("data-scroll-motion", "idle");
  const baseline = await geometry(viewport);
  expect(baseline.rows).toEqual(["visible/prompt", "visible/answer"]);
  const measurements = [baseline];

  for (let batch = 0; batch < BATCHES; batch += 1) {
    state.turns.push(...silentTurns(batch * TURNS_PER_BATCH));
    visible.items[0].content = [{ text: `Visible prompt ${batch + 1}` }];
    await publish(page, state);
    await expect(page.locator('[data-message-id="prompt"]')).toHaveText(`Visible prompt ${batch + 1}`);
    await expect(page.locator('[data-transcript-row^="silent-"], [data-message-id^="silent-"]')).toHaveCount(0);
    await expect.poll(() => geometry(viewport)).toEqual(baseline);
    measurements.push(await geometry(viewport));
  }

  state.turns = state.turns.filter((turn) => turn.id !== visible.id);
  await publish(page, state);
  await expect(page.locator("[data-transcript-row]")).toHaveCount(0);
  await expect(page.getByText("What are we working on?", { exact: true })).toBeVisible();
  await expect(viewport).toHaveAttribute("data-scroll-motion", "idle");
  const empty = await geometry(viewport);
  state.turns.push(...silentTurns(BATCHES * TURNS_PER_BATCH));
  state.model = "silent-fixture-1";
  await publish(page, state);
  await expect(page.locator("main > .chat-header")).toContainText(state.model);
  await expect(page.locator('[data-transcript-row], [data-slot="bubble"][data-message-id]')).toHaveCount(0);
  await expect.poll(() => geometry(viewport)).toEqual(empty);
  expect(writes).toEqual([]);
  await writeFile(
    `.local/virtualization-${info.project.name}-silent-extents.json`,
    JSON.stringify({ measurements, empty, emptyAfter: await geometry(viewport) })
  );
});
