import {
  type NonNullableUsage,
  type SDKAssistantMessage,
  type SDKResultSuccess,
  type SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";

const emptyUsage: NonNullableUsage = {
  fallback_credit: null,
  iterations: [],
  output_tokens_details: { thinking_tokens: 0 },
  speed: "standard",
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard",
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  inference_geo: "not_available",
};

/**
Build the actual SDK initialization event with an intentionally empty external capability catalog.
@param sessionId - Test session identity.
@param model - Selected model.
@param permissionMode - Current native permission mode.
@returns SDK initialization message.
*/
export function claudeInit(sessionId: string, model: string, permissionMode: SDKSystemMessage["permissionMode"]) {
  return {
    type: "system",
    subtype: "init",
    uuid: randomUUID(),
    session_id: sessionId,
    cwd: process.cwd(),
    apiKeySource: "none",
    claude_code_version: "2.1.292",
    tools: [],
    mcp_servers: [],
    model,
    permissionMode,
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
  } satisfies SDKSystemMessage;
}

/**
Create a typed assistant message without inventing token consumption.
@param sessionId - Test session.
@param model - Selected model.
@param text - Scripted literal output.
@returns SDK assistant message.
*/
export function claudeAssistant(sessionId: string, model: string, text: string) {
  return {
    type: "assistant",
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text, citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: emptyUsage,
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
    },
  } satisfies SDKAssistantMessage;
}

/**
Create the terminal SDK receipt, with explicit zero simulated costs.
@param sessionId - Test session.
@param text - Scripted terminal result.
@returns SDK success message.
*/
export function claudeResult(sessionId: string, text: string) {
  return {
    type: "result",
    subtype: "success",
    uuid: randomUUID(),
    session_id: sessionId,
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 1,
    result: text,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: emptyUsage,
    modelUsage: {},
    permission_denials: [],
  } satisfies SDKResultSuccess;
}
