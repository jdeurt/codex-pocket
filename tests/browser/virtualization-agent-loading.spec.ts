import { expect, test } from "@playwright/test";
import { type AgentEntry } from "../../src/lib/agents";
import { initialSnapshot } from "../../src/lib/protocol";
import { mount } from "./virtualization-fixture";

const SKELETON_LINES = 3;
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

test("Side Pocket previews and cold conversations use bounded skeletons until history arrives", async ({ page }) => {
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
    await expect(loading).toBeVisible();
    await expect(loading.locator('[data-slot="skeleton"]')).toHaveCount(SKELETON_LINES);
    await expect(dialog.getByText("Loading conversation…", { exact: true })).toHaveCount(0);
    expect(
      await loading.evaluate((element) => {
        const container = element.getBoundingClientRect();

        return [...element.querySelectorAll('[data-slot="skeleton"]')].every((skeleton) => {
          const bounds = skeleton.getBoundingClientRect();

          return bounds.width > 0 && bounds.left >= container.left && bounds.right <= container.right;
        });
      })
    ).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(loading.locator('[data-slot="skeleton"]').first()).toHaveCSS("animation-name", "none");
    gate.resolve(undefined);
    await expect(dialog.getByText("Loaded child history", { exact: true })).toBeVisible();
    await expect(loading).toHaveCount(0);
  } finally {
    gate.resolve(undefined);
  }
});
