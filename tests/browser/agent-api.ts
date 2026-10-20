import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { HTTP_FORBIDDEN, HTTP_NOT_FOUND } from "../../src/lib/constants";
import { agentCatalogSchema, agentTranscriptSchema, isActiveAgent } from "../../src/lib/agents";
import { mkdir, readFile } from "node:fs/promises";
import { claudeSession } from "../fixtures/agent-browser-data";
import { readAgentIds } from "./agent-replay";
import { replayLogSchema } from "../fixtures/replay-protocol";

const ACTIVE_COUNT = 6;
const METHOD_NOT_ALLOWED = 405;
const directory = ".local/agent-browser-replay";

/**
Checks scoped native discovery, complete saved histories and strictly read-only routes.
@param page - Browser backed by private native replay state.
@param request - Native request client bound to the same isolated app.
@returns Completion of ancestry, origin, mutation, image and native-call assertions.
*/
export async function checkAgentAccess(page: Page, request: APIRequestContext) {
  const catalog = await test.step("Open parent and read scoped native discovery", async () => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "6 agents", exact: true })).toBeVisible();
    await mkdir(".local/agent-browser-screenshots", { recursive: true });
    await page.screenshot({ animations: "disabled", path: ".local/agent-browser-screenshots/mobile-parent.png" });

    return await request.get("/api/agents");
  });
  const data = await test.step("Normalize successful discovery response", async () => {
    expect(catalog.ok()).toBeTruthy();

    return agentCatalogSchema.parse(await catalog.json());
  });
  const entries = await test.step("Check scoped discovery and load managed identities", async () => {
    expect(data.agents.filter(isActiveAgent)).toHaveLength(ACTIVE_COUNT);
    expect(data.agents.filter((agent) => agent.name === "Codex Side Pocket")).toHaveLength(1);
    expect(data.agents.some((agent) => /PRIVATE|Duplicate/.test(agent.name))).toBeFalsy();
    expect(data.agents.find((agent) => agent.id === "codex:native-grandchild")?.parentId).toBe("codex:native-codex");
    expect(data.agents.find((agent) => agent.id === `claude:${claudeSession}:a-nested`)?.parentId).toBe(
      `claude:${claudeSession}:a-replay`
    );
    expect(data.agents.find((agent) => agent.id === "codex:side-native")?.status).toBe("running");
    expect(data.agents.find((agent) => agent.id === "codex:stale-codex")?.status).toBe("unknown");

    return await readAgentIds();
  });
  const crossOrigin = await test.step("Reject unowned identities before testing cross-origin discovery", async () => {
    for (const id of [
      "codex:unrelated",
      "codex:unrelated-grandchild",
      `pocket:${entries.private}`,
      "../secrets",
      "replay-parent",
    ]) {
      const denied = await request.get(`/api/agents?agent=${encodeURIComponent(id)}&parent=unrelated-parent`);

      expect(denied.status()).toBe(HTTP_NOT_FOUND);
    }

    return await request.get("/api/agents", { headers: { Origin: "https://untrusted.example" } });
  });
  const transcriptResponse =
    await test.step("Reject cross-origin and mutation requests before reading history", async () => {
      expect(crossOrigin.status()).toBe(HTTP_FORBIDDEN);

      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const mutation = await request.fetch("/api/agents?agent=codex:native-codex", {
          method,
          data: { action: "resume" },
        });

        expect(mutation.status()).toBe(METHOD_NOT_ALLOWED);
      }

      return await request.get("/api/agents?agent=codex:native-codex");
    });
  const transcript = agentTranscriptSchema.parse(await transcriptResponse.json());

  const imageUrl = await test.step("Verify normalized history and select its actual image", () => {
    const image = transcript.state.turns.flatMap((turn) => turn.items).find((item) => item.type === "imageOutput");

    expect(JSON.stringify(transcript)).toContain("Earlier progress from the full transcript");
    expect(JSON.stringify(transcript)).toContain("REPLAY_TOOL_OUTPUT");
    expect(JSON.stringify(transcript)).not.toMatch(
      /PRIVATE_SESSION_SECRET|PRIVATE_ENV|HIDDEN_CONFIG|sandbox|approval_policy|developerInstructions/
    );

    if (!image) {
      throw new Error("Expected replay image.");
    }

    return (image.images ?? [])[0].source;
  });
  const imageResponse = await request.get(imageUrl);

  const unrelatedImage = await test.step("Serve the owned image and reject a substituted owner", async () => {
    expect(imageResponse.headers()["content-type"]).toBe("image/webp");

    return await request.get(imageUrl.replace("codex%3Anative-codex", "codex%3Aunrelated"));
  });
  const markdownImage = await test.step("Reject unrelated image reads before resolving Markdown media", async () => {
    expect(unrelatedImage.status()).toBe(HTTP_NOT_FOUND);

    return await request.get("/api/agents?agent=codex:native-codex&item=markdown-image&source=child-image.png");
  });
  const forgedImage = await test.step("Serve saved Markdown media before rejecting path forgery", async () => {
    expect(markdownImage.headers()["content-type"]).toBe("image/webp");

    return await request.get("/api/agents?agent=codex:native-codex&item=markdown-image&source=../../private.png");
  });
  const claudeResponse = await test.step("Reject forged sources before reading managed Claude history", async () => {
    expect(forgedImage.status()).toBe(HTTP_NOT_FOUND);

    return await request.get(`/api/agents?agent=pocket:${entries["Claude Side Pocket"]}`);
  });
  const claude = agentTranscriptSchema.parse(await claudeResponse.json());

  const rawLog = await test.step("Verify saved Claude projection before auditing native calls", async () => {
    expect(JSON.stringify(claude)).toContain("CLAUDE_REPLAY_TOOL_OUTPUT");
    expect(claude.state.turns.flatMap((turn) => turn.items).filter((item) => item.type === "userMessage")).toHaveLength(
      1
    );

    return await readFile(`${directory}/rpc.jsonl`, "utf8");
  });
  const log = rawLog
    .trim()
    .split("\n")
    .map((line) => replayLogSchema.parse(JSON.parse(line)));

  expect(
    log.filter(
      (entry) =>
        entry.threadId &&
        entry.threadId !== "replay-parent" &&
        !["thread/read", "thread/turns/list", "thread/items/list"].includes(entry.method)
    )
  ).toEqual([]);
  expect(
    log.filter((entry) => entry.method === "thread/resume").every((entry) => entry.threadId === "replay-parent")
  ).toBeTruthy();
}
