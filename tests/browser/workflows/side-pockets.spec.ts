import { expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import { control, lifecycle } from "../agent-replay";
import { checkHeldTranscript } from "../agent-latency";

test.beforeEach(async () => {
  await control("initial");
  await lifecycle();
});

test("saved Codex and Claude work remains readable while the parent keeps its draft and approval", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message Pocket" });
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });

  await expect(page.getByRole("button", { name: "6 agents", exact: true })).toBeVisible();
  await composer.fill("Keep my parent draft.");
  await page.getByRole("button", { name: "6 agents", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /Finished research/ })).toBeVisible();
  await dialog.getByRole("button", { name: /Codex Side Pocket/ }).click();
  await expect(dialog.getByText("Replay child wants approval. This is informative only.")).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Approve|Decline|Send|Resume|Interrupt/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Back to agents", exact: true }).click();
  await dialog.getByRole("button", { name: /Claude Side Pocket/ }).click();
  await expect(dialog.getByText("Claude saved transcript claude-main", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Read", exact: true }).click();
  await expect(dialog.getByText("CLAUDE_REPLAY_TOOL_OUTPUT", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(composer).toHaveValue("Keep my parent draft.");
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toBeVisible();
});

test("saved Side Pocket opens immediately while its native history refresh is held", async ({ page, request }) => {
  await checkHeldTranscript(page, request);
});
