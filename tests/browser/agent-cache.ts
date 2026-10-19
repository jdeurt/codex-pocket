import { type APIRequestContext, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import type { AgentTranscript } from "../../src/lib/agents";

const directory = ".local/agent-browser-replay";
const ARCHIVED_TURNS = 40;
const MAX_READS = 4;
export async function checkAgentCache(request: APIRequestContext, control: (stage: string) => Promise<void>) {
  const initialLog = await readFile(`${directory}/rpc.jsonl`, "utf8");
  const baseline = initialLog.trim().split("\n").length;
  const catalog = await request.get("/api/agents");
  expect(catalog.ok()).toBeTruthy();
  const afterCatalog = await readFile(`${directory}/rpc.jsonl`, "utf8");
  const discoveryReads = afterCatalog
    .trim()
    .split("\n")
    .slice(baseline)
    .map((line) => JSON.parse(line));
  expect(
    discoveryReads.filter(
      (entry) =>
        entry.threadId &&
        entry.threadId !== "replay-parent" &&
        ["thread/turns/list", "thread/items/list"].includes(entry.method)
    )
  ).toEqual([]);
  const idsText = await readFile(`${directory}/ids.json`, "utf8");
  const closedId = JSON.parse(idsText)["Closed Side Pocket"] as string;
  const coldBaseline = afterCatalog.trim().split("\n").length;
  const concurrent = await Promise.all([
    request.get(`/api/agents?agent=pocket:${closedId}`),
    request.get(`/api/agents?agent=pocket:${closedId}&item=closed-session-image&index=0`),
    request.get(`/api/agents?agent=pocket:${closedId}&item=closed-session-image&index=0&thumbnail=1`),
  ]);
  expect(concurrent.every((response) => response.ok())).toBeTruthy();
  const coldLog = await readFile(`${directory}/rpc.jsonl`, "utf8");
  const coldReads = coldLog
    .trim()
    .split("\n")
    .slice(coldBaseline)
    .map((line) => JSON.parse(line))
    .filter(
      (entry) =>
        entry.threadId === "closed-session" && entry.method === "thread/turns/list" && entry.itemsView === "full"
    );
  expect(coldReads).toHaveLength(1);
  await request.get("/api/agents?view=list");
  const first = await request.get("/api/agents?agent=codex:done-codex");
  const firstHistory = (await first.json()) as AgentTranscript;
  expect(firstHistory.state.turns.length).toBeGreaterThan(ARCHIVED_TURNS);
  expect(firstHistory.state.turns[0].id).toBe("archived-0");
  const beforeReuse = await readFile(`${directory}/rpc.jsonl`, "utf8");
  const reuseBaseline = beforeReuse.trim().split("\n").length;
  const reused = await request.get("/api/agents?agent=codex:done-codex");
  expect(reused.ok()).toBeTruthy();
  await request.get("/api/agents?agent=codex:done-codex&item=done-codex-image&index=0");
  await request.get("/api/agents?agent=codex:done-codex&item=done-codex-image&index=0&thumbnail=1");
  const afterReuse = await readFile(`${directory}/rpc.jsonl`, "utf8");
  const reuseReads = afterReuse
    .trim()
    .split("\n")
    .slice(reuseBaseline)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.threadId === "done-codex");
  expect(reuseReads).toEqual([]);
  await control("history-changed");
  await expect
    .poll(async () => {
      const response = await request.get("/api/agents?agent=codex:done-codex");
      const transcript = (await response.json()) as AgentTranscript;

      return transcript.state.turns.findLast(() => true)?.id;
    })
    .toBe("changed-turn");
  const changed = await request.get("/api/agents?agent=codex:done-codex");
  const changedHistory = (await changed.json()) as AgentTranscript;
  expect(changedHistory.state.turns[0].id).toBe("archived-0");
  expect(changedHistory.state.turns.length).toBe(firstHistory.state.turns.length + 1);
  const changedLog = await readFile(`${directory}/rpc.jsonl`, "utf8");
  const changedReads = changedLog
    .trim()
    .split("\n")
    .slice(reuseBaseline)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.threadId === "done-codex" && entry.method === "thread/turns/list");
  expect(changedReads.length).toBeGreaterThan(0);
  expect(
    changedReads.every((entry) => entry.sortDirection === "desc" && entry.limit < firstHistory.state.turns.length)
  ).toBeTruthy();
  const metricsText = await readFile(`${directory}/rpc-metrics.json`, "utf8");
  const metrics = JSON.parse(metricsText);
  expect(metrics.maxReads).toBeLessThanOrEqual(MAX_READS);
  expect(metrics.maxReads).toBeGreaterThan(1);
  await writeFile(
    `${directory}/cache-result.json`,
    JSON.stringify({
      discoveryChildHistoryReads: discoveryReads.filter(
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
