import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";
import { expect, test } from "@playwright/test";
import { mount, publish } from "./virtualization-fixture";
import { pocketSettingsMutationSchema } from "../../src/lib/settings";

const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const COMPOSER_GAP = 10;
const HIT_TARGET = 44;
const STREAM_PARAGRAPHS = 12;

test("host tool preference reveals shared details while conversation, images and composer geometry survive updates", async ({
  page,
}) => {
  const state: Snapshot = {
    ...initialSnapshot,
    connection: "connected",
    threadId: "settings-transcript",
    turns: [
      {
        id: "work",
        status: "inProgress",
        items: [
          { id: "assistant", type: "agentMessage", text: "The conversation stays visible", phase: "final_answer" },
          {
            id: "command",
            type: "toolTrace",
            tool: "Command",
            toolLabels: ["Executed echo abcdefghijklmnop"],
            status: "completed",
            text: "Saved command details",
            images: [{ source: "/api/images?item=command&index=0" }],
          },
        ],
      },
    ],
  };
  const writes = await mount(page, state);

  let isShowToolCalls = false;

  const savedPreferences: boolean[] = [];

  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "POST") {
      const change = pocketSettingsMutationSchema.parse(route.request().postDataJSON());

      if (change.showToolCalls !== undefined) {
        isShowToolCalls = change.showToolCalls;
        savedPreferences.push(isShowToolCalls);
      }
    }

    await route.fulfill({
      json: {
        showToolCalls: isShowToolCalls,
        realtimeVoice: null,
        realtimeModel: null,
        openaiApiKeyConfigured: false,
        openaiApiKeySource: null,
      },
    });
  });

  const changePreference = async (isChecked: boolean) => {
    await page.getByRole("button", { name: "Open Pockets", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("checkbox", { name: /Show tool calls/ }).setChecked(isChecked);
    await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close Settings", exact: true }).click();
  };
  const tool = page.getByRole("button", { name: "Executed echo abcdefghijklmnop", exact: true });
  const composer = page.getByRole("textbox", { name: "Message Pocket" });

  await composer.fill("Keep my draft while changing settings");
  await expect(tool).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Image from Pocket", exact: true })).toBeVisible();
  await changePreference(true);
  await expect(tool).toBeVisible();
  await tool.click();
  await expect(page.locator(".tool-output")).toHaveText("Saved command details");
  await page.getByRole("button", { name: "Preview image: Image from Pocket", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close image preview", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close image preview", exact: true }).click();
  await expect(tool).toHaveAttribute("aria-expanded", "true");
  await page.locator(".tool-output").click();
  await expect(tool).toHaveAttribute("aria-expanded", "false");
  await changePreference(false);
  await expect(tool).toHaveCount(0);
  await expect(page.getByText("The conversation stays visible", { exact: true })).toBeVisible();

  for (const size of [DESKTOP, PHONE]) {
    await page.setViewportSize(size);

    for (const activeTurnId of [undefined, "work"]) {
      await publish(page, {
        ...state,
        activeTurnId,
        turns: state.turns.map((turn) => ({
          ...turn,
          status: activeTurnId ? "inProgress" : "completed",
          items: [
            ...turn.items,
            {
              id: "streamed",
              type: "agentMessage",
              phase: "final_answer",
              text: "Updated streamed result\n\n".repeat(STREAM_PARAGRAPHS),
            },
          ],
        })),
      });

      await expect
        .poll(() =>
          page.locator(".activity-row").evaluate((element, gap) => {
            const composerTop = document.querySelector(".composer-wrap")?.getBoundingClientRect().top ?? 0;

            return Math.abs(composerTop - element.getBoundingClientRect().bottom - gap);
          }, COMPOSER_GAP)
        )
        .toBeLessThan(1);
      await expect(page.locator(".activity-row")).toHaveCSS("height", `${String(HIT_TARGET)}px`);
    }

    const widths = await page.locator(".transcript").evaluate((element) => {
      const composerBounds = document.querySelector(".composer-wrap")?.getBoundingClientRect();
      const transcript = element.getBoundingClientRect();

      return {
        transcript: transcript.width,
        composer: composerBounds?.width ?? 0,
        centerDelta: Math.abs(
          transcript.left + transcript.width / 2 - (composerBounds?.left ?? 0) - (composerBounds?.width ?? 0) / 2
        ),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

    expect(widths.centerDelta).toBeLessThan(1);
    expect(widths.overflow).toBeLessThanOrEqual(1);

    if (size === DESKTOP) {
      expect(widths.transcript).toBeGreaterThan(widths.composer);
    }
  }

  await expect(composer).toHaveValue("Keep my draft while changing settings");
  expect(savedPreferences).toEqual([true, false]);
  expect(writes).toEqual([]);
});
