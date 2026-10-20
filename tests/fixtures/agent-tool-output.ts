// OFFLINE wire fixtures checked against Codex CLI 0.163 generated v2 ThreadItem,
// McpToolCallResult/Error and DynamicToolCallOutputContentItem. MCP resource/text
// blocks follow the installed MCP SDK ContentBlock schema. No live tool runs.
export function replayToolOutputs(id: string, image: string) {
  const mcp = {
    type: "mcpToolCall" as const,
    server: "offline-mcp",
    arguments: { PRIVATE_TOOL_ARGUMENT: "not visible output" },
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: true,
    durationMs: 1,
  };
  const dynamic = {
    type: "dynamicToolCall" as const,
    namespace: "offline",
    arguments: { PRIVATE_TOOL_ARGUMENT: "not visible output" },
    durationMs: 1,
  };

  return [
    {
      ...mcp,
      id: `${id}-mcp-text`,
      tool: "Replay MCP result",
      status: "completed" as const,
      result: {
        content: [
          { type: "text", text: "REPLAY_MCP_TEXT" },
          {
            type: "resource",
            resource: { uri: "fixture://saved", mimeType: "text/plain", text: "REPLAY_MCP_RESOURCE" },
          },
          { type: "image", mimeType: "image/png", data: image.split(",", 2)[1] },
        ],
        structuredContent: { PRIVATE_TOOL_STRUCTURED: "not visible output" },
        _meta: { PRIVATE_TOOL_META: "not visible output" },
      },
      error: null,
    },
    {
      ...mcp,
      id: `${id}-mcp-error`,
      tool: "Replay MCP failure",
      status: "failed" as const,
      result: null,
      error: { message: "REPLAY_MCP_ERROR" },
    },
    {
      ...dynamic,
      id: `${id}-dynamic-text`,
      tool: "Replay dynamic result",
      status: "completed" as const,
      contentItems: [
        { type: "inputText" as const, text: "REPLAY_DYNAMIC_TEXT" },
        { type: "inputImage" as const, imageUrl: image },
      ],
      success: true,
    },
    {
      ...dynamic,
      id: `${id}-dynamic-error`,
      tool: "Replay dynamic failure",
      status: "failed" as const,
      contentItems: [{ type: "inputText" as const, text: "REPLAY_DYNAMIC_ERROR" }],
      success: false,
    },
  ];
}
