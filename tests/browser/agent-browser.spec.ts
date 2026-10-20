import { control, lifecycle } from "./agent-replay";
import { expect, test } from "@playwright/test";
import { HTTP_FORBIDDEN } from "../../src/lib/constants";
import { checkAgentAccess } from "./agent-api";
import { checkAgentCache, checkAgentReconnect } from "./agent-cache";
import { checkAgentScroll } from "./agent-scroll";
import { checkAgentTools } from "./agent-tools";
import { checkAgentUploads } from "./agent-uploads";
import { longName } from "../fixtures/agent-browser-data";
import { mkdir } from "node:fs/promises";

// OFFLINE whole-flow replay: real Next routes, SQLite, JSON-RPC transport, Claude
// SDK saved-history reader and shared browser renderers; no live inference/auth.
const LONG_NAME_PREFIX = 40;

test.beforeEach(async () => {
  await control("initial");
  await lifecycle();
});

test("offline replay: discovery stays light, unchanged history is cached, changed history refreshes its tail", async ({
  request,
}) => {
  await checkAgentCache(request, control);
});

test("offline replay: parent uploads and centered header survive read-only child navigation", async ({ page }) => {
  await checkAgentUploads(page);
});

test("offline replay: slow native discovery retains the agent list and reconnects", async ({ page, request }) => {
  await checkAgentReconnect(page, request, control);
});

test("offline replay: MCP and dynamic saved output, errors and images use shared read-only traces", async ({
  page,
  request,
}) => {
  await checkAgentTools(page, request);
});

test("offline replay: scoped discovery, complete normalized histories and GET-only routes", async ({
  page,
  request,
}) => {
  await checkAgentAccess(page, request);
});

test("offline replay: mobile/desktop read-only navigation, ellipsis, focus and preserved writable parent", async ({
  page,
}) => {
  const actions: string[] = [];
  const viewport = page.locator('[data-slot="message-scroller-viewport"]').first();
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });
  const row = dialog.getByRole("button", { name: new RegExp(longName.slice(0, LONG_NAME_PREFIX)) });
  const scroll = await test.step("Capture positioned parent before opening child navigation", async () => {
    page.on("request", (request) => {
      if (request.method() === "POST" && !request.url().includes("/api/logs")) {
        actions.push(request.url());
      }
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "6 agents", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Message Pocket" }).fill("Preserved parent draft");

    await viewport.evaluate((element) => {
      element.scrollTop = 240;
    });

    return await viewport.evaluate((element) => element.scrollTop);
  });

  await page.getByRole("button", { name: "6 agents", exact: true }).evaluate((button: HTMLButtonElement) => {
    button.click();
  });

  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".agents-list-header").getByRole("button")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Back to Pocket", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close agents", exact: true })).toHaveCount(0);
  await expect(dialog).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(dialog.getByRole("button", { name: /Finished research/ })).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await expect(row.locator(".agent-preview")).toHaveCSS("white-space", "nowrap");
  await expect(row.locator(".agent-preview")).toHaveCSS("text-overflow", "ellipsis");
  await expect(row.locator(".agent-preview")).toHaveCSS("overflow", "hidden");
  await mkdir(".local/agent-browser-screenshots", { recursive: true });
  await page.screenshot({ animations: "disabled", path: ".local/agent-browser-screenshots/mobile-list.png" });
  await row.click();
  await expect(dialog.getByRole("heading", { name: "Side Pocket", exact: true })).toBeFocused();
  await expect(dialog.locator(".agent-chat-header").getByRole("button")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Back to agents", exact: true })).toBeVisible();
  await expect(dialog.locator(".agent-read-only")).toHaveCount(0);
  await expect(dialog.getByLabel("Model and reasoning effort")).toHaveText("gpt-replay · high reasoning");
  await expect(dialog.getByText("Saved native-codex result", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Send|Approve|Decline|Interrupt|Resume|Restart/i })).toHaveCount(0);
  await expect(dialog.getByRole("img", { name: "Image from Pocket" })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Scoped child image" })).toBeVisible();
  await dialog.getByRole("button", { name: /Command/ }).click();
  await expect(dialog.getByText("REPLAY_TOOL_OUTPUT", { exact: true })).toBeVisible();
  await expect(dialog.getByText("REPLAY_TOOL_OUTPUT", { exact: true })).toBeInViewport();
  await page.screenshot({ animations: "disabled", path: ".local/agent-browser-screenshots/mobile-chat.png" });
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
  await dialog.getByRole("button", { name: /Codex Side Pocket/ }).click();
  await expect(dialog.getByText("Replay child wants approval. This is informative only.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Approve|Decline|Send|Resume|Interrupt/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: /Claude Side Pocket/ }).click();
  await expect(dialog.getByText("Claude saved transcript claude-main", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: /Read Completed/ }).click();
  await expect(dialog.getByText("CLAUDE_REPLAY_TOOL_OUTPUT", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ animations: "disabled", path: ".local/agent-browser-screenshots/desktop-chat.png" });
  await dialog.getByRole("button", { name: "Back to agents", exact: true }).click();
  await page.screenshot({ animations: "disabled", path: ".local/agent-browser-screenshots/desktop-list.png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(dialog).toHaveCSS("transition-duration", "0s");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "6 agents", exact: true })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("Preserved parent draft");
  // Resizing can change content height, so verify parent position before resizing
  // separately in the live-update navigation case below.
  expect(scroll).toBeGreaterThan(0);
  expect(actions).toEqual([]);
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => actions.length).toBe(2);
});

test("offline replay: live updates, retained terminal history, errors and zero active agents", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "6 agents", exact: true });
  const parentViewport = page.locator('[data-slot="message-scroller-viewport"]').first();
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });

  const scroll = await test.step("Position the writable parent before observing child updates", async () => {
    await page.goto("/");

    await expect(trigger).toBeVisible();

    await parentViewport.dispatchEvent("wheel", { deltaY: -180 });
    await parentViewport.evaluate((element) => {
      element.scrollTop = 180;
    });

    return await parentViewport.evaluate((element) => element.scrollTop);
  });

  await trigger.evaluate((button: HTMLButtonElement) => {
    button.click();
  });

  await dialog.getByRole("button", { name: /Researching an exceptionally long/ }).click();
  await control("updated");
  await expect(dialog.locator(".agent-chat").getByText("LIVE_REPLAY_UPDATE", { exact: true })).toBeVisible();
  await control("unavailable");
  await expect(dialog.getByText(/Saved history is unavailable/).first()).toBeVisible();
  await control("updated");
  await expect(dialog.getByText(/Saved history is unavailable/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: /Empty Side Pocket/ }).click();
  await expect(
    dialog.locator(".agent-chat").getByText("No visible messages saved yet.", { exact: true })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: /Unavailable history/ }).click();
  await expect(dialog.getByText("Saved history is unavailable.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await control("settled");
  await lifecycle(true);
  await expect(dialog.getByRole("button", { name: /Researching an exceptionally long.*Completed/ })).toBeVisible();
  await dialog.getByRole("button", { name: /Finished research/ }).click();
  await expect(dialog.getByText("Saved done-codex result", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".agents-trigger")).toHaveCount(0);
  expect(Math.abs((await parentViewport.evaluate((element) => element.scrollTop)) - scroll)).toBeLessThan(2);
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toBeFocused();
});

test("offline replay: denied access, network reconnect, native Claude chat and narrow keyboard navigation", async ({
  page,
}) => {
  const connection = { mode: "healthy" };
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });
  const chat = dialog.locator(".agent-chat");

  await page.route("**/api/agents?agent=codex%3Anative-codex", async (route) => {
    if (connection.mode === "denied") {
      await route.fulfill({ status: HTTP_FORBIDDEN, json: { error: "Replay access denied" } });
    } else if (connection.mode === "offline") {
      await route.abort("internetdisconnected");
    } else {
      await route.continue();
    }
  });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await page.getByRole("button", { name: "6 agents", exact: true }).click();

  await expect(dialog).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await expect(dialog.locator(".agents-list-header").getByRole("button")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Back to Pocket", exact: true })).toBeFocused();
  await page.screenshot({ animations: "disabled", path: ".local/agent-browser-screenshots/narrow-list.png" });
  await dialog.getByRole("button", { name: /Researching an exceptionally long/ }).click();
  await expect(chat.getByText("Saved native-codex result", { exact: true })).toBeVisible();
  await expect(chat.locator("header").getByRole("button")).toHaveCount(1);
  await expect(chat.getByRole("button", { name: "Back to agents", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close agents", exact: true })).toHaveCount(0);
  await expect(chat.locator(".agent-read-only")).toHaveCount(0);
  expect(await chat.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await page.screenshot({ animations: "disabled", path: ".local/agent-browser-screenshots/narrow-chat.png" });
  connection.mode = "denied";
  await expect(chat.getByText(/Access denied/)).toBeVisible();
  await expect(chat.getByText("Saved native-codex result", { exact: true })).toBeVisible();
  connection.mode = "offline";
  await expect(chat.getByText(/Updates unavailable/)).toBeVisible();
  connection.mode = "healthy";
  await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
  await expect(chat.getByText(/Access denied|Updates unavailable/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("button", { name: /Researching an exceptionally long/ })).toBeFocused();
  await dialog.getByRole("button", { name: /Claude native research/ }).click();
  await expect(chat.getByText("Claude saved transcript a-replay", { exact: true })).toBeVisible();
  await expect(chat.getByRole("img", { name: "Image from Pocket" })).toBeVisible();
  await expect(chat.getByRole("button", { name: /Send|Approve|Decline|Resume|Interrupt/ })).toHaveCount(0);
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBeTruthy();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "6 agents", exact: true })).toBeFocused();
});

test("offline replay: parent offsets survive incoming appends while navigating child chats", async ({ page }) => {
  await checkAgentScroll(page, control);
});
