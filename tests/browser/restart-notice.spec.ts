import { type Snapshot, snapshotSchema } from "../../src/lib/protocol";
import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const OLD_TURNS = 600;
const RELOADS = 3;
const artifacts = { snapshotFile: process.env.POCKET_RESTART_SNAPSHOT };

/**
Runs the offline restart workflow and requires its reported private artifact directory.
@returns Persisted canonical snapshot path produced by the native replay.
*/
async function restartSnapshotPath() {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "scripts/restart-notice-check.ts"],
    {
      env: { ...process.env, CODEX_THREAD_ID: "" },
    }
  );
  const directory = /Artifacts: (.+)/.exec(stdout)?.[1];

  if (!directory) {
    throw new Error(`No restart integration artifact: ${stdout}`);
  }

  return `${directory}/snapshot.json`;
}

/**
Loads and validates the persisted restart snapshot at its saved-file boundary.
@returns Canonical parent snapshot shared by the rendered restart scenarios.
*/
async function savedRestartSnapshot() {
  const filename = artifacts.snapshotFile;

  if (!filename) {
    throw new Error("Run scripts/restart-notice-check.ts and pass its snapshot.json path as POCKET_RESTART_SNAPSHOT");
  }

  return snapshotSchema.parse(JSON.parse(await readFile(filename, "utf8")));
}

test.beforeAll(async () => {
  artifacts.snapshotFile ??= await restartSnapshotPath();
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/notifications", (route) => route.fulfill({ json: { publicKey: "AAAA" } }));
  await page.route("**/api/logs", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/spinner", (route) => route.fulfill({ json: { current: null } }));
});

for (const length of ["short", "long"]) {
  test(`restart event is durable and styled in a ${length} chat`, async ({ page }, testInfo) => {
    let connections = 0;

    const saved = await savedRestartSnapshot();
    const state: Snapshot = {
      ...saved,
      activeTurnId: "fixture-thinking",
      activity: "Considering options",
      turns: [
        ...(length === "long"
          ? Array.from({ length: OLD_TURNS }, (_, index) => ({
              id: `old-turn-${String(index)}`,
              status: "completed",
              items: [
                {
                  id: `old-user-${String(index)}`,
                  type: "userMessage",
                  content: [{ type: "text", text: `Earlier task ${String(index)}` }],
                },
                {
                  id: `old-reply-${String(index)}`,
                  type: "agentMessage",
                  phase: "final_answer",
                  text: `Earlier reply ${String(index)}`,
                },
              ],
            }))
          : []),
        ...saved.turns,
      ],
    };

    const notice = page.getByRole("note");
    const metrics = await test.step("Render the persisted restart event and measure its actual layout", async () => {
      await page.route("**/api/events", async (route) => {
        connections += 1;
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify(state)}\n\ndata: ${JSON.stringify(state)}\n\n`,
        });
      });
      await page.goto("/");
      await expect(notice).toHaveText("Pocket restarted");
      await expect(notice).toHaveCount(1);
      await page.getByRole("button", { name: "Dismiss notification prompt" }).click();
      await notice.scrollIntoViewIfNeeded();
      await expect(notice).toBeVisible();

      return await notice.evaluate((element) => {
        /**
        Captures one atomic style/geometry sample after required layout nodes were verified.
        @param indicator - Mounted activity label used as the visual reference.
        @param icon - Mounted restart icon whose accessibility state is inspected.
        @param parent - Restart container supplying the shared message gap.
        @returns Actual restart/activity styles, shared gap and document geometry.
        */
        function captureLayout(indicator: Element, icon: SVGElement, parent: HTMLElement) {
          const style = getComputedStyle(element);
          const activity = getComputedStyle(indicator);
          const row = element.closest("[data-transcript-row]");
          const preceding = row?.previousElementSibling?.firstElementChild ?? element.previousElementSibling;

          return {
            font: style.fontSize,
            activityFont: activity.fontSize,
            color: style.color,
            activityColor: activity.color,
            opacity: style.opacity,
            activityOpacity: activity.opacity,
            gap: style.gap,
            activityGap: activity.gap,
            center: style.justifyContent,
            sharedGap: getComputedStyle(parent).getPropertyValue("--message-block-gap"),
            measuredGap: preceding
              ? element.getBoundingClientRect().top - preceding.getBoundingClientRect().bottom
              : undefined,
            iconHidden: icon.getAttribute("aria-hidden"),
            insideBubble: !!element.closest('[data-slot="bubble"]'),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        }

        const indicator = document.querySelector(".activity-indicator");
        const icon = element.querySelector("svg");
        const parent = element.parentElement;

        if (!indicator || !icon || !parent) {
          throw new Error("Missing restart or activity layout");
        }

        return captureLayout(indicator, icon, parent);
      });
    });

    expect(metrics.font).toBe(metrics.activityFont);
    expect(metrics.color).toBe(metrics.activityColor);
    expect(metrics.opacity).toBe(metrics.activityOpacity);
    expect(metrics.gap).toBe(metrics.activityGap);
    expect(metrics.center).toBe("center");
    expect(metrics.measuredGap).toBe(Number(metrics.sharedGap.trim().replace("px", "")));
    expect(metrics.iconHidden).toBe("true");
    expect(metrics.insideBubble).toBe(false);
    expect(metrics.overflow).toBe(false);
    await expect(page.locator('[data-message-id^="pocket-recovery:"]')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("restart.png") });

    for (let reload = 0; reload < RELOADS; reload += 1) {
      await page.reload();
      await expect(notice).toHaveCount(1);
      await expect(notice).toHaveText("Pocket restarted");
    }

    expect(connections).toBeGreaterThan(1);
  });
}

test("read-only agent viewer excludes a parent restart event and retains ordinary messages", async ({ page }) => {
  const saved =
    await test.step("Require the integrated read-only viewer before loading saved parent state", async () => {
      test.skip(!existsSync("src/components/agent-browser.tsx"), "Requires the integrated agent viewer");

      return await savedRestartSnapshot();
    });
  const agent = {
    id: "codex:restart-exclusion",
    parentId: saved.threadId,
    name: "Restart exclusion child",
    source: "native",
    harness: "codex",
    status: "running",
    preview: "Read-only exclusion replay",
  };
  // Deliberately include the parent's typed item in a child response: readOnly must exclude it.
  const child = { ...saved, threadId: "restart-exclusion-child", activeTurnId: undefined };
  const parent = page.locator("main");
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });

  expect(child.turns.flatMap((turn) => turn.items).filter((item) => item.type === "pocketRestart")).toHaveLength(1);
  await page.route("**/api/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(saved)}\n\n`,
    })
  );
  await page.route("**/api/agents**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).searchParams.has("agent")
        ? { agent, state: child, history: "available", updatedAt: 1 }
        : { agents: [agent], warnings: [], updatedAt: 1 },
    })
  );
  await page.goto("/");
  await expect(parent.getByRole("note")).toHaveCount(1);
  await expect(parent.getByRole("note")).toHaveText("Pocket restarted");
  await page.getByRole("button", { name: "1 agent", exact: true }).click();
  await dialog.getByRole("button", { name: /Restart exclusion child/ }).click();
  await expect(dialog.getByText("Original user content must remain unchanged.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("note")).toHaveCount(0);
  await expect(dialog.locator("[data-system-event]")).toHaveCount(0);
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Back to agents", exact: true }).click();
  await dialog.getByRole("button", { name: "Back to Pocket", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(parent.getByRole("note")).toHaveCount(1);
  await expect(parent.getByRole("note")).toHaveText("Pocket restarted");
});
