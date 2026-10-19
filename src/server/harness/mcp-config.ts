import type { AdapterOptions } from "./types";

export function codexParentTools(server: AdapterOptions["parentTools"]) {
  const overrides: Record<string, unknown> = {
    "mcp_servers.pocket.enabled": false,
    "mcp_servers.pocket.command": process.execPath,
    "mcp_servers.pocket.env.POCKET_MAIN_THREAD_ID": "",
    "mcp_servers.pocket.env.POCKET_CHILD_ID": server?.env.POCKET_CHILD_ID ?? "side-pocket",
  };

  if (server) {
    overrides["mcp_servers.pocket_parent.command"] = server.command;
    overrides["mcp_servers.pocket_parent.args"] = server.args;
    overrides["mcp_servers.pocket_parent.default_tools_approval_mode"] = "approve";

    for (const [key, value] of Object.entries(server.env)) {
      overrides[`mcp_servers.pocket_parent.env.${key}`] = value;
    }
  }

  return Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}
