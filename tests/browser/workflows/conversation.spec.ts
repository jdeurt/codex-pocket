import { type Page, expect } from "@playwright/test";
import { test } from "../../fixtures/browser-workflow";
import { z } from "zod";
import { pocketSchema } from "../../../src/lib/pockets";
import { POCKETS_ORIGIN } from "../../fixtures/browser-defaults";

/** Create an independent conversation through the application's Pocket menu.
@param page - Browser displaying the actual application.
@param name - User-chosen conversation name.
*/
async function create(page: Page, name: string) {
  await page.getByRole("button", { name: "Open Pockets", exact: true }).click();
  await page.getByRole("button", { name: "New Pocket", exact: true }).click();
  await page.getByRole("textbox", { name: "Pocket name" }).fill(name);
  await page.getByRole("button", { name: "Create Pocket", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.locator(".thread-heading [role=status]")).toHaveText("Connected");
}

/** Open the central settings dialog from an active conversation.
@param page - Browser displaying the actual application.
*/
async function settings(page: Page) {
  await page.getByRole("button", { name: "Open Pockets", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
}

test("messages and independent Pocket drafts survive switching, rename and reload", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: "Message Pocket", exact: true });
  const message = "Keep my exact message: café ✓ <quoted>text</quoted>";

  await page.goto("/");
  await create(page, "Research");

  for (const count of [1, 2]) {
    await composer.fill(message);
    await page.getByRole("button", { name: /^Send message(?:;|$)/ }).click();
    await expect(page.getByText("Saved reply.", { exact: true })).toHaveCount(count);
  }

  await expect(page.getByText(message, { exact: true })).toHaveCount(2);
  await composer.fill("Research draft");
  await create(page, "Writing");
  await expect(composer).toHaveValue("");
  await composer.fill("Writing draft");
  await page.reload();
  await expect(composer).toHaveValue("Writing draft");
  await page.getByRole("button", { name: "Open Pockets", exact: true }).click();
  await page.getByRole("button", { name: "Rename Writing", exact: true }).click();
  await page.getByRole("textbox", { name: "Pocket name" }).fill("Writing notes");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await page
    .getByRole("link")
    .filter({ has: page.getByText("Research", { exact: true }) })
    .click();
  await expect(composer).toHaveValue("Research draft");
  await expect(page.getByText(message, { exact: true })).toHaveCount(2);
  await page.reload();
  await expect(page.getByText(message, { exact: true })).toHaveCount(2);
  await expect(composer).toHaveValue("Research draft");
  await page.getByRole("button", { name: "Open Pockets", exact: true }).click();
  await expect(page.getByRole("link").filter({ has: page.getByText("Writing notes", { exact: true }) })).toBeVisible();
  await page.getByRole("button", { name: "Delete Writing notes", exact: true }).click();
  await page.getByRole("button", { name: "Delete Pocket", exact: true }).click();
  await expect(page.getByRole("link").filter({ has: page.getByText("Writing notes", { exact: true }) })).toHaveCount(0);
});

test("settings keep write-only keys private and synchronize tool visibility between tabs", async ({
  page,
  context,
  request,
}) => {
  const headers = { Origin: POCKETS_ORIGIN };
  const other = await context.newPage();
  const key = "sk-synthetic-browser-workflow";
  const reset = { showToolCalls: false, openaiApiKey: null, realtimeVoice: null, realtimeModel: null };

  await request.post("/api/settings", { headers, data: reset });

  try {
    await page.goto("/");
    await settings(page);
    await page.getByRole("checkbox", { name: "Show tool calls" }).check();
    await page.getByLabel("OpenAI API key", { exact: true }).fill(key);
    await page.getByRole("button", { name: "Save API key", exact: true }).click();
    await expect(page.getByText("API key configured.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("OpenAI API key", { exact: true })).toHaveValue("");
    await page.reload();
    await settings(page);
    await expect(page.getByRole("checkbox", { name: "Show tool calls" })).toBeChecked();
    const response = await request.get("/api/settings");

    expect(await response.json()).toEqual({
      realtimeVoice: null,
      realtimeModel: null,
      showToolCalls: true,
      openaiApiKeyConfigured: true,
      openaiApiKeySource: "saved",
    });
    await other.goto("/");
    await settings(other);
    await other.getByRole("checkbox", { name: "Show tool calls" }).uncheck();
    await expect(page.getByRole("checkbox", { name: "Show tool calls" })).not.toBeChecked();
    await page.getByRole("button", { name: "Remove saved key", exact: true }).click();
    await expect(other.getByText("No API key configured.", { exact: true })).toBeVisible();
  } finally {
    await other.close();
    await request.post("/api/settings", { headers, data: reset });
  }
});

test("HTTP retries create one conversation and one message while unknown identities cannot cross-deliver", async ({
  request,
  page,
}) => {
  const id = crypto.randomUUID();
  const headers = { Origin: POCKETS_ORIGIN };
  const body = { action: "create", id, name: "HTTP conversation" };
  const first = await request.post("/api/pockets", { headers, data: body });
  const repeated = await request.post("/api/pockets", { headers, data: body });

  expect(first.ok()).toBe(true);
  const initialCatalog = z.object({ pockets: z.array(pocketSchema) }).parse(await first.json());
  const repeatedCatalog = z.object({ pockets: z.array(pocketSchema) }).parse(await repeated.json());
  const initial = initialCatalog.pockets.find((pocket) => pocket.id === id);
  const matches = repeatedCatalog.pockets.filter((pocket) => pocket.id === id);

  expect(initial?.threadId).toEqual(expect.any(String));
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ id, name: "HTTP conversation", threadId: initial?.threadId });
  const message = { id: crypto.randomUUID(), text: "Keep one exact HTTP request." };
  const sent = await request.post(`/api/messages?pocket=${id}`, { headers, data: message });
  const retried = await request.post(`/api/messages?pocket=${id}`, { headers, data: message });

  expect(sent.ok()).toBe(true);
  expect(await retried.json()).toEqual(await sent.json());
  const rejected = await request.post(`/api/messages?pocket=${crypto.randomUUID()}`, { headers, data: message });

  expect(rejected.ok()).toBe(false);
  await page.goto(`/?pocket=${id}`);
  await expect(page.getByRole("heading", { name: "HTTP conversation", exact: true })).toBeVisible();
  await expect(page.getByText(message.text, { exact: true })).toHaveCount(1);
  await expect(page.getByText("Saved reply.", { exact: true })).toBeVisible();
});
