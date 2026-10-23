import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { agentTranscriptSchema } from "../../src/lib/agents";
import { mkdir } from "node:fs/promises";

const expected = [
  {
    suffix: "mcp-text",
    tool: "Replay MCP result",
    label: "Replay mcp result",
    status: "completed",
    text: "REPLAY_MCP_TEXT\nREPLAY_MCP_RESOURCE",
    image: true,
  },
  {
    suffix: "mcp-error",
    tool: "Replay MCP failure",
    label: "Replay mcp failure",
    status: "failed",
    text: "REPLAY_MCP_ERROR",
    image: false,
  },
  {
    suffix: "dynamic-text",
    tool: "Replay dynamic result",
    label: "Replay dynamic result",
    status: "completed",
    text: "REPLAY_DYNAMIC_TEXT",
    image: true,
  },
  {
    suffix: "dynamic-error",
    tool: "Replay dynamic failure",
    label: "Replay dynamic failure",
    status: "failed",
    text: "REPLAY_DYNAMIC_ERROR",
    image: false,
  },
];
const session = "tool-codex";
const NAME_FORMAT_COUNT = 3;

/**
Checks native saved tool results through scoped GET routes and shared read-only traces.
@param page - Browser backed by private native replay state.
@param request - Client for the same isolated app routes.
@returns Completion of text, error, image and parent-draft checks.
*/
export async function checkAgentTools(page: Page, request: APIRequestContext) {
  const mutations: string[] = [];
  const draft = page.getByRole("textbox", { name: "Message Pocket" });

  const response = await test.step("Retain parent draft and read saved native tool transcript", async () => {
    page.on("request", (call) => {
      if (!["GET", "HEAD"].includes(call.method()) && !call.url().includes("/api/logs")) {
        mutations.push(call.url());
      }
    });
    await page.goto("/");
    await draft.fill("Keep the parent tool replay draft");

    return await request.get(`/api/agents?agent=codex:${session}`);
  });
  const transcript = await test.step("Normalize successful native tool history", async () => {
    expect(response.ok()).toBeTruthy();

    return agentTranscriptSchema.parse(await response.json());
  });
  const items = transcript.state.turns.flatMap((turn) => turn.items);
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });
  const chat = dialog.locator(".agent-chat");

  for (const output of expected) {
    const item = items.find((entry) => entry.id === `${session}-${output.suffix}`);

    expect(item).toMatchObject({ type: "toolTrace", tool: output.tool, status: output.status, text: output.text });

    if (!output.image) {
      continue;
    }

    await test.step(`Read scoped image for ${output.tool}`, async () => {
      const images = item?.images ?? [];
      const image = await test.step("Require one native image", async () => {
        expect(images).toHaveLength(1);

        return await request.get(images[0].source);
      });

      expect(image.ok()).toBeTruthy();
      expect(image.headers()["content-type"]).toBe("image/webp");
      expect(await image.body()).not.toHaveLength(0);
    });
  }

  expect(JSON.stringify(transcript)).not.toMatch(/PRIVATE_TOOL_ARGUMENT|PRIVATE_TOOL_META|PRIVATE_TOOL_STRUCTURED/);
  await page.getByRole("button", { name: "6 agents", exact: true }).click();
  await dialog.getByRole("button", { name: /Saved Codex tool transcript/ }).click();
  await expect(chat.getByText("Saved tool output transcript", { exact: true })).toBeVisible();
  await mkdir(".local/agent-browser-screenshots", { recursive: true });

  for (const output of expected) {
    const trace = chat.locator('[data-slot="trace"]').filter({ hasText: output.label });
    const trigger = trace.getByRole("button", { name: new RegExp(output.label) });

    await expect(trigger).toHaveText(`${output.status === "failed" ? "Failed: " : ""}${output.label}`);
    await expect(trigger.locator('[data-slot="trace-line"] > svg')).toHaveCount(output.status === "failed" ? 1 : 0);
    await trigger.click();
    await expect(trace.locator(".tool-output")).toHaveText(output.text);
    await expect(trace.locator(".tool-output")).toBeInViewport({ ratio: 1 });

    if (output.image) {
      const image = trace.getByRole("img", { name: "Image from Pocket", exact: true });

      await expect(image).toHaveJSProperty("complete", true);
      await expect(image).toBeInViewport({ ratio: 1 });
    }

    await page.screenshot({
      animations: "disabled",
      path: `.local/agent-browser-screenshots/tool-${output.suffix}.png`,
    });
    await trace.locator(".tool-output").click();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  }

  const labels = [
    "Executed pwd",
    "Executed npm run build --verbose",
    "Executed echo abcdefghijklmnop",
    "Executed 123456789012345",
    "Executed abcdefghijklmnopqrstuvwxyz",
    "Edited src/edited.ts",
    "Created src/created.ts",
    "Deleted src/deleted.ts",
    "Message parent",
    "Send http request",
  ];

  for (const label of labels) {
    await expect(chat.getByText(label, { exact: true }).first()).toBeVisible();
  }

  await expect(chat.getByText("Message parent", { exact: true })).toHaveCount(NAME_FORMAT_COUNT);
  const overflow = await chat.evaluate((element) => element.scrollWidth - element.clientWidth);

  expect(overflow).toBeLessThanOrEqual(1);
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await expect(
    dialog
      .getByRole("button", { name: /Send|Approve|Decline|Resume|Interrupt/i })
      .and(dialog.locator(':not([data-slot="trace-collapsible-trigger"])'))
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Back to agents", exact: true }).click();
  await dialog.getByRole("button", { name: "Back to Pocket", exact: true }).click();
  await expect(draft).toHaveValue("Keep the parent tool replay draft");
  expect(mutations).toEqual([]);
}
