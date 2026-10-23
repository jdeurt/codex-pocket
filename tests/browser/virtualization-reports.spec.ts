import { type Page, expect, test } from "@playwright/test";
import { type AgentEntry } from "../../src/lib/agents";
import { type Snapshot, initialSnapshot, snapshotSchema } from "../../src/lib/protocol";
import { mount } from "./virtualization-fixture";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const REPORT_GAP = 8;
const HIT_TARGET = 44;
const MESSAGE_GAP = 16;
const TOLERANCE = 1;

const original =
  "Checks passed. The task is still blocked: choose option A or B before deployment.\n\n" +
  "The original report retains its details and questions without adding blank space after the preview.\n\n";
const agent: AgentEntry = {
  id: "pocket:reporter",
  parentId: "parent",
  name: "Reporter",
  source: "side-pocket",
  harness: "codex",
  status: "waiting",
  preview: original,
};

test("original delegate reports open read-only history and retain questions, draft and focus", async ({
  page,
}, info) => {
  const report = {
    id: "report",
    agentId: agent.id,
    text: original,
    status: "completed" as const,
    final: { commandId: "child-command", outcome: "completed" as const },
  };
  const state: Snapshot = {
    ...initialSnapshot,
    connection: "connected" as const,
    threadId: "parent",
    turns: [
      {
        id: "delivery",
        status: "completed",
        items: [
          { id: "ordinary", type: "agentMessage", text: "Ordinary assistant text" },
          {
            id: "interim",
            type: "delegateReport",
            delegateReport: { id: "interim", agentId: agent.id, text: "Interim work update", status: "completed" },
          },
          { id: "report", type: "delegateReport", delegateReport: report },
          { id: "following", type: "agentMessage", text: "Following assistant text" },
        ],
      },
    ],
  };
  const writes = await mount(page, state);
  const button = page.locator("[data-report-id=report]");
  const open = page.getByRole("button", { name: "Open Side Pocket", exact: true });
  const geometry = await button.evaluate((element) => {
    const ordinary = element.ownerDocument.querySelector('[data-message-id="following"] .markdown');
    const icon = element.querySelector("svg")?.getBoundingClientRect();
    const text = element.querySelector("span")?.getBoundingClientRect();

    return {
      fontSize: getComputedStyle(element).fontSize,
      assistantFontSize: ordinary ? getComputedStyle(ordinary).fontSize : "",
      gap: text && icon ? text.left - icon.right : 0,
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      textHeight: text?.height,
      lineHeight: Number(getComputedStyle(element).lineHeight.replace("px", "")),
      isTruncated: (element.querySelector("span")?.scrollWidth ?? 0) > (text?.width ?? 0),
      followingGap:
        (element.ownerDocument.querySelector('[data-message-id="following"] .markdown')?.getBoundingClientRect().top ??
          0) - element.getBoundingClientRect().bottom,
      maxWidth: ordinary?.closest('[data-slot="message-content"]')?.getBoundingClientRect().width ?? 0,
    };
  });

  await expect(page.locator("[data-interim-report-id=interim]")).toHaveText("Interim work update");
  await expect(page.locator("[data-report-id=interim]")).toHaveCount(0);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".delegate-report-details")).toHaveCount(0);
  expect(Math.abs((geometry.textHeight ?? 0) - geometry.lineHeight)).toBeLessThan(TOLERANCE);
  expect(geometry.isTruncated).toBe(true);
  expect(geometry.width).toBeLessThanOrEqual(geometry.maxWidth + TOLERANCE);
  expect(geometry.followingGap).toBe(MESSAGE_GAP);
  expect(geometry.fontSize).toBe(geometry.assistantFontSize);
  expect(geometry.gap).toBe(REPORT_GAP);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + TOLERANCE);
  await info.attach("delegate-report-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });

  await page.route("**/api/agents?agent=*", (route) =>
    route.fulfill({
      json: {
        agent,
        state: {
          ...initialSnapshot,
          connection: "connected",
          threadId: "child",
          turns: [
            { id: "answer", status: "completed", items: [{ id: "original", type: "agentMessage", text: original }] },
          ],
        },
        history: "available",
        updatedAt: 1,
      },
    })
  );
  await page.route("**/api/agents?view=*", (route) =>
    route.fulfill({ json: { agents: [agent], warnings: [], updatedAt: 1 } })
  );
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("Parent draft before report");
  await expect(button).toHaveText(original.trim());
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".delegate-report-details > div")).toHaveText(original.trimEnd());
  await expect(page.locator('[data-slot="collapsible-content"]')).toHaveCSS("transition-duration", "0.2s");
  await page.locator(".delegate-report-details > div").click();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.click();
  const alignment = await open.evaluate((element) => ({
    left: element.getBoundingClientRect().left,
    icon: element.querySelector("svg")?.getBoundingClientRect().left,
    text: element.parentElement?.getBoundingClientRect().left,
    height: element.getBoundingClientRect().height,
  }));

  expect(alignment.icon).toBe(alignment.text);
  expect(alignment.left).toBe(alignment.text);
  expect(alignment.height).toBeGreaterThanOrEqual(HIT_TARGET);
  await open.click();
  await expect(page.getByRole("dialog", { name: "Agents", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Side Pocket", exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("list", { name: "Conversation", exact: true })
      .getByText(original.split("\n\n", 1)[0], { exact: true })
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("textbox")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("Parent draft before report");
  expect(writes).toEqual([]);
});

/** Render a production Pi snapshot after mailbox delivery and verify complete artifact delivery across reload.
@param page - Real browser showing the main chat.
@param snapshotFile - Private file receiving the actual model and projection flow output.
*/
async function generatedStory(page: Page, snapshotFile: string) {
  await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--test", "--test-name-pattern=Pi main executes", "tests/pi-main-flow.test.ts"],
    { env: { ...process.env, POCKET_VISIBILITY_SNAPSHOT: snapshotFile } }
  );
  const state = snapshotSchema.parse(JSON.parse(await readFile(snapshotFile, "utf8")));
  const report = state.turns
    .flatMap((turn) => turn.items)
    .find((item) => item.type === "delegateReport")?.delegateReport;

  expect(report).toBeDefined();
  const story = report?.text ?? "";
  const writes = await mount(page, state);
  const delivered = page.locator(".markdown").filter({ hasText: "The dragon arrived carrying the learner car." });
  const preview = page.locator(`[data-report-id="${report?.id ?? ""}"]`);

  await expect(delivered).toHaveCount(1);
  await expect(delivered).toHaveText(story);
  await expect(preview).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".delegate-report-details")).toHaveCount(0);
  await expect(page.getByText("[POCKET_INTERNAL_CONTEXT]", { exact: false })).toHaveCount(0);
  await preview.click();
  await expect(page.locator(".delegate-report-details > div")).toHaveText(story);
  await page.reload();
  await expect(delivered).toHaveCount(1);
  await expect(delivered).toHaveText(story);
  expect(writes).toEqual([]);
}

test("generated internal handoff delivers one complete story beside its collapsed report", async ({ page }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-visibility-browser-"));
  const snapshotFile = path.join(directory, "snapshot.json");

  try {
    await generatedStory(page, snapshotFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
