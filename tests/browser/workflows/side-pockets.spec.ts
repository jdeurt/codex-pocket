import { expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import { control, lifecycle } from "../agent-replay";
import { swipe, swipeScreen } from "../navigation-swipe";
import { checkHeldTranscript } from "../agent-latency";

const SWIPE_TRAVEL = 130;
const SHORT_TRAVEL = 30;
const DIAGONAL_X = 100;
const DIAGONAL_Y = 160;

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

test("swipes navigate Pockets and Side Pockets while retaining the selected transcript and draft", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message Pocket" });
  const agents = page.getByRole("dialog", { name: "Agents", exact: true });
  const pockets = page.getByRole("dialog", { name: "Pockets", exact: true });
  const main = page.locator("main.chat-shell");
  const originalUrl = page.url();

  await expect(page.getByRole("button", { name: "6 agents", exact: true })).toBeVisible();
  await composer.fill("Preserve my swipe draft.");
  await swipeScreen(page, main, SWIPE_TRAVEL);
  await expect(pockets).toBeVisible();
  await swipeScreen(page, pockets, -SWIPE_TRAVEL);
  await expect(pockets).toBeHidden();
  await expect(page).toHaveURL(originalUrl);
  await expect(composer).toHaveValue("Preserve my swipe draft.");

  await swipeScreen(page, main, -SWIPE_TRAVEL);
  const row = agents.getByRole("button", { name: /Codex Side Pocket/ });

  await expect(row).toBeVisible();
  await row.click();
  await expect(agents.getByRole("heading", { name: "Side Pocket", exact: true })).toBeVisible();
  await swipeScreen(page, agents, SWIPE_TRAVEL);
  await expect(row).toBeVisible();
  await expect(row).toBeFocused();
  await swipeScreen(page, agents, SWIPE_TRAVEL);
  await expect(agents).toBeHidden();
  await expect(composer).toHaveValue("Preserve my swipe draft.");
  await expect(page).toHaveURL(originalUrl);
});

test("short, vertical, cancelled and editing gestures keep the current screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "6 agents", exact: true })).toBeVisible();
  const main = page.locator("main.chat-shell");
  const composer = page.getByRole("textbox", { name: "Message Pocket" });

  await swipe(main, SHORT_TRAVEL);
  await swipe(main, DIAGONAL_X, DIAGONAL_Y);
  await swipe(main, -SWIPE_TRAVEL, 0, true);
  await composer.fill("Editing safely.");
  await swipe(composer, SWIPE_TRAVEL);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(composer).toHaveValue("Editing safely.");

  await swipe(main, SWIPE_TRAVEL);
  const pockets = page.getByRole("dialog", { name: "Pockets", exact: true });

  await pockets.getByRole("button", { name: "New Pocket", exact: true }).click();
  await page.getByRole("textbox", { name: "Pocket name" }).fill("Keep this name");
  await swipe(pockets, -SWIPE_TRAVEL);
  await expect(pockets).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pocket name" })).toHaveValue("Keep this name");
});
