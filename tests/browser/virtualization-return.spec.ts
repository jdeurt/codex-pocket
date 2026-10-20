/* eslint-disable @typescript-eslint/no-magic-numbers -- Whole-flow frame and coverage measurements over a large synthetic transcript. */
import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { expect, test } from "@playwright/test";
import { mount } from "./virtualization-fixture";
import { writeFile } from "node:fs/promises";

test.use({ video: { mode: "on", size: { width: 720, height: 480 } } });
interface ReturnFrame {
  kind: string;
  t: number;
  top: number;
  height: number;
  total: number;
  phase?: string;
  mounted: number;
  covered: boolean;
}

const counts = process.env.POCKET_RETURN_MESSAGES ? [Number(process.env.POCKET_RETURN_MESSAGES)] : [120, 1200];
const viewport = '[data-slot="message-scroller-viewport"]';

for (const messageCount of counts) {
  test(`${messageCount}-row return records continuity, painted coverage and final arrival for review`, async ({
    page,
  }, info) => {
    const state: Snapshot = {
      ...initialSnapshot,
      connection: "connected",
      turns: [
        {
          id: "long-return",
          status: "interrupted",
          items: Array.from({ length: messageCount }, (_, index) => ({
            id: `return-${index}`,
            type: "agentMessage",
            text: `Message ${index}\n\n${"Variable **Markdown** paragraph.\n\n".repeat(index % 7)}${index % 23 === 0 ? "\n```ts\nconst example = true;\n```\n" : ""}`,
            ...(index % 97 === 0 && {
              images: [{ source: `/api/images?item=return-${index}`, alt: `Return image ${index}` }],
            }),
          })),
        },
      ],
    };
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await mount(page, state);
    const scroller = page.locator(viewport);
    await expect(scroller).toHaveAttribute("data-scroll-motion", "idle");
    await scroller.evaluate(async (node) => {
      node.dispatchEvent(new globalThis.PointerEvent("pointerdown", { bubbles: true }));
      node.scrollTop = 0;

      for (let frame = 0; frame < 12; frame++) {
        await new Promise(globalThis.requestAnimationFrame);
      }
    });
    await expect(page.locator('[data-message-id="return-0"]')).toBeVisible();
    const video = page.video();
    const frames = await scroller.evaluate(async (node) => {
      const start = globalThis.performance.now();
      const samples: ReturnFrame[] = [];
      const read = (kind: string) => {
        const bounds = node.getBoundingClientRect();
        const rows = [...node.querySelectorAll<HTMLElement>("[data-transcript-row]")];
        const visible = rows
          .map((row) => row.getBoundingClientRect())
          .filter((box) => box.bottom > bounds.top && box.top < bounds.bottom);
        samples.push({
          kind,
          t: globalThis.performance.now() - start,
          top: node.scrollTop,
          height: node.clientHeight,
          total: node.scrollHeight,
          phase: node.dataset.scrollMotion,
          mounted: rows.length,
          covered:
            visible.length > 0 &&
            visible[0].top <= bounds.top + 32 &&
            (visible.at(-1)?.bottom ?? 0) >= bounds.bottom - 64,
        });
      };
      read("before");
      node
        .closest('[data-slot="message-scroller"]')
        ?.querySelector<HTMLButtonElement>('[aria-label="Jump to latest message"]')
        ?.click();
      read("command");

      while (globalThis.performance.now() - start < 2000) {
        await new Promise(globalThis.requestAnimationFrame);
        read("frame");
      }

      return samples;
    });
    const first = frames[0];
    const last = frames.at(-1);

    if (!last) {
      throw new Error("Missing return frames");
    }

    const travel = last.top - first.top;
    const paintFrames = frames.filter((frame) => frame.kind === "frame");
    const moving = paintFrames.filter((frame) => frame.top > first.top + 1 && frame.top < last.top - 1);
    const intervals = paintFrames.slice(1).map((frame, index) => frame.t - paintFrames[index].t);
    const metrics = {
      travel,
      immediateJump: frames[1].top - first.top,
      immediateTravelFraction: (frames[1].top - first.top) / travel,
      intermediatePositions: new Set(moving.map((frame) => frame.top)).size,
      firstMoved: paintFrames.find((frame) => frame.top > first.top + 1),
      uncoveredFrames: paintFrames.filter((frame) => !frame.covered).length,
      maxMounted: Math.max(...frames.map((frame) => frame.mounted)),
      initialFrameDelay: paintFrames[0]?.t ?? 0,
      maxFrameInterval: Math.max(...intervals),
      intervalsOver34ms: intervals.filter((interval) => interval > 34).length,
      finalGap: last.total - last.top - last.height,
    };
    const suffix = process.env.POCKET_RETURN_PREVIEW ?? "seek-review";
    const name = `.local/long-return-${suffix}-${messageCount}-${info.project.name}`;
    await writeFile(`${name}.json`, JSON.stringify({ metrics, frames }));
    await page.screenshot({ path: `${name}.png` });
    await page.close();
    await video?.saveAs(`${name}.webm`);
    // These assertions verify coverage and arrival, not acceptance of the initial
    // seek. Its size is exported explicitly for UX review; full-distance 200ms and
    // 1000ms continuous experiments produced visible blank frames in this fixture.
    expect(metrics.travel).toBeGreaterThan(10_000);

    if (messageCount <= 150) {
      expect(metrics.immediateJump).toBeLessThan(1);
    }

    expect(metrics.intermediatePositions).toBeGreaterThan(2);
    expect(metrics.uncoveredFrames).toBe(0);
    expect(metrics.maxMounted).toBeLessThan(250);
    expect(Math.abs(metrics.finalGap)).toBeLessThan(2);
  });
}
