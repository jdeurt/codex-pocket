import { type CodexRpc } from "./rpc";
import { type Config } from "./config";
import { MAIN_INSTRUCTIONS } from "./pocket-prompts";
import { delegations } from "./delegations";
import { localDirectory } from "./local-state";
import { parentPolicy } from "./harness/permissions";
import path from "node:path";
import { string } from "../lib/protocol";

/**
Extend native server arguments with this process's bundled Pocket MCP connection.
@param config - Validated parent configuration retaining its native process arguments.
@returns Arguments with explicit private state and parent identities.
*/
export function pocketServerArgs(config: Config) {
  const root = process.cwd();
  const overrides: Record<string, unknown> = {
    "mcp_servers.pocket.command": process.execPath,
    "mcp_servers.pocket.args": [
      "--import",
      path.join(root, "node_modules/tsx/dist/loader.mjs"),
      path.join(root, "scripts/mcp.ts"),
    ],
    "mcp_servers.pocket.cwd": root,
    "mcp_servers.pocket.default_tools_approval_mode": "approve",
    "mcp_servers.pocket.env.CODEX_POCKET_STATE_DIR": localDirectory(),
    "mcp_servers.pocket.env.POCKET_THREAD_ID": config.threadId,
    "mcp_servers.pocket.env.POCKET_MAIN_THREAD_ID": config.threadId,
  };

  return [
    ...config.serverArgs,
    ...Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
  ];
}

/**
Append the approved Pocket contract while retaining effective native developer instructions.
@param existing - Effective native developer instructions to preserve.
@returns Native instruction-layer composition without adding user history.
*/
export function pocketInstructions(existing: string) {
  return [existing, MAIN_INSTRUCTIONS].filter(Boolean).join("\n\n");
}

/**
Resume the parent with Pocket instructions and persist its effective child policy.
@param rpc - Connected native Codex protocol client.
@param config - Validated parent identity and working directory.
@returns Native resumed-thread result and effective runtime metadata.
*/
export async function resumePocket(rpc: CodexRpc, config: Config) {
  const { config: effective } = await rpc.request("config/read", {
    includeLayers: false,
    cwd: config.cwd,
  });

  const effort = string(effective.model_reasoning_effort);
  const instructions = pocketInstructions(string(effective.developer_instructions));

  const resumed = await rpc.request("thread/resume", {
    threadId: config.threadId,
    excludeTurns: true,
    ...(effort && { config: { model_reasoning_effort: effort } }),
    developerInstructions: instructions,
  });
  const sandboxModes: Record<string, string> = {
    dangerFullAccess: "danger-full-access",
    readOnly: "read-only",
    workspaceWrite: "workspace-write",
  };

  delegations().saveParent(config.threadId, {
    cwd: config.cwd,
    policy: parentPolicy({
      ...effective,
      sandbox_mode: sandboxModes[resumed.sandbox?.type ?? ""] ?? effective.sandbox_mode,
      approval_policy: resumed.approvalPolicy ?? effective.approval_policy,
      model: resumed.model,
      model_reasoning_effort: resumed.reasoningEffort ?? effort,
    }),
  });

  return resumed;
}
