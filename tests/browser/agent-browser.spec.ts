import { HTTP_FORBIDDEN, HTTP_NOT_FOUND } from "../../src/lib/constants";
import { activeAgent, agentCatalogSchema, agentTranscriptSchema } from "../../src/lib/agents";
import { claudeSession, longName } from "../fixtures/agent-browser-data";
import { expect, test } from "@playwright/test";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { checkAgentCache } from "./agent-cache";
import { checkAgentScroll } from "./agent-scroll";
import { checkAgentTools } from "./agent-tools";
import { checkAgentUploads } from "./agent-uploads";
import { replayLogSchema } from "../fixtures/replay-protocol";
import { z } from "zod";

// OFFLINE whole-flow replay: real Next routes, SQLite, JSON-RPC transport, Claude
// SDK saved-history reader and shared browser renderers; no live inference/auth.
const ACTIVE_COUNT = 6;
const LONG_NAME_PREFIX = 40;
const METHOD_NOT_ALLOWED = 405;
const directory = ".local/agent-browser-replay";

async function control(stage: string) {
  await writeFile(`${directory}/control.tmp`, JSON.stringify({ stage }));
  await rename(`${directory}/control.tmp`, `${directory}/control.json`);
}

async function ids() {
  return z.record(z.string(), z.string()).parse(JSON.parse(await readFile(`${directory}/ids.json`, "utf8")));
}

async function lifecycle(settled = false) {
  const entries = await ids();
  const db = new Database(`${directory}/state/delegations.sqlite`);

  db.prepare("UPDATE side_pockets SET status=? WHERE id=?").run(
    settled ? "idle" : "waiting",
    entries["Codex Side Pocket"]
  );
  db.prepare("UPDATE side_pockets SET status=? WHERE id=?").run(
    settled ? "idle" : "running",
    entries["Claude Side Pocket"]
  );
  db.prepare("UPDATE delegation_requests SET status='pending' WHERE childId=?").run(entries["Codex Side Pocket"]);
  db.close();
}

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
  await page.goto("/");
  await expect(page.getByRole("button", { name: "6 agents", exact: true })).toBeVisible();
  await mkdir(".local/agent-browser-screenshots", { recursive: true });
  await page.screenshot({ animations: "disabled", path: ".local/agent-browser-screenshots/mobile-parent.png" });
  const catalog = await request.get("/api/agents");

  expect(catalog.ok()).toBeTruthy();
  const data = agentCatalogSchema.parse(await catalog.json());

  expect(data.agents.filter(activeAgent)).toHaveLength(ACTIVE_COUNT);
  expect(data.agents.filter((agent) => agent.name === "Codex Side Pocket")).toHaveLength(1);
  expect(data.agents.some((agent) => /PRIVATE|Duplicate/.test(agent.name))).toBeFalsy();
  expect(data.agents.find((agent) => agent.id === "codex:native-grandchild")?.parentId).toBe("codex:native-codex");
  expect(data.agents.find((agent) => agent.id === `claude:${claudeSession}:a-nested`)?.parentId).toBe(
    `claude:${claudeSession}:a-replay`
  );
  expect(data.agents.find((agent) => agent.id === "codex:side-native")?.status).toBe("running");
  expect(data.agents.find((agent) => agent.id === "codex:stale-codex")?.status).toBe("unknown");
  const entries = await ids();

  for (const id of [
    "codex:unrelated",
    "codex:unrelated-grandchild",
    `pocket:${entries.private}`,
    "../secrets",
    "replay-parent",
  ]) {
    const denied = await request.get(`/api/agents?agent=${encodeURIComponent(id)}&parent=unrelated-parent`);

    expect(denied.status()).toBe(HTTP_NOT_FOUND);
  }

  const crossOrigin = await request.get("/api/agents", { headers: { Origin: "https://untrusted.example" } });

  expect(crossOrigin.status()).toBe(HTTP_FORBIDDEN);

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const mutation = await request.fetch("/api/agents?agent=codex:native-codex", {
      method,
      data: { action: "resume" },
    });

    expect(mutation.status()).toBe(METHOD_NOT_ALLOWED);
  }

  const transcriptResponse = await request.get("/api/agents?agent=codex:native-codex");
  const transcript = agentTranscriptSchema.parse(await transcriptResponse.json());

  expect(JSON.stringify(transcript)).toContain("Earlier progress from the full transcript");
  expect(JSON.stringify(transcript)).toContain("REPLAY_TOOL_OUTPUT");
  expect(JSON.stringify(transcript)).not.toMatch(
    /PRIVATE_SESSION_SECRET|PRIVATE_ENV|HIDDEN_CONFIG|sandbox|approval_policy|developerInstructions/
  );
  const image = transcript.state.turns.flatMap((turn) => turn.items).find((item) => item.type === "imageOutput");

  if (!image) {
    throw new Error("Expected replay image.");
  }

  const imageUrl = (image.images ?? [])[0].source;
  const imageResponse = await request.get(imageUrl);

  expect(imageResponse.headers()["content-type"]).toBe("image/webp");
  const unrelatedImage = await request.get(imageUrl.replace("codex%3Anative-codex", "codex%3Aunrelated"));

  expect(unrelatedImage.status()).toBe(HTTP_NOT_FOUND);
  const markdownImage = await request.get(
    "/api/agents?agent=codex:native-codex&item=markdown-image&source=child-image.png"
  );

  expect(markdownImage.headers()["content-type"]).toBe("image/webp");
  const forgedImage = await request.get(
    "/api/agents?agent=codex:native-codex&item=markdown-image&source=../../private.png"
  );

  expect(forgedImage.status()).toBe(HTTP_NOT_FOUND);
  const claudeResponse = await request.get(`/api/agents?agent=pocket:${entries["Claude Side Pocket"]}`);
  const claude = agentTranscriptSchema.parse(await claudeResponse.json());

  expect(JSON.stringify(claude)).toContain("CLAUDE_REPLAY_TOOL_OUTPUT");
  expect(claude.state.turns.flatMap((turn) => turn.items).filter((item) => item.type === "userMessage")).toHaveLength(
    1
  );
  const rawLog = await readFile(`${directory}/rpc.jsonl`, "utf8");
  const log = rawLog
    .trim()
    .split("\n")
    .map((line) => replayLogSchema.parse(JSON.parse(line)));

  expect(
    log.filter(
      (entry) =>
        entry.threadId &&
        entry.threadId !== "replay-parent" &&
        !["thread/read", "thread/turns/list", "thread/items/list"].includes(entry.method)
    )
  ).toEqual([]);
  expect(
    log.filter((entry) => entry.method === "thread/resume").every((entry) => entry.threadId === "replay-parent")
  ).toBeTruthy();
});

test("offline replay: mobile/desktop read-only navigation, ellipsis, focus and preserved writable parent", async ({
  page,
}) => {
  const actions: string[] = [];

  page.on("request", (request) => {
    if (request.method() === "POST" && !request.url().includes("/api/logs")) {
      actions.push(request.url());
    }
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "6 agents", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message Pocket" }).fill("Preserved parent draft");
  const viewport = page.locator('[data-slot="message-scroller-viewport"]').first();

  await viewport.evaluate((element) => {
    element.scrollTop = 240;
  });
  const scroll = await viewport.evaluate((element) => element.scrollTop);

  await page.getByRole("button", { name: "6 agents", exact: true }).evaluate((button: HTMLButtonElement) => {
    button.click();
  });
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });

  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".agents-list-header").getByRole("button")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Back to Pocket", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close agents", exact: true })).toHaveCount(0);
  await expect(dialog).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(dialog.getByRole("button", { name: /Finished research/ })).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  const row = dialog.getByRole("button", { name: new RegExp(longName.slice(0, LONG_NAME_PREFIX)) });

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
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "6 agents", exact: true });

  await expect(trigger).toBeVisible();
  const parentViewport = page.locator('[data-slot="message-scroller-viewport"]').first();

  await parentViewport.dispatchEvent("wheel", { deltaY: -180 });
  await parentViewport.evaluate((element) => {
    element.scrollTop = 180;
  });
  const scroll = await parentViewport.evaluate((element) => element.scrollTop);

  await trigger.evaluate((button: HTMLButtonElement) => {
    button.click();
  });
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });

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
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });

  await expect(dialog).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await expect(dialog.locator(".agents-list-header").getByRole("button")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Back to Pocket", exact: true })).toBeFocused();
  await page.screenshot({ animations: "disabled", path: ".local/agent-browser-screenshots/narrow-list.png" });
  await dialog.getByRole("button", { name: /Researching an exceptionally long/ }).click();
  const chat = dialog.locator(".agent-chat");

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
