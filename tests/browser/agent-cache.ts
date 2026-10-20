import { type APIRequestContext, expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { agentTranscriptSchema } from "../../src/lib/agents";
import { replayLogSchema } from "../fixtures/replay-protocol";
import { z } from "zod";

const LAST_TURN = -1;
const directory = ".local/agent-browser-replay";
const ARCHIVED_TURNS = 40;
const MAX_READS = 4;
const idsSchema = z.record(z.string(), z.string());
const metricsSchema = z.object({ maxReads: z.number() });

/**
Reads newly captured native requests once at the private replay-log boundary.
@param after - Number of earlier lines excluded from this audit pass.
@returns Total native line count and normalized requests after the selected baseline.
*/
async function journal(after = 0) {
  const text = await readFile(`${directory}/rpc.jsonl`, "utf8");
  const lines = text.trim().split("\n").filter(Boolean);

  return { count: lines.length, entries: lines.slice(after).map((line) => replayLogSchema.parse(JSON.parse(line))) };
}

/**
Loads the completed archive fixture through the real app route and normalizes its transcript once.
@param request - Native Playwright client bound to the isolated fake-backed app.
@returns Canonical agent transcript from the actual GET route.
*/
async function archivedTranscript(request: APIRequestContext) {
  const response = await request.get("/api/agents?agent=codex:done-codex");

  return agentTranscriptSchema.parse(await response.json());
}

/**
Checks lightweight discovery, coalesced native history, cached image reads and changed-tail refresh as one workflow.
@param request - Native Playwright client bound to the private fake-backed app.
@param control - Private replay stage writer owned by the browser workflow.
@returns Completion of native cache/concurrency assertions and captured evidence.
*/
export async function checkAgentCache(request: APIRequestContext, control: (stage: string) => Promise<void>) {
  const discovery = await test.step("Capture lightweight agent discovery", async () => {
    const initial = await journal();
    const catalog = await request.get("/api/agents");

    expect(catalog.ok()).toBeTruthy();

    return await journal(initial.count);
  });
  const idsText = await test.step("Verify discovery avoids child history", async () => {
    expect(
      discovery.entries.filter(
        (entry) =>
          entry.threadId &&
          entry.threadId !== "replay-parent" &&
          ["thread/turns/list", "thread/items/list"].includes(entry.method)
      )
    ).toEqual([]);

    return await readFile(`${directory}/ids.json`, "utf8");
  });
  const closedId = idsSchema.parse(JSON.parse(idsText))["Closed Side Pocket"];
  const concurrent = await Promise.all([
    request.get(`/api/agents?agent=pocket:${closedId}`),
    request.get(`/api/agents?agent=pocket:${closedId}&item=closed-session-image&index=0`),
    request.get(`/api/agents?agent=pocket:${closedId}&item=closed-session-image&index=0&thumbnail=1`),
  ]);
  const cold = await test.step("Capture concurrent cold transcript and image loads", async () => {
    expect(concurrent.every((response) => response.ok())).toBeTruthy();

    return await journal(discovery.count);
  });
  const coldReads = cold.entries.filter(
    (entry) => entry.threadId === "closed-session" && entry.method === "thread/turns/list" && entry.itemsView === "full"
  );
  const firstHistory = await test.step("Coalesce cold history and load complete archived turns", async () => {
    expect(coldReads).toHaveLength(1);
    await request.get("/api/agents?view=list");

    return await archivedTranscript(request);
  });
  const beforeReuse = await test.step("Preserve the beginning of the complete native archive", async () => {
    expect(firstHistory.state.turns.length).toBeGreaterThan(ARCHIVED_TURNS);
    expect(firstHistory.state.turns[0].id).toBe("archived-0");

    return await journal();
  });
  const reused = await request.get("/api/agents?agent=codex:done-codex");
  const reuse = await test.step("Reuse transcript and original/thumbnail image history", async () => {
    expect(reused.ok()).toBeTruthy();
    await request.get("/api/agents?agent=codex:done-codex&item=done-codex-image&index=0");
    await request.get("/api/agents?agent=codex:done-codex&item=done-codex-image&index=0&thumbnail=1");

    return await journal(beforeReuse.count);
  });
  const reuseReads = reuse.entries.filter((entry) => entry.threadId === "done-codex");
  const changedHistory = await test.step("Refresh changed terminal history after a cache-only reread", async () => {
    expect(reuseReads).toEqual([]);
    await control("history-changed");
    await expect
      .poll(async () => {
        const current = await archivedTranscript(request);

        return current.state.turns.at(LAST_TURN)?.id;
      })
      .toBe("changed-turn");

    return await archivedTranscript(request);
  });
  const changed = await test.step("Retain the archive while appending changed history", async () => {
    expect(changedHistory.state.turns[0].id).toBe("archived-0");
    expect(changedHistory.state.turns.length).toBe(firstHistory.state.turns.length + 1);

    return await journal(beforeReuse.count);
  });
  const changedReads = changed.entries.filter(
    (entry) => entry.threadId === "done-codex" && entry.method === "thread/turns/list"
  );
  const metricsText = await test.step("Fetch only descending changed-tail pages", async () => {
    expect(changedReads.length).toBeGreaterThan(0);
    expect(
      changedReads.every(
        (entry) =>
          entry.sortDirection === "desc" && entry.limit !== undefined && entry.limit < firstHistory.state.turns.length
      )
    ).toBeTruthy();

    return await readFile(`${directory}/rpc-metrics.json`, "utf8");
  });
  const metrics = metricsSchema.parse(JSON.parse(metricsText));

  expect(metrics.maxReads).toBeLessThanOrEqual(MAX_READS);
  expect(metrics.maxReads).toBeGreaterThan(1);
  await writeFile(
    `${directory}/cache-result.json`,
    JSON.stringify({
      discoveryChildHistoryReads: discovery.entries.filter(
        (entry) =>
          entry.threadId &&
          entry.threadId !== "replay-parent" &&
          ["thread/turns/list", "thread/items/list"].includes(entry.method)
      ).length,
      concurrentColdFullLoads: coldReads.length,
      repeatedTranscriptAndImageLoads: reuseReads.length,
      changedTailPages: changedReads.length,
      maxConcurrentHistoryReads: metrics.maxReads,
      cachedTurns: firstHistory.state.turns.length,
    })
  );
}
