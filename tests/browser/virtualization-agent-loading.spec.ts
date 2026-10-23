import { expect, test } from "@playwright/test";
import { type AgentEntry, type AgentTranscript } from "../../src/lib/agents";
import { initialSnapshot } from "../../src/lib/protocol";
import { mount } from "./virtualization-fixture";

const agent: AgentEntry = {
  id: "codex:loading-child",
  parentId: "loading-parent",
  name: "Loading child",
  source: "side-pocket",
  harness: "codex",
  status: "running",
  preview: "",
  previewState: "loading",
};

test("Side Pocket previews load while cold conversations quietly await history", async ({ page }) => {
  const gate = Promise.withResolvers<undefined>();
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });
  const loading = dialog.getByRole("status", { name: "Loading conversation", exact: true });
  const catalog = { agents: [agent], warnings: [], updatedAt: 1 };

  await mount(page, { ...initialSnapshot, threadId: "loading-parent", connection: "connected" });
  await page.route("**/api/agents", (route) => route.fulfill({ json: catalog }));
  await page.route("**/api/agents?view=*", (route) => route.fulfill({ json: catalog }));
  await page.route("**/api/agents?agent=*", async (route) => {
    await gate.promise;
    await route.fulfill({
      json: {
        agent,
        state: {
          ...initialSnapshot,
          connection: "connected",
          threadId: "loading-child",
          turns: [
            {
              id: "reply",
              status: "completed",
              items: [{ id: "answer", type: "agentMessage", text: "Loaded child history" }],
            },
          ],
        },
        history: "available",
        updatedAt: 1,
      },
    });
  });

  try {
    await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
    await page.getByRole("button", { name: "1 agent", exact: true }).click();
    await expect(
      dialog.getByRole("status", { name: "Loading preview", exact: true }).locator('[data-slot="skeleton"]')
    ).toBeVisible();
    await expect(dialog.getByText("Loading preview…", { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: /Loading child/ }).click();
    await expect(loading).toHaveCount(0);
    gate.resolve(undefined);
    await expect(dialog.getByText("Loaded child history", { exact: true })).toBeVisible();
    await expect(loading).toHaveCount(0);
  } finally {
    gate.resolve(undefined);
  }
});

test("Side Pockets prioritize active rows and retain history through refresh, failure and recovery", async ({
  page,
}) => {
  const gate = Promise.withResolvers<undefined>();
  const read = { mode: "initial" };
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });
  const loading = dialog.getByRole("status", { name: "Loading latest history", exact: true });
  const failure = dialog.getByRole("alert", { name: "History refresh failed", exact: true });
  const catalog = {
    agents: [
      { ...agent, id: "idle", name: "A idle", status: "idle" },
      { ...agent, id: "waiting", name: "Z waiting", status: "waiting" },
      agent,
    ],
    warnings: [],
    updatedAt: 1,
  };
  const transcript: AgentTranscript = {
    agent,
    state: {
      ...initialSnapshot,
      connection: "connected",
      turns: [
        {
          id: "reply",
          status: "completed",
          items: [{ id: "answer", type: "agentMessage", text: "Cached child history" }],
        },
      ],
    },
    history: "available",
    updatedAt: 1,
  };

  await mount(page, { ...initialSnapshot, threadId: "loading-parent", connection: "connected" });
  await page.route("**/api/agents", (route) => route.fulfill({ json: catalog }));
  await page.route("**/api/agents?view=*", (route) => route.fulfill({ json: catalog }));
  await page.route("**/api/agents?agent=*", async (route) => {
    if (read.mode === "held") {
      await gate.promise;
    } else if (read.mode === "failed") {
      await route.fulfill({ status: 500, json: {} });

      return;
    }

    await route.fulfill({ json: { ...transcript, isHistoryLoading: read.mode === "refreshing" } });
  });
  await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
  await page.getByRole("button", { name: "2 agents", exact: true }).click();
  await expect(dialog.locator(".agent-row .agent-status")).toHaveText(["Running", "Waiting for input", "Idle"]);
  await dialog.getByRole("button", { name: /Loading child/ }).click();
  await expect(dialog.getByText("Cached child history", { exact: true })).toBeVisible();
  await expect(loading).toHaveCount(0);

  try {
    read.mode = "held";
    await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
    await expect(loading).toHaveCount(0);
    await expect(dialog.getByText("Cached child history", { exact: true })).toBeVisible();
    await expect(dialog.locator("[data-transcript-row]")).toHaveCount(1);
    const refreshed = page.waitForResponse("**/api/agents?agent=*");

    read.mode = "refreshing";
    gate.resolve(undefined);
    await refreshed;
    await expect(loading).toHaveCount(0);
    await expect(dialog.getByText("Cached child history", { exact: true })).toBeVisible();
    read.mode = "failed";
    await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
    await expect(failure).toBeVisible();
    await expect(loading).toHaveCount(0);
    await expect(dialog.getByText("Cached child history", { exact: true })).toBeVisible();
    transcript.state.turns[0].items[0].text = "Latest child history";
    read.mode = "healthy";
    await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
    await expect(dialog.getByText("Latest child history", { exact: true })).toBeVisible();
    await expect(loading).toHaveCount(0);
    await expect(failure).toHaveCount(0);
    await expect(dialog.locator("[data-transcript-row]")).toHaveCount(1);
  } finally {
    gate.resolve(undefined);
  }
});
