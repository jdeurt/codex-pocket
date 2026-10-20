import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { agentCatalogSchema, agentTranscriptSchema, isActiveAgent } from "../../src/lib/agents";
import { readFile, writeFile } from "node:fs/promises";
import { replayLogSchema } from "../fixtures/replay-protocol";
import { z } from "zod";

const LAST_TURN = -1;
const ACTIVE_AGENT_COUNT = 6;
const directory = ".local/agent-browser-replay";
const ARCHIVED_TURNS = 40;
const MAX_READS = 4;
const CACHED_READ_TIMEOUT_MS = 2000;
const REPEATED_CATALOG_READS = 3;
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
Checks that warm catalog requests and the real agent dialog remain usable while native discovery is held.
@param page - Browser displaying the private fake-backed parent and agent dialog.
@param request - API client sharing that same real server and cache.
@returns The last verified catalog timestamp retained while discovery cannot complete.
*/
async function heldDiscovery(page: Page, request: APIRequestContext) {
  const verified =
    await test.step("Keep known agents available without awaiting the held native response", async () => {
      const response = await test.step("Await the held discovery request", async () => {
        await expect
          .poll(async () => {
            const heldResponse = await request.get("/api/agents", { timeout: CACHED_READ_TIMEOUT_MS });
            const captured = await journal();

            expect(heldResponse.ok()).toBeTruthy();

            return captured.entries.filter(
              (entry) => entry.method === "thread/list" && entry.stage === "discovery-held"
            ).length;
          })
          .toBe(1);

        return request.get("/api/agents", { timeout: CACHED_READ_TIMEOUT_MS });
      });
      const catalog = agentCatalogSchema.parse(await response.json());

      expect(catalog.agents.filter(isActiveAgent)).toHaveLength(ACTIVE_AGENT_COUNT);

      return catalog.updatedAt;
    });

  const captured = await test.step("Repeated reads use the verified catalog", async () => {
    for (let read = 0; read < REPEATED_CATALOG_READS; read++) {
      const response = await request.get("/api/agents?view=list", { timeout: CACHED_READ_TIMEOUT_MS });
      const catalog = agentCatalogSchema.parse(await response.json());

      expect(catalog.updatedAt).toBe(verified);
      expect(catalog.agents.filter(isActiveAgent)).toHaveLength(ACTIVE_AGENT_COUNT);
    }

    return journal();
  });

  expect(
    captured.entries.filter((entry) => entry.method === "thread/list" && entry.stage === "discovery-held")
  ).toHaveLength(1);
  await expect(page.getByRole("dialog", { name: "Agents", exact: true })).toBeVisible();
  await expect(page.getByText("Updates unavailable. Reconnecting automatically.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "6 agents", exact: true, includeHidden: true })).toHaveCount(1);

  return verified;
}

/**
Exercises the real polling UI, scoped routes, native discovery gate and eventual cache refresh together.
@param page - Browser showing the parent chat whose draft must survive reconnect.
@param request - API client bound to the same isolated app.
@param control - Atomic fake-host stage writer used to hold and release native responses.
*/
export async function checkAgentReconnect(
  page: Page,
  request: APIRequestContext,
  control: (stage: string) => Promise<void>
) {
  const verified = await test.step("Hold discovery with an open agent dialog", async () => {
    await page.goto("/");
    await page.getByRole("textbox", { name: "Message Pocket" }).fill("Retained during slow discovery");
    await page.getByRole("button", { name: "6 agents", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Agents", exact: true })).toBeVisible();
    await control("discovery-held");

    try {
      return await heldDiscovery(page, request);
    } finally {
      await control("updated");
    }
  });

  await expect
    .poll(async () => {
      const response = await request.get("/api/agents");
      const catalog = agentCatalogSchema.parse(await response.json());

      return catalog.updatedAt;
    })
    .toBeGreaterThan(verified);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Message Pocket" })).toHaveValue("Retained during slow discovery");
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
