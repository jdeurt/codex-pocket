// OFFLINE wire fixtures checked against Codex CLI 0.163 generated v2 ThreadItem,
// McpToolCallResult/Error and DynamicToolCallOutputContentItem. MCP resource/text
// blocks follow the installed MCP SDK ContentBlock schema. No live tool runs.
/**
Builds saved native MCP and dynamic text, resource, image and error records for the offline transcript.
@param id - Synthetic session prefix giving every native item a stable identity.
@param image - Inline synthetic image used by native tool output variants.
@returns Synthetic native tool items with private argument and metadata sentinels.
*/
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

  const commands = [
    "pwd",
    "npm run build --verbose",
    "echo abcdefghijklmnop next",
    "123456789012345 next",
    "abcdefghijklmnopqrstuvwxyz",
  ];

  return [
    ...commands.map((command, index) => ({
      id: `${id}-command-${String(index)}`,
      type: "commandExecution",
      status: "completed",
      command,
      aggregatedOutput: `Saved output for ${command}`,
    })),
    {
      id: `${id}-changes`,
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "src/edited.ts", kind: { type: "update", move_path: null }, diff: "saved edit" },
        { path: "src/created.ts", kind: { type: "add" }, diff: "saved addition" },
        { path: "src/deleted.ts", kind: { type: "delete" }, diff: "saved deletion" },
      ],
    },
    ...["message_parent", "messageParent", "MessageParent", "sendHTTPRequest"].map((tool) => ({
      ...dynamic,
      id: `${id}-${tool}`,
      tool,
      status: "completed",
      contentItems: [{ type: "inputText", text: `Saved ${tool} output` }],
      success: true,
    })),
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
