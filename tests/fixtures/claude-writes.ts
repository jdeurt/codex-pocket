import { type FileWriteOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { type SDKAssistantMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeAssistant } from "../simulators/claude-messages";
import { randomUUID } from "node:crypto";

export const writeCases = ["create", "update", "staged", "failed", "unknown", "other-tool"];

/** Build SDK-shaped write results, including cases that cannot prove an applied write.
@param sessionId - Native saved-session identity.
@returns Wire messages carrying structured outputs that the saved SDK reader discards.
*/
export function claudeWriteMessages(sessionId: string) {
  return writeCases.flatMap((kind): (SDKAssistantMessage | SDKUserMessage)[] => {
    const call: SDKAssistantMessage = claudeAssistant(sessionId, "simulator-model", "");
    const output: FileWriteOutput = {
      type: kind === "update" ? "update" : "create",
      filePath: `/fixture/${kind}.txt`,
      content: "Private file content stays out of display metadata",
      structuredPatch: [],
      originalFile: kind === "update" ? "Original private content" : null,
      ...(kind === "staged" && { staged: true }),
    };

    call.message.content = [
      {
        type: "tool_use",
        id: kind,
        name: kind === "other-tool" ? "Read" : "Write",
        input: { file_path: output.filePath, content: output.content },
      },
    ];
    call.message.stop_reason = "tool_use";

    return [
      call,
      {
        type: "user",
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        tool_use_result: kind === "unknown" ? undefined : output,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: kind,
              is_error: kind === "failed",
              content: "Native display text is not operation evidence",
            },
          ],
        },
      },
    ];
  });
}

/** Convert the same external messages to Claude's saved JSONL chain.
@param messages - Original SDK call and result messages.
@param sessionId - Owning native session.
@param cwd - Fixture project directory.
@returns Serialized saved transcript consumed by the unmodified SDK history reader.
*/
export function claudeWriteHistory(messages: ReturnType<typeof claudeWriteMessages>, sessionId: string, cwd: string) {
  return (
    messages
      .map((message, index) =>
        JSON.stringify({
          ...message,
          sessionId,
          cwd,
          timestamp: new Date().toISOString(),
          parentUuid: messages[index - 1]?.uuid,
        })
      )
      .join("\n") + "\n"
  );
}
