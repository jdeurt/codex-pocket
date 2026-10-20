/* eslint-disable @typescript-eslint/no-magic-numbers -- Replay a complete resize/press/dialog flow with strict frame geometry. */
import { expect, test } from "@playwright/test";
import { initialSnapshot } from "../../src/lib/protocol";
import { writeFile } from "node:fs/promises";

for (const mode of ["dialog", "approval", "cancel", "touch"] as const) {
  test(`a footer control keeps its resize-correction hitbox through ${mode} activation`, async ({ page }, info) => {
    test.setTimeout(30_000);
    test.skip(mode === "touch" && !info.project.use.isMobile, "Native touch replay uses mobile projects");
    await page.clock.install();
    await page.setViewportSize({ width: 320, height: 1000 });
    await page.goto("/virtualization-fixture/dialog");
    await expect(page.locator("main")).toHaveAttribute("data-fixture-ready", "true");
    const state = {
      ...initialSnapshot,
      activeTurnId: "parent",
      activity: "control-press",
      requests: [
        {
          id: "approval",
          method: "item/commandExecution/requestApproval",
          params: { reason: "Responsive approval detail that wraps while resizing. ".repeat(30) },
        },
      ],
      turns: [
        {
          id: "resize-parent",
          status: "interrupted",
          items: Array.from({ length: 50 }, (_, index) => ({
            id: `resize-${index}`,
            type: "agentMessage",
            text: `Message ${index}`,
          })),
        },
      ],
    };
    await page.evaluate((detail) => {
      globalThis.dispatchEvent(new globalThis.CustomEvent("suspension-snapshot", { detail }));
    }, state);
    const viewport = page.locator('[data-slot="message-scroller-viewport"]');
    const trigger = page.getByRole("button", {
      name: mode === "approval" ? "Decline" : "Open child overlay",
      exact: true,
    });
    await expect(page.locator("main")).toHaveAttribute("data-revision", "control-press");
    await viewport.evaluate(async (node) => {
      node.scrollTop = node.scrollHeight;

      for (let frame = 0; frame < 4; frame++) {
        await new Promise(globalThis.requestAnimationFrame);
      }
    });
    await expect(viewport).toHaveAttribute("data-scroll-motion", "idle");
    await viewport.evaluate((node) => {
      node.dispatchEvent(new globalThis.WheelEvent("wheel", { bubbles: true, deltaY: -200 }));
      node.scrollTop -= 200;
    });
    await page.getByRole("button", { name: "Jump to latest message" }).click();
    await expect(viewport).toHaveAttribute("data-scroll-motion", "idle");
    const composer = page.getByRole("textbox", { name: "Parent draft", exact: true });
    await composer.fill("Keep the focused parent draft");
    await expect(composer).toBeFocused();
    // Hold the real pending correction between resize and press, rather than
    // depending on machine speed to land inside its two-frame settling window.
    await page.clock.pauseAt(Date.now() + 1000);

    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: `.local/control-press-${info.project.name}-${width}.png`, animations: "disabled" });
    }

    await trigger.evaluate((button) => button.scrollIntoView({ block: "center", behavior: "instant" }));
    const before = await trigger.boundingBox();

    if (!before) {
      throw new Error("Missing footer control");
    }

    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    const original = await viewport.evaluate((node) => {
      const canvas = node.querySelector<HTMLElement>(":scope .transcript > div");

      return {
        top: node.scrollTop,
        phase: node.dataset.scrollMotion,
        height: canvas?.style.height,
        minHeight: canvas?.style.minHeight,
      };
    });

    if (mode === "touch") {
      await page.touchscreen.tap(before.x + before.width / 2, before.y + before.height / 2);
    } else {
      await page.mouse.down();
      await page.mouse.move(before.x + before.width / 2 + 1, before.y + before.height / 2 + 1);
    }

    const measuredControl = mode === "touch" ? page.locator("#fixture-agents") : trigger;
    const recording = measuredControl.evaluate(async (button) => {
      button.dataset.recording = "true";
      const frames = [];

      for (let index = 0; index < 5; index++) {
        const box = button.getBoundingClientRect();
        const node = button.closest('[data-slot="message-scroller-viewport"]');
        frames.push({ y: box.y, top: node?.scrollTop, phase: (node as HTMLElement | null)?.dataset.scrollMotion });
        await new Promise(globalThis.requestAnimationFrame);
      }

      return frames;
    });
    await expect(measuredControl).toHaveAttribute("data-recording", "true");
    await page.clock.runFor(100);
    const pressed = await recording;
    await page.screenshot({ path: `.local/control-press-${mode}-${info.project.name}-pressed.png` });
    let stopped = original.top;

    if (mode === "cancel") {
      await viewport.evaluate((node) => {
        node.dispatchEvent(new globalThis.WheelEvent("wheel", { bubbles: true, deltaY: -1000 }));
        node.scrollTop -= 1000;
      });
      stopped = await viewport.evaluate((node) => node.scrollTop);
      await page.mouse.move(0, 0);
    }

    if (mode !== "touch") {
      await page.mouse.up();
    }

    await page.clock.resume();
    await writeFile(
      `.local/control-press-${mode}-${info.project.name}.json`,
      JSON.stringify({ original, before, pressed })
    );
    // eslint-disable-next-line unicorn/prefer-number-coercion -- CSS values contain px units.
    expect(Number.parseFloat(original.minHeight ?? "0") - Number.parseFloat(original.height ?? "0")).toBeGreaterThan(
      100
    );
    expect(Math.max(...pressed.map((frame) => Math.abs(frame.y - before.y)))).toBeLessThan(1);
    const dialog = page.getByRole("dialog", { name: "Child overlay", exact: true });

    if (mode === "dialog" || mode === "touch") {
      await expect(dialog).toBeVisible();
      const returning = viewport.evaluate(async (node) => {
        node.dataset.returnRecording = "true";
        const offsets = [];

        for (let frame = 0; frame < 20; frame++) {
          offsets.push(node.scrollTop);
          await new Promise(globalThis.requestAnimationFrame);
        }

        return offsets;
      });
      await expect(viewport).toHaveAttribute("data-return-recording", "true");
      await page.getByRole("button", { name: "Return to parent", exact: true }).click();
      await expect(dialog).toBeHidden();
      const returnedOffsets = await returning;
      expect(Math.max(...returnedOffsets.map((offset) => Math.abs(offset - original.top)))).toBeLessThan(1);
      await expect(viewport).not.toHaveAttribute("data-scroll-suspended", "true");
      await page.getByRole("button", { name: "Jump to latest message" }).click();
    } else if (mode === "approval") {
      await expect(page.getByText("Fixture is read-only", { exact: true })).toBeVisible();
    } else {
      await expect(dialog).toBeHidden();
      const offsets = await viewport.evaluate(async (node) => {
        const frames = [];

        for (let frame = 0; frame < 20; frame++) {
          frames.push(node.scrollTop);
          await new Promise(globalThis.requestAnimationFrame);
        }

        return frames;
      });
      expect(Math.max(...offsets.map((offset) => Math.abs(offset - stopped)))).toBeLessThan(1);
    }

    await expect(viewport).toHaveAttribute("data-scroll-motion", "idle");
    await expect(composer).toHaveValue("Keep the focused parent draft");
    await expect(page.locator(".transcript > div")).toHaveCSS("min-height", "0px");

    if (mode !== "cancel") {
      await expect
        .poll(() => viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
        .toBeLessThan(2);
    }

    await page.screenshot({ path: `.local/control-press-${mode}-${info.project.name}-complete.png` });
  });
}
