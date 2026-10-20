/* eslint-disable @typescript-eslint/no-magic-numbers -- Observe actual content geometry over a complete disclosure/scroll flow. */
import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { expect, test } from "@playwright/test";
import { ACTIVITY_MOTION } from "../../src/lib/activity-motion";
import { mount } from "./virtualization-fixture";
import { writeFile } from "node:fs/promises";

test.use({ video: { mode: "on", size: { width: 720, height: 480 } } });

interface ContentFrame {
  t: number;
  height: number;
  controlY: number;
  offset: number;
  mounted: number;
  gapError: number;
  contentHeight: number;
  contentRows: number;
  visibleContent: number;
}

for (const count of [4, 1200]) {
  test(`${count} activity messages reveal and conceal actual content while preserving a history reader`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const state: Snapshot = {
      ...initialSnapshot,
      connection: "connected",
      activeTurnId: "next",
      activity: "Activity motion fixture",
      turns: [
        {
          id: "history",
          status: "interrupted",
          items: Array.from({ length: 1200 }, (_, index) => ({
            id: `older-${index}`,
            type: "agentMessage",
            text: `Older message ${index}`,
          })),
        },
        {
          id: "activity",
          status: "completed",
          items: [
            { id: "before", type: "userMessage", content: [{ text: "Inspect activity content" }] },
            ...Array.from({ length: count }, (_, index) => ({
              id: `detail-${index}`,
              type: "agentMessage",
              phase: "commentary",
              text: `Detail ${index}\n\n${"Variable **Markdown** content.\n\n".repeat(index % 5)}`,
              ...(index % 83 === 0 && {
                images: [{ source: `/api/images?item=activity-${index}`, alt: `Detail image ${index}` }],
              }),
            })),
            {
              id: "final",
              type: "agentMessage",
              phase: "final_answer",
              text: `Final block\n\n${"Following visible content.\n\n".repeat(30)}`,
            },
          ],
        },
      ],
    };
    const writes = await mount(page, state);
    const viewport = page.locator('[data-slot="message-scroller-viewport"]');
    await expect(viewport).toHaveAttribute("data-scroll-motion", "idle");
    await viewport.evaluate(async (node) => {
      node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const control = node.querySelector('[data-slot="trace-collapsible-trigger"]');

      if (!control) {
        throw new Error("Missing activity control");
      }

      node.scrollTop += control.getBoundingClientRect().top - node.getBoundingClientRect().top - 100;

      for (let frame = 0; frame < 4; frame++) {
        await new Promise(globalThis.requestAnimationFrame);
      }
    });
    const sample = () =>
      viewport.evaluate(async (node) => {
        const control = node.querySelector<HTMLButtonElement>('[data-slot="trace-collapsible-trigger"]');

        if (!control) {
          throw new Error("Missing activity control");
        }

        const start = globalThis.performance.now();
        const frames: ContentFrame[] = [];
        const read = () => {
          const panel = node.querySelector<HTMLElement>('[data-slot="trace-collapsible-content"]');
          const content = node.querySelector<HTMLElement>("[data-activity-virtualizer]");
          const previous = node.querySelector(':scope [data-message-id="before"] [data-slot="bubble-content"]');
          const final = node.querySelector(':scope [data-message-id="final"] .markdown');
          const status = node.querySelector('[role="status"][aria-label="Pocket activity"]');
          const c = control.getBoundingClientRect();
          const p = panel?.getBoundingClientRect();
          const b = previous?.getBoundingClientRect();
          const f = final?.getBoundingClientRect();
          const s = status?.getBoundingClientRect();
          const detail = content?.querySelector("[data-message-id]")?.getBoundingClientRect();
          const view = node.getBoundingClientRect();
          frames.push({
            t: globalThis.performance.now() - start,
            height: p?.height ?? 0,
            controlY: c.top,
            offset: node.scrollTop,
            mounted: node.querySelectorAll("[data-transcript-row]").length,
            contentHeight: content?.getBoundingClientRect().height ?? 0,
            contentRows: content?.querySelectorAll("li").length ?? 0,
            visibleContent:
              p && detail
                ? Math.max(0, Math.min(detail.bottom, p.bottom, view.bottom) - Math.max(detail.top, p.top, view.top))
                : 0,
            gapError:
              b && f && s
                ? Math.max(
                    Math.abs(c.top - b.bottom - 16),
                    Math.abs(f.top - (p?.bottom ?? c.bottom) - 16),
                    Math.abs(s.top - f.bottom - 16)
                  )
                : Infinity,
          });
        };
        read();
        control.click();

        while (globalThis.performance.now() - start < 1000) {
          await new Promise(globalThis.requestAnimationFrame);
          read();
        }

        return frames;
      });
    const expanded = await sample();
    await page.screenshot({ path: `.local/activity-content-${count}-${info.project.name}.png` });
    const panel = page.locator('[data-slot="trace-collapsible-content"]');
    await expect(panel).toHaveCSS("transition-duration", `${ACTIVITY_MOTION.duration / 1000}s`);
    await expect(panel).toHaveCSS("transition-timing-function", ACTIVITY_MOTION.easing);
    const collapsed = await sample();
    const full = expanded.at(-1)?.height ?? 0;
    const intermediate = (frames: ContentFrame[]) =>
      frames.filter((frame) => frame.height > 2 && frame.height < full - 2);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reducedExpanded = await sample();
    await expect(panel).toHaveCSS("transition-property", "none");
    const reducedCollapsed = await sample();
    const reduced = [...reducedExpanded, ...reducedCollapsed];
    expect(reduced.every((frame) => frame.height < 1 || Math.abs(frame.height - frame.contentHeight - 16) < 1)).toBe(
      true
    );
    expect(reducedExpanded.at(-1)?.height).toBeGreaterThan(200);
    expect(reducedCollapsed.at(-1)?.height).toBe(0);
    await writeFile(
      `.local/activity-content-${count}-${info.project.name}.json`,
      JSON.stringify({ expanded, collapsed, reducedExpanded, reducedCollapsed })
    );
    expect(full).toBeGreaterThan(200);
    expect(new Set(intermediate(expanded).map((frame) => frame.height)).size).toBeGreaterThan(2);
    expect(new Set(intermediate(collapsed).map((frame) => frame.height)).size).toBeGreaterThan(2);
    expect(collapsed.at(-1)?.height).toBe(0);
    expect(expanded.some((frame) => frame.contentRows > 0 && frame.height < frame.contentHeight)).toBe(true);
    expect(expanded.some((frame) => frame.visibleContent > 20)).toBe(true);
    expect(collapsed.some((frame) => frame.visibleContent > 20 && frame.height < full - 2)).toBe(true);
    const frames = [...expanded, ...collapsed, ...reduced];
    expect(Math.max(...frames.map((frame) => Math.abs(frame.controlY - expanded[0].controlY)))).toBeLessThan(1);
    expect(Math.max(...frames.map((frame) => Math.abs(frame.offset - expanded[0].offset)))).toBeLessThan(1);
    expect(Math.max(...frames.map((frame) => frame.mounted))).toBeLessThan(250);
    expect(Math.max(...frames.map((frame) => frame.gapError))).toBeLessThan(1);
    expect(writes).toEqual([]);
    const video = page.video();
    await page.close();
    await video?.saveAs(`.local/activity-content-${count}-${info.project.name}.webm`);
  });
}
