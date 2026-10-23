import { type Page, expect, test } from "@playwright/test";
import { POCKETS_ORIGIN } from "../fixtures/browser-defaults";

const HIT_TARGET = 44;
const NARROW_WIDTH = 320;
const PHONE_HEIGHT = 844;
const HEADER_INSET = 16;
const ALIGNMENT_TOLERANCE = 0.5;

/** Create a real saved Pocket through the menu and wait for native simulator hydration.
@param page - Browser connected to the actual app and offline native transport.
@param name - Name chosen through the phone UI.
*/
async function create(page: Page, name: string) {
  await page.getByRole("button", { name: "Open Pockets", exact: true }).click();
  await page.getByRole("button", { name: "New Pocket", exact: true }).click();
  await page.getByRole("textbox", { name: "Pocket name" }).fill(name);
  await page.getByRole("button", { name: "Create Pocket", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.locator(".thread-heading [role=status]")).toHaveText("Connected");
}

/** Assert real clickable bounds and narrow-screen horizontal overflow.
@param page - Browser with the actual Pocket drawer open.
*/
async function measureMenu(page: Page) {
  const measurements = await page.getByRole("dialog", { name: "Pockets", exact: true }).evaluate((dialog) => ({
    overflow: dialog.scrollWidth - dialog.clientWidth,
    controls: [...dialog.querySelectorAll("button,a")].map((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    })),
  }));

  expect(measurements.overflow).toBe(0);

  for (const control of measurements.controls) {
    expect(control.width).toBeGreaterThanOrEqual(HIT_TARGET);
    expect(control.height).toBeGreaterThanOrEqual(HIT_TARGET);
  }
}

/** Delete an idle Pocket through its named, explicit confirmation.
@param page - Parent chat containing the saved menu entry.
@param name - Exact saved Pocket name.
*/
async function remove(page: Page, name: string) {
  await page.getByRole("button", { name: "Open Pockets", exact: true }).click();
  await page.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
  await page.getByRole("button", { name: "Delete Pocket", exact: true }).click();
}

test("named Pockets preserve separate conversations and drafts across switching, reload, rename, and deletion", async ({
  page,
  context,
}, info) => {
  const suffix = info.project.name;
  const first = `Research ${suffix}`;
  const second = `Writing ${suffix}`;
  const renamed = `Writing notes ${suffix}`;
  const other = await context.newPage();
  const composer = page.getByRole("textbox", { name: "Message Pocket", exact: true });

  await page.goto("/");
  await create(page, first);
  await composer.fill("Only the research Pocket should receive this message.");
  await page.getByRole("button", { name: /^Send message(?:;|$)/ }).click();
  await expect(page.getByText("Only the research Pocket should receive this message.", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Pocket activity" })).toHaveCount(0);
  await composer.fill("Research draft stays here");

  await other.goto(page.url());
  await expect(other.getByRole("textbox", { name: "Message Pocket", exact: true })).toHaveValue(
    "Research draft stays here"
  );
  await create(page, second);
  await expect(composer).toHaveValue("");
  await expect(page.getByText("Only the research Pocket should receive this message.", { exact: true })).toHaveCount(0);
  await composer.fill("Writing draft stays here");
  await other.getByRole("textbox", { name: "Message Pocket", exact: true }).fill("Second research message");
  await other.getByRole("button", { name: /^Send message(?:;|$)/ }).click();
  await expect(other.getByText("Second research message", { exact: true })).toHaveCount(1);
  await expect(
    other.getByRole("list", { name: "Conversation", exact: true }).getByText("Second research message", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Second research message", { exact: true })).toHaveCount(0);
  await other.close();
  await page.reload();
  await expect(composer).toHaveValue("Writing draft stays here");
  await page.setViewportSize({ width: NARROW_WIDTH, height: PHONE_HEIGHT });
  await expect
    .poll(() => page.locator(".pocket-menu-trigger").evaluate((element) => element.getBoundingClientRect().left))
    .toBe(HEADER_INSET);
  await expect
    .poll(() =>
      page.locator(".chat-header").evaluate((header) => {
        const title = header.querySelector(".thread-heading")?.getBoundingClientRect();
        const bounds = header.getBoundingClientRect();

        return title ? Math.abs(title.left + title.width / 2 - bounds.left - bounds.width / 2) : Infinity;
      })
    )
    .toBeLessThan(ALIGNMENT_TOLERANCE);
  await page.getByRole("button", { name: "Open Pockets", exact: true }).click();
  await measureMenu(page);
  await page.screenshot({ path: `.local/pocket-menu-${info.project.name}.png` });
  await expect(
    page
      .locator(".pocket-entry")
      .filter({ has: page.getByText(first, { exact: true }) })
      .locator(".pocket-preview")
  ).not.toHaveText("No messages yet");
  await page.getByRole("button", { name: `Rename ${second}`, exact: true }).click();
  await page.getByRole("textbox", { name: "Pocket name" }).fill(renamed);
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByRole("link").filter({ hasText: renamed })).toBeVisible();
  await page
    .getByRole("link")
    .filter({ has: page.getByText(first, { exact: true }) })
    .click();
  await expect(page.getByRole("heading", { name: first, exact: true })).toBeVisible();
  await expect(page.getByText("Second research message", { exact: true })).toBeVisible();
  await remove(page, renamed);
  await expect(page.getByRole("link").filter({ hasText: renamed })).toHaveCount(0);
  await page.getByRole("button", { name: "Close Pockets", exact: true }).click();
  await remove(page, first);
  await expect(page.getByRole("heading", { name: "Pocket", exact: true })).toBeVisible();
});

test("creation retries are idempotent and unknown Pocket IDs cannot send into another conversation", async ({
  request,
}) => {
  const id = crypto.randomUUID();
  const headers = { Origin: POCKETS_ORIGIN };
  const body = { action: "create", id, name: "Idempotent Pocket" };
  const first = await request.post("/api/pockets", { headers, data: body });
  const repeated = await request.post("/api/pockets", { headers, data: body });
  const unknown = await request.post(`/api/messages?pocket=${crypto.randomUUID()}`, {
    headers,
    data: { id: crypto.randomUUID(), text: "Must not send" },
  });

  expect(first.ok()).toBe(true);
  expect(repeated.ok()).toBe(true);
  expect(await repeated.json()).toEqual(await first.json());
  expect(unknown.ok()).toBe(false);
  await request.post("/api/pockets", { headers, data: { action: "delete", id } });
});

/** Open global Settings through the real hamburger menu and its gear action.
@param page - Browser displaying a parent Pocket.
*/
async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Open Pockets", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
}

test("central Settings persist tool visibility and write-only API keys across reloads and tabs", async ({
  page,
  context,
  request,
}, info) => {
  const headers = { Origin: POCKETS_ORIGIN };
  const reset = { showToolCalls: false, openaiApiKey: null, realtimeVoice: null, realtimeModel: null };
  const key = "sk-pocket-synthetic-browser-only";
  const replacement = "sk-pocket-synthetic-replacement-only";
  const checkbox = page.getByRole("checkbox", { name: "Show tool calls" });
  const input = page.getByLabel("OpenAI API key", { exact: true });
  const other = await context.newPage();

  await request.post("/api/settings", { headers, data: reset });

  try {
    await page.goto("/");
    await page.setViewportSize({ width: NARROW_WIDTH, height: PHONE_HEIGHT });
    await openSettings(page);
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await expect(page.getByRole("status").filter({ hasText: "Settings saved." })).toBeVisible();
    await page.getByLabel("Realtime voice", { exact: true }).fill("marin");
    await page.getByLabel("Realtime model", { exact: true }).fill("gpt-realtime-synthetic");
    await page.getByRole("button", { name: "Save realtime settings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save realtime settings", exact: true })).toBeEnabled();
    await expect(input).toHaveAttribute("type", "password");
    await input.fill(key);
    await page.getByRole("button", { name: "Save API key", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(page.getByText("API key configured.", { exact: true })).toBeVisible();

    const response = await request.get("/api/settings");
    const publicSettings: unknown = await response.json();

    expect(publicSettings).toEqual({
      showToolCalls: true,
      realtimeVoice: "marin",
      realtimeModel: "gpt-realtime-synthetic",
      openaiApiKeyConfigured: true,
      openaiApiKeySource: "saved",
    });
    await input.fill("invalid key with spaces");
    await page.getByRole("button", { name: "Replace API key", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Could not save Pocket settings. Check your input and try again.");
    await expect(input).toHaveValue("invalid key with spaces");
    await input.fill(replacement);
    await page.getByRole("button", { name: "Replace API key", exact: true }).click();
    await expect(input).toHaveValue("");
    await page.reload();
    await openSettings(page);
    await expect(checkbox).toBeChecked();
    await expect(page.getByLabel("Realtime voice", { exact: true })).toHaveValue("marin");
    await expect(page.getByLabel("Realtime model", { exact: true })).toHaveValue("gpt-realtime-synthetic");
    await expect(page.getByText("API key configured.", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("");

    await other.goto("/");
    await openSettings(other);
    await expect(other.getByRole("checkbox", { name: "Show tool calls" })).toBeChecked();
    await other.getByRole("checkbox", { name: "Show tool calls" }).uncheck();
    await expect(checkbox).not.toBeChecked();
    await page.getByRole("button", { name: "Remove saved key", exact: true }).click();
    await expect(page.getByText("No API key configured.", { exact: true })).toBeVisible();
    await expect(other.getByText("No API key configured.", { exact: true })).toBeVisible();
    await page.getByLabel("Realtime voice", { exact: true }).fill("");
    await page.getByLabel("Realtime model", { exact: true }).fill("");
    await page.getByRole("button", { name: "Save realtime settings", exact: true }).click();
    await expect
      .poll(async () => {
        const settings = await request.get("/api/settings");
        const value: unknown = await settings.json();

        return value;
      })
      .toEqual({
        showToolCalls: false,
        realtimeVoice: null,
        realtimeModel: null,
        openaiApiKeyConfigured: false,
        openaiApiKeySource: null,
      });

    const overflow = await page.getByRole("dialog", { name: "Settings", exact: true }).evaluate((dialog) => {
      return dialog.scrollWidth - dialog.clientWidth;
    });

    expect(overflow).toBe(0);
    await page.screenshot({ path: `.local/settings-${info.project.name}.png` });
    await page.getByRole("button", { name: "Back to Pockets", exact: true }).click();
    await measureMenu(page);
    await expect(page.getByRole("button", { name: "New Pocket", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close Pockets", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open Pockets", exact: true })).toBeFocused();
  } finally {
    await other.close();
    await request.post("/api/settings", { headers, data: reset });
  }
});
