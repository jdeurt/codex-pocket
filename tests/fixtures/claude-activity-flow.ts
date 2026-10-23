import { type SDKAssistantMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type AgentRecord } from "../../src/server/agent-sources";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { checkActivityUi } from "./activity-ui";
import { claudeAssistant } from "../simulators/claude-messages";
import { claudeWriteHistory } from "./claude-writes";
import { projectAgentTranscript } from "../../src/server/agent-projection";
import { randomUUID } from "node:crypto";
import { readClaude } from "../../src/server/agent-claude";
import assert from "node:assert/strict";
import path from "node:path";

/** Build a real SDK tool-result message associated with exactly one invocation.
@param sessionId - Native saved-session identity.
@param id - Native tool_use identifier.
@param isError - Whether this invocation failed.
@returns Native result-only user message, which must not become a human bubble.
*/
function result(sessionId: string, id: string, isError = false): SDKUserMessage {
  return {
    type: "user",
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "Native result" }],
    },
  };
}

/** Exercise the production Claude SDK saved-history reader and Side Pocket projection after each native append.
@param root - Private Claude project and test storage.
*/
export async function claudeActivityFlow(root: string) {
  const sessionId = randomUUID();
  const project = path.join(process.env.CLAUDE_CONFIG_DIR ?? root, "projects", root.replaceAll(/[^a-zA-Z0-9]/g, "-"));
  const filename = path.join(project, `${sessionId}.jsonl`);
  const messages: (SDKAssistantMessage | SDKUserMessage)[] = [];
  const record: AgentRecord = {
    agent: {
      id: `claude:${sessionId}`,
      parentId: "parent",
      name: "File inspector",
      source: "native",
      harness: "claude",
      status: "running",
      preview: "",
    },
    observedStatus: "running",
    cwd: root,
    sessionId,
  };
  const check = async (expected: string | undefined) => {
    await writeFile(filename, claudeWriteHistory(messages, sessionId, root));
    await readClaude(record, sessionId);
    await checkActivityUi(projectAgentTranscript(record, record.agent.id).state, expected);
  };
  const call: SDKAssistantMessage = claudeAssistant(sessionId, "fixture-model", "");

  call.message.stop_reason = "tool_use";
  call.message.content = [
    { type: "tool_use", id: "first", name: "Read", input: { file_path: "CaseSensitive.txt" } },
    { type: "tool_use", id: "second", name: "Write", input: { file_path: "OtherFile.txt", content: "draft" } },
    { type: "tool_use", id: "third", name: "Read", input: { file_path: "ThirdFile.txt" } },
  ];
  messages.push(call);
  await mkdir(project, { recursive: true });
  await check("reading files, editing files, reading files");
  const commentary: SDKAssistantMessage = claudeAssistant(sessionId, "fixture-model", "Inspection continues");

  commentary.message.stop_reason = null;
  commentary.message.content.push({ type: "thinking", thinking: "Consider the remaining files", signature: "fixture" });
  messages.push(commentary);
  await check("reading files, editing files, reading files");
  messages.push(result(sessionId, "second", true));
  await check("reading files, reading files");
  messages.push(result(sessionId, "third"));
  await check("reading files");
  messages.push(result(sessionId, "first"));
  await check("");
  const next: SDKAssistantMessage = claudeAssistant(sessionId, "fixture-model", "");

  next.message.stop_reason = "tool_use";
  next.message.content = [
    { type: "tool_use", id: "next", name: "Write", input: { file_path: "CaseSensitive.txt", content: "new" } },
  ];
  messages.push(next);
  await check("editing files");
  assert.equal(record.turns?.[0].items.find((item) => item.nativeId === "next")?.tool, "Write");
  assert.equal(record.turns[0].items.find((item) => item.nativeId === "first")?.tool, "Read");
  assert.match(await readFile(filename, "utf8"), /CaseSensitive\.txt/);
  record.observedStatus = "failed";
  await check(undefined);
  record.observedStatus = "running";
  await check("editing files");
  record.historyError = true;
  await checkActivityUi(projectAgentTranscript(record, record.agent.id).state, undefined);
  record.historyError = false;
  messages.push(result(sessionId, "next", true));
  await check("");
  messages.push(claudeAssistant(sessionId, "fixture-model", "Finished"));
  record.observedStatus = "completed";
  await check(undefined);
}
