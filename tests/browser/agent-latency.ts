import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { agentTranscriptSchema } from "../../src/lib/agents";
import { control } from "./agent-replay";
import { readFile } from "node:fs/promises";
import { replayLogSchema } from "../fixtures/replay-protocol";

const OPEN_TIMEOUT_MS = 1500;

/**
Reopen an actual Side Pocket while its native reader is held, retaining complete saved history.
@param page - Browser bound to the private replay server.
@param request - API client sharing the browser's native transcript cache.
*/
export async function checkHeldTranscript(page: Page, request: APIRequestContext) {
  const dialog = page.getByRole("dialog", { name: "Agents", exact: true });
  const row = dialog.getByRole("button", { name: /Researching an exceptionally long/ });

  await page.goto("/");
  await page.getByRole("button", { name: "6 agents", exact: true }).click();
  await row.click();
  await expect(dialog.getByText("Saved native-codex result", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await control("history-held");

  await test
    .step("Wait until the native history read is blocked", async () => {
      await expect
        .poll(async () => {
          const response = await request.get("/api/agents?agent=codex:native-codex", { timeout: OPEN_TIMEOUT_MS });
          const journal = await readFile(".local/agent-browser-replay/rpc.jsonl", "utf8");
          const entries = journal
            .trim()
            .split("\n")
            .map((line) => replayLogSchema.parse(JSON.parse(line)));

          expect(response.ok()).toBe(true);
          const transcript = agentTranscriptSchema.parse(await response.json());

          return (
            transcript.isHistoryLoading &&
            entries.some(
              (entry) =>
                entry.stage === "history-held" && entry.threadId === "native-codex" && entry.method === "thread/read"
            )
          );
        })
        .toBe(true);

      return Date.now();
    })
    .then(async (started) => {
      await row.click();
      await expect(dialog.getByText("Saved native-codex result", { exact: true })).toBeVisible({
        timeout: OPEN_TIMEOUT_MS,
      });
      await expect(dialog.getByText("Loading conversation…", { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("status", { name: "Loading latest history", exact: true })).toHaveCount(0);
      await test.info().attach("held-native-history-open", {
        body: JSON.stringify({ elapsedMs: Date.now() - started, nativeHistoryHeld: true }),
        contentType: "application/json",
      });
    })
    .finally(async () => {
      await control("updated");
    });

  await expect(dialog.locator(".agent-chat").getByText("LIVE_REPLAY_UPDATE", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("status", { name: "Loading latest history", exact: true })).toHaveCount(0);
}
